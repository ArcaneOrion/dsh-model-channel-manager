import z from "@deepseek-ai/schemastery";
import { randomUUID } from 'node:crypto';
import { HealthStore } from './health-store.js';
import { ChannelController, RuntimeStore, TaskRegistry, aggregateHealth, createRpcHandler } from './channel-state.js';
export const name = 'model-channel-manager';
export const inject = ['llm', 'timer'];
// storageDomain 由 dsh-base 组合（json 后端，root=storages/）；不进 inject 硬依赖——
// 缺栈的 profile 降级为「健康流水不持久化」而不是拒绝启动。
const ROUTE_PREFIX = 'roundrobin/';
const GROUP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// health is a read-only migration input; it is never exposed by Settings forms.
export const Config = z.object({
    groups: z.array(z.any()).default([]).volatile(),
    providerOrder: z.array(z.string()).default([]).volatile(),
    effortMemory: z.dict(z.string()).default({}).volatile(),
    health: z.any(),
}).loose(true);
export function apply(ctx, config) {
    // 本行在 profile 中的 entry id 就是 settings 命名空间；缺失时回落到包名。
    const SELF_NS = (ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.id) || 'model-channel-manager';
    const refOf = (key, fallback) => {
        const field = config && config[key];
        if (field && typeof field.get === 'function') {
            try {
                return field.get();
            }
            catch (_e) {
                return fallback;
            }
        }
        return fallback;
    };
    const legacyHealth = config.health || {};
    const cfgOf = () => ({
        groups: refOf('groups', []) || [],
        providerOrder: refOf('providerOrder', []) || [],
        effortMemory: refOf('effortMemory', {}) || {},
    });

    const isContentChunk = (c) => {
        if (!c) return false;
        if (c.type === 'text-delta' || c.type === 'reasoning-delta') return c.text !== '';
        if (c.type === 'tool-call-delta') return c.argumentsDelta !== '' || c.name !== undefined;
        return false;
    };
    const isTerminalChunk = (c) => c && c.type === 'finish';
    const isSuccessReason = (r) => r && (r.kind === 'stop' || r.kind === 'max-tokens' || r.kind === 'tool-calls');
    const failChunk = (message, code) => ({ type: 'finish', reason: { kind: 'error', failure: { message, code } } });
    const abortedChunk = (message) => ({ type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } });
    const candKey = (c) => c.provider + '::' + c.model;
    const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
    const groupOfRoute = (p) => (p != null && p.startsWith(ROUTE_PREFIX) ? p.slice(ROUTE_PREFIX.length) : null);
    const routeOfGroup = (id) => ROUTE_PREFIX + id;
    const runtime = new Map();
    const state = { config: cfgOf(), records: clone(legacyHealth.records || {}), speedResults: clone(legacyHealth.speedResults || {}) };
    let healthStore = null;
    let runtimeStore = null;
    let storageReady = Promise.resolve();
    let storageStatus = 'memory';
    let storageError = null;
    let closed = false;
    let runtimeTimer = null;
    let cleanupLegacy = () => {};
    const pendingEvents = [];
    const saveRuntime = async (rows = tasks.list()) => {
        if (runtimeStore) await runtimeStore.save({ runtime: persistRuntime(), tasks: rows });
    };
    const tasks = new TaskRegistry({ persist: saveRuntime });
    const scheduleRuntime = () => {
        if (runtimeTimer || closed) return;
        runtimeTimer = ctx.timeout(() => {
            runtimeTimer = null;
            saveRuntime().catch(error => { storageError = error.message; });
        }, 5000);
    };
    const groupRuntime = (id) => {
        let g = runtime.get(id);
        if (g === undefined) {
            g = { currentIndex: 0, cooldowns: new Map(), lastSpeedTestAt: 0, speedTestRunning: false, events: [] };
            runtime.set(id, g);
        }
        return g;
    };
    // ---------- 可取消超时（避免 Promise.race 留下孤儿定时器） ----------
    // 0.3.13（审计 R3）：guard 不能只在 dispose 时 clearTimeout。
    // dispose（= fiber 卸载/重载）时若只清定时器，promise 永不 settle，
    // `await Promise.race([inner.next(), guard.promise])` 就永远挂住：
    // 在飞测试既不结束也不写终态，客户端 66s 后得到假超时。
    // 现在 dispose 会主动 reject（ABORTED），调用方走正常失败路径。
    const timed = (ms, makeError) => {
        let rejectFn;
        let settled = false;
        let timer = null;
        const promise = new Promise((_, reject) => { rejectFn = reject; });
        const fire = (err) => { if (settled) return; settled = true; rejectFn(err); };
        const release = ctx.effect(() => {
            timer = setTimeout(() => fire(makeError()), ms);
            return () => {
                if (timer !== null) clearTimeout(timer);
                fire({ code: 'ABORTED', message: 'plugin reloaded while this attempt was in flight' });
            };
        }, 'model-channel timeout guard');
        return { promise, dispose: () => { settled = true; release(); } };
    };
    // ---------- 配置归一化（与动态原型逐行一致） ----------
    function normalizeConfig(raw) {
        const groups = Array.isArray(raw && raw.groups) ? raw.groups : [];
        const out = [];
        const seen = new Set();
        for (const rg of groups) {
            const id = rg && typeof rg.id === 'string' ? rg.id : null;
            if (id === null || !GROUP_ID_RE.test(id) || seen.has(id))
                continue;
            seen.add(id);
            const vm = rg.virtualModel || {};
            const st = rg.speedTest || {};
            out.push({
                id,
                virtualModel: {
                    name: typeof vm.name === 'string' && vm.name.length > 0 ? vm.name : id,
                    reasoning: vm.reasoning !== false,
                    input: Array.isArray(vm.input) && vm.input.length > 0 && vm.input.every((x) => x === 'text' || x === 'image') ? vm.input.slice() : ['text'],
                    contextWindow: Number.isSafeInteger(vm.contextWindow) && vm.contextWindow > 0 ? vm.contextWindow : 200000,
                    maxTokens: Number.isSafeInteger(vm.maxTokens) && vm.maxTokens > 0 ? vm.maxTokens : 16384,
                },
                candidates: Array.isArray(rg.candidates)
                    ? rg.candidates.filter((c) => c && typeof c.provider === 'string' && c.provider.length > 0 && typeof c.model === 'string' && c.model.length > 0).map((c) => ({ provider: c.provider, model: c.model }))
                    : [],
                presets: Array.isArray(rg.presets)
                    ? rg.presets.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.candidates)).map((p) => ({
                        id: p.id, name: typeof p.name === 'string' ? p.name : p.id,
                        candidates: p.candidates.filter((c) => c && typeof c.provider === 'string' && typeof c.model === 'string').map((c) => ({ provider: c.provider, model: c.model })),
                    }))
                    : [],
                activePreset: typeof rg.activePreset === 'string' ? rg.activePreset : null,
                strategy: ['sticky', 'round-robin', 'primary'].includes(rg.strategy) ? rg.strategy : 'sticky',
                timeoutMs: Number.isFinite(rg.timeoutMs) && rg.timeoutMs > 0 ? rg.timeoutMs : 30000,
                cooldownMs: Number.isFinite(rg.cooldownMs) && rg.cooldownMs >= 0 ? rg.cooldownMs : 60000,
                maxRetriesPerCandidate: Number.isSafeInteger(rg.maxRetriesPerCandidate) && rg.maxRetriesPerCandidate >= 0 ? rg.maxRetriesPerCandidate : 2,
                // F01 配套（审计 §5.3）：整次请求的总预算。旧实现最坏 2×N×(R+1) 次尝试
                // （默认 R=2 → 6N 次），4 候选组可拖数分钟。默认 10 分钟；超预算
                // 后不再开新尝试，直接 CHANNEL_FULL_FAIL 终结。
                totalBudgetMs: Number.isFinite(rg.totalBudgetMs) && rg.totalBudgetMs > 0 ? rg.totalBudgetMs : 600000,
                speedTest: {
                    enabled: st.enabled !== false,
                    sortKey: ['ttft', 'latency', 'hybrid', 'smart'].includes(st.sortKey) ? st.sortKey : 'ttft',
                    prompt: typeof st.prompt === 'string' && st.prompt.length > 0 ? st.prompt : '欧拉函数的意义？',
                    maxTokens: Number.isFinite(st.maxTokens) && st.maxTokens > 0 ? st.maxTokens : 2048,
                    timeoutMs: Number.isFinite(st.timeoutMs) && st.timeoutMs > 0 ? st.timeoutMs : 60000,
                    concurrency: Number.isSafeInteger(st.concurrency) && st.concurrency > 0 ? st.concurrency : 3,
                    retries: Number.isSafeInteger(st.retries) && st.retries >= 0 ? st.retries : 2,
                    onFirstUse: st.onFirstUse === true,
                },
            });
        }
        return { groups: out };
    }
    function pullConfig() {
        return normalizeConfig(state.config);
    }
    function pullRecords() { return state.records; }
    function pullSpeedResults() { return state.speedResults; }
    // ---------- 健康聚合 ----------
    function healthAggregate() {
        const recordsMap = pullRecords();
        // 聚合所有真实渠道（provider::model）的请求健康流水；记录由全局 llm/stream 拦截器按 provider 键写入
        const allEvents = Object.values(recordsMap).flat();
        const by = new Map();
        for (const e of allEvents) {
            const key = e.provider + '::' + e.model;
            let agg = by.get(key);
            if (agg === undefined) {
                agg = { provider: e.provider, model: e.model, total: 0, success: 0, ttftSum: 0, latSum: 0, lastTs: 0, lastCode: null, lastOk: null };
                by.set(key, agg);
            }
            agg.total++;
            if (e.ok)
                agg.success++;
            if (e.ttftMs != null)
                agg.ttftSum += e.ttftMs;
            if (e.latencyMs != null)
                agg.latSum += e.latencyMs;
            if (e.ts > agg.lastTs) {
                agg.lastTs = e.ts;
                agg.lastCode = e.code || null;
                agg.lastOk = e.ok;
            }
        }
        return [...by.values()].map((a) => ({
            provider: a.provider, model: a.model, total: a.total, success: a.success,
            successRate: a.total > 0 ? a.success / a.total : null,
            reliability: (a.success + 2.5) / (a.total + 5),
            avgTtftMs: a.success > 0 ? a.ttftSum / a.success : null,
            avgLatencyMs: a.success > 0 ? a.latSum / a.success : null,
            lastTs: a.lastTs, lastCode: a.lastCode, lastOk: a.lastOk,
        }));
    }
    function activeCandidates(cfg) {
        if (cfg.activePreset) {
            const preset = cfg.presets.find((p) => p.id === cfg.activePreset);
            if (preset && preset.candidates.length > 0)
                return preset.candidates;
        }
        return cfg.candidates;
    }
    function speedResultOf(cfg, key) {
        const r = (pullSpeedResults()[cfg.id] || []).find((s) => candKey(s) === key);
        return r && r.ok ? r : null;
    }
    function dynamicTimeoutMs(cfg, key) {
        const ttft = cfg.speedTest.enabled ? (speedResultOf(cfg, key) || {}).ttft : null;
        if (ttft && ttft > 0)
            return Math.max(cfg.timeoutMs, Math.min(120000, Math.round(ttft * 2)));
        return cfg.timeoutMs;
    }
    function median(nums) {
        if (!nums || nums.length === 0)
            return null;
        const s = nums.slice().sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
    }
    function orderedCandidates(cfg) {
        const rt = groupRuntime(cfg.id);
        const base = activeCandidates(cfg);
        const aggList = healthAggregate();
        const speedRows = pullSpeedResults()[cfg.id] || [];
        const entries = base.map((cand) => {
            const key = candKey(cand);
            return { cand, key, speed: speedRows.find((s) => candKey(s) === key), agg: aggList.find((a) => a.provider === cand.provider && a.model === cand.model) };
        });
        let scored;
        if (cfg.speedTest.enabled && speedRows.length > 0) {
            const measured = entries.filter((e) => e.speed && e.speed.ok && (e.speed.ttft != null || e.speed.latency != null));
            const ttfts = measured.map((e) => e.speed.ttft).filter((v) => v != null);
            const lats = measured.map((e) => e.speed.latency).filter((v) => v != null);
            const ttftMedian = median(ttfts);
            const latMedian = median(lats);
            const ttftRange = ttfts.length > 1 ? Math.max(...ttfts) - Math.min(...ttfts) : 0;
            const latRange = lats.length > 1 ? Math.max(...lats) - Math.min(...lats) : 0;
            scored = entries.map((e) => {
                if (e.speed && e.speed.ok && (e.speed.ttft != null || e.speed.latency != null)) {
                    const ttft = e.speed.ttft != null ? e.speed.ttft : ttftMedian;
                    const lat = e.speed.latency != null ? e.speed.latency : latMedian;
                    const reliability = e.agg ? e.agg.reliability : 0.5;
                    let score;
                    if (cfg.speedTest.sortKey === 'latency')
                        score = lat;
                    else if (cfg.speedTest.sortKey === 'hybrid')
                        score = 0.7 * ttft + 0.3 * lat;
                    else if (cfg.speedTest.sortKey === 'smart')
                        score = 0.5 * (ttft / (ttftRange || 1)) + 0.3 * (1 - reliability) + 0.2 * (lat / (latRange || 1));
                    else
                        score = ttft;
                    return { ...e, score, failed: false };
                }
                return { ...e, score: Infinity, failed: true };
            });
        }
        else {
            scored = entries.map((e, i) => ({ ...e, score: i, failed: false }));
        }
        const out = scored.slice();
        out.sort((a, b) => {
            if (a.failed !== b.failed)
                return a.failed ? 1 : -1;
            if (a.score !== b.score)
                return a.score - b.score;
            return entries.indexOf(a) - entries.indexOf(b);
        });
        return out.map((e) => e.cand);
    }
    function pushEvent(cfg, kind, payload) {
        const rt = groupRuntime(cfg.id);
        rt.events.push(Object.assign({ ts: Date.now(), group: cfg.id, kind }, payload || {}));
        scheduleRuntime();
        if (rt.events.length > 200)
            rt.events.splice(0, rt.events.length - 200);
    }
    // ---------- 路由运行态快照 ----------
    const persistRuntime = () => {
        const out = {};
        for (const [id, rt] of runtime) {
            const now = Date.now();
            out[id] = {
                currentIndex: rt.currentIndex,
                cooldowns: Array.from(rt.cooldowns.entries()).map(([key, until]) => ({ key, until, active: until > now })),
                events: rt.events.slice(-40),
                lastSpeedTestAt: rt.lastSpeedTestAt,
                speedTestRunning: rt.speedTestRunning,
            };
        }
        return out;
    };
    // ---------- 运行时态恢复（重启后还原冷却与 sticky 指针） ----------
    function restoreRuntime(saved) {
        if (!saved || typeof saved !== 'object') return;
        const now = Date.now();
        for (const [id, data] of Object.entries(saved)) {
            if (!data || typeof data !== 'object') continue;
            const rt = groupRuntime(id);
            if (Number.isSafeInteger(data.currentIndex)) rt.currentIndex = data.currentIndex;
            if (Number.isSafeInteger(data.lastSpeedTestAt)) rt.lastSpeedTestAt = data.lastSpeedTestAt;
            if (Array.isArray(data.cooldowns)) {
                for (const c of data.cooldowns) {
                    if (c && typeof c.key === 'string' && Number.isFinite(c.until) && c.until > now) {
                        rt.cooldowns.set(c.key, c.until);
                    }
                }
            }
        }
    }
    const recordHealth = (gid, cand, entry) => {
        const now = Date.now();
        const key = gid || 'global';
        const rec = { id: randomUUID(), ts: now, provider: cand.provider, model: cand.model, ok: entry.ok, ttftMs: entry.ttftMs, latencyMs: entry.latencyMs, code: entry.code || null };
        // 上游真实 token 用量（来自 usage StreamChunk，计费口径与 dsh-token-meter 一致）：
        // 展平写入记录条目；缺失/非法字段不写，旧记录按 0 处理（向后兼容）。
        const u = entry.usage;
        if (u && typeof u === 'object') {
            if (Number.isFinite(u.inputTokens)) rec.inputTokens = u.inputTokens;
            if (Number.isFinite(u.outputTokens)) rec.outputTokens = u.outputTokens;
            if (Number.isFinite(u.cacheReadTokens)) rec.cacheReadTokens = u.cacheReadTokens;
            if (Number.isFinite(u.cacheWriteTokens)) rec.cacheWriteTokens = u.cacheWriteTokens;
            if (Number.isFinite(u.reasoningTokens)) rec.reasoningTokens = u.reasoningTokens;
        }
        // 内存镜像（聚合与 smart 键读内存即可）+ domain 追加（事实持久化）。
        // domain 写入走 per-record put（写一条只动一个渠道桶文档），
        // 不再有 2s 防抖与 volatile 快照覆盖的竞态窗口。
        const list = state.records[key] || (state.records[key] = []);
        list.push(rec);
        const cutoff = now - 7 * 24 * 3600 * 1000;
        state.records[key] = list.filter((e) => e.ts >= cutoff).slice(-300);
        if (healthStore !== null) {
            healthStore.appendEvent(key, rec).catch((e) => { storageError = e.message; console.warn('[model-channel-manager] health event append failed:', e.message); });
        } else if (storageStatus === 'loading') pendingEvents.push({ key, rec });
        scheduleRuntime();
    };
    const persistSpeedResults = async (r) => {
        if (healthStore !== null) {
            await healthStoreSpeed(r).catch(() => { });
        }
        await saveRuntime();
    };
    const healthStoreSpeed = async (r) => {
        for (const [groupId, rows] of Object.entries(r || {})) {
            await healthStore.putSpeedRows(groupId, rows);
        }
    };
    // ---------- 引擎：单候选尝试 ----------
    // F01/F02（审计）：超时必须能真正结束一次尝试。
    //  - 旧行为：Promise.race 超时后 await inner.return()，但 return() 排在挂起的
    //    next() 之后——上游挂着时 failover 被拖住（H02：15ms 超时 80ms 后仍未切换）。
    //  - 新行为：每次尝试独立 AbortController。pi-ai 适配器把 options.signal 经
    //    AbortSignal.any 融进 watchdog 并传给上游 HTTP（signal: watchdog.signal），
    //    abort 即真正取消网络请求。超时路径：先 abort → 有界等待（3s）排干 → 放弃
    //    等待继续 failover（放弃的迭代器由适配器的 finally 自行清理）。
    //  - 生命周期（F02）：成功 return / 失败 / 消费者提前退出统一走 finally 的
    //    有界 closeInner，不再只在 catch 里清理。
    const ATTEMPT_CLOSE_BUDGET_MS = 3000;
    async function* streamAttempt(cfg, cand, options, attemptStart) {
        if (cand.provider.startsWith(ROUTE_PREFIX))
            throw { code: 'INVALID_CANDIDATE', message: 'candidate provider must not be a virtual route' };
        const llm = ctx.llm;
        // 用户取消信号透传 + 尝试自身的超时中止，二者融合为本次尝试的 signal
        const attemptController = new AbortController();
        const outerSignal = options.signal;
        const relayAbort = () => { try { attemptController.abort(outerSignal.reason); } catch (_e) { } };
        if (outerSignal) {
            if (outerSignal.aborted)
                relayAbort();
            else
                outerSignal.addEventListener('abort', relayAbort, { once: true });
        }
        const inner = llm.stream(Object.assign({}, options, { provider: cand.provider, model: cand.model, signal: attemptController.signal }));
        const timeoutMs = dynamicTimeoutMs(cfg, candKey(cand));
        let buffer = [];
        let started = false;
        let ttftMs = null;
        let lastAt = Date.now();
        let lastUsage = null;
        let closed = false;
        const closeInner = async () => {
            if (closed)
                return;
            closed = true;
            try {
                const c = inner.return ? inner.return() : null;
                if (c && c.then) {
                    await Promise.race([
                        c,
                        ctx.timeout(ATTEMPT_CLOSE_BUDGET_MS).then(() => { attemptController.abort({ code: 'TIMEOUT', message: 'attempt close budget exceeded' }); }, () => { }),
                    ]);
                }
            }
            catch (_e) { }
        };
        try {
            while (true) {
                if (outerSignal && outerSignal.aborted)
                    throw { code: 'ABORTED', message: 'request aborted' };
                const remaining = Math.max(0, timeoutMs - (Date.now() - (started ? lastAt : attemptStart)));
                if (remaining <= 0)
                    throw { code: 'TIMEOUT', message: 'channel candidate timed out after ' + timeoutMs + 'ms' };
                // guard 覆盖全量 remaining：不能 cap 到 30s，否则 timeoutMs>30s 的首响应
                // 超时与动态超时（min(120s, ttft×2)）在 >30s 区间全部退化为 30s 切候选
                const guard = timed(Math.max(1, remaining), () => ({ code: 'TIMEOUT', message: 'channel candidate timed out after ' + timeoutMs + 'ms' }));
                let next;
                try {
                    next = await Promise.race([inner.next(), guard.promise]);
                }
                catch (raceErr) {
                    // 超时（或任何 next 失败）：先中止本次尝试的上游请求再上抛——
                    // 这是 F01 的核心：abort 信号会穿透 pi-ai 取消真实 HTTP 请求
                    if (raceErr && raceErr.code === 'TIMEOUT')
                        attemptController.abort(raceErr);
                    throw raceErr;
                }
                finally {
                    // 超时路径同样要 dispose：ctx.effect 的注册表条目只有显式调用 disposer 才会移除
                    guard.dispose();
                }
                lastAt = Date.now();
                const chunk = next.value;
                // 适配器在 finish 前发 usage 块（pi-ai done/error 都带）；捕获后随记录写入，
                // 与请求/健康计数保持同一记录、同一窗口口径
                if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object')
                    lastUsage = chunk.usage;
                if (chunk === undefined)
                    throw { code: 'STREAM_CLOSED', message: 'channel stream ended without a terminal chunk' };
                if (!started) {
                    if (isContentChunk(chunk)) {
                        started = true;
                        ttftMs = Date.now() - attemptStart;
                        for (const b of buffer)
                            yield b;
                        yield chunk;
                    }
                    else if (isTerminalChunk(chunk)) {
                        const reason = chunk.reason || {};
                        // 引擎提前终止的内层流不会被全局拦截器完整排水记账，这里自行记录
                        if (isSuccessReason(reason)) {
                            recordHealth(cand.provider, cand, { ok: false, ttftMs: null, latencyMs: null, code: 'EMPTY_RESPONSE', usage: lastUsage });
                            throw { code: 'EMPTY_RESPONSE', message: 'model returned a completed response with no content' };
                        }
                        const preCode = (reason.failure && reason.failure.code) || 'STREAM_ERROR';
                        recordHealth(cand.provider, cand, { ok: false, ttftMs: null, latencyMs: null, code: preCode, usage: lastUsage });
                        throw { code: preCode, message: (reason.failure && reason.failure.message) || 'candidate stream failed' };
                    }
                    else {
                        buffer.push(chunk);
                    }
                }
                else {
                    if (isTerminalChunk(chunk)) {
                        const reason = chunk.reason || {};
                        if (isSuccessReason(reason)) {
                            recordHealth(cand.provider, cand, { ok: true, ttftMs, latencyMs: Date.now() - attemptStart, code: null, usage: lastUsage });
                            yield chunk;
                            return;
                        }
                        // 内容已向下游输出：绝不能再下发该失败终止块（否则出现 finish 后继续输出/双 finish），
                        // 改为抛错并标记 emitted，由组层直接终结本次请求
                        const midCode = (reason.failure && reason.failure.code) || 'STREAM_ERROR';
                        recordHealth(cand.provider, cand, { ok: false, ttftMs, latencyMs: null, code: midCode, usage: lastUsage });
                        throw { code: midCode, message: (reason.failure && reason.failure.message) || 'candidate stream failed mid-stream' };
                    }
                    yield chunk;
                }
            }
        }
        catch (err) {
            if (started && err && typeof err === 'object')
                err.emitted = true;
            if (err && err.code === 'TIMEOUT')
                recordHealth(cand.provider, cand, { ok: false, ttftMs, latencyMs: null, code: 'TIMEOUT', usage: lastUsage });
            throw err;
        }
        finally {
            // F02：所有出口（成功 return / 失败 / 消费者提前 return）统一有界关闭；
            // relayAbort 监听器随本次尝试终结移除（防泄漏：outerSignal 可能长命）
            if (outerSignal)
                outerSignal.removeEventListener('abort', relayAbort);
            await closeInner();
        }
    }
    // ---------- F08 最小切片：候选能力过滤（防「成功路径改变用户输入」） ----------
    // 审计 H14：虚拟模型声明 image，候选只支持 text——宿主把图片静默替换为
    //   "[image omitted...]" 后仍返回 stop 成功（用户输入被改变却报成功）。
    // 审计 H06：非推理候选被强塞 effort → dispatch 前被拒 → CHANNEL_FULL_FAIL。
    // 策略：请求含图/带 effort 时，过滤「明确声明不支持」的候选；能力未知
    // （inputModalities 缺失 = 未知，只有显式排除才是负能力——宿主契约）不过滤，
    // 保持原 failover 行为。解析失败不阻塞（同样视作未知）。
    // 缓存 60s TTL：pi-ai 的 resolveModel 是内存快照解析（已核安装版源码），
    // 但 async 接口 + 每次请求都调不划算；能力基本静态，TTL 足够。
    const capabilityCache = new Map(); // key: provider::model → { at, info }
    const CAPABILITY_TTL_MS = 60000;
    const resolveCapability = async (cand) => {
        const key = candKey(cand);
        const hit = capabilityCache.get(key);
        if (hit && Date.now() - hit.at < CAPABILITY_TTL_MS)
            return hit.info;
        try {
            const info = await ctx.llm.resolveModelInfo(cand.provider, cand.model);
            const entry = { at: Date.now(), info };
            capabilityCache.set(key, entry);
            return info;
        }
        catch (_e) {
            return null; // 解析失败 = 未知，不过滤
        }
    };
    /** 请求是否包含图片输入（粗判：消息 content 里有 image 块）。 */
    const requestHasImage = (options) => {
        try {
            return (options.messages || []).some((m) => Array.isArray(m === null || m === void 0 ? void 0 : m.content) && m.content.some((p) => p && p.type === 'image'));
        }
        catch (_e) {
            return false;
        }
    };
    /** 过滤掉明确不支持本次请求能力的候选；全部被滤或未知时退回原列表（不因过滤而失去候选）。 */
    const filterByCapability = async (cands, options) => {
        const needImage = requestHasImage(options);
        const needReasoning = typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0 && options.reasoningEffort !== 'off';
        if (!needImage && !needReasoning)
            return cands;
        const skipped = [];
        const kept = [];
        for (const cand of cands) {
            const info = await resolveCapability(cand);
            if (info === null) {
                kept.push(cand); // 未知：不过滤
                continue;
            }
            if (needImage) {
                const mods = info.inputModalities;
                if (Array.isArray(mods) && mods.length > 0 && !mods.includes('image')) {
                    skipped.push({ candidate: candKey(cand), reason: 'image input not supported' });
                    continue; // 明确排除 image
                }
            }
            if (needReasoning && info.reasoning === undefined) {
                skipped.push({ candidate: candKey(cand), reason: 'reasoning not supported' });
                continue; // 明确无 reasoning 档位
            }
            kept.push(cand);
        }
        // 全被滤掉 = 声明与所有候选冲突：退回原列表（让请求去撞，报真实错误）
        // 而不是直接 NO_CANDIDATES 假装没有渠道
        if (skipped.length > 0 && kept.length > 0) {
            // 记录到组事件（cfg 此时未知，用 provider 维度的 console 代替；组事件在
            // streamGroup 拿到 cfg 后会补记 capability-filter）
            console.log('[model-channel-manager] capability filter:', skipped.map((s) => s.candidate + ' (' + s.reason + ')').join(', '));
        }
        return kept.length > 0 ? kept : cands;
    };

    // ---------- 引擎：组级故障转移循环 ----------
    async function* streamGroup(cfg, options) {
        const rt = groupRuntime(cfg.id);
        let order = orderedCandidates(cfg);
        if (order.length === 0) {
            pushEvent(cfg, 'no-candidates', {});
            yield failChunk('channel group "' + cfg.id + '" has no candidates', 'NO_CANDIDATES');
            return;
        }
        // F14（审计 H07）：enabled=true 但从未测过速的组，首次真实使用时后台触发一次
        // 自动测速（不阻塞、不 await 当前请求）。旧实现只有 boot 时的 onFirstUse 分支，
        // 常规请求路径完全没有自动测速入口——开启开关后从未生效。
        if (cfg.speedTest.enabled && (state.speedResults[cfg.id] || []).length === 0 && !rt.speedTestRunning) {
            rt.speedTestRunning = true; // 先占位防重入（runSpeedTest 内部还会再查）
            rt.speedTestRunning = false;
            runSpeedTest(cfg).catch(() => { });
        }
        // F08：按本次请求能力过滤（含图/带 effort 时）。过滤发生在测速排序之后，
        // 保序不改变相对优先级。
        const before = order.length;
        order = await filterByCapability(order, options);
        if (order.length < before)
            pushEvent(cfg, 'capability-filter', { skipped: before - order.length, kept: order.length });
        const strategy = cfg.strategy || 'sticky';
        // F13（审计 H13）：round-robin 的指针改为「选择时原子预留」——旧实现成功后才
        // 推进 rt.currentIndex，两个并发请求都从 first 开始（并发不均分）。
        // 现在：选定时立即占位推进（同步读改写，JS 单线程内原子），失败不回滚
        // （失败反馈走冷却，指针保持前进语义——轮询分布比严格顺序更重要）。
        // 0.3.15：`cursor` 必须先声明——0.3.5 重构时把原来的 `let cursor = …`
        // 改成了分支内赋值却没保留声明，ESM 严格模式下每次走虚拟路由都抛
        // `ReferenceError: cursor is not defined`（本轮运行失败）。
        let cursor = 0;
        if (strategy === 'round-robin') {
            cursor = rt.currentIndex % order.length;
            rt.currentIndex = (cursor + 1) % order.length; // 本次请求已占用 cursor 槽位
        }
        else {
            cursor = strategy === 'primary' ? 0 : rt.currentIndex % order.length;
        }
        let fullRounds = 0;
        let lastFail = null;
        const failedKeys = [];
        // 总请求预算（F01 配套）：组级起点。超预算不再开新尝试。
        const groupStart = Date.now();
        const budgetMs = cfg.totalBudgetMs || 600000;
        const budgetLeft = () => budgetMs - (Date.now() - groupStart);
        while (true) {
            if (options.signal && options.signal.aborted) {
                yield abortedChunk('request aborted');
                return;
            }
            if (budgetLeft() <= 0) {
                pushEvent(cfg, 'budget-exhausted', { budgetMs, failures: failedKeys.slice() });
                yield failChunk('channel group "' + cfg.id + '" exhausted its total budget of ' + budgetMs + 'ms: ' + (lastFail || 'multiple failures'), 'CHANNEL_BUDGET_EXCEEDED');
                return;
            }
            const round = [];
            for (let i = 0; i < order.length; i++)
                round.push(order[(cursor + i) % order.length]);
            const now = Date.now();
            const allCooled = round.every((cand) => (rt.cooldowns.get(candKey(cand)) || 0) > now);
            let succeeded = false;
            lastFail = null;
            for (const cand of round) {
                const key = candKey(cand);
                const cooledUntil = rt.cooldowns.get(key) || 0;
                if (cooledUntil > now && !allCooled)
                    continue;
                if (options.signal && options.signal.aborted) {
                    yield abortedChunk('request aborted');
                    return;
                }
                let candidateOk = false;
                for (let r = 0; r <= (cfg.maxRetriesPerCandidate || 0); r++) {
                    if (options.signal && options.signal.aborted) {
                        yield abortedChunk('request aborted');
                        return;
                    }
                    if (budgetLeft() <= 0)
                        break; // 预算耗尽：不开新尝试，交给组层终结
                    const attemptStart = Date.now();
                    try {
                        const attempt = streamAttempt(cfg, cand, options, attemptStart);
                        for await (const chunk of attempt)
                            yield chunk;
                        succeeded = true;
                        candidateOk = true;
                        rt.cooldowns.delete(key);
                        // F13：round-robin 的推进已移到选定时（见上方原子预留）；
                        // 成功路径只维护 sticky/primary 的语义。
                        const pos = order.findIndex((c) => candKey(c) === key);
                        if (strategy === 'sticky')
                            rt.currentIndex = pos;
                        else if (strategy === 'primary')
                            rt.currentIndex = 0;
                        if (failedKeys.length > 0)
                            pushEvent(cfg, 'failover', { from: failedKeys[failedKeys.length - 1], to: key, reason: 'candidate change after ' + failedKeys.length + ' failure(s)' });
                        break;
                    }
                    catch (err) {
                        const message = (err && err.message) || 'candidate failed';
                        lastFail = message;
                        if (options.signal && options.signal.aborted) {
                            yield abortedChunk('request aborted');
                            return;
                        }
                        if (err && err.emitted) {
                            // 内容已流出后失败：无法干净重放到下一候选（会拼接两个模型的输出/产生第二个 finish），
                            // 置冷却并直接以失败终结本次请求
                            rt.cooldowns.set(key, Date.now() + (cfg.cooldownMs || 0));
                            failedKeys.push(key);
                            pushEvent(cfg, 'midstream-fail', { candidate: key, reason: message });
                            yield failChunk('channel candidate failed after content was already delivered: ' + message, (err && err.code) || 'CHANNEL_MIDSTREAM_FAIL');
                            return;
                        }
                        if (r < (cfg.maxRetriesPerCandidate || 0)) {
                            pushEvent(cfg, 'retry', { candidate: key, attempt: r + 1, reason: message });
                            await ctx.timeout(Math.min(4000, 250 * Math.pow(2, r)));
                            continue;
                        }
                        rt.cooldowns.set(key, Date.now() + (cfg.cooldownMs || 0));
                        failedKeys.push(key);
                        break;
                    }
                }
                if (candidateOk)
                    break;
            }
            if (succeeded)
                return;
            pushEvent(cfg, 'full-fail', { candidates: failedKeys.slice(), reason: lastFail });
            if (fullRounds < 1) {
                fullRounds++;
                rt.cooldowns.clear();
                rt.currentIndex = 0;
                cursor = 0;
                continue;
            }
            if (options.signal && options.signal.aborted) {
                yield abortedChunk('request aborted');
                return;
            }
            yield failChunk('all channel candidates failed: ' + (lastFail || 'unknown error'), 'CHANNEL_FULL_FAIL');
            return;
        }
    }
    // ---------- 测速 ----------
    // F15 修复：旧行为每 chunk 重置 guard（单次等待上限而非总时限，H12：timeoutMs=40
    // 流每 20ms 输出，84ms 后仍成功）+ 超时不中止上游。现在：总时限 deadline +
    // 超时 abort 上游（与 streamAttempt 同一模式）+ 统一 finally 关闭。
    async function measureCandidate(cfg, cand, st, signal) {
        const llm = ctx.llm;
        const controller = new AbortController();
        const cancelled = new Promise((_, reject) => {
            const abort = () => { controller.abort(signal.reason); reject(signal.reason); };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            controller.detach = () => signal?.removeEventListener('abort', abort);
        });
        cancelled.catch(() => {});
        const deadline = Date.now() + (st.timeoutMs || 60000);
        const inner = llm.stream({ provider: cand.provider, model: cand.model, messages: [{ role: 'user', content: [{ type: 'text', text: st.prompt }] }], maxTokens: st.maxTokens, sessionId: 'mcm-speedtest-' + (st.nonce ?? Date.now()), signal: controller.signal });
        const start = Date.now();
        let ttft = null;
        let closed = false;
        const closeInner = async () => {
            if (closed)
                return;
            closed = true;
            try {
                const c = inner.return ? inner.return() : null;
                if (c && c.then) {
                    await Promise.race([
                        c,
                        ctx.timeout(ATTEMPT_CLOSE_BUDGET_MS).then(() => { try { controller.abort({ code: 'TIMEOUT', message: 'speedtest close budget exceeded' }); } catch (_e) { } }, () => { }),
                    ]);
                }
            }
            catch (_e) { }
        };
        try {
            while (true) {
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    throw { code: 'TIMEOUT', message: 'speedtest timed out after ' + st.timeoutMs + 'ms (total)' };
                const guard = timed(Math.max(1, remaining), () => ({ code: 'TIMEOUT', message: 'speedtest timed out after ' + st.timeoutMs + 'ms (total)' }));
                let next;
                try {
                    next = await Promise.race([inner.next(), guard.promise, cancelled]);
                }
                catch (raceErr) {
                    if (raceErr && raceErr.code === 'TIMEOUT')
                        try { controller.abort(raceErr); } catch (_e) { }
                    throw raceErr;
                }
                finally {
                    guard.dispose();
                }
                const chunk = next.value;
                if (chunk === undefined)
                    throw { code: 'STREAM_CLOSED', message: 'speedtest stream ended early' };
                if (ttft === null && isContentChunk(chunk))
                    ttft = Date.now() - start;
                if (isTerminalChunk(chunk)) {
                    const reason = chunk.reason || {};
                    if (isSuccessReason(reason))
                        return { provider: cand.provider, model: cand.model, ok: true, ttft, latency: Date.now() - start };
                    throw { code: (reason.failure && reason.failure.code) || 'STREAM_ERROR', message: (reason.failure && reason.failure.message) || 'speedtest failed' };
                }
            }
        }
        catch (err) {
            throw { code: (err && err.code) || 'STREAM_ERROR', message: (err && err.message) || 'speedtest failed' };
        }
        finally {
            controller.detach();
            await closeInner();
        }
    }
    async function runSpeedTest(cfg, signal) {
        const rt = groupRuntime(cfg.id);
        if (rt.speedTestRunning)
            return { ok: false, reason: 'already-running' };
        rt.speedTestRunning = true;
        pushEvent(cfg, 'speedtest-start', {});
        try {
            const st = cfg.speedTest;
            const order = orderedCandidates(cfg);
            const results = [];
            const concurrency = Math.max(1, st.concurrency || 3);
            for (let i = 0; i < order.length; i += concurrency) {
                signal?.throwIfAborted();
                const wave = order.slice(i, i + concurrency);
                if (wave.length === 0)
                    break;
                const measured = await Promise.all(wave.map(async (cand) => {
                    let lastErr = null;
                    for (let t = 0; t <= (st.retries || 0); t++) {
                        try {
                            return await measureCandidate(cfg, cand, st, signal);
                        }
                        catch (err) {
                            signal?.throwIfAborted();
                            lastErr = err;
                            if (t < (st.retries || 0))
                                await ctx.timeout(1500);
                        }
                    }
                    return { provider: cand.provider, model: cand.model, ok: false, ttft: null, latency: null, failure: (lastErr && lastErr.message) || 'speedtest failed', code: (lastErr && lastErr.code) || null };
                }));
                results.push(...measured);
            }
            const rows = results.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, ttft: r.ttft, latency: r.latency, at: Date.now(), failure: r.failure || null }));
            // 整组候选都因「环境未就绪」（凭据服务尚未加载等）失败时，不落盘 speedResults、不冷却候选，
            // 交给调用方延后重试——否则启动瞬间的一次重放会把所有渠道误判成故障并冷却。
            if (rows.length > 0 && rows.every((r, i) => !r.ok && notReady({ code: results[i] && results[i].code, message: r.failure })))
                return { ok: false, deferred: true };
            state.speedResults[cfg.id] = rows;
            await persistSpeedResults(state.speedResults);
            const now = Date.now();
            for (const r of rows)
                if (!r.ok)
                    rt.cooldowns.set(candKey(r), now + (cfg.cooldownMs || 0));
            rt.currentIndex = 0;
            rt.lastSpeedTestAt = now;
            pushEvent(cfg, 'speedtest-done', { ok: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length });
            return { ok: true, results };
        }
        finally {
            rt.speedTestRunning = false;
        }
    }
    // ---------- LLM 适配器（虚拟 route 注册） ----------
    // 模型元数据解析。config 显式传入：resolveModel 用现势 pullConfig()，
    // prepareCall 用准备时刻的快照——「prepare 与 dispatch 间 settings 变化不得混代」。
    function resolveModelWith(config, provider, model) {
        const id = groupOfRoute(provider) || provider;
        const cfg = config.groups.find((g) => g.id === id);
        if (!cfg)
            return { provider, id: model, name: model };
        const levels = cfg.virtualModel.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : [];
        return {
            provider, id: model, name: cfg.virtualModel.name,
            context: { contextWindow: cfg.virtualModel.contextWindow },
            defaultMaxTokens: cfg.virtualModel.maxTokens,
            inputModalities: cfg.virtualModel.input.slice(),
            // defaultEffort=max：原生 /model 弹窗对新模型自动填与列表展示都跟随该声明
            // （此前 medium 导致新会话选组即 medium）；会话内显式档位由 selector 插件的
            // 档位记忆层（modelDirectories 拦截）恢复
            reasoning: levels.length > 0 ? { efforts: levels.map((l) => ({ id: l, name: l })), defaultEffort: 'max' } : undefined,
        };
    }
    const adapter = {
        providerInfo(provider) {
            const id = groupOfRoute(provider) || provider;
            const cfg = pullConfig().groups.find((g) => g.id === id);
            return { id: provider, name: cfg ? cfg.virtualModel.name : provider };
        },
        providerRetryPolicy() { return undefined; },
        async listModels(provider) {
            const id = groupOfRoute(provider) || provider;
            const cfg = pullConfig().groups.find((g) => g.id === id);
            if (!cfg)
                return [];
            return [{ provider, id: cfg.id, name: cfg.virtualModel.name, inputModalities: cfg.virtualModel.input.slice() }];
        },
        async resolveModel(provider, model, _signal) {
            return resolveModelWith(pullConfig(), provider, model);
        },
        // rc.2 运行时契约：主分发路径（llm.stream / llm.prepareCall）都先调
        // adapter.prepareCall(provider, model, signal) 拿 {model, stream}——
        // 缺失会在真实发对话时报 `registration.adapter.prepareCall is not a function`
        // （注册/目录/菜单不经过它，所以此前未暴露）。快照绑定对齐 llm-pi-ai 的
        // current() 模式：元数据与本次 dispatch 都用同一份组配置。
        prepareCall(provider, model, _signal) {
            const snapshot = pullConfig();
            const cfg = snapshot.groups.find((g) => g.id === groupOfRoute(provider));
            return Promise.resolve({
                model: resolveModelWith(snapshot, provider, model),
                stream: (options) => cfg === undefined
                    ? (async function* () { yield failChunk('unknown channel group "' + provider + '"', 'NO_ADAPTER'); })()
                    : streamGroup(cfg, options),
            });
        },
        stream(options) {
            const gid = groupOfRoute(options.provider);
            const cfg = pullConfig().groups.find((g) => g.id === gid);
            if (!cfg) {
                return (async function* () { yield failChunk('unknown channel group "' + options.provider + '"', 'NO_ADAPTER'); })();
            }
            return streamGroup(cfg, options);
        },
    };
    let adapterHandle = null;
    // ---------- 单模型任务：通过 DSH llm.stream 执行 ----------
    async function runModelTest(provider, model, prompt, maxTokens, signal) {
        const llm = ctx.llm;
        // F15（与 measureCandidate 同一模式）：总时限 45s（旧行为每 chunk 重置 guard，
        // 持续输出的请求永不超时而 client 已放弃）+ 超时 abort 上游 + 统一 finally 关闭。
        // 0.3.13：60s → 45s。client 轮询上限约 66s，60s 的 host 预算只留 6s 余量给
        // 「终态写入 + 下一次 describe」，跑满就会撞上假超时（审计 #7）。
        const MODEL_TEST_TOTAL_MS = 45000;
        const controller = new AbortController();
        const cancelled = new Promise((_, reject) => {
            const abort = () => { controller.abort(signal.reason); reject(signal.reason); };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            controller.detach = () => signal?.removeEventListener('abort', abort);
        });
        cancelled.catch(() => {});
        const deadline = Date.now() + MODEL_TEST_TOTAL_MS;
        const inner = llm.stream({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt || '你好' }] }], maxTokens: maxTokens || 512, sessionId: 'mcm-modeltest-' + Date.now(), signal: controller.signal });
        const start = Date.now();
        let ttft = null;
        let text = '';
        let reasoning = '';
        let lastUsage = null;
        let closed = false;
        const closeInner = async () => {
            if (closed)
                return;
            closed = true;
            try {
                const c = inner.return ? inner.return() : null;
                if (c && c.then) {
                    await Promise.race([
                        c,
                        ctx.timeout(ATTEMPT_CLOSE_BUDGET_MS).then(() => { try { controller.abort({ code: 'TIMEOUT', message: 'model test close budget exceeded' }); } catch (_e) { } }, () => { }),
                    ]);
                }
            }
            catch (_e) { }
        };
        try {
            while (true) {
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    throw { code: 'TIMEOUT', message: 'model test timed out after ' + MODEL_TEST_TOTAL_MS + 'ms (total)' };
                const guard = timed(Math.max(1, remaining), () => ({ code: 'TIMEOUT', message: 'model test timed out after ' + MODEL_TEST_TOTAL_MS + 'ms (total)' }));
                let next;
                try {
                    next = await Promise.race([inner.next(), guard.promise, cancelled]);
                }
                catch (raceErr) {
                    if (raceErr && raceErr.code === 'TIMEOUT')
                        try { controller.abort(raceErr); } catch (_e) { }
                    throw raceErr;
                }
                finally {
                    guard.dispose();
                }
                const chunk = next.value;
                if (chunk === undefined)
                    throw { code: 'STREAM_CLOSED', message: 'model test stream ended early' };
                if (ttft === null && isContentChunk(chunk)) {
                    ttft = Date.now() - start;
                }
                if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object')
                    lastUsage = chunk.usage;
                if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                    text = (text + chunk.text).slice(0, 2000);
                }
                else if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                    reasoning = (reasoning + chunk.text).slice(0, 2000);
                }
                if (isTerminalChunk(chunk)) {
                    const reason = chunk.reason || {};
                    if (isSuccessReason(reason)) {
                        // Internal model tests bypass the global interceptor and record exactly once here.
                        recordHealth(provider, { provider, model }, { ok: true, ttftMs: ttft, latencyMs: Date.now() - start, code: null, usage: lastUsage });
                        return { ok: true, ttftMs: ttft, latencyMs: Date.now() - start, text: text.slice(0, 2000), reasoning: reasoning.slice(0, 2000) };
                    }
                    throw { code: (reason.failure && reason.failure.code) || 'STREAM_ERROR', message: (reason.failure && reason.failure.message) || 'model test failed' };
                }
            }
        }
        catch (err) {
            if (!controller.signal.aborted && err?.code !== 'ABORTED')
                recordHealth(provider, { provider, model }, { ok: false, ttftMs: ttft, latencyMs: Date.now() - start, code: err.code || 'STREAM_ERROR', usage: lastUsage });
            throw err;
        }
        finally {
            controller.detach();
            await closeInner();
        }
    }
    function rewireRoutes() {
        const llm = ctx.llm;
        // F16（审计 H08）：normalizeConfig 对非法/重复 ID 是静默 continue——保存 3 组
        // 实际只注册 1 条路由，界面仍显示「已保存」。这里把被丢弃的组大声报出来：
        // 配置里有 N 组但只有 M 组成为路由时，用户能从日志看到哪组、为什么被丢。
        const rawGroups = Array.isArray(state.config && state.config.groups) ? state.config.groups : [];
        const normalized = pullConfig().groups;
        if (rawGroups.length > normalized.length) {
            const keptIds = new Set(normalized.map((g) => g.id));
            const dropped = rawGroups
                .map((g) => g && g.id)
                .filter((id) => typeof id === 'string' && !keptIds.has(id));
            if (dropped.length > 0)
                console.warn('[model-channel-manager] 以下轮询组未通过校验，已被丢弃（不会成为路由）:', dropped.join(', '), '——组 ID 规则：小写字母/数字/连字符，且不重复');
        }
        const next = normalized.map((g) => routeOfGroup(g.id));
        const current = llm.listProviders().map((p) => p.id).filter((id) => id.startsWith(ROUTE_PREFIX));
        if (next.length === 0) {
            // 空配置：LLM 服务拒绝注册零 provider 的适配器——推迟首次注册；已注册则清空路由
            if (adapterHandle !== null)
                adapterHandle.replace(next);
            return;
        }
        if (adapterHandle === null)
            adapterHandle = llm.registerAdapter(next, adapter);
        else if (JSON.stringify(current) !== JSON.stringify(next))
            adapterHandle.replace(next);
    }
    // Configuration changes only rebuild routes; they never reload runtime snapshots.
    const reloadFromConfig = () => {
        state.config = clone(cfgOf());
        const live = pullConfig().groups;
        for (const group of live) groupRuntime(group.id);
        for (const id of runtime.keys()) if (!live.some(group => group.id === id)) runtime.delete(id);
        rewireRoutes();
    };
    const notReady = error => /credential/i.test(String(error?.code || '') + ' ' + String(error?.message || ''));
    restoreRuntime(legacyHealth.runtime || {});
    tasks.restore(Object.entries(legacyHealth.testResults || {}).map(([id, row]) => ({ ...row, id, kind: 'test', fingerprint: 'legacy' })));
    ctx.on('loader/volatile-update', reloadFromConfig);
    reloadFromConfig();

    // No settings service is needed for runtime reads or model tasks.
    {
        const handler = createRpcHandler({
            tasks,
            ready: () => storageReady,
            snapshot: () => ({
                windows: aggregateHealth(state.records), digestAt: Date.now(),
                speedResults: clone(state.speedResults), runtime: persistRuntime(),
                storage: { mode: storageStatus, error: storageError },
                retention: { days: 7, perBucketLimit: 300 },
            }),
            test: (request, signal) => runModelTest(request.provider, request.model, request.prompt, request.maxTokens, signal),
            speed: async (request, signal) => {
                const group = pullConfig().groups.find(group => group.id === request.group);
                if (!group) throw Object.assign(new Error('轮询组不存在，请先保存配置'), { code: 'GROUP_NOT_FOUND' });
                const result = await runSpeedTest(group, signal);
                if (!result.ok) throw Object.assign(new Error(result.deferred ? '凭据尚未就绪，请配置后重试' : '该组正在测速'), { code: result.deferred ? 'MISSING_CREDENTIAL' : 'BUSY' });
                return result;
            },
        });
        ctx.plugin(ChannelController, { handler });
    }

    ctx.inject(['storageDomain'], dctx => {
        const store = new HealthStore(dctx);
        const profile = ctx.get('profileContext');
        const persistent = new RuntimeStore(dctx, (profile?.dir || 'default') + ':' + SELF_NS);
        storageStatus = 'loading';
        storageReady = (async () => {
            await store.open();
            const saved = await persistent.open();
            // Import before deleting Config, including requests retained as an archive only.
            await persistent.archive(clone(legacyHealth));
            await store.migrateFrom(legacyHealth.records || {}, legacyHealth.speedResults || {});
            await store.migrateFrom(state.records, state.speedResults);
            while (pendingEvents.length) {
                const batch = {};
                for (const { key, rec } of pendingEvents.splice(0)) (batch[key] ||= []).push(rec);
                await store.migrateFrom(batch, {});
            }
            if (closed) { await store.close(); await persistent.close(); return; }
            healthStore = store;
            runtimeStore = persistent;
            state.records = clone(store.allEventBuckets());
            state.speedResults = clone(store.allSpeedBuckets());
            if (saved) { restoreRuntime(saved.runtime); tasks.restore(saved.tasks); }
            await saveRuntime();
            storageStatus = 'persistent';
            queueMicrotask(() => cleanupLegacy());
        })().catch(async error => {
            storageStatus = 'memory';
            storageError = '健康数据暂存内存，旧配置保留：' + error.message;
            console.warn('[model-channel-manager]', storageError);
        });
        dctx.effect(() => async () => {
            await storageReady;
            await tasks.close();
            await saveRuntime().catch(error => { storageError = error.message; });
            if (healthStore === store) healthStore = null;
            if (runtimeStore === persistent) runtimeStore = null;
            await store.close();
            await persistent.close();
            if (!closed) { tasks.closed = false; storageStatus = 'memory'; }
        }, 'model-channel persistent stores');
    });
    // This one-time edit uses ConfigEditor because health is intentionally not live-editable.
    ctx.inject(['configEditor'], ectx => {
        const hmr = ctx.get('hmr');
        const cleanup = async () => {
            await storageReady;
            if (closed || storageStatus !== 'persistent' || !Object.keys(legacyHealth).length) return;
            const entry = ectx.configEditor.entries().find(row => row.options.id === SELF_NS);
            if (!entry || !Object.hasOwn(entry.options.config || {}, 'health')) return;
            await ectx.configEditor.edit(entry, raw => {
                if (JSON.stringify(raw.health) !== JSON.stringify(legacyHealth)) throw new Error('旧健康数据在迁移期间发生变化，已保留配置，请重新加载完成迁移');
                const next = { ...raw };
                delete next.health;
                return next;
            });
        };
        const launch = () => { void cleanup().catch(error => { storageError = error.message; console.warn('[model-channel-manager] migration cleanup:', error.message); }); };
        cleanupLegacy = () => {
            if (hmr?.executing?.getStore()) hmr.executing.exit(launch);
            else launch();
        };
        cleanupLegacy();
    });
    ctx.effect(() => async () => {
        closed = true;
        if (runtimeTimer) runtimeTimer();
        await tasks.close();
    }, 'model-channel task shutdown');

    // ---------- 全局 LLM 请求健康拦截 (涵盖所有非虚拟路由的真实渠道模型调用) ----------
    ctx.on('llm/stream', async function* (options, next) {
        if (/^mcm-(modeltest|speedtest)-/.test(options?.sessionId || '')) { yield* next(); return; }
        // 如果 options.provider 是虚拟轮询路由（以 roundrobin/ 开头），则跳过被动采集（避免双计）
        if (options && typeof options.provider === 'string' && options.provider.startsWith(ROUTE_PREFIX)) {
            for await (const chunk of next()) {
                yield chunk;
            }
            return;
        }
        const startTs = Date.now();
        let ttft = null;
        let lastError = null;
        let isSuccess = false;
        let usage = null;
        // 用户主动中止不是渠道故障：AbortError / code ABORTED / signal 已 aborted
        // 三种形态都不进健康流水，否则污染成功率与 smart 键的 reliability 权重
        const isAbortLike = (err) => {
            if (options && options.signal && options.signal.aborted)
                return true;
            if (!err)
                return false;
            if (err.code === 'ABORTED' || err.name === 'AbortError')
                return true;
            return typeof err.message === 'string' && /abort/i.test(err.message);
        };
        try {
            for await (const chunk of next()) {
                // 适配器在 finish 前发 usage 块（done/error 都带）；捕获后随记录写入
                if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object')
                    usage = chunk.usage;
                if (ttft === null && isContentChunk(chunk)) {
                    ttft = Date.now() - startTs;
                }
                if (isTerminalChunk(chunk)) {
                    const reason = chunk.reason || {};
                    if (isSuccessReason(reason)) {
                        isSuccess = true;
                    } else {
                        lastError = (reason.failure && (reason.failure.code || reason.failure.message)) || 'ERROR';
                    }
                }
                yield chunk;
            }
            if (options && options.provider && options.model && lastError !== 'ABORTED') {
                // lastError 'ABORTED' = 终止块 kind aborted（用户中止而非渠道故障），不进健康流水
                const latency = Date.now() - startTs;
                const p = options.provider;
                recordHealth(p, { provider: p, model: options.model }, {
                    ok: isSuccess,
                    ttftMs: isSuccess ? ttft : null,
                    latencyMs: isSuccess ? latency : null,
                    code: isSuccess ? null : (lastError || 'UNKNOWN_TERMINAL'),
                    usage,
                });
            }
        } catch (err) {
            if (options && options.provider && options.model && !isAbortLike(err)) {
                const p = options.provider;
                recordHealth(p, { provider: p, model: options.model }, {
                    ok: false,
                    code: (err && err.code) || (err && err.message) || 'EXCEPTION',
                    usage,
                });
            }
            throw err;
        }
    }, { global: true, prepend: true });

    console.log('[model-channel-manager] ready, groups:', pullConfig().groups.map(group => group.id).join(', ') || '(none)');
}
