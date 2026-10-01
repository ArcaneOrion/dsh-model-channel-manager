import z from "@deepseek-ai/schemastery";
import { HealthStore } from './health-store.js';
export const name = 'model-channel-manager';
export const inject = ['llm', 'timer'];
// storageDomain 由 dsh-base 组合（json 后端，root=storages/）；不进 inject 硬依赖——
// 缺栈的 profile 降级为「健康流水不持久化」而不是拒绝启动。
const ROUTE_PREFIX = 'roundrobin/';
const GROUP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const NS_CONFIG = 'model-channels';
const NS_HEALTH = 'model-channel-health';
// dsh 0.2：settings 不再是可动态注册的命名空间总线，而是「插件行实例配置」的表单投影。
// 因此原先的 model-channels / model-channel-health 两个命名空间合并为本插件的 Config
// （字段 groups / providerOrder / effortMemory / health），命名空间 id 即本行 id。
const HEALTH_SCHEMA = z.object({
    // records/speedResults 仅作旧版存量迁移的读取源（迁入 domain 后不再写入）；
    // 权威数据在 storageDomain 的 model_channel_health 单元。
    records: z.dict(z.array(z.any())).default({}),
    speedResults: z.dict(z.array(z.any())).default({}),
    runtime: z.dict(z.any()).default({}),
    speedRequest: z.any(),
    // nonce 必须容忍 number 与 string 两种历史形态：0.3.2 的 client 写过 UUID 字符串，
    // 而 schema 当时声明 z.number() → 字符串一旦落盘，**整个 health 子树校验失败**，
    // 被 .loose(true) 兜底替换成默认值：records/digest 在运行时全部消失、迁移空转。
    // （0.3.11 线上事故根因；回归见 tests/health-schema-tolerance.test.cjs）
    lastHandledNonce: z.union([z.number(), z.string()]).default(0),
    testRequest: z.any(),
    testResults: z.dict(z.any()).default({}),
    lastTestHandledNonce: z.union([z.number(), z.string()]).default(0),
    legacyMigrated: z.any(),
    healthMigrated: z.any(),
    // 小投影：host 聚合好的健康摘要（client 渲染用），digestAt 为生成时刻
    digest: z.array(z.any()).default([]),
    digestAt: z.number().default(0),
}).loose(true);
export const Config = z.object({
    groups: z.array(z.any()).default([]).volatile(),
    providerOrder: z.array(z.string()).default([]).volatile(),
    effortMemory: z.dict(z.string()).default({}).volatile(),
    health: HEALTH_SCHEMA.volatile(),
}).loose(true);
// ---------- 任务请求的 consume-once 判定（纯函数，便于回归测试） ----------
// nonce 规范化为字符串键：number（现行 client 的随机 53-bit 整数）与 string（0.3.2–0.3.8 的 UUID）
// 都能比较；非法形态返回 null。
export const nonceKey = (v) => (typeof v === 'number' || typeof v === 'string') ? String(v) : null;
// schema 默认值 0 表示「从未处理过」，不能当一个真实 nonce 用
export const settledNonceKey = (v) => {
    const k = nonceKey(v);
    return (k === null || k === '0') ? null : k;
};
/**
 * 是否应当消费这个 nonce（唯一入口，测试与测速共用）。
 * 关键点：只用「严格等值 + 已消费集合」，不做任何数值大小推断——
 * 旧实现用 Math.max(…) 比较数值大小来判等，而 nonce 是随机 53-bit，
 * 「上一轮 > 本轮」时（≈50%）guard 失效，同一请求会在每次 volatile-update
 * 被重新消费（重复上游请求 + 结果条目互相污染）。
 * hasTerminal 为真（finishedAt / status ok|error）时也视为已消费：结果已落地，
 * 重放只会得到重复计费与覆盖。
 */
export function shouldConsumeNonce({ consumed, key, claimed, settled, hasTerminal }) {
    if (key === null || key === undefined) return false;
    if (hasTerminal) return false;
    if (key === claimed || key === settled) return false;
    return !consumed.has(key);
}
/**
 * 启动清扫的分类（纯函数）：新进程里已存在的测试条目分为两类——
 *   aborted  : status=running 且没有 finishedAt = 上次进程遗留的在飞任务（重载打断），
 *              必须补写 ABORTED 终态，否则客户端只会等到 66s 假超时（审计 R3）；
 *   repaired : status=running 但有 finishedAt（终态字段已在）= status 被并发整树回写
 *              改坏的僵尸条目，按 ok 归一状态位（审计 #2 的线上物证形态）。
 */
