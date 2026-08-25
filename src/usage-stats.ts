// Currency-aware model cost statistics: incrementally scan Claude Code JSONL
// transcripts once, keep independent per-model buckets, and persist byte offsets.
// Pricing and model normalization live in model-pricing.ts; this module owns only
// transcript scanning, stream-fragment deduplication, time scopes, and state IO.
// Different currencies are never added together. Rendering selects one current
// model from the per-model scopes.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeConfigDir } from './claude-config-dir.js';
import {
  PRICING_CATALOG_VERSION,
  beijingDate,
  calculateModelUsageCost,
  resolveModelPricing,
  sessionOfFile,
  splitUsageTokens,
  yesterdayOf,
  type ModelPricing,
  type TokenSplit,
} from './model-pricing.js';

const STATE_VERSION = 4;

/** Legacy same-currency aggregate retained for callers/tests; null means mixed currencies. */
export interface CostBucket {
  miss: number;
  hit: number;
  out: number;
  costPeak: number;
  costOff: number;
}

export interface ModelUsageBucket extends TokenSplit {
  amount: number;
  costPeak: number;
  costOff: number;
}

interface ScopeState {
  perModel: Record<string, ModelUsageBucket>;
}

interface MsgState extends ModelUsageBucket {
  date: string;
  month: string;
  session: string | null;
  model: string;
}

interface UsageStateFile {
  stateV: number;
  month: string;
  date: string;
  pricingCatalogVersion: string;
  sessionId: string | null;
  dayTotals: Record<string, ScopeState>;
  monthTotal: ScopeState;
  sessionTotals: ScopeState;
  files: Record<string, number>;
  msgs: Record<string, MsgState>;
}

export interface UsageStatsOptions {
  /** 当前会话 id（stdin.session_id）；null 时不统计会话层 */
  sessionId?: string | null;
  /** 转录根目录；默认 <claude 配置目录>/projects */
  projectsRoot?: string;
  /** 状态文件路径；默认 <claude 配置目录>/scripts/.usage-state.json（目录自动创建） */
  stateFile?: string;
  /** 当前 UTC ISO 时间（测试注入；默认取系统时间） */
  now?: string;
}

export interface UsageStatsResult {
  today: CostBucket | null;
  yesterday: CostBucket | null;
  month: CostBucket | null;
  session: CostBucket | null;
  todayPerModel: Record<string, ModelUsageBucket>;
  yesterdayPerModel: Record<string, ModelUsageBucket>;
  monthPerModel: Record<string, ModelUsageBucket>;
  sessionPerModel: Record<string, ModelUsageBucket>;
  /** 当前会话在"今天之前"的累计（按模型拆分）——会话跨天时供渲染层标注 */
  sessionPriorPerModel: Record<string, ModelUsageBucket>;
  /** 当前会话在"日历昨天"的累计（按模型拆分）——与 prior 对比判断是否只跨一天 */
  sessionYesterdayPerModel: Record<string, ModelUsageBucket>;
  sessionId: string | null;
}

export interface SelectedModelUsageStats {
  model: ModelPricing;
  today: ModelUsageBucket;
  yesterday: ModelUsageBucket;
  month: ModelUsageBucket;
  session: ModelUsageBucket;
  sessionPrior: ModelUsageBucket;
  sessionYesterday: ModelUsageBucket;
  sessionId: string | null;
}

/** Claude 配置目录（复用 HUD 全局口径：CLAUDE_CONFIG_DIR 支持 ~ 前缀展开并做路径规范化） */
function defaultConfigDir(): string {
  return getClaudeConfigDir(os.homedir());
}

function zeroModelBucket(): ModelUsageBucket {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, amount: 0, costPeak: 0, costOff: 0 };
}

function zeroScope(): ScopeState {
  return { perModel: {} };
}

function zeroLegacyBucket(): CostBucket {
  return { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0 };
}

function freshState(month: string, date: string, sessionId: string | null): UsageStateFile {
  return {
    stateV: STATE_VERSION,
    month,
    date,
    pricingCatalogVersion: PRICING_CATALOG_VERSION,
    sessionId,
    dayTotals: {},
    monthTotal: zeroScope(),
    sessionTotals: zeroScope(),
    files: {},
    msgs: {},
  };
}

/**
 * 整体重建（偏移置空、全量重读本月转录），并按需把"日历昨天"的桶搬运进新状态：
 * 回放只重读本月记录，昨天在上月时（月初 1 号）回放读不到、必须靠搬运保留；
 * 昨天在本月时不搬运——回放会自然重建（搬运反而会与回放重复累计）。
 */
function rebuildCarryingYesterday(
  s: Partial<UsageStateFile>,
  month: string,
  today: string,
  sessionId: string | null,
): UsageStateFile {
  const fresh = freshState(month, today, sessionId);
  const yesterdayKey = yesterdayOf(today);
  if (yesterdayKey.slice(0, 7) !== month) {
    const carried = s.dayTotals?.[yesterdayKey];
    if (carried) fresh.dayTotals[yesterdayKey] = carried;
  }
  return fresh;
}

/**
 * 加载状态：
 * - 同月内跨天：只更新"今天"；dayTotals 各天桶保留（今天桶天然从 0 开始）
 * - 会话切换（含首次启用会话统计）：整体重建（偏移置空、全量重读本月转录，
 *   从而回溯当前会话的历史记录；同月回放重建各天桶）；昨天在上月时搬运旧状态昨天桶
 * - 新月：整体重建（偏移置空，触发全量重读的一次性回溯）；"日历昨天"的桶跨月搬运保留
 * - 旧版本状态、计价目录版本变化：整体重建（偏移置空，触发全量重读的一次性回溯）
 */
function loadState(stateFile: string, today: string, month: string, sessionId: string | null): UsageStateFile {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s = JSON.parse(raw) as Partial<UsageStateFile>;
    if (
      s?.stateV === STATE_VERSION
      && s.pricingCatalogVersion === PRICING_CATALOG_VERSION
    ) {
      if (s.month !== month) {
        // 新月：整体重建（偏移置空、全量重读本月转录）。
        // "日历昨天"的桶跨月搬运：回放只重读本月记录，上月昨天的累计必须靠搬运保留，
        // 否则月初 1 号的昨天行会错误归零。
        // 已知限制：跨月补到的更完整分片会与搬运来的昨天桶重复计费（msgs 跨月重置、去重不可达），
        // 金额为中间分片、次日剪枝自愈；不值得为此恢复跨月 msgs 去重。
        // 今天为新月 1 号时昨天必在上月；多天未开机时昨天在本月、靠回放重建，helper 两种都覆盖
        return rebuildCarryingYesterday(s, month, today, sessionId);
      }
      if (sessionId == null || s.sessionId === undefined || s.sessionId === sessionId) {
        if (sessionId != null && s.sessionId === undefined) {
          // 首次启用会话统计：整体重建，回溯当前会话的历史记录
          return rebuildCarryingYesterday(s, month, today, sessionId);
        }
        let out = s as UsageStateFile;
        if (s.date !== today) {
          // 跨天只更新"今天"；各天桶保留，今天的桶天然从 0 开始
          out = { ...out, date: today };
        }
        return out;
      }
      // 会话切换：整体重建，回溯当前会话的历史记录（同月回放会重建各天桶）；
      // 昨天在上月时（月初 1 号）搬运旧状态的昨天桶，防止昨天行错误归零
      return rebuildCarryingYesterday(s, month, today, sessionId);
    }
  } catch {
    // 状态文件损坏或不存在 → 重建
  }
  // 旧版本状态/损坏/计价目录版本变化 → 整体重建。注意：升级当天恰逢月初 1 号时
  // 无旧 dayTotals 可搬、昨天行单次归零（一次性，见设计文档风险节）
  return freshState(month, today, sessionId);
}

/** 递归收集所有 jsonl 转录文件（目录不存在时返回空数组） */
function collectJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonl(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** Add or subtract one priced model contribution from a scope. */
function applyToScope(
  scope: ScopeState,
  sign: 1 | -1,
  model: string,
  contribution: ModelUsageBucket,
): void {
  const bucket = scope.perModel[model] ?? (scope.perModel[model] = zeroModelBucket());
  bucket.input += sign * contribution.input;
  bucket.cacheRead += sign * contribution.cacheRead;
  bucket.cacheWrite += sign * contribution.cacheWrite;
  bucket.output += sign * contribution.output;
  bucket.amount += sign * contribution.amount;
  bucket.costPeak += sign * contribution.costPeak;
  bucket.costOff += sign * contribution.costOff;
}

function legacyAggregate(scope: ScopeState): CostBucket | null {
  const entries = Object.entries(scope.perModel);
  if (entries.length === 0) return zeroLegacyBucket();
  const currencies = new Set(entries.map(([model]) => resolveModelPricing(model)?.currency).filter(Boolean));
  if (currencies.size > 1) return null;

  const total = zeroLegacyBucket();
  for (const [, bucket] of entries) {
    total.miss += bucket.input + bucket.cacheWrite;
    total.hit += bucket.cacheRead;
    total.out += bucket.output;
    total.costPeak += bucket.costPeak;
    total.costOff += bucket.costOff;
  }
  return total;
}

/** 原子写入状态文件（tmp + rename，避免并发触发时写坏） */
function persistState(stateFile: string, state: UsageStateFile): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  } catch {
    // 写失败不影响本次结果：下次触发会从旧偏移重读，message.id 去重保证不重复计费
  }
}

/**
 * 增量扫描转录并更新状态，返回今日/本月/会话三层累计（含按模型拆分）。
 * 任何异常返回 null（调用方显示占位），不影响 HUD 其他行。
 */
export function updateUsageStats(options: UsageStatsOptions = {}): UsageStatsResult | null {
  try {
    const now = options.now ?? new Date().toISOString();
    const today = beijingDate(now);
    const month = today.slice(0, 7);
    const sessionId = options.sessionId ?? null;
    const stateFile = options.stateFile ?? path.join(defaultConfigDir(), 'scripts', '.usage-state.json');
    const projectsRoot = options.projectsRoot ?? path.join(defaultConfigDir(), 'projects');

    const state = loadState(stateFile, today, month, sessionId);

    // 消费单行转录：只统计本月、能计价的 assistant 记录（按 message.id 去重取最完整分片）
    const consumeLine = (line: string, file: string): void => {
      let record: {
        type?: string;
        timestamp?: string;
        sessionId?: string;
        message?: {
          id?: string;
          model?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
      };
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      if (record?.type !== 'assistant' || !record?.message?.usage || !record?.timestamp) return;
      const date = beijingDate(record.timestamp);
      if (date.slice(0, 7) !== state.month) return; // 非本月记录（回溯时会读到历史数据）
      const id = record.message.id;
      if (!id) return; // 无 message.id 的记录无法去重，跳过避免重复计费
      const tokens = splitUsageTokens(record.message.usage);
      const rawModel = typeof record.message.model === 'string' && record.message.model
        ? record.message.model
        : 'unknown';
      const priced = calculateModelUsageCost(rawModel, tokens, record.timestamp);
      if (!priced) return;
      const model = priced.model.canonicalName;
      const session = sessionOfFile(file, record.sessionId);
      const contribution: ModelUsageBucket = {
        ...tokens,
        amount: priced.amount,
        costPeak: priced.peakAmount,
        costOff: priced.offPeakAmount,
      };

      const old = state.msgs[id];
      if (old && tokens.output <= old.output) return; // 旧分片已完整，忽略重复/更旧的分片
      if (old) {
        // 同一消息的更新分片：先从旧模型/日期/会话桶对称扣回旧贡献。
        if (old.month === state.month) {
          applyToScope(state.monthTotal, -1, old.model, old);
        }
        if (old.session === state.sessionId) {
          applyToScope(state.sessionTotals, -1, old.model, old);
        }
        const oldDay = state.dayTotals[old.date] ?? (state.dayTotals[old.date] = zeroScope());
        applyToScope(oldDay, -1, old.model, old);
      }
      state.msgs[id] = { ...contribution, date, month, session, model };

      applyToScope(state.monthTotal, 1, model, contribution);
      const day = state.dayTotals[date] ?? (state.dayTotals[date] = zeroScope());
      applyToScope(day, 1, model, contribution);
      if (session === state.sessionId) {
        applyToScope(state.sessionTotals, 1, model, contribution);
      }
    };

    for (const file of collectJsonl(projectsRoot)) {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      let offset = state.files[file] ?? 0;
      if (offset > size) offset = 0; // 文件被截断/重建，从头重读
      if (offset === size) continue;

      let chunk: string;
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch {
        continue;
      }

      // 只处理完整行；末尾不完整的行留到下次触发时重试，避免读到半个 JSON。
      // 注意：chunk 以 '\n' 结尾时 split 会多出一个尾部空串元素，故统一 parts.length - 1，
      // 否则 consumed 会比实际多 1 字节，导致偏移越过 EOF、下次触发被迫从头重读
      const parts = chunk.split('\n');
      const complete = parts.length - 1;
      let consumed = 0;
      for (let i = 0; i < complete; i += 1) {
        consumeLine(parts[i], file);
        consumed += Buffer.byteLength(parts[i], 'utf8') + 1;
      }
      state.files[file] = offset + consumed;
    }

    // 剪枝：dayTotals 只保留本月各天 + 日历昨天（最多 ~32 个桶）。正常流程不会残留，
    // 此为防御脏状态/未来回归的保险
    const yesterdayKey = yesterdayOf(today);
    for (const key of Object.keys(state.dayTotals)) {
      if (key !== yesterdayKey && key.slice(0, 7) !== state.month) {
        delete state.dayTotals[key];
      }
    }

    persistState(stateFile, state);

    // 会话跨天拆分：渲染层在会话跨天时标注"含昨/含更早"金额。
    // 由 msgs 现算、不入状态文件——msgs 已按 message.id 去重且带 session/date 归属，
    // 天然覆盖增量扫描与整体重建两条路径，无需状态版本迁移
    const sessionPriorPerModel: Record<string, ModelUsageBucket> = {};
    const sessionYesterdayPerModel: Record<string, ModelUsageBucket> = {};
    if (state.sessionId) {
      for (const msg of Object.values(state.msgs)) {
        if (msg.session !== state.sessionId || msg.date >= today) continue;
        const prior = sessionPriorPerModel[msg.model] ?? (sessionPriorPerModel[msg.model] = zeroModelBucket());
        prior.input += msg.input;
        prior.cacheRead += msg.cacheRead;
        prior.cacheWrite += msg.cacheWrite;
        prior.output += msg.output;
        prior.amount += msg.amount;
        prior.costPeak += msg.costPeak;
        prior.costOff += msg.costOff;
        if (msg.date !== yesterdayKey) continue;
        const yd = sessionYesterdayPerModel[msg.model] ?? (sessionYesterdayPerModel[msg.model] = zeroModelBucket());
        yd.input += msg.input;
        yd.cacheRead += msg.cacheRead;
        yd.cacheWrite += msg.cacheWrite;
        yd.output += msg.output;
        yd.amount += msg.amount;
        yd.costPeak += msg.costPeak;
        yd.costOff += msg.costOff;
      }
    }

    const todayBucket = state.dayTotals[today] ?? zeroScope();
    const yesterdayBucket = state.dayTotals[yesterdayKey] ?? zeroScope();
    return {
      today: legacyAggregate(todayBucket),
      yesterday: legacyAggregate(yesterdayBucket),
      month: legacyAggregate(state.monthTotal),
      session: legacyAggregate(state.sessionTotals),
      todayPerModel: todayBucket.perModel,
      yesterdayPerModel: yesterdayBucket.perModel,
      monthPerModel: state.monthTotal.perModel,
      sessionPerModel: state.sessionTotals.perModel,
      sessionPriorPerModel,
      sessionYesterdayPerModel,
      sessionId: state.sessionId,
    };
  } catch {
    return null;
  }
}

export function selectModelUsage(stats: UsageStatsResult, model: ModelPricing): SelectedModelUsageStats {
  const pick = (scope: Record<string, ModelUsageBucket>): ModelUsageBucket => (
    scope[model.canonicalName] ?? zeroModelBucket()
  );
  return {
    model,
    today: pick(stats.todayPerModel),
    yesterday: pick(stats.yesterdayPerModel),
    month: pick(stats.monthPerModel),
    session: pick(stats.sessionPerModel),
    sessionPrior: pick(stats.sessionPriorPerModel),
    sessionYesterday: pick(stats.sessionYesterdayPerModel),
    sessionId: stats.sessionId,
  };
}
