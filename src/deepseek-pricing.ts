// DeepSeek V4 系列计费配置（从 ~/.claude/scripts/deepseek-pricing.mjs 移植，口径保持一致）
// 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 高峰时段：北京时间 9:00-12:00、14:00-18:00，其余为空闲时段（空闲价 = 高峰价的一半）
// 峰谷分时计价自 2026-08-17 起生效（北京时间），此前的记录按旧价格体系计费，统计时过滤
// 价格单位：元 / 百万 tokens
//
// 换模型：在 PRICES_RMB_PER_MILLION 加条目即可（displayName 为费用行短写），
// 状态机与渲染均为动态遍历，无需改其他代码。无峰谷价的模型把 peak/off 填同值即可。

/** 高峰时段窗口（北京时间小时，[起始, 结束)） */
export const PEAK_WINDOWS_BEIJING: Array<[number, number]> = [
  [9, 12],
  [14, 18],
];

/** 单个模型的峰谷单价（元 / 百万 tokens） */
export interface ModelRmbPricing {
  /** 费用行显示用短写（如 deepseek-v4-pro → pro）；缺省时显示原始模型名 */
  displayName?: string;
  cacheHit: { peak: number; off: number };
  cacheMiss: { peak: number; off: number };
  output: { peak: number; off: number };
}

/** 各模型单价（元 / 百万 tokens），键为转录里记录的原始模型名 */
export const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing> = {
  'deepseek-v4-pro': {
    displayName: 'pro',
    cacheHit: { peak: 0.3, off: 0.15 },
    cacheMiss: { peak: 9.0, off: 4.5 },
    output: { peak: 27.0, off: 13.5 },
  },
  'deepseek-v4-flash': {
    displayName: 'flash',
    cacheHit: { peak: 0.1, off: 0.05 },
    cacheMiss: { peak: 3.0, off: 1.5 },
    output: { peak: 9.0, off: 4.5 },
  },
};

/** 峰谷分时计价的生效日期（北京时间，含当天）；此前的记录按旧价格体系计费，统计时过滤 */
export const PRICING_EFFECTIVE_DATE = '2026-08-17';

/** 计费 token 分类（Anthropic 口径 usage 提取结果） */
export interface TokenSplit {
  /** 缓存未命中（含 cache_creation；DeepSeek 不单独计缓存写入） */
  miss: number;
  /** 缓存命中 */
  hit: number;
  /** 输出 */
  out: number;
}

/**
 * 从转录文件路径推导所属会话 id：
 * - 主会话文件：projects/<项目>/<sessionId>.jsonl → 记录自带的 sessionId（或文件名）
 * - 子代理文件：projects/<项目>/<sessionId>/subagents/*.jsonl → 归属父会话 <sessionId>
 *   （子代理记录自带的 sessionId 是子代理自己的 id，不能直接用）
 */
export function sessionOfFile(file: string, recordSessionId?: string | null): string | null {
  const parts = file.split(/[\\/]/);
  const idx = parts.indexOf('subagents');
  if (idx > 0) return parts[idx - 1];
  if (recordSessionId) return recordSessionId;
  const base = parts[parts.length - 1];
  return base.endsWith('.jsonl') ? base.slice(0, -6) : null;
}

/** 判断一个 UTC 时间戳是否落在北京高峰时段 */
export function isPeak(utcTimestamp: string): boolean {
  const d = new Date(utcTimestamp);
  if (Number.isNaN(d.getTime())) return false;
  const bj = new Date(d.getTime() + 8 * 3600_000);
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return PEAK_WINDOWS_BEIJING.some(([start, end]) => hour >= start && hour < end);
}

/** UTC 时间戳对应的北京日期 YYYY-MM-DD（跨时区按天分组用）；非法时间戳返回空串（调用方按日期过滤自然跳过） */
export function beijingDate(utcTimestamp: string): string {
  const d = new Date(utcTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * 从 Anthropic 口径的 usage 提取计费 token 分类
 * - 缓存未命中 = input_tokens（不含缓存读）；DeepSeek 不单独计缓存写入，
 *   cache_creation 正常为 0，若出现按未命中价计入，避免漏计费
 * - 缓存命中 = cache_read_input_tokens
 */
export function tokenSplit(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): TokenSplit {
  return {
    miss: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    hit: usage.cache_read_input_tokens ?? 0,
    out: usage.output_tokens ?? 0,
  };
}

/**
 * 计算费用（元）
 * @param model 原始模型名（如 deepseek-v4-pro）
 * @param t token 分类（见 tokenSplit）
 * @param peak 是否高峰时段
 * @returns 未知模型无法计价时返回 null
 */
export function costOfTokens(model: string, t: TokenSplit, peak: boolean): number | null {
  const p = PRICES_RMB_PER_MILLION[model];
  if (!p) return null;
  const key = peak ? 'peak' : 'off';
  return (t.miss * p.cacheMiss[key] + t.hit * p.cacheHit[key] + t.out * p.output[key]) / 1_000_000;
}

/** 模型显示名：计价表 displayName 短写，缺省用原始模型名 */
export function displayNameOf(model: string): string {
  return PRICES_RMB_PER_MILLION[model]?.displayName ?? model;
}
