import {
  displayNameOf,
  pricingOrderOf,
  resolveModelPricing,
  splitUsageTokens,
  type PriceVector,
} from './model-pricing.js';

export {
  PEAK_WINDOWS_BEIJING,
  PRICING_EFFECTIVE_DATE,
  beijingDate,
  displayNameOf,
  isPeak,
  pricingOrderOf,
  sessionOfFile,
  yesterdayOf,
} from './model-pricing.js';

/** @deprecated Use ModelPricing from model-pricing.ts for new code. */
export interface ModelRmbPricing {
  displayName?: string;
  cacheHit: { peak: number; off: number };
  cacheMiss: { peak: number; off: number };
  output: { peak: number; off: number };
}

function timePrices(model: string): { displayName: string; peak: PriceVector; offPeak: PriceVector } {
  const pricing = resolveModelPricing(model);
  if (!pricing || pricing.strategy.kind !== 'time-of-day') {
    throw new Error(`Expected time-of-day pricing for ${model}`);
  }
  return { displayName: pricing.displayName, peak: pricing.strategy.peak, offPeak: pricing.strategy.offPeak };
}

function legacyPricing(model: string): ModelRmbPricing {
  const pricing = timePrices(model);
  return {
    displayName: pricing.displayName,
    cacheHit: { peak: pricing.peak.cacheRead, off: pricing.offPeak.cacheRead },
    cacheMiss: { peak: pricing.peak.input, off: pricing.offPeak.input },
    output: { peak: pricing.peak.output, off: pricing.offPeak.output },
  };
}

/** @deprecated New code should use MODEL_PRICING_CATALOG. */
export const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing> = {
  'deepseek-v4-pro': legacyPricing('deepseek-v4-pro'),
  'deepseek-v4-flash': legacyPricing('deepseek-v4-flash'),
};

/** @deprecated New code should use TokenSplit from model-pricing.ts. */
export interface TokenSplit {
  miss: number;
  hit: number;
  out: number;
}

/** @deprecated New code should use splitUsageTokens. */
export function tokenSplit(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): TokenSplit {
  const tokens = splitUsageTokens(usage);
  return {
    miss: tokens.input + tokens.cacheWrite,
    hit: tokens.cacheRead,
    out: tokens.output,
  };
}

/** @deprecated New code should use calculateModelUsageCost. */
export function costOfTokens(model: string, tokens: TokenSplit, peak: boolean): number | null {
  const canonical = resolveModelPricing(model)?.canonicalName;
  if (!canonical) return null;
  const pricing = PRICES_RMB_PER_MILLION[canonical];
  if (!pricing) return null;
  const tier = peak ? 'peak' : 'off';
  return (
    tokens.miss * pricing.cacheMiss[tier]
    + tokens.hit * pricing.cacheHit[tier]
    + tokens.out * pricing.output[tier]
  ) / 1_000_000;
}
