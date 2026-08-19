import { resolveSessionCost, formatUsd } from '../../cost.js';
import { t } from '../../i18n/index.js';
import { label } from '../colors.js';
export function renderCostEstimate(ctx) {
    if (ctx.config?.display?.showCost !== true) {
        return null;
    }
    // 开启人民币费用行（display.showRmbCost）时抑制美元 cost 段，
    // 避免同屏出现两个矛盾的"费用"
    if (ctx.config?.display?.showRmbCost === true) {
        return null;
    }
    const cost = resolveSessionCost(ctx.stdin, ctx.transcript.sessionTokens, {
        allowRoutedCost: ctx.config?.display?.showRoutedCost === true,
    });
    if (!cost) {
        return null;
    }
    const labelKey = cost.source === 'native' ? 'label.cost' : 'label.estimatedCost';
    return label(`${t(labelKey)} ${formatUsd(cost.totalUsd)}`, ctx.config?.colors);
}
//# sourceMappingURL=cost.js.map