export declare const PRICING_CATALOG_VERSION = "2026-08-23-gpt56-sol-v1";
export declare const PRICING_EFFECTIVE_DATE = "2026-08-17";
export declare const GPT_56_CONTEXT_THRESHOLD = 272000;
export declare const PEAK_WINDOWS_BEIJING: Array<[number, number]>;
export interface TokenSplit {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
}
export interface PriceVector {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
}
export type PricingStrategy = {
    kind: 'time-of-day';
    peak: PriceVector;
    offPeak: PriceVector;
} | {
    kind: 'context-tiered';
    threshold: number;
    short: PriceVector;
    long: PriceVector;
} | {
    kind: 'flat';
    prices: PriceVector;
};
export interface ModelPricing {
    canonicalName: string;
    aliases: string[];
    displayName: string;
    currency: 'CNY' | 'USD';
    symbol: '¥' | '$';
    effectiveFrom?: string;
    strategy: PricingStrategy;
    sourceUrl: string;
    verifiedAt: string;
    note?: string;
}
export interface PricedModelUsage {
    model: ModelPricing;
    tokens: TokenSplit;
    amount: number;
    peakAmount: number;
    offPeakAmount: number;
}
export declare const MODEL_PRICING_CATALOG: readonly ModelPricing[];
export declare function resolveModelPricing(...candidates: unknown[]): ModelPricing | null;
export declare function resolveCurrentModelPricing(model?: {
    id?: unknown;
    display_name?: unknown;
} | null): ModelPricing | null;
export declare function currentModelLabel(model?: {
    id?: unknown;
    display_name?: unknown;
} | null): string | null;
export declare function displayNameOf(model: string): string;
export declare function pricingOrderOf(model: string): number;
export declare function splitUsageTokens(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}): TokenSplit;
export declare function calculateModelUsageCost(rawModel: string, tokens: TokenSplit, utcTimestamp: string): PricedModelUsage | null;
export declare function sessionOfFile(file: string, recordSessionId?: string | null): string | null;
export declare function isPeak(utcTimestamp: string): boolean;
export declare function beijingDate(utcTimestamp: string): string;
export declare function yesterdayOf(date: string): string;
//# sourceMappingURL=model-pricing.d.ts.map