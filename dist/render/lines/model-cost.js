import { formatUsd } from '../../cost.js';
function formatAmount(amount, stats) {
    return stats.model.currency === 'USD'
        ? formatUsd(amount)
        : `¥${amount.toFixed(2)}`;
}
function hasUsage(bucket) {
    return bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output > 0;
}
function renderDay(label, bucket, stats) {
    const amount = formatAmount(bucket.amount, stats);
    let total = `${label}${amount}`;
    if (hasUsage(bucket)) {
        total += `(${stats.model.displayName}${amount})`;
    }
    const parts = [total];
    if (stats.model.strategy.kind === 'time-of-day') {
        if (bucket.costPeak > 0)
            parts.push(`峰${formatAmount(bucket.costPeak, stats)}`);
        if (bucket.costOff > 0)
            parts.push(`谷${formatAmount(bucket.costOff, stats)}`);
    }
    return parts.join(' ');
}
export function renderModelCostLine(input) {
    if (input.kind === 'error')
        return '⚡费用统计异常';
    if (input.kind === 'unknown')
        return `⚡${input.modelName} 暂无计价`;
    const stats = input.stats;
    const yesterdayLine = `⚡${renderDay('昨', stats.yesterday, stats)}`;
    const todayParts = [
        `⚡${renderDay('今', stats.today, stats)}`,
        `月${formatAmount(stats.month.amount, stats)}`,
    ];
    if (stats.sessionId) {
        todayParts.push(`会话${formatAmount(stats.session.amount, stats)}`);
    }
    return `${yesterdayLine}\n${todayParts.join(' ')}`;
}
//# sourceMappingURL=model-cost.js.map