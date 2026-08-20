// DeepSeek 人民币费用统计：增量扫描 ~/.claude/projects/**/*.jsonl 转录，
// 状态文件记录每个转录已消费的字节偏移，每次触发只解析新增内容。
// 从 ~/.claude/scripts/usage-statusline.mjs 移植（口径保持一致），新增按模型拆分。
//
// 计费口径：同一次 API 响应因流式输出会拆成多条 assistant 记录（中间分片 output 为 0），
//   按 message.id 去重——已见过的消息再次出现时，先扣回旧分片再计入更完整的分片，
//   保证跨多次触发也能还原 DeepSeek 实际计费。
// 会话归属：主会话文件 projects/<项目>/<sessionId>.jsonl 归该会话；
//   子代理文件 <sessionId>/subagents/*.jsonl 归父会话（会话花费含子代理）。
//   会话切换（新会话 id）时整体重建，回溯当前会话的历史记录。
// 按天累计：dayTotals 以北京日期为键，记录按自身日期落桶（跨天补到的更完整分片
//   会把该消息费用从旧日期桶挪到新日期桶）。渲染取今天与昨天两个桶。
// 本月累计：monthTotal 跨天持久累加，文件偏移跨天不清零（漏开机的天数由增量消费自然补齐）；
//   新月或旧版本状态时偏移置空、全量重读本月记录一次（一次性回溯）。
//   月初跨月时"日历昨天"的桶搬运进新状态——回放只重读本月记录，上月昨天必须靠搬运保留。
// 计价生效日期：峰谷分时计价自 2026-08-17 起生效，之前的记录过滤不计入；
//   状态里记录 pricingEra，生效日期常量变更时自动整体重建，避免旧数据残留。
//
// 配置：display.showRmbCost 开启后由 render/index.ts 调用（渲染见 render/lines/rmb-cost.ts）。
// 注意：转录 JSONL 是内部格式，字段可能随 Claude Code 版本变化；任何异常只影响费用行本身。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeConfigDir } from './claude-config-dir.js';
import {
  beijingDate,
  costOfTokens,
  isPeak,
  PRICING_EFFECTIVE_DATE,
  sessionOfFile,
  tokenSplit,
  yesterdayOf,
  type TokenSplit,
} from './deepseek-pricing.js';

/** 状态文件版本：v2 起各层累计带 perModel 字段、msgs 记录带 model；v3 起今日层改为按天累计 dayTotals。旧版本状态整体重建一次 */
const STATE_VERSION = 3;

/** 单层累计（今日/本月/会话）：token 分类 + 峰谷费用 */
export interface CostBucket {
  miss: number;
  hit: number;
  out: number;
  costPeak: number;
  costOff: number;
}

/** 带按模型拆分的一层累计 */
interface ScopeState extends CostBucket {
  perModel: Record<string, CostBucket>;
}

/** msgs 中已消费分片的记录（跨扫描去重用） */
interface MsgState extends TokenSplit {
  peak: boolean;
  cost: number;
  date: string; // 北京日期 YYYY-MM-DD
  month: string; // YYYY-MM
  session: string | null; // 归属会话 id
  model: string;
}

/** 状态文件结构（与 usage-statusline.mjs 原格式兼容，新增 stateV/perModel/model 字段；v3 起 totals 改为 dayTotals） */
interface UsageStateFile {
  stateV: number;
  month: string;
  date: string;
  pricingEra: string;
  sessionId: string | null;
  /** 按天累计：北京日期 YYYY-MM-DD → 当日累计（含 perModel） */
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
  today: CostBucket;
  /** 昨天累计（无数据时为零桶，配合渲染"昨¥0.00"始终显示） */
  yesterday: CostBucket;
  month: CostBucket;
  session: CostBucket;
  /** 今天按模型拆分（昨天行与今天行各用各的拆分） */
  todayPerModel: Record<string, CostBucket>;
  /** 昨天按模型拆分（无数据时为空对象） */
  yesterdayPerModel: Record<string, CostBucket>;
  /** 月/会话按模型拆分：当前渲染未使用，保留供未来扩展（如月/会话按模型拆分） */
  monthPerModel: Record<string, CostBucket>;
  /** 会话层按模型拆分：当前渲染未使用，保留供未来扩展 */
  sessionPerModel: Record<string, CostBucket>;
  sessionId: string | null;
}

/** Claude 配置目录（复用 HUD 全局口径：CLAUDE_CONFIG_DIR 支持 ~ 前缀展开并做路径规范化） */
function defaultConfigDir(): string {
  return getClaudeConfigDir(os.homedir());
}

function zeroBucket(): CostBucket {
  return { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0 };
}

function zeroScope(): ScopeState {
  return { ...zeroBucket(), perModel: {} };
}

function freshState(month: string, date: string, sessionId: string | null): UsageStateFile {
  return {
    stateV: STATE_VERSION,
    month,
    date,
    pricingEra: PRICING_EFFECTIVE_DATE,
    sessionId,
    dayTotals: {},
    monthTotal: zeroScope(),
    sessionTotals: zeroScope(),
    files: {},
    msgs: {},
  };
}

