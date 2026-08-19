import { displayNameOf } from '../../deepseek-pricing.js';
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
export function renderRmbCostLine(stats) {
    if (!stats) {
        return '⚡费用统计异常';
    }
    const todayCost = stats.today.costPeak + stats.today.costOff;
    const monthCost = stats.month.costPeak + stats.month.costOff;
    const sessionCost = stats.session.costPeak + stats.session.costOff;
    let todayPart = `⚡今¥${todayCost.toFixed(2)}`;
    const models = Object.keys(stats.todayPerModel);
    if (models.length > 0) {
        const detail = models
            .map((model) => {
            const bucket = stats.todayPerModel[model];
            const cost = bucket.costPeak + bucket.costOff;
            return `${displayNameOf(model)}¥${cost.toFixed(2)}`;
        })
            .join('/');
        todayPart += `(${detail})`;
    }
    const parts = [todayPart];
    if (stats.today.costPeak > 0)
        parts.push(`峰¥${stats.today.costPeak.toFixed(2)}`);
    if (stats.today.costOff > 0)
        parts.push(`谷¥${stats.today.costOff.toFixed(2)}`);
    parts.push(`月¥${monthCost.toFixed(2)}`);
    if (stats.sessionId)
        parts.push(`会话¥${sessionCost.toFixed(2)}`);
    return parts.join(' ');
}
//# sourceMappingURL=rmb-cost.js.map