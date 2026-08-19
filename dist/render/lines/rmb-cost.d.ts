import type { UsageStatsResult } from '../../usage-stats.js';
/**
 * 渲染 DeepSeek 人民币费用行（display.showRmbCost 开启时由 render/index.ts
 * 在 expanded / compact 两种布局末尾追加）。
 *
 * 格式：⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
 * - 括号内为今日按模型拆分（动态遍历实际出现的模型，用计价表 displayName 短写）
 * - 峰/谷仅非零时显示；会话段仅当前会话有值时显示
 * - stats 为 null（统计异常）时显示占位，不影响 HUD 其他行
 * - 行内文字硬编码中文（个人 fork，与现有脚本显示一致，不进 i18n 表）
 */
export declare function renderRmbCostLine(stats: UsageStatsResult | null): string;
//# sourceMappingURL=rmb-cost.d.ts.map