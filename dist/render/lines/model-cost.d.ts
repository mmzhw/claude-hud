import type { SelectedModelUsageStats } from '../../usage-stats.js';
export type ModelCostRenderInput = {
    kind: 'ready';
    stats: SelectedModelUsageStats;
} | {
    kind: 'unknown';
    modelName: string;
} | {
    kind: 'error';
};
export declare function renderModelCostLine(input: ModelCostRenderInput): string;
//# sourceMappingURL=model-cost.d.ts.map