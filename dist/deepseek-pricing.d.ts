export { PEAK_WINDOWS_BEIJING, PRICING_EFFECTIVE_DATE, beijingDate, displayNameOf, isPeak, pricingOrderOf, sessionOfFile, yesterdayOf, } from './model-pricing.js';
/** @deprecated Use ModelPricing from model-pricing.ts for new code. */
export interface ModelRmbPricing {
    displayName?: string;
    cacheHit: {
        peak: number;
        off: number;
    };
    cacheMiss: {
        peak: number;
        off: number;
    };
    output: {
        peak: number;
        off: number;
    };
}
/** @deprecated New code should use MODEL_PRICING_CATALOG. */
export declare const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing>;
/** @deprecated New code should use TokenSplit from model-pricing.ts. */
export interface TokenSplit {
    miss: number;
    hit: number;
    out: number;
}
/** @deprecated New code should use splitUsageTokens. */
export declare function tokenSplit(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}): TokenSplit;
/** @deprecated New code should use calculateModelUsageCost. */
export declare function costOfTokens(model: string, tokens: TokenSplit, peak: boolean): number | null;
//# sourceMappingURL=deepseek-pricing.d.ts.map