/**
 * 加载状态：
 * - 同月内跨天：只更新"今天"；dayTotals 各天桶保留（今天桶天然从 0 开始）
 * - 会话切换（含首次启用会话统计）：整体重建（偏移置空、全量重读本月转录，
 *   从而回溯当前会话的历史记录；同月回放会重建各天桶）
 * - 新月：整体重建（偏移置空，触发全量重读的一次性回溯）
 * - 旧版本状态、计价生效日期变更：整体重建（偏移置空，触发全量重读的一次性回溯）
 */
function loadState(stateFile: string, today: string, month: string, sessionId: string | null): UsageStateFile {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s = JSON.parse(raw) as Partial<UsageStateFile>;
    if (s?.stateV === STATE_VERSION && s.pricingEra === PRICING_EFFECTIVE_DATE) {
      if (s.month !== month) {
        // 新月：整体重建（偏移置空、全量重读本月转录）
        return freshState(month, today, sessionId);
      }
      if (sessionId == null || s.sessionId === undefined || s.sessionId === sessionId) {
        if (sessionId != null && s.sessionId === undefined) {
          // 首次启用会话统计：整体重建，回溯当前会话的历史记录
          return freshState(month, today, sessionId);
        }
        let out = s as UsageStateFile;
        if (s.date !== today) {
          // 跨天只更新"今天"；各天桶保留，今天的桶天然从 0 开始
          out = { ...out, date: today };
        }
        return out;
      }
      // 会话切换：整体重建，回溯当前会话的历史记录（同月回放会重建各天桶）
      return freshState(month, today, sessionId);
    }
  } catch {
    // 状态文件损坏或不存在 → 重建
  }
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

/** 按符号累加/扣回一层累计（sign=1 计入，sign=-1 扣回），同步维护 perModel 拆分 */
function applyToScope(
  scope: ScopeState,
  sign: 1 | -1,
  t: TokenSplit,
  cost: number,
  peak: boolean,
  model: string,
): void {
  scope.miss += sign * t.miss;
  scope.hit += sign * t.hit;
  scope.out += sign * t.out;
  if (peak) scope.costPeak += sign * cost;
  else scope.costOff += sign * cost;

  const bucket = scope.perModel[model] ?? (scope.perModel[model] = zeroBucket());
  bucket.miss += sign * t.miss;
  bucket.hit += sign * t.hit;
  bucket.out += sign * t.out;
  if (peak) bucket.costPeak += sign * cost;
  else bucket.costOff += sign * cost;
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
      if (date < PRICING_EFFECTIVE_DATE) return; // 新价格体系生效前的记录不计入
      if (date.slice(0, 7) !== state.month) return; // 非本月记录（回溯时会读到历史数据）
      const id = record.message.id;
      if (!id) return; // 无 message.id 的记录无法去重，跳过避免重复计费
      const peak = isPeak(record.timestamp);
      const t = tokenSplit(record.message.usage);
      const model = typeof record.message.model === 'string' && record.message.model
        ? record.message.model
        : 'unknown';
      const cost = costOfTokens(model, t, peak);
      if (cost == null) return;
      const session = sessionOfFile(file, record.sessionId);

      const old = state.msgs[id];
      if (old && t.out <= old.out) return; // 旧分片已完整，忽略重复/更旧的分片
      if (old) {
        // 同一消息的更新分片：先扣回旧贡献（跨天/跨会话分片只影响对应累计）
        if (old.month === state.month) {
          applyToScope(state.monthTotal, -1, old, old.cost, old.peak, old.model);
        }
        if (old.session === state.sessionId) {
          applyToScope(state.sessionTotals, -1, old, old.cost, old.peak, old.model);
        }
        // 按天桶扣回：旧分片按它落桶的日期扣（跨天补到的更完整分片会把该消息费用挪到新日期桶）
        const oldDay = state.dayTotals[old.date] ?? (state.dayTotals[old.date] = zeroScope());
        applyToScope(oldDay, -1, old, old.cost, old.peak, old.model);
      }
      state.msgs[id] = { ...t, peak, cost, date, month, session, model };

      // 本月累计：始终计入
      applyToScope(state.monthTotal, 1, t, cost, peak, model);
      // 按天累计：按记录自身北京日期落桶
      const day = state.dayTotals[date] ?? (state.dayTotals[date] = zeroScope());
      applyToScope(day, 1, t, cost, peak, model);
      // 会话累计：仅当前会话（含其子代理）计入
      if (session === state.sessionId) {
        applyToScope(state.sessionTotals, 1, t, cost, peak, model);
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

    persistState(stateFile, state);

    const yesterdayKey = yesterdayOf(today);
    const todayBucket = state.dayTotals[today] ?? zeroScope();
    const yesterdayBucket = state.dayTotals[yesterdayKey] ?? zeroScope();
    return {
      today: todayBucket,
      yesterday: yesterdayBucket,
      month: state.monthTotal,
      session: state.sessionTotals,
      todayPerModel: todayBucket.perModel,
      yesterdayPerModel: yesterdayBucket.perModel,
      monthPerModel: state.monthTotal.perModel,
      sessionPerModel: state.sessionTotals.perModel,
      sessionId: state.sessionId,
    };
  } catch {
    return null;
  }
}
