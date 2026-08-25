import { formatUsd } from '../../cost.js';
import type { ModelUsageBucket, SelectedModelUsageStats } from '../../usage-stats.js';

export type ModelCostRenderInput =
  | { kind: 'ready'; stats: SelectedModelUsageStats }
  | { kind: 'unknown'; modelName: string }
  | { kind: 'error' };

function formatAmount(amount: number, stats: SelectedModelUsageStats): string {
  return stats.model.currency === 'USD'
    ? formatUsd(amount)
    : `¥${amount.toFixed(2)}`;
}

function hasUsage(bucket: ModelUsageBucket): boolean {
  return bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output > 0;
}

/** 会话段：跨天时标注今天之前的部分，避免 会话>今 看起来像记账错误 */
function renderSessionSegment(stats: SelectedModelUsageStats): string {
  let text = `会话${formatAmount(stats.session.amount, stats)}`;
  if (hasUsage(stats.sessionPrior)) {
    const allYesterday = Math.abs(stats.sessionPrior.amount - stats.sessionYesterday.amount) < 1e-9;
    text += `(${allYesterday ? '含昨' : '含更早'}${formatAmount(stats.sessionPrior.amount, stats)})`;
  }
  return text;
}

function renderDay(label: '今' | '昨', bucket: ModelUsageBucket, stats: SelectedModelUsageStats): string {
  const amount = formatAmount(bucket.amount, stats);
  let total = `${label}${amount}`;
  if (hasUsage(bucket)) {
    total += `(${stats.model.displayName}${amount})`;
  }
  const parts = [total];
  if (stats.model.strategy.kind === 'time-of-day') {
    if (bucket.costPeak > 0) parts.push(`峰${formatAmount(bucket.costPeak, stats)}`);
    if (bucket.costOff > 0) parts.push(`谷${formatAmount(bucket.costOff, stats)}`);
  }
  return parts.join(' ');
}

export function renderModelCostLine(input: ModelCostRenderInput): string {
  if (input.kind === 'error') return '⚡费用统计异常';
  if (input.kind === 'unknown') return `⚡${input.modelName} 暂无计价`;

  const stats = input.stats;
  const yesterdayLine = `⚡${renderDay('昨', stats.yesterday, stats)}`;
  const todayParts = [
    `⚡${renderDay('今', stats.today, stats)}`,
    `月${formatAmount(stats.month.amount, stats)}`,
  ];
  if (stats.sessionId) {
    todayParts.push(renderSessionSegment(stats));
  }
  return `${yesterdayLine}\n${todayParts.join(' ')}`;
}
