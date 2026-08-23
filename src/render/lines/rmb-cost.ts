import type { UsageStatsResult } from '../../usage-stats.js';
import { renderModelCostLine, type ModelCostRenderInput } from './model-cost.js';

export { renderModelCostLine, type ModelCostRenderInput };

/** Temporary compatibility for callers still passing the pre-selection stats shape. */
export function renderRmbCostLine(input: ModelCostRenderInput | UsageStatsResult | null): string {
  if (input && 'kind' in input) return renderModelCostLine(input);
  return renderModelCostLine({ kind: 'error' });
}
