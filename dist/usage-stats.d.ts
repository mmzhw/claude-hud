/** 单层累计（今日/本月/会话）：token 分类 + 峰谷费用 */
export interface CostBucket {
    miss: number;
    hit: number;
    out: number;
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
    today: CostBucket;
    /** 昨天累计（无数据时为零桶，配合渲染"昨¥0.00"始终显示） */
    yesterday: CostBucket;
    month: CostBucket;
    session: CostBucket;
    /** 今天行按模型拆分 */
    todayPerModel: Record<string, CostBucket>;
    /** 昨天按模型拆分（无数据时为空对象） */
    yesterdayPerModel: Record<string, CostBucket>;
    /** 月/会话按模型拆分：当前渲染未使用，保留供未来扩展（如月/会话按模型拆分） */
    monthPerModel: Record<string, CostBucket>;
    /** 会话层按模型拆分：当前渲染未使用，保留供未来扩展 */
    sessionPerModel: Record<string, CostBucket>;
    sessionId: string | null;
}
/**
 * 增量扫描转录并更新状态，返回今日/本月/会话三层累计（含按模型拆分）。
 * 任何异常返回 null（调用方显示占位），不影响 HUD 其他行。
 */
export declare function updateUsageStats(options?: UsageStatsOptions): UsageStatsResult | null;
//# sourceMappingURL=usage-stats.d.ts.map