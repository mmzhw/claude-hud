import { type ModelPricing, type TokenSplit } from './model-pricing.js';
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
    sessionId: string | null;
}
export interface SelectedModelUsageStats {
    model: ModelPricing;
    today: ModelUsageBucket;
    yesterday: ModelUsageBucket;
    month: ModelUsageBucket;
    session: ModelUsageBucket;
    sessionId: string | null;
}
/**
 * 增量扫描转录并更新状态，返回今日/本月/会话三层累计（含按模型拆分）。
 * 任何异常返回 null（调用方显示占位），不影响 HUD 其他行。
 */
export declare function updateUsageStats(options?: UsageStatsOptions): UsageStatsResult | null;
export declare function selectModelUsage(stats: UsageStatsResult, model: ModelPricing): SelectedModelUsageStats;
//# sourceMappingURL=usage-stats.d.ts.map