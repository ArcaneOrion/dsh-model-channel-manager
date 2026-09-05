import z from "@deepseek-ai/schemastery";
export const name = 'model-channel-manager';
export const inject = ['llm', 'timer'];
const ROUTE_PREFIX = 'roundrobin/';
const GROUP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const NS_CONFIG = 'model-channels';
const NS_HEALTH = 'model-channel-health';
const CONFIG_SCHEMA = z.object({
    groups: z.array(z.object({
        id: z.string(),
    }).loose(true)).default([]),
    // 面板供应商顺序的持久化载体：settings-file 的 patchNode 对 map 键序是盲的
    // （纯重排 = 零 diff），但数组是 deepEqual 不等即整值 setIn（原位、保序）。
    // 顺序存成数组数据而不是对象键序元数据，重启后从文件真实还原。引擎不消费它。
    providerOrder: z.array(z.string()).default([]),
}).loose(true);
const HEALTH_SCHEMA = z.object({
    records: z.dict(z.array(z.any())).default({}),
    speedResults: z.dict(z.array(z.any())).default({}),
    runtime: z.dict(z.any()).default({}),
    speedRequest: z.any(),
    lastHandledNonce: z.number().default(0),
    testRequest: z.any(),
    testResults: z.dict(z.any()).default({}),
    lastTestHandledNonce: z.number().default(0),
    legacyMigrated: z.any(),
}).loose(true);
export function apply(ctx) {
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
    const timed = (ms, makeError) => {
        let rejectFn;
        const promise = new Promise((_, reject) => { rejectFn = reject; });
        const dispose = ctx.effect(() => {
            const timer = setTimeout(() => rejectFn(makeError()), ms);
            return () => clearTimeout(timer);
        }, 'model-channel timeout guard');
        return { promise, dispose };
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
        const list = state.records[key] || (state.records[key] = []);
        list.push({ ts: now, provider: cand.provider, model: cand.model, ok: entry.ok, ttftMs: entry.ttftMs, latencyMs: entry.latencyMs, code: entry.code || null });
        const cutoff = now - 7 * 24 * 3600 * 1000;
        state.records[key] = list.filter((e) => e.ts >= cutoff).slice(-2000);
        persistHealth();
    };
    const persistSpeedResults = async (r) => {
        if (bus === null) return;
        await bus.settings.update(NS_HEALTH, { speedResults: clone(r), runtime: await persistRuntime() });
    };
    // ---------- 健康持久化节流：合并 2s 窗口内的写入，避免每个请求全量重写 settings ----------
    let healthFlushHandle = null;
    let healthDirty = false;
    const flushHealthNow = async () => {
        if (bus === null) return;
        await bus.settings.update(NS_HEALTH, { records: clone(pullRecords()), speedResults: clone(pullSpeedResults()), runtime: await persistRuntime() });
    };
    const persistHealth = () => {
        healthDirty = true;
        if (healthFlushHandle === null) {
            healthFlushHandle = ctx.timeout(() => {
                healthFlushHandle = null;
                if (!healthDirty) return;
                healthDirty = false;
                flushHealthNow().catch(() => { });
            }, 2000);
        }
    };
    ctx.effect(() => () => {
        // 插件卸载时尽力冲刷最后一批健康数据（settings 服务仍在，失败静默）
        if (healthFlushHandle !== null) {
            healthFlushHandle();
            healthFlushHandle = null;
        }
        if (healthDirty) {
            healthDirty = false;
            flushHealthNow().catch(() => { });
        }
    }, 'model-channel health flush');
    // ---------- 引擎：单候选尝试 ----------
    async function* streamAttempt(cfg, cand, options, attemptStart) {
        if (cand.provider.startsWith(ROUTE_PREFIX))
            throw { code: 'INVALID_CANDIDATE', message: 'candidate provider must not be a virtual route' };
        const llm = ctx.llm;
        const inner = llm.stream(Object.assign({}, options, { provider: cand.provider, model: cand.model }));
        const timeoutMs = dynamicTimeoutMs(cfg, candKey(cand));
        let buffer = [];
        let started = false;
        let ttftMs = null;
        let lastAt = Date.now();
        const closeInner = async () => { try {
            const c = inner.return ? inner.return() : null;
            if (c && c.then)
                await c;
        }
        catch (_e) { } };
        try {
            while (true) {
                if (options.signal && options.signal.aborted)
                    throw { code: 'ABORTED', message: 'request aborted' };
                const remaining = Math.max(0, timeoutMs - (Date.now() - (started ? lastAt : attemptStart)));
                if (remaining <= 0)
                    throw { code: 'TIMEOUT', message: 'channel candidate timed out after ' + timeoutMs + 'ms' };
                const guard = timed(Math.max(1, Math.min(remaining, 30000)), () => ({ code: 'TIMEOUT', message: 'channel candidate timed out after ' + timeoutMs + 'ms' }));
                let next;
                try {
                    next = await Promise.race([inner.next(), guard.promise]);
                }
                finally {
                    // 超时路径同样要 dispose：ctx.effect 的注册表条目只有显式调用 disposer 才会移除
                    guard.dispose();
                }
                lastAt = Date.now();
                const chunk = next.value;
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
                            recordHealth(cand.provider, cand, { ok: false, ttftMs: null, latencyMs: null, code: 'EMPTY_RESPONSE' });
                            throw { code: 'EMPTY_RESPONSE', message: 'model returned a completed response with no content' };
                        }
                        const preCode = (reason.failure && reason.failure.code) || 'STREAM_ERROR';
                        recordHealth(cand.provider, cand, { ok: false, ttftMs: null, latencyMs: null, code: preCode });
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
                            recordHealth(cand.provider, cand, { ok: true, ttftMs, latencyMs: Date.now() - attemptStart, code: null });
                            yield chunk;
                            return;
                        }
                        // 内容已向下游输出：绝不能再下发该失败终止块（否则出现 finish 后继续输出/双 finish），
                        // 改为抛错并标记 emitted，由组层直接终结本次请求
                        const midCode = (reason.failure && reason.failure.code) || 'STREAM_ERROR';
                        recordHealth(cand.provider, cand, { ok: false, ttftMs, latencyMs: null, code: midCode });
                        throw { code: midCode, message: (reason.failure && reason.failure.message) || 'candidate stream failed mid-stream' };
                    }
                    yield chunk;
                }
            }
        }
        catch (err) {
            await closeInner();
            if (started && err && typeof err === 'object')
                err.emitted = true;
            if (err && err.code === 'TIMEOUT')
                recordHealth(cand.provider, cand, { ok: false, ttftMs, latencyMs: null, code: 'TIMEOUT' });
            throw err;
        }
    }
    // ---------- 引擎：组级故障转移循环 ----------
    async function* streamGroup(cfg, options) {
        const rt = groupRuntime(cfg.id);
        const order = orderedCandidates(cfg);
        if (order.length === 0) {
            pushEvent(cfg, 'no-candidates', {});
            yield failChunk('channel group "' + cfg.id + '" has no candidates', 'NO_CANDIDATES');
            return;
        }
        const strategy = cfg.strategy || 'sticky';
        let cursor = strategy === 'primary' ? 0 : rt.currentIndex % order.length;
        let fullRounds = 0;
        let lastFail = null;
        const failedKeys = [];
        while (true) {
            if (options.signal && options.signal.aborted) {
                yield abortedChunk('request aborted');
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
                    const attemptStart = Date.now();
                    try {
                        const attempt = streamAttempt(cfg, cand, options, attemptStart);
                        for await (const chunk of attempt)
                            yield chunk;
                        succeeded = true;
                        candidateOk = true;
                        rt.cooldowns.delete(key);
                        const pos = order.findIndex((c) => candKey(c) === key);
                        if (strategy === 'round-robin')
                            rt.currentIndex = (pos + 1) % order.length;
                        else if (strategy === 'sticky')
                            rt.currentIndex = pos;
                        else
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
    async function measureCandidate(cfg, cand, st) {
        const llm = ctx.llm;
        const inner = llm.stream({ provider: cand.provider, model: cand.model, messages: [{ role: 'user', content: [{ type: 'text', text: st.prompt }] }], maxTokens: st.maxTokens });
        const start = Date.now();
        let ttft = null;
        const closeInner = async () => { try {
            const c = inner.return ? inner.return() : null;
            if (c && c.then)
                await c;
        }
        catch (_e) { } };
        try {
            while (true) {
                const guard = timed(Math.max(1, st.timeoutMs), () => ({ code: 'TIMEOUT', message: 'speedtest timed out after ' + st.timeoutMs + 'ms' }));
                let next;
                try {
                    next = await Promise.race([inner.next(), guard.promise]);
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
            await closeInner();
            throw { code: (err && err.code) || 'STREAM_ERROR', message: (err && err.message) || 'speedtest failed' };
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
                    return { provider: cand.provider, model: cand.model, ok: false, ttft: null, latency: null, failure: (lastErr && lastErr.message) || 'speedtest failed' };
                }));
                results.push(...measured);
            }
            const rows = results.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, ttft: r.ttft, latency: r.latency, at: Date.now(), failure: r.failure || null }));
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
        async resolveModel(provider, model) {
            const id = groupOfRoute(provider) || provider;
            const cfg = pullConfig().groups.find((g) => g.id === id);
            if (!cfg)
                return { provider, id: model, name: model };
            const levels = cfg.virtualModel.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : [];
            return {
                provider, id: model, name: cfg.virtualModel.name,
                context: { contextWindow: cfg.virtualModel.contextWindow },
                defaultMaxTokens: cfg.virtualModel.maxTokens,
                inputModalities: cfg.virtualModel.input.slice(),
                reasoning: levels.length > 0 ? { efforts: levels.map((l) => ({ id: l, name: l })), defaultEffort: 'medium' } : undefined,
            };
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
        const inner = llm.stream({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt || '你好' }] }], maxTokens: maxTokens || 512 });
        const start = Date.now();
        let ttft = null;
        let text = '';
        let reasoning = '';
        const closeInner = async () => { try {
            const c = inner.return ? inner.return() : null;
            if (c && c.then)
                await c;
        }
        catch (_e) { } };
        try {
            while (true) {
                const guard = timed(60000, () => ({ code: 'TIMEOUT', message: 'model test timed out after 60000ms' }));
                let next;
                try {
                    next = await Promise.race([inner.next(), guard.promise]);
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
                if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                    text += chunk.text;
                }
                else if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                    reasoning += chunk.text;
                }
                if (isTerminalChunk(chunk)) {
                    const reason = chunk.reason || {};
                    if (isSuccessReason(reason))
                        return { ok: true, ttftMs: ttft, latencyMs: Date.now() - start, text: text.slice(0, 2000), reasoning: reasoning.slice(0, 2000) };
                    throw { code: (reason.failure && reason.failure.code) || 'STREAM_ERROR', message: (reason.failure && reason.failure.message) || 'model test failed' };
                }
            }
        }
        catch (err) {
            await closeInner();
            throw err;
        }
    }
    function handleTestRequest(settings, next) {
        const req = next.testRequest;
        const last = next.lastTestHandledNonce || 0;
        if (!req || typeof req.provider !== 'string' || typeof req.model !== 'string' || typeof req.nonce !== 'number' || req.nonce === last)
            return;
        settings.update(NS_HEALTH, { lastTestHandledNonce: req.nonce }).catch(() => { });
        // 读写都以 healthScope.get()（settings 已提交的最新值）为准，而不是 watcher 同步的 state 快照：
        // 连续两个测试请求时 state 可能滞后，读到旧 testResults 会互相覆盖结果
        const readResults = () => ((bus && bus.healthScope ? bus.healthScope.get().testResults : null) || {});
        const done = async (r) => {
            try {
                const all = Object.assign({}, readResults(), { [req.nonce]: Object.assign({}, r, { nonce: req.nonce, provider: req.provider, model: req.model, finishedAt: Date.now() }) });
                // 只保留最近 50 条测试结果，避免 testResults 无限增长
                const pruned = Object.fromEntries(Object.entries(all).sort((a, b) => ((b[1] && b[1].finishedAt) || 0) - ((a[1] && a[1].finishedAt) || 0)).slice(0, 50));
                await settings.update(NS_HEALTH, { testResults: pruned });
            }
            catch (_e) { }
        };
        const running = Object.assign({}, readResults(), { [req.nonce]: { status: 'running', nonce: req.nonce, provider: req.provider, model: req.model, startedAt: Date.now() } });
        settings.update(NS_HEALTH, { testResults: running }).catch(() => { });
        runModelTest(req.provider, req.model, req.prompt, req.maxTokens).then(async (r) => {
            await done(Object.assign({ status: 'ok' }, r));
        }).catch(async (e) => {
            await done({ status: 'error', code: (e && e.code) || 'STREAM_ERROR', error: (e && e.message) || String(e) });
        });
    }
    function rewireRoutes() {
        const llm = ctx.llm;
        const next = pullConfig().groups.map((g) => routeOfGroup(g.id));
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
    // ---------- settings 总线接入（响应式：settings 服务异步初始化，apply 时查询太早） ----------
    let bus = null;
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        bus = { settings };
        const cfgScope = settings.register(NS_CONFIG, CONFIG_SCHEMA, { base: {} });
        const healthScope = settings.register(NS_HEALTH, HEALTH_SCHEMA, { base: {} });
        bus.cfgScope = cfgScope;
        bus.healthScope = healthScope;
        state.config = clone(cfgScope.get() || { groups: [] });
        state.records = clone(healthScope.get().records || {});
        state.speedResults = clone(healthScope.get().speedResults || {});
        state.testResults = clone(healthScope.get().testResults || {});
        restoreRuntime(healthScope.get().runtime || {});
        cfgScope.watch(() => {
            state.config = clone(cfgScope.get() || { groups: [] });
            const live = pullConfig().groups;
            for (const g of live)
                groupRuntime(g.id);
            // 清理已删除组的运行时残留，避免 runtime 持久化无限累积
            for (const id of Array.from(runtime.keys()))
                if (!live.some((g) => g.id === id))
                    runtime.delete(id);
            rewireRoutes();
            console.log('[model-channel-manager] config hot-reloaded, routes:', pullConfig().groups.map((g) => g.id).join(', ') || '(none)');
        });
        healthScope.watch((next) => {
            state.records = clone(next.records || {});
            state.speedResults = clone(next.speedResults || {});
            state.testResults = clone(next.testResults || {});
            const req = next.speedRequest;
            const last = next.lastHandledNonce || 0;
            if (req && typeof req.group === 'string' && typeof req.nonce === 'number' && req.nonce !== last) {
                settings.update(NS_HEALTH, { lastHandledNonce: req.nonce }).catch(() => { });
                const cfg = pullConfig().groups.find((g) => g.id === req.group);
                if (cfg)
                    runSpeedTest(cfg).catch((e) => console.error('[model-channel-manager] speedtest error:', e));
            }
            handleTestRequest(settings, next);
        });
        boot();
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
        try {
            for await (const chunk of next()) {
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
            if (options && options.provider && options.model) {
                const latency = Date.now() - startTs;
                const p = options.provider;
                recordHealth(p, { provider: p, model: options.model }, {
                    ok: isSuccess,
                    ttftMs: isSuccess ? ttft : null,
                    latencyMs: isSuccess ? latency : null,
                    code: isSuccess ? null : (lastError || 'UNKNOWN_TERMINAL'),
                });
            }
        } catch (err) {
            if (options && options.provider && options.model) {
                const p = options.provider;
                recordHealth(p, { provider: p, model: options.model }, {
                    ok: false,
                    code: (err && err.code) || (err && err.message) || 'EXCEPTION',
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
    // 工作区 .channel-manager/config.json -> settings 命名空间（一次性）。
    // 完成后写 legacyMigrated 哨兵，防止「用户清空全部组 → 重启 → 旧配置复活」；
    // fs/sandboxPolicy 未就绪时短暂重试，而不是静默放弃直到下次重启。
    async function migrateLegacyConfig() {
        const settings = bus && bus.settings;
        if (settings === undefined || pullConfig().groups.length !== 0)
            return;
        if ((bus && bus.healthScope ? bus.healthScope.get().legacyMigrated : false) === true)
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
                    if (migrated.groups.length > 0) {
                        await settings.replace(NS_CONFIG, { groups: migrated.groups });
                        state.config = { groups: migrated.groups };
                        console.log('[model-channel-manager] migrated legacy config from workspace .channel-manager/config.json');
                    }
                }
                catch (_e) { /* 无遗留配置，忽略 */ }
                settings.update(NS_HEALTH, { legacyMigrated: true }).catch(() => { });
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
