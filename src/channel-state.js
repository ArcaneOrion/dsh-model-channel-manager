/** Runtime snapshots and idempotent, cancellable model tasks, independent of Config. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export const CHANNEL = '/api';
export const ENDPOINT = 'modelChannels/invoke';
const remoteInitializers = [];
/** Source-mode Gateway binding keeps the handwritten browser module build-free. */
export class ChannelController extends TypertRemoteService {
  constructor(ctx, { handler }) {
    super(ctx, 'modelChannelController', { namespace: 'modelChannels' });
    this.handler = handler;
    for (const initialize of remoteInitializers) initialize.call(this);
  }
  async invoke(method, payload) {
    const result = await this.handler(method, payload);
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, {});
    return result.value;
  }
}
// Standard Remote decorator semantics, expressed as JavaScript without a compiler.
Remote(ChannelController.prototype.invoke, { kind: 'method', name: 'invoke', static: false, private: false, addInitializer(fn) { remoteInitializers.push(fn); } });
export const WINDOWS = { '30m': 30 * 60000, '24h': 24 * 3600000, '7d': 7 * 24 * 3600000 };
const stateDomain = defineDomain({
  name: 'model_channel_state', version: 1, layout: 'per-record',
  tables: {
    instances: domainTable(z.object({ runtime: z.record(z.string(), z.any()), tasks: z.array(z.any()) })),
    legacy: domainTable(z.object({ health: z.any(), migratedAt: z.number() })),
  },
});

/** A separate domain keeps the existing health-event format and version unchanged. */
export class RuntimeStore {
  constructor(ctx, owner) {
    this.ctx = ctx;
    this.key = createHash('sha256').update(owner).digest('hex');
    this.queue = Promise.resolve();
  }
  async open() {
    this.domain = await this.ctx.storageDomain.open(stateDomain);
    this.table = this.domain.table('instances');
    this.legacy = this.domain.table('legacy');
    return this.table.get(this.key);
  }
  save(value) {
    const snapshot = structuredClone(value);
    const next = this.queue.then(() => this.table.put(this.key, snapshot));
    this.queue = next.catch(() => {}); // Each caller receives its own write error.
    return next;
  }
  async archive(health) {
    if (this.legacy.get(this.key) === undefined)
      await this.legacy.put(this.key, { health, migratedAt: Date.now() });
  }
  async close() {
    await this.queue;
    await this.domain?.close();
  }
}

/** Aggregate retained events by their actual timestamp; no last-active approximation. */
export function aggregateHealth(records, now = Date.now()) {
  return Object.fromEntries(Object.entries(WINDOWS).map(([window, duration]) => {
    const rows = new Map();
    for (const events of Object.values(records)) for (const e of Array.isArray(events) ? events : []) {
      if (!e || typeof e.provider !== 'string' || typeof e.model !== 'string' || typeof e.ok !== 'boolean' || !Number.isFinite(e.ts) || e.ts < now - duration || e.ts > now) continue;
      const key = JSON.stringify([e.provider, e.model]);
      let a = rows.get(key);
      if (!a) {
        a = { provider: e.provider, model: e.model, total: 0, success: 0, ttftSum: 0, ttftCount: 0, latSum: 0, latCount: 0, tokIn: 0, tokOut: 0, tokCache: 0, lastTs: 0, lastOk: null, lastCode: null };
        rows.set(key, a);
      }
      a.total++;
      a.success += Number(e.ok === true);
      if (e.ok && Number.isFinite(e.ttftMs) && e.ttftMs >= 0) { a.ttftSum += e.ttftMs; a.ttftCount++; }
      if (e.ok && Number.isFinite(e.latencyMs) && e.latencyMs >= 0) { a.latSum += e.latencyMs; a.latCount++; }
      const token = n => Number.isFinite(n) && n > 0 ? n : 0;
      a.tokIn += token(e.inputTokens);
      a.tokOut += token(e.outputTokens);
      a.tokCache += token(e.cacheReadTokens) + token(e.cacheWriteTokens);
      if (e.ts >= a.lastTs) { a.lastTs = e.ts; a.lastOk = e.ok; a.lastCode = e.ok ? null : e.code || null; }
    }
    return [window, [...rows.values()].map(({ ttftSum, ttftCount, latSum, latCount, ...a }) => ({
      ...a, ttftCount, latCount,
      ttftAvg: ttftCount ? Math.round(ttftSum / ttftCount) : null,
      latAvg: latCount ? Math.round(latSum / latCount) : null,
    }))];
  }));
}

export const taskId = z.union([z.string().min(1).max(128).regex(/^[\w.-]+$/), z.number().int().positive().safe()]).transform(String);
const identity = z.object({ nonce: taskId });
export const requests = {
  snapshot: z.object({}).strict(),
  task: z.object({ id: taskId }).strict(),
  cancel: z.object({ id: taskId }).strict(),
  test: identity.extend({ provider: z.string().min(1).max(512), model: z.string().min(1).max(512), prompt: z.string().max(16000).default('你好'), maxTokens: z.number().int().min(1).max(8192).default(256) }).strict(),
  speed: identity.extend({ group: z.string().min(1).max(128) }).strict(),
};
const fault = (code, message) => Object.assign(new Error(message), { code });

