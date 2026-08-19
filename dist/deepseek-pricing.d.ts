/** 高峰时段窗口（北京时间小时，[起始, 结束)） */
export declare const PEAK_WINDOWS_BEIJING: Array<[number, number]>;
/** 单个模型的峰谷单价（元 / 百万 tokens） */
export interface ModelRmbPricing {
    /** 费用行显示用短写（如 deepseek-v4-pro → pro）；缺省时显示原始模型名 */
    displayName?: string;
    cacheHit: {
        peak: number;
        off: number;
    };
    cacheMiss: {
        peak: number;
        off: number;
    };
    output: {
        peak: number;
        off: number;
    };
}
/** 各模型单价（元 / 百万 tokens），键为转录里记录的原始模型名 */
export declare const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing>;
/** 峰谷分时计价的生效日期（北京时间，含当天）；此前的记录按旧价格体系计费，统计时过滤 */
export declare const PRICING_EFFECTIVE_DATE = "2026-08-17";
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
export declare function sessionOfFile(file: string, recordSessionId?: string | null): string | null;
/** 判断一个 UTC 时间戳是否落在北京高峰时段 */
export declare function isPeak(utcTimestamp: string): boolean;
/** UTC 时间戳对应的北京日期 YYYY-MM-DD（跨时区按天分组用）；非法时间戳返回空串（调用方按日期过滤自然跳过） */
export declare function beijingDate(utcTimestamp: string): string;
/**
 * 从 Anthropic 口径的 usage 提取计费 token 分类
 * - 缓存未命中 = input_tokens（不含缓存读）；DeepSeek 不单独计缓存写入，
 *   cache_creation 正常为 0，若出现按未命中价计入，避免漏计费
 * - 缓存命中 = cache_read_input_tokens
 */
export declare function tokenSplit(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}): TokenSplit;
/**
 * 计算费用（元）
 * @param model 原始模型名（如 deepseek-v4-pro）
 * @param t token 分类（见 tokenSplit）
 * @param peak 是否高峰时段
 * @returns 未知模型无法计价时返回 null
 */
export declare function costOfTokens(model: string, t: TokenSplit, peak: boolean): number | null;
/** 模型显示名：计价表 displayName 短写，缺省用原始模型名 */
export declare function displayNameOf(model: string): string;
//# sourceMappingURL=deepseek-pricing.d.ts.map