export function selectStaleTestEntries(testResults) {
    const aborted = [];
    const repaired = [];
    for (const [key, e] of Object.entries(testResults || {})) {
        if (!e || typeof e !== 'object') continue;
        if (e.status !== 'running') continue;
        if (!e.finishedAt) aborted.push(key);
        else if (e.ok === true || e.code || e.error) repaired.push(key);
    }
    return { aborted, repaired };
}
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
    const healthOf = () => refOf('health', null) || {};
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
    const state = { config: { groups: [] }, records: {}, speedResults: {}, testResults: {} };
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
        ctx.effect(() => {
            timer = setTimeout(() => fire(makeError()), ms);
            return () => {
                if (timer !== null) clearTimeout(timer);
                fire({ code: 'ABORTED', message: 'plugin reloaded while this attempt was in flight' });
            };
        }, 'model-channel timeout guard');
        return { promise, dispose: () => { if (timer !== null) clearTimeout(timer); settled = true; } };
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
        if (rt.events.length > 200)
            rt.events.splice(0, rt.events.length - 200);
    }
    // ---------- 持久化：settings 总线 ----------
    const persistRuntime = async () => {
        const out = {};
        for (const [id, rt] of runtime) {
            const now = Date.now();
            out[id] = {
                currentIndex: rt.currentIndex,
                cooldowns: Array.from(rt.cooldowns.entries()).map(([key, until]) => ({ key, until, active: until > now })),
                events: rt.events.slice(-40),
                lastSpeedTestAt: rt.lastSpeedTestAt,
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
        const rec = { ts: now, provider: cand.provider, model: cand.model, ok: entry.ok, ttftMs: entry.ttftMs, latencyMs: entry.latencyMs, code: entry.code || null };
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
            healthStore.appendEvent(key, rec).catch((e) => console.warn('[model-channel-manager] health event append failed:', e && e.message));
        }
        scheduleDigest();
    };
    const persistSpeedResults = async (r) => {
        if (healthStore !== null) {
            await healthStoreSpeed(r).catch(() => { });
        }
        if (bus === null) return;
        await bus.writeHealth({ runtime: await persistRuntime() });
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
    async function measureCandidate(cfg, cand, st) {
        const llm = ctx.llm;
        const controller = new AbortController();
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
                    next = await Promise.race([inner.next(), guard.promise]);
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
            await closeInner();
        }
    }
    async function runSpeedTest(cfg) {
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
                const wave = order.slice(i, i + concurrency);
                if (wave.length === 0)
                    break;
                const measured = await Promise.all(wave.map(async (cand) => {
                    let lastErr = null;
                    for (let t = 0; t <= (st.retries || 0); t++) {
                        try {
                            return await measureCandidate(cfg, cand, st);
                        }
                        catch (err) {
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
    // ---------- 单模型真实请求测试（client 经 settings 总线下发，走 DSH 真实 llm.stream 链路） ----------
    async function runModelTest(provider, model, prompt, maxTokens) {
        const llm = ctx.llm;
        // F15（与 measureCandidate 同一模式）：总时限 45s（旧行为每 chunk 重置 guard，
        // 持续输出的请求永不超时而 client 已放弃）+ 超时 abort 上游 + 统一 finally 关闭。
        // 0.3.13：60s → 45s。client 轮询上限约 66s，60s 的 host 预算只留 6s 余量给
        // 「终态写入 + 下一次 describe」，跑满就会撞上假超时（审计 #7）。
        const MODEL_TEST_TOTAL_MS = 45000;
        const controller = new AbortController();
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
                    next = await Promise.race([inner.next(), guard.promise]);
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
                    text += chunk.text;
                }
                else if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                    reasoning += chunk.text;
                }
                if (isTerminalChunk(chunk)) {
                    const reason = chunk.reason || {};
                    if (isSuccessReason(reason)) {
                        // 命中 finish 就 return，内层流不会被全局拦截器完整排干，成功这一笔要自己补记
                        // （失败那笔由拦截器的 catch 分支记，所以此前只有失败会进健康流水）
                        recordHealth(provider, { provider, model }, { ok: true, ttftMs: ttft, latencyMs: Date.now() - start, code: null, usage: lastUsage });
                        return { ok: true, ttftMs: ttft, latencyMs: Date.now() - start, text: text.slice(0, 2000), reasoning: reasoning.slice(0, 2000) };
                    }
                    throw { code: (reason.failure && reason.failure.code) || 'STREAM_ERROR', message: (reason.failure && reason.failure.message) || 'model test failed' };
                }
            }
        }
        catch (err) {
            throw err;
        }
        finally {
            await closeInner();
        }
    }
    // 启动清扫（审计 R3）：新进程里任何「status running 但没有 finishedAt」的测试条目
    // 必然是上一次进程遗留的（进程内在飞任务都有 fiber 生命周期，重载会打断它们，
    // 旧闭包的收尾写入往往以 "Configuration entry is no longer available" 失败）。
    // 补写 ABORTED 终态，客户端就不必等到 66s 假超时。
    // 同时修复「running + finishedAt」的僵尸条目（status 被并发整树回写改坏），
    // 按 ok 归一状态位。
    const sweepStaleTestResults = () => {
        if (bus === null) return;
        const all = healthOf().testResults || {};
        const { aborted, repaired } = selectStaleTestEntries(all);
        for (const key of aborted) {
            bus.writeHealthLeaf(['testResults', key], Object.assign({}, all[key], {
                status: 'error', code: 'ABORTED',
                error: 'host 在测试执行期间重启/重载，结果未写入；请重试',
                finishedAt: Date.now(),
            })).catch((err) => console.warn('[model-channel-manager] stale test result sweep failed:', err && err.message));
        }
        for (const key of repaired) {
            bus.writeHealthLeaf(['testResults', key], Object.assign({}, all[key], { status: all[key].ok === true ? 'ok' : 'error' }))
                .catch((err) => console.warn('[model-channel-manager] zombie test result repair failed:', err && err.message));
        }
        if (aborted.length > 0 || repaired.length > 0)
            console.log('[model-channel-manager] test results swept after restart: aborted =', aborted.length, ', repaired =', repaired.length);
    };
    // 兜底重试（审计 R2）：testRequest 存在、却既没被认领也没结算 —— 典型是 loader 的
    // volatile 提交被静默拒绝（document 落盘、fiber 引用不更新、不发 volatile-update），
    // 请求会被彻底忽略。这里每个 nonce 主动重试一次并留下日志，不再无声失败。
    const sweepPendingTestRequest = () => {
        if (bus === null) return;
        const health = healthOf();
        const req = health.testRequest;
        const key = nonceKey(req && req.nonce);
        if (key === null) return;
        const entry = (health.testResults || {})[key];
        const hasTerminal = !!(entry && (entry.finishedAt || entry.status === 'ok' || entry.status === 'error'));
        // 复用与消费路径同一个（已被测试覆盖的）判定：返回 true = 这个请求还没被消费
        const needsSweep = shouldConsumeNonce({
            consumed: consumedTestNonces,
            key,
            claimed: nonceKey(claimedTestNonce),
            settled: settledNonceKey(health.lastTestHandledNonce),
            hasTerminal,
        });
        if (!needsSweep || pendingSweepAttempted.has(key)) return;
        markConsumed(pendingSweepAttempted, key);
        console.warn('[model-channel-manager] testRequest nonce', key,
            '既未结算也未消费——疑似 volatile 提交被静默拒绝，主动重试一次（若仍无结果，请看宿主 stdout 的 loader 警告）');
        reloadFromConfig(false);
    };
    function handleTestRequest(next) {
        const req = next.testRequest;
        // nonce 接受 number（现行 client 的随机 53-bit 整数）与 string（0.3.2–0.3.8 的 UUID）
        // 两种历史形态；去重一律按字符串键严格比较，不再做数值大小推断。
        const nonceOf = (v) => (typeof v === 'number' || typeof v === 'string') ? v : null;
        const reqNonce = nonceOf(req && req.nonce);
        const reqKey = nonceKey(reqNonce);
        const claimedKey = nonceKey(claimedTestNonce);
        const settled = settledNonceKey(next.lastTestHandledNonce);
        const entry = reqKey !== null ? (next.testResults || {})[reqKey] : null;
        // 终态判定用 finishedAt（写入后不会被覆盖），不只信 status：
        // 整树快照回写曾把 status 改回 running 却保留 finishedAt/code/error（0.3.11 事故）。
        const hasTerminal = !!(entry && (entry.finishedAt || entry.status === 'ok' || entry.status === 'error'));
        if (!req || typeof req.provider !== 'string' || typeof req.model !== 'string' || reqKey === null) {
            // 字段非法：显式记一次，别再静默吞掉（审计 R2）
            if (req && reqKey !== null && !warnedTestNonces.has(reqKey)) {
                markConsumed(warnedTestNonces, reqKey);
                console.warn('[model-channel-manager] testRequest 字段非法，已忽略（需要 provider/model/nonce）:', JSON.stringify(req).slice(0, 200));
            }
            return;
        }
        if (Date.now() < testBackoffUntil) return; // 退避窗口内不消费（等重放）
        if (!shouldConsumeNonce({ consumed: consumedTestNonces, key: reqKey, claimed: claimedKey, settled, hasTerminal })) {
            // 未消费的显式解释：请求存在但既没被认领、也没终态 → 多半是 volatile 提交被
            // loader 静默拒绝（document 已落盘、fiber 引用不更新、不发 volatile-update，
            // 审计 R2），此时请求会被彻底忽略且没有任何可见报错。
            if (!hasTerminal && reqKey !== claimedKey && !warnedTestNonces.has(reqKey)) {
                markConsumed(warnedTestNonces, reqKey);
                console.warn('[model-channel-manager] testRequest 未被消费: nonce', reqKey,
                    '（已结算或已消费命中）——若本次测试始终没有结果，检查宿主 stdout 是否有 loader 的 "volatile config update failed"');
            }
            return;
        }
        markConsumed(consumedTestNonces, reqKey);
        claimedTestNonce = reqNonce;
        // nonce 的落盘推迟到本次测试得出结论之后：只有「真跑过」才算 handled。
        // 启动早于凭据服务就绪时会以 MISSING_CREDENTIAL 失败，那要释放认领重试；
        // 若提前写了 nonce，重试会被自己的持久值挡掉。
        const settle = (entry) => {
            if (bus !== null)
                bus.writeHealth({ lastTestHandledNonce: reqNonce }).catch((e) => console.error('[model-channel-manager] lastTestHandledNonce 写入失败:', e));
            return setResult(entry);
        };
        // 0.3.12：结果按「单键叶写」落盘（path-ops），不再把整个 testResults 读出来整段写回。
        // 整段写回的 payload 是调用时刻的快照，落盘晚于并发的终态写时会把该 nonce 的
        // status 改回 running（深合并保留 finishedAt/code/error）——线上事故的直接成因。
        // 叶写只动这一个 nonce 的条目，物理上不可能覆盖别人的、也不可能自我回退。
        const setResult = async (entry) => {
            const key = String(reqNonce);
            const value = Object.assign({}, entry, { nonce: reqNonce, provider: req.provider, model: req.model });
            if (bus !== null)
                await bus.writeHealthLeaf(['testResults', key], value).catch((e) => console.error('[model-channel-manager] testResults 写入失败:', e));
        };
        // 修剪低频执行：只在条目数超限时砍到 50。用 unset 叶删（update 的深合并删不掉键）
        const maybePrune = () => {
            const all = healthOf().testResults || {};
            const entries = Object.entries(all);
            if (entries.length <= 50) return;
            const removed = entries
                .sort((a, b) => ((b[1] && b[1].finishedAt) || 0) - ((a[1] && a[1].finishedAt) || 0))
                .slice(50)
                .map(([k]) => k);
            if (removed.length === 0 || bus === null) return;
            bus.writeHealthOps(removed.map((k) => ({ op: 'unset', path: ['health', 'testResults', k] })))
                .catch((e) => console.error('[model-channel-manager] testResults 修剪失败:', e));
        };
        const done = async (r) => {
            try {
                await settle(Object.assign({}, r, { finishedAt: Date.now() }));
                maybePrune();
            }
            catch (_e) { }
        };
        void setResult({ status: 'running', startedAt: Date.now() });
        runModelTest(req.provider, req.model, req.prompt, req.maxTokens).then(async (r) => {
            replayAttempts.delete('test');
            await done(Object.assign({ status: 'ok' }, r));
        }).catch(async (e) => {
            if (notReady(e)) {
                // 凭据服务尚未就绪（典型是启动瞬间的重放）：不写成假 error，释放认领并延后重试
                claimedTestNonce = null;
                releaseConsumed(consumedTestNonces, reqKey); // 释放后才能靠重放再消费
                releaseConsumed(warnedTestNonces, reqKey);
                testBackoffUntil = Date.now() + 5000;       // 退避窗口：期间任何 volatile-update 都不再消费
                scheduleReplay('test', () => reloadFromConfig(false));
                return;
            }
            await done({ status: 'error', code: (e && e.code) || 'STREAM_ERROR', error: (e && e.message) || String(e) });
        });
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
    // ---------- 健康数据 domain 存储 + 存量迁移 + 小投影 ----------
    // healthStore：storageDomain 存在时启用（dsh-base 组合了 json 后端）。
    // 启动序列：先开 domain → 迁移 settings 存量 → reloadFromConfig 从 domain 读权威数据。
    let healthStore = null;
    // digest：写进 settings health 子树的小投影（client 健康页渲染用）。
    // 聚合上移 host，client 不再拉原始流水全量 describe——settings 里不再出现 records。
    let digestTimer = null;
    let lastDigestJson = null;   // 上次落盘的 digest 内容（相同则跳过，减少 revision 噪声）
    let lastDigestWriteAt = 0;
    const DIGEST_INTERVAL = 5000;
    const buildDigest = () => {
        // 与旧 client HealthPanel 聚合口径一致：total/success/ttft/latency/token（计费口径
        // = input + cacheRead + cacheWrite + output），外加 lastTs/lastOk/lastCode
        const by = new Map();
        for (const list of Object.values(state.records)) {
            for (const e of list) {
                const key = e.provider + '::' + e.model;
                let a = by.get(key);
                if (a === undefined) {
                    a = { provider: e.provider, model: e.model, total: 0, success: 0, ttftSum: 0, latSum: 0, tokIn: 0, tokOut: 0, tokCache: 0, lastTs: 0, lastOk: null, lastCode: null };
                    by.set(key, a);
                }
                a.total++;
                const inTok = e.inputTokens || 0;
                const outTok = e.outputTokens || 0;
                const cacheTok = (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0);
                a.tokIn += inTok;
                a.tokOut += outTok;
                a.tokCache += cacheTok;
                if (e.ok) {
                    a.success++;
                    if (e.ttftMs != null && e.ttftMs >= 0) a.ttftSum += e.ttftMs;
                    if (e.latencyMs != null && e.latencyMs >= 0) a.latSum += e.latencyMs;
                }
                if ((e.ts || 0) > a.lastTs) {
                    a.lastTs = e.ts || 0;
                    a.lastOk = e.ok;
                    a.lastCode = e.ok ? null : (e.code || null); // lastCode 随 lastTs 对齐（不再按遍历序覆盖）
                }
            }
        }
        return [...by.values()].map((a) => ({
            provider: a.provider, model: a.model, total: a.total, success: a.success,
            ttftAvg: a.success > 0 ? Math.round(a.ttftSum / a.success) : null,
            latAvg: a.success > 0 ? Math.round(a.latSum / a.success) : null,
            tokIn: a.tokIn, tokOut: a.tokOut, tokCache: a.tokCache,
            lastTs: a.lastTs, lastOk: a.lastOk, lastCode: a.lastCode,
        }));
    };
    const flushDigest = () => {
        digestTimer = null;
        if (bus !== null) {
            const digest = buildDigest();
            // 0.3.14：内容没变就不写。settings 行的 revision 是 raw config 的 JSON 指纹
            // （dsh-settings describe：revision += raw !== previous.raw），每一次无意义的写
            // 都会让 client 手里的 revision 过期，表现为保存时的 settings/conflict。
            // 60s 心跳保证 digestAt 不会永远停住。
            const json = JSON.stringify(digest);
            if (json === lastDigestJson && Date.now() - lastDigestWriteAt < 60000) return;
            lastDigestJson = json;
            lastDigestWriteAt = Date.now();
            bus.writeHealth({ digest, digestAt: Date.now() }).catch(() => { });
        }
    };
    const scheduleDigest = () => {
        if (digestTimer === null) {
            digestTimer = ctx.timeout(flushDigest, DIGEST_INTERVAL);
        }
    };
    ctx.effect(() => () => {
        if (digestTimer !== null) {
            digestTimer();
            digestTimer = null;
        }
        flushDigest();
    }, 'model-channel health digest');
    // settings 存量 records/speedResults → domain 一次性迁移（桶已存在即跳过，domain 权威）。
    // 清空旧键必须走 path-ops：update 是深合并，`records: {}` 清不掉已有键——
    // 0.3.8 用合并写「清空」实际没删，旧流水一直留在 profile 里（每 5s describe 都要带着它）。
    const migrateHealthToDomain = async () => {
        if (healthStore === null || bus === null) return;
        const health = healthOf();
        const alreadyMigrated = health.healthMigrated === true;
        const hasRecords = health.records !== undefined && Object.keys(health.records || {}).length > 0;
        const hasSpeed = health.speedResults !== undefined && Object.keys(health.speedResults || {}).length > 0;
        if (!hasRecords && !hasSpeed) {
            // 无存量：只补哨兵（幂等）
            if (!alreadyMigrated) {
                await bus.writeHealthOps([{ op: 'set', path: ['health', 'healthMigrated'], value: true }])
                    .catch((e) => console.warn('[model-channel-manager] health marker write failed:', e && e.message));
            }
            return;
        }
        // 有存量就必须导入（合并幂等）——不能只看 marker：schema 缺陷期间 marker 可能已被
        // 误写而数据从未导入（0.3.11 线上事故），照 marker 跳过再清理 = 直接删掉旧账。
        let ok = false;
        try {
            ok = await healthStore.migrateFrom(health.records || {}, health.speedResults || {});
        }
        catch (e) {
            console.warn('[model-channel-manager] legacy health import failed (will retry next boot):', e && e.message);
            return;
        }
        if (!ok) return; // store 已关闭（卸载竞态）：不清理，避免标记与数据永久不一致
        // 导入成功才真删除旧键（path-ops；update 的深合并清不掉）+ 落哨兵
        const ops = [];
        if (hasRecords) ops.push({ op: 'unset', path: ['health', 'records'] });
        if (hasSpeed) ops.push({ op: 'unset', path: ['health', 'speedResults'] });
        if (!alreadyMigrated) ops.push({ op: 'set', path: ['health', 'healthMigrated'], value: true });
        if (ops.length === 0) return;
        await bus.writeHealthOps(ops).catch((e) => console.warn('[model-channel-manager] legacy health cleanup failed:', e && e.message));
        console.log('[model-channel-manager] legacy health imported into domain and cleared from settings');
    };

    // ---------- settings 总线接入（响应式：settings 服务异步初始化，apply 时查询太早） ----------
    let bus = null;
    let runtimeRestored = false;
    // 非持久去重：回写要等当前 HMR 事务结束才落盘，这中间 volatile-update 可能带着同一个 nonce 再来，
    // 内存里先认领，避免同一请求被重复执行（并顺带消掉重复的回写风暴）。
    //
    // 0.3.12：改为严格 consume-once（字符串键集合），不再依赖 nonce 的数值单调性。
    // 旧实现 last = Math.max(上一轮结算值, 本次认领值)，而两个 nonce 都是随机 53-bit：
    // 「上一轮 > 本轮」时判等直接失效（≈50%），于是测试在每次 loader/volatile-update
    // （包括宿主自己每 5s 的 digest 回写）都被重新消费——重复上游请求（真实计费）
    // 且结果条目互相污染。线上物证：同 nonce 一条记录同时带
    // `code TIMEOUT / 60000ms` 与 `ok:true / text`（单次执行不可能）。
    // 回归见 tests/task-dedup.test.cjs。
    let claimedTestNonce = null; // string UUID 或旧数字；null = 未认领
    let claimedSpeedNonce = null; // string UUID 或旧数字；null = 未认领
    let lastHealthKeyCount = -1;  // health 子树键数（用于探测「被兜底清空」，审计 R2/#4）
    const consumedTestNonces = new Set();  // 已消费过的 nonce 字符串键（含本次）
    const consumedSpeedNonces = new Set();
    const warnedTestNonces = new Set();    // 每个 nonce 只提醒一次（防日志刷屏）
    const pendingSweepAttempted = new Set(); // 兜底重试每个 nonce 只做一次
    const CONSUMED_NONCE_CAP = 256; // 上限：只用于防重复消费，不需要无限历史
    // notReady（凭据服务未就绪）释放认领后的退避窗口：期间不再消费，等 scheduleReplay 到点。
    // 否则释放后任何一次 volatile-update 都会立刻再消费，并发起多个 60s 上游请求（审计 #6）。
    let testBackoffUntil = 0;
    let speedBackoffUntil = 0;
    const markConsumed = (set, key) => {
        set.add(key);
        if (set.size > CONSUMED_NONCE_CAP) {
            const oldest = set.values().next().value;
            set.delete(oldest);
        }
    };
    const releaseConsumed = (set, key) => { if (key !== null) set.delete(key); };
    // 启动早于凭据服务就绪：此时重放测试/测速会以 MISSING_CREDENTIAL 失败。
    // 这类错误是「环境还没准备好」而不是「渠道故障」，必须释放认领、延后重试，不能写成假 error。
    const notReady = (e) => {
        const code = (e && e.code) || '';
        const msg = String((e && (e.message || e.error)) || '');
        return code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL' || /no credential|credential .*not set|is not set — store/i.test(msg);
    };
    const replayAttempts = new Map();
    const scheduleReplay = (key, fn, ms = 5000) => {
        const n = (replayAttempts.get(key) || 0) + 1;
        if (n > 24)
            return;
        replayAttempts.set(key, n);
        ctx.timeout(() => { fn(); }, ms);
    };
    // 从实例配置读取全部状态；volatile 提交后由 loader/volatile-update 触发重载。
    // 0.3.1 起 records/speedResults 的权威在 storageDomain（healthStore）；
    // settings health 子树只承载小投影（digest 给 client 渲染）+ 运行态 + 任务哨，
    // volatile 快照覆盖不再能抹掉任何流水（F11/F23 的根因消除）。
    function reloadFromConfig(initial) {
        const cfg = cfgOf();
        state.config = clone(cfg) || { groups: [] };
        const health = healthOf();
        // 意外清空告警（审计 R2/#4）：health 子树本来有内容，运行时却变成空对象 =
        // schema 校验失败被 .loose(true) 兜底（0.3.11 事故形态），必须大声报出来。
        const healthKeys = Object.keys(health || {}).length;
        if (healthKeys === 0 && lastHealthKeyCount > 0) {
            console.warn('[model-channel-manager] health 子树在运行时变空（上一轮有 ' + lastHealthKeyCount + ' 个键）——极可能是 schema 校验失败被 .loose(true) 静默兜底，请检查最近一次写入的字段类型');
        }
        lastHealthKeyCount = healthKeys;
        state.records = healthStore !== null
            ? clone(healthStore.allEventBuckets())
            : clone(health.records || {});
        state.speedResults = healthStore !== null
            ? clone(healthStore.allSpeedBuckets())
            : clone(health.speedResults || {});
        state.testResults = clone(health.testResults || {});
        if (initial && !runtimeRestored) {
            restoreRuntime(health.runtime || {});
            runtimeRestored = true;
        }
        const live = pullConfig().groups;
        for (const g of live)
            groupRuntime(g.id);
        // 清理已删除组的运行时残留，避免 runtime 持久化无限累积
        for (const id of Array.from(runtime.keys()))
            if (!live.some((g) => g.id === id))
                runtime.delete(id);
        rewireRoutes();
        const req = health.speedRequest;
        // 与 handleTestRequest 同一策略：nonce 兼容字符串/数字，去重按字符串键严格等值
        const speedKey = nonceKey(req && req.nonce);
        const speedClaimed = nonceKey(claimedSpeedNonce);
        const speedSettled = settledNonceKey(health.lastHandledNonce);
        if (req && typeof req.group === 'string' && Date.now() < speedBackoffUntil) return;
        if (req && typeof req.group === 'string'
            && shouldConsumeNonce({ consumed: consumedSpeedNonces, key: speedKey, claimed: speedClaimed, settled: speedSettled, hasTerminal: false })) {
            markConsumed(consumedSpeedNonces, speedKey);
            claimedSpeedNonce = req.nonce;
            const cfgRow = pullConfig().groups.find((g) => g.id === req.group);
            // nonce 落盘推迟到本次测速得出结论之后（同 handleTestRequest 的理由）：
            // 提前写会把「没就绪」的重试用自己的持久值挡掉。
            const settleSpeed = () => {
                if (bus !== null)
                    bus.writeHealth({ lastHandledNonce: req.nonce }).catch(() => { });
            };
            if (cfgRow)
                runSpeedTest(cfgRow).then((r) => {
                    if (r && r.deferred) {
                        claimedSpeedNonce = null;
                        releaseConsumed(consumedSpeedNonces, speedKey);
                        speedBackoffUntil = Date.now() + 5000; // 退避：别让 volatile-update 立刻再消费
                        scheduleReplay('speed', () => reloadFromConfig(false));
                        return;
                    }
                    replayAttempts.delete('speed');
                    settleSpeed();
                }).catch((e) => {
                    if (notReady(e)) {
                        claimedSpeedNonce = null;
                        releaseConsumed(consumedSpeedNonces, speedKey);
                        speedBackoffUntil = Date.now() + 5000; // 退避：同上
                        scheduleReplay('speed', () => reloadFromConfig(false));
                        return;
                    }
                    settleSpeed();
                    console.error('[model-channel-manager] speedtest error:', e);
                });
            else
                settleSpeed();
        }
        handleTestRequest(health);
    }
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        // 0.2 只暴露「按行 id 定位的实例配置」；健康字段是同一 Config 里的 health 子树，
        // 写入为整字段合并写（旧的 path-ops mutate 在 0.2 不存在）。
        // 0.2 的配置写入走 configEditor.edit() → hmr.runExclusive()，而 runExclusive 一旦发现已在
        // 事务内就直接拒绝（"HMR transactions cannot be nested"）。loader/volatile-update 回调本身
        // 就运行在该事务里，所以回写必须先切出事务上下文：事务内创建的异步资源（AsyncResource、
        // setTimeout）都会继承事务上下文，只有 AsyncLocalStorage.exit() 能干净地切出去，
        // 写入再由 runExclusive 排进队列、在本次事务结束后执行。
        const outsideTransaction = (fn) => {
            const hmr = ctx.get('hmr');
            const als = hmr && hmr.executing;
            if (als && typeof als.exit === 'function' && als.getStore()) return als.exit(fn);
            return fn();
        };
        // 0.2 是「整字段落盘」，并发调用会各自基于同一份旧快照做 read-modify-write，
        // 后写的直接覆盖先写的（实测 lastTestHandledNonce 与 records 就这样丢过）。
        // 所以写入串行化：排队后逐个重新读当前值再合并，不让两次写入互相覆写。
        let healthWrites = Promise.resolve();
        const enqueueHealthWrite = (run) => {
            const queued = healthWrites.then(run, run);
            healthWrites = queued.catch(() => { });
            return queued;
        };
        // 0.2 的 health 子树写入曾用「整树读-改-写」（cur = healthOf(); update({health:{...cur, patch}})）。
        // 只要内存视图落后于已提交的行（volatile 提交与事件之间有窗口），旧快照就会把新值写回去：
        // 线上物证是终态写入后 status 又被改回 running（同一 nonce 同时有 finishedAt/error 与 running）。
        // 0.3.12 起一律「叶写」：patch 里出现的每个顶层键单独 set，不再回灌未见过的值。
        // 需要只动某个子键时用 writeHealthLeaf（如 testResults.<nonce>）。
        const writeHealth = (patch) => enqueueHealthWrite(async () => {
            const ops = Object.keys(patch || {}).map((k) => ({ op: 'set', path: ['health', k], value: patch[k] }));
            if (ops.length === 0) return;
            return outsideTransaction(() => settings.mutate(SELF_NS, ops, undefined));
        });
        // path-ops 写入：update 是深合并，空对象清不掉旧键；需要真删除时走 mutate。
        const writeHealthOps = (ops) => enqueueHealthWrite(async () => outsideTransaction(() => settings.mutate(SELF_NS, ops, undefined)));
        // 单叶写入：把 value 精确写到 health.<path...>，不读、不带任何快照
        const writeHealthLeaf = (path, value) => enqueueHealthWrite(async () => outsideTransaction(() => settings.mutate(SELF_NS, [{ op: 'set', path: ['health', ...path], value }], undefined)));
        // 行级配置写入（groups 等）：也必须切出 HMR 事务——migrateLegacyConfig 可能在
        // loader 回调链里被调用，事务内直写会抛 "HMR transactions cannot be nested"
        // 并被空 catch 吞掉，只剩哨兵、旧配置永久不迁（审计 #13）。
        const writeConfig = (patch) => enqueueHealthWrite(async () => outsideTransaction(() => settings.update(SELF_NS, patch, undefined)));
        bus = {
            settings,
            writeHealth,
            writeHealthOps,
            writeHealthLeaf,
            writeConfig,
            cfgScope: { get: () => cfgOf() },
            healthScope: { get: () => healthOf() },
        };
        // 卸载竞态防护：异步链回到插件时先确认 fiber 仍存活（uid 被清除即已卸载）。
        const fiberUid = ctx.fiber && ctx.fiber.uid;
        const fiberAlive = () => ctx.fiber !== undefined && ctx.fiber.uid !== undefined && ctx.fiber.uid === fiberUid;
        // 启动不等待 domain：先用现有 settings 数据把路由与健康页带起来（旧 records 尚在
        // settings 时也能立即显示）；domain 就绪后再以它为权威重载。
        // 清扫必须在首次消费 testRequest 之前：新进程里已存在的 running 条目都是上次遗留的。
        sweepStaleTestResults();
        reloadFromConfig(true);
        ctx.on('loader/volatile-update', () => {
            reloadFromConfig(false);
            console.log('[model-channel-manager] config hot-reloaded, routes:', pullConfig().groups.map((g) => g.id).join(', ') || '(none)');
        });
        boot();
        scheduleDigest(); // 首屏投影：让健康页不用等下一次真实请求
        // 未消费请求的兜底轮询（审计 R2）：每 5s 看一眼 testRequest 是否被静默丢弃
        ctx.effect(() => {
            const timer = setInterval(() => { try { sweepPendingTestRequest(); } catch (_e) { } }, 5000);
            return () => clearInterval(timer);
        }, 'model-channel pending-request sweep');
        // storageDomain 是可选服务，必须经响应式 inject 取得「已声明依赖」的上下文：
        // 直接 ctx.get('storageDomain') 只能拿到未注入的裸服务，随后任何属性访问都会被
        // Cordis 代理拒绝（实测 "cannot get property storageDomain without inject"，
        // domain 永远打不开、健康流水静默降级为内存）。inject 回调在服务可用时触发；
        // profile 没有 storage 栈时它不触发，插件保持内存模式，路由与面板不受影响。
        ctx.inject(['storageDomain'], (dctx) => {
            const store = new HealthStore(dctx);
            Promise.resolve()
                .then(() => store.open())
                .then(() => {
                    if (!fiberAlive()) {
                        void store.close().catch(() => { }); // 已卸载：由 facility closeAll 兜底回收
                        return;
                    }
                    healthStore = store;
                    ctx.effect(() => () => { void store.close(); }, 'model-channel health domain close');
                    console.log('[model-channel-manager] health domain ready: model_channel_health');
                })
                .catch((e) => {
                    console.warn('[model-channel-manager] storageDomain open failed, health records stay in-memory only:', e && e.message);
                })
                .then(() => (healthStore !== null ? migrateHealthToDomain().catch(() => { }) : null))
                .then(() => {
                    if (!fiberAlive()) return;
                    reloadFromConfig(true); // domain 权威数据覆盖内存镜像
                    scheduleDigest();       // 立刻把投影刷新到 settings（健康页首屏可读）
                })
                .catch(() => { }); // 卸载竞态下 reload 内部可能 throw，链尾兜底防 unhandled rejection
        });
    });
    // ---------- 全局 LLM 请求健康拦截 (涵盖所有非虚拟路由的真实渠道模型调用) ----------
    ctx.on('llm/stream', async function* (options, next) {
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

    // ---------- 启动 ----------
    async function boot() {
        // 动态原型迁移异步进行，不阻塞路由注册（迁移落盘后 cfg watcher 会热重建路由）
        void migrateLegacyConfig();
        rewireRoutes();
        for (const g of pullConfig().groups) {
            if (g.speedTest.enabled && g.speedTest.onFirstUse) {
                const rt = groupRuntime(g.id);
                if ((state.speedResults[g.id] || []).length === 0)
                    runSpeedTest(g).catch(() => { });
            }
        }
        console.log('[model-channel-manager] booted, groups:', pullConfig().groups.map((g) => g.id).join(', ') || '(none)');
    }
    // 工作区 .channel-manager/config.json -> 本行实例配置（一次性）。
    // 完成后写 legacyMigrated 哨兵，防止「用户清空全部组 → 重启 → 旧配置复活」；
    // fs/sandboxPolicy 未就绪时短暂重试，而不是静默放弃直到下次重启。
    async function migrateLegacyConfig() {
        if (bus === null || pullConfig().groups.length !== 0)
            return;
        if (healthOf().legacyMigrated === true)
            return;
        for (let attempt = 0; attempt < 6; attempt++) {
            const fsSvc = ctx.get('fs');
            const sp = ctx.get('sandboxPolicy');
            const root = sp ? sp.workspaceRoot : null;
            if (fsSvc !== undefined && root) {
                try {
                    const target = await fsSvc.resolve(root + '/.channel-manager/config.json');
                    const text = await fsSvc.readText(target);
                    const legacy = JSON.parse(text);
                    const migrated = normalizeConfig(legacy);
                    // F10（审计 H15）：读取是 await 的——这个窗口里用户可能已经保存了
                    // 新组。写前重检：现在有组了就不迁（用户的新配置优先于旧文件复活）。
                    if (pullConfig().groups.length !== 0) {
                        console.log('[model-channel-manager] legacy migration skipped: user config arrived during read');
                        bus.writeHealth({ legacyMigrated: true }).catch(() => { });
                        return;
                    }
                    if (migrated.groups.length > 0) {
                        await bus.writeConfig({ groups: migrated.groups });
                        state.config = { groups: migrated.groups };
                        console.log('[model-channel-manager] migrated legacy config from workspace .channel-manager/config.json');
                    }
                }
                catch (_e) { /* 无遗留配置，忽略 */ }
                bus.writeHealth({ legacyMigrated: true }).catch(() => { });
                return;
            }
            try {
                await ctx.timeout(5000);
            }
            catch (_e) {
                return; // 插件已卸载，停止重试
            }
        }
    }
}