/** Reserve before execution; duplicate ids never start a second billable request. */
export class TaskRegistry {
  constructor({ persist = async () => {}, limit = 4 } = {}) {
    this.persist = persist;
    this.limit = limit;
    this.tasks = new Map();
    this.running = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }
  restore(rows = []) {
    for (const row of rows) {
      if (!row || typeof row.id !== 'string') continue;
      if (this.running.has(row.id)) continue;
      this.tasks.set(row.id, row.status !== 'running' ? row : row.finishedAt
        ? { ...row, status: row.ok === true ? 'ok' : 'error' }
        : { ...row, status: 'error', code: 'ABORTED', error: '宿主已重启，任务未重放', finishedAt: Date.now() });
    }
  }
  list() { return structuredClone([...this.tasks.values()]); }
  get(id) {
    const row = this.tasks.get(id);
    if (!row) throw fault('TASK_NOT_FOUND', '任务不存在或已超过保留上限，请重新发起测试');
    const { fingerprint, ...publicRow } = row;
    return structuredClone(publicRow);
  }
  submit(kind, request, run) {
    const reserve = async () => {
      if (this.closed) throw fault('UNAVAILABLE', '插件正在停止');
      const id = request.nonce;
      const fingerprint = createHash('sha256').update(JSON.stringify([kind, request])).digest('hex');
      const old = this.tasks.get(id);
      if (old) {
        if (old.fingerprint !== fingerprint) throw fault('TASK_CONFLICT', '该任务编号已用于另一项请求');
        return this.get(id);
      }
      if (this.running.size >= this.limit) throw fault('BUSY', '同时执行的测试过多，请等待已有任务完成');
      if (kind === 'speed' && [...this.tasks.values()].some(t => t.kind === 'speed' && t.group === request.group && t.status === 'running'))
        throw fault('BUSY', '该轮询组正在测速');
      const row = { id, kind, fingerprint, status: 'running', startedAt: Date.now(), ...(kind === 'test' ? { provider: request.provider, model: request.model } : { group: request.group }) };
      this.tasks.set(id, row);
      try { await this.persist(this.list()); }
      catch (error) { this.tasks.delete(id); throw fault('STORAGE_ERROR', '任务未能保存，未发起模型请求：' + error.message); }
      const controller = new AbortController();
      const operation = { controller, done: null };
      this.running.set(id, operation);
      operation.done = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }).then(
        result => ({ status: 'ok', ...result }),
        error => ({ status: 'error', code: controller.signal.aborted ? 'ABORTED' : error.code || 'STREAM_ERROR', error: controller.signal.aborted ? '任务已取消' : String(error.message || error) }),
      ).then(async result => {
        if (controller.signal.aborted) result = { status: 'error', code: 'ABORTED', error: '任务已取消' };
        this.tasks.set(id, { ...row, ...result, finishedAt: Date.now() });
        const finished = [...this.tasks.values()].filter(t => t.status !== 'running').sort((a, b) => b.finishedAt - a.finishedAt);
        for (const expired of finished.slice(100)) this.tasks.delete(expired.id);
        try { await this.persist(this.list()); }
        catch (error) { this.tasks.get(id).persistenceError = '结果仅保留在当前进程：' + error.message; }
      }).finally(() => this.running.delete(id));
      return this.get(id);
    };
    const pending = this.queue.then(reserve);
    this.queue = pending.catch(() => {}); // Failed reservations do not block later independent tasks.
    return pending;
  }
  cancel(id) {
    const task = this.get(id);
    this.running.get(id)?.controller.abort(fault('ABORTED', '任务已取消'));
    return task;
  }
  async close() {
    this.closed = true;
    await this.queue;
    for (const op of this.running.values()) op.controller.abort(fault('ABORTED', '插件已停止'));
    await Promise.allSettled([...this.running.values()].map(op => op.done));
  }
}

/** Connection already owns browser authentication and response framing. */
export function createRpcHandler({ snapshot, tasks, test, speed, ready = Promise.resolve() }) {
  return async (endpoint, payload) => {
    try {
      if (!Object.hasOwn(requests, endpoint)) throw fault('NOT_FOUND', '未知操作');
      const parsed = requests[endpoint].safeParse(payload);
      if (!parsed.success) throw fault('BAD_REQUEST', parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; '));
      await (typeof ready === 'function' ? ready() : ready);
      const req = parsed.data;
      const value = endpoint === 'snapshot' ? snapshot()
        : endpoint === 'task' ? tasks.get(req.id)
        : endpoint === 'cancel' ? tasks.cancel(req.id)
        : await tasks.submit(endpoint, req, signal => endpoint === 'test' ? test(req, signal) : speed(req, signal));
      return { ok: true, value };
    } catch (error) { return { ok: false, error: { code: error.code || 'UNAVAILABLE', message: String(error.message || error) } }; }
  };
}
