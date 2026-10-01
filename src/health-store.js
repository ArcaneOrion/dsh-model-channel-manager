/** Retained health events and speed results in the existing per-record storage domain.
 * Runtime snapshots and task results live in channel-state.js; neither uses Config.
 */
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

const WINDOW_MS = 7 * 24 * 3600 * 1000;
// 每渠道保留上限：30m/24h 视图 + selector 置顶绰绰有余，同时控制 storages/ 目录体量
const PER_KEY_LIMIT = 300;

/** 单条健康事件记录（zod，domain 落盘边界校验）。向后兼容：token 字段可选。 */
const eventRecord = z.object({
  id: z.string().optional(),
  ts: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  ok: z.boolean(),
  ttftMs: z.number().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
  code: z.string().nullable().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
});

/** 单渠道的事件桶记录：key = provider（与旧 state.records 的键一致，迁移零转换）。 */
const bucketRecord = z.object({
  events: z.array(eventRecord),
});

/** 测速结果桶：key = 组 id（与旧 state.speedResults 的键一致）。 */
const speedRecord = z.object({
  rows: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    ok: z.boolean(),
    ttft: z.number().nullable(),
    latency: z.number().nullable(),
    at: z.number(),
    failure: z.string().nullable().optional(),
  })),
});

const healthDomainSpec = defineDomain({
  name: 'model_channel_health',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    events: domainTable(bucketRecord),
    speed: domainTable(speedRecord),
  },
});

/**
 * 事件去重键：同一笔在 settings 与 domain 之间合并时不重复计。
 * 0.3.13（审计 #10）：旧键只有 `ts|provider|model`，同一毫秒同渠道的两笔真实请求
 * 会被当成同一笔合并掉。把判定性字段一起纳入指纹——同毫秒 + 同渠道 + 同结果形态
 * 的两笔在语义上本就不可区分；真正不同的两笔（成功率/延迟/token 不同）不会再被吞。
 */
const eventKey = (e) => e.id || [
  e.ts, e.provider, e.model, e.ok ? 1 : 0, e.code || '',
  e.ttftMs ?? '', e.latencyMs ?? '',
  e.inputTokens ?? '', e.outputTokens ?? '', e.cacheReadTokens ?? '', e.cacheWriteTokens ?? '',
].join('|');

/**
 * HealthStore：封装 domain 读写 + 保留策略 + 聚合。
 * 非 Service（宿主插件自有生命周期），由 apply() 创建并 effect 持有 close。
 */
export class HealthStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = null; // Promise<Domain>
    this.events = null; // KvTable
    this.speed = null; // KvTable
    this.eventChain = Promise.resolve(); // 类内写链：appendEvent 串行化（并发不丢更新）
  }

  /** 打开 domain（幂等）。dsh-base 未装 storage 栈的 profile 会 reject——调用方降级。 */
  open() {
    if (this.ready === null) {
      this.ready = this.ctx.storageDomain.open(healthDomainSpec).then((domain) => {
        this.events = domain.table('events');
        this.speed = domain.table('speed');
        return domain;
      });
    }
    return this.ready;
  }

  /** effect 用：domain 关闭（写入队列排干后释放）。 */
  async close() {
    if (this.ready === null) return;
    // 0.3.13（审计 #10）：先排干类内写链再关 domain——旧实现直接 close，
    // 排队中的 append/迁移写入可能在 domain 关闭后才执行（丢最后一笔）。
    await this.eventChain.catch(() => {});
    const domain = await this.ready.catch(() => null);
    this.ready = null;
    this.events = null;
    this.speed = null;
    if (domain) await domain.close().catch(() => {});
  }

  /** 把一次事件表写入排入类内写链：并发调用逐个重读当前值，不交错、不互相覆盖。
   * 返回本次写入的真实结果（失败会 reject，调用方可记录/重试）；链本身用吞错版本续接。
   */
  enqueueEvent(run) {
    const result = this.eventChain.then(run, run);
    this.eventChain = result.catch(() => { });
    return result;
  }

  /** 追加一条事件到渠道桶，同时执行窗口过期 + 条数截断。
   * 桶不存在时先 put 初始化（KvTable.update 对缺失键报 missing-key）。
   */
  appendEvent(provider, rec) {
    if (this.events === null) return Promise.resolve();
    return this.enqueueEvent(async () => {
      rec = eventRecord.parse(rec);
      const cutoff = Date.now() - WINDOW_MS;
      const cur = this.events.get(provider);
      if (cur === undefined) {
        await this.events.put(provider, { events: [rec] });
        return;
      }
      await this.events.update(provider, (c) => ({
        events: [...c.events.filter((e) => e.ts >= cutoff), rec].slice(-PER_KEY_LIMIT),
      }));
    });
  }

  /** 整组测速结果替换写入。0.3.13（审计 #10）：也排入同一条写链，
   * 避免与迁移/追加写入交错（快照语义下后写者胜，交错会写出半新半旧的桶）。 */
  async putSpeedRows(groupId, rows) {
    if (this.speed === null) return;
    const record = speedRecord.parse({ rows });
    await this.enqueueEvent(async () => {
      if (this.speed === null) return;
      await this.speed.put(groupId, record);
    });
  }

  /** 读全部事件桶（迁移/聚合用）。 */
  allEventBuckets() {
    const out = {};
    if (this.events === null) return out;
    for (const [provider, bucket] of this.events.entries()) out[provider] = bucket.events;
    return out;
  }

  /** 读全部测速桶。 */
  allSpeedBuckets() {
    const out = {};
    if (this.speed === null) return out;
    for (const [groupId, bucket] of this.speed.entries()) out[groupId] = bucket.rows;
    return out;
  }

  /**
   * 存量迁移：把 settings health 子树的 records/speedResults 并入 domain。
   *
   * 与早期实现的关键差别：**桶已存在时合并去重，而不是整桶跳过**。
   * 原因是 0.3.11 修掉的 schema 缺陷（nonce 类型漂移 → health 整树被宽松兜底
   * 清空）期间，迁移标记可能已被误写、而 settings 里的旧流水从未真正导入；
   * 此时若沿用「桶已存在即跳过」再清理 settings，旧账会被直接删除。
   * 合并保证不丢数据，且幂等（同 ts+provider+model 视为同一笔）。
   * 测速结果是「最新快照」语义，仍以 domain 已有行为准。
   */
  async migrateFrom(records, speedResults) {
    if (this.events === null) return false;
    const cutoff = Date.now() - WINDOW_MS;
    for (const [provider, list] of Object.entries(records || {})) {
      const incoming = (Array.isArray(list) ? list : [])
        .filter((e) => e && Number.isFinite(e.ts) && e.ts >= cutoff)
        .map(e => eventRecord.parse(e));
      if (incoming.length === 0) continue;
      await this.enqueueEvent(async () => {
        const existing = (this.events.get(provider) || {}).events || [];
        const seen = new Set(existing.map(eventKey));
        const merged = existing.slice();
        for (const e of incoming) {
          const k = eventKey(e);
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(e);
        }
        merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        await this.events.put(provider, { events: merged.slice(-PER_KEY_LIMIT) });
      });
    }
    for (const [groupId, rows] of Object.entries(speedResults || {})) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const record = speedRecord.parse({ rows });
      await this.enqueueEvent(async () => {
        if (this.speed === null) return;
        if (this.speed.get(groupId) !== undefined) return; // domain 已有该组结果：以 domain 为准
        await this.speed.put(groupId, record);
      });
    }
    return true;
  }
}
