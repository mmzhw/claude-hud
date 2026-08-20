import { displayNameOf } from '../../deepseek-pricing.js';
import type { CostBucket, UsageStatsResult } from '../../usage-stats.js';

/**
 * 渲染 DeepSeek 人民币费用行（display.showRmbCost 开启时由 render/index.ts
 * 在 expanded / compact 两种布局末尾追加）。
 *
 * 两行输出：昨天行在上、今天行在下；昨天无数据时显示昨¥0.00，两行结构恒定：
 *   ⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥0.80 谷¥0.43
 *   ⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
 * - 括号内为按模型拆分（动态遍历实际出现的模型，用计价表 displayName 短写）
 * - 峰/谷仅非零时显示；会话段仅当前会话有 id 时显示，且只属于今天行
 * - stats 为 null（统计异常）时显示单行占位，不影响 HUD 其他行
 * - 行内文字硬编码中文（个人 fork，与现有脚本显示一致，不进 i18n 表）
 */

/** 构建一天的费用段：总额 + 按模型拆分（有数据时）+ 峰/谷（非零时） */
function renderDayCost(
  label: '今' | '昨',
  total: CostBucket,
  perModel: Record<string, CostBucket>,
): string {
  const cost = total.costPeak + total.costOff;
  let part = `${label}¥${cost.toFixed(2)}`;
  const models = Object.keys(perModel);
  if (models.length > 0) {
    const detail = models
      .map((model) => {
        const bucket = perModel[model];
        const modelCost = bucket.costPeak + bucket.costOff;
        return `${displayNameOf(model)}¥${modelCost.toFixed(2)}`;
      })
      .join('/');
    part += `(${detail})`;
  }
  const parts = [part];
  if (total.costPeak > 0) parts.push(`峰¥${total.costPeak.toFixed(2)}`);
  if (total.costOff > 0) parts.push(`谷¥${total.costOff.toFixed(2)}`);
  return parts.join(' ');
}

/** 渲染昨天 + 今天两行费用（以 \n 连接；render/index.ts 会按物理行拆分输出） */
export function renderRmbCostLine(stats: UsageStatsResult | null): string {
  if (!stats) {
    return '⚡费用统计异常';
  }

  const monthCost = stats.month.costPeak + stats.month.costOff;
  const sessionCost = stats.session.costPeak + stats.session.costOff;

  const yesterdayLine = `⚡${renderDayCost('昨', stats.yesterday, stats.yesterdayPerModel)}`;
  const todayParts = [`⚡${renderDayCost('今', stats.today, stats.todayPerModel)}`, `月¥${monthCost.toFixed(2)}`];
  if (stats.sessionId) todayParts.push(`会话¥${sessionCost.toFixed(2)}`);

  return `${yesterdayLine}\n${todayParts.join(' ')}`;
}
