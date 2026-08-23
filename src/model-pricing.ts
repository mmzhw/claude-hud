import { sanitizeTranscriptModel } from './model-source.js';

export const PRICING_CATALOG_VERSION = '2026-08-23-gpt56-sol-v1';
export const PRICING_EFFECTIVE_DATE = '2026-08-17';
export const GPT_56_CONTEXT_THRESHOLD = 272_000;
export const PEAK_WINDOWS_BEIJING: Array<[number, number]> = [[9, 12], [14, 18]];

const TOKENS_PER_MILLION = 1_000_000;

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

export type PricingStrategy =
  | { kind: 'time-of-day'; peak: PriceVector; offPeak: PriceVector }
  | { kind: 'context-tiered'; threshold: number; short: PriceVector; long: PriceVector }
  | { kind: 'flat'; prices: PriceVector };

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

export const MODEL_PRICING_CATALOG: readonly ModelPricing[] = [
  {
    canonicalName: 'deepseek-v4-pro',
    aliases: [],
    displayName: 'pro',
    currency: 'CNY',
    symbol: '¥',
    effectiveFrom: PRICING_EFFECTIVE_DATE,
    strategy: {
      kind: 'time-of-day',
      peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 },
      offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
    },
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    verifiedAt: '2026-08-17',
  },
  {
    canonicalName: 'deepseek-v4-flash',
    aliases: [],
    displayName: 'flash',
    currency: 'CNY',
    symbol: '¥',
    effectiveFrom: PRICING_EFFECTIVE_DATE,
    strategy: {
      kind: 'time-of-day',
      peak: { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 },
      offPeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 },
    },
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    verifiedAt: '2026-08-17',
  },
  {
    canonicalName: 'gpt-5.6-sol',
    aliases: ['gpt-5.6 sol'],
    displayName: 'sol',
    currency: 'USD',
    symbol: '$',
    strategy: {
      kind: 'context-tiered',
      threshold: GPT_56_CONTEXT_THRESHOLD,
      short: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
      long: { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 },
    },
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    verifiedAt: '2026-08-23',
    note: 'Standard promotional pricing available at least through 2026-11-21',
  },
];

function normalizeModelKey(value: unknown): string | undefined {
  const sanitized = sanitizeTranscriptModel(value);
  if (!sanitized) return undefined;
  return sanitized
    .replace(/\s*\[1m\]\s*$/i, '')
    .replace(/\s*\(1m context\)\s*$/i, '')
    .trim()
    .toLowerCase();
}

const MODEL_INDEX = new Map<string, ModelPricing>();
for (const entry of MODEL_PRICING_CATALOG) {
  for (const name of [entry.canonicalName, ...entry.aliases]) {
    const key = normalizeModelKey(name);
    if (key) MODEL_INDEX.set(key, entry);
  }
}

export function resolveModelPricing(...candidates: unknown[]): ModelPricing | null {
  for (const candidate of candidates) {
    const key = normalizeModelKey(candidate);
    if (!key) continue;
    const pricing = MODEL_INDEX.get(key);
    if (pricing) return pricing;
  }
  return null;
}

export function resolveCurrentModelPricing(model?: { id?: unknown; display_name?: unknown } | null): ModelPricing | null {
  return resolveModelPricing(model?.id, model?.display_name);
}

export function currentModelLabel(model?: { id?: unknown; display_name?: unknown } | null): string | null {
  return sanitizeTranscriptModel(model?.id) ?? sanitizeTranscriptModel(model?.display_name) ?? null;
}

export function displayNameOf(model: string): string {
  return resolveModelPricing(model)?.displayName ?? model;
}

export function pricingOrderOf(model: string): number {
  const pricing = resolveModelPricing(model);
  if (!pricing) return MODEL_PRICING_CATALOG.length;
  return MODEL_PRICING_CATALOG.indexOf(pricing);
}

export function splitUsageTokens(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): TokenSplit {
  return {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
}

function costWith(prices: PriceVector, tokens: TokenSplit): number {
  return (
    tokens.input * prices.input
    + tokens.cacheRead * prices.cacheRead
    + tokens.cacheWrite * prices.cacheWrite
    + tokens.output * prices.output
  ) / TOKENS_PER_MILLION;
}

export function calculateModelUsageCost(
  rawModel: string,
  tokens: TokenSplit,
  utcTimestamp: string,
): PricedModelUsage | null {
  const model = resolveModelPricing(rawModel);
  if (!model) return null;
  const date = beijingDate(utcTimestamp);
  if (!date || (model.effectiveFrom && date < model.effectiveFrom)) return null;

  let prices: PriceVector;
  let peak: boolean | null = null;
  if (model.strategy.kind === 'time-of-day') {
    peak = isPeak(utcTimestamp);
    prices = peak ? model.strategy.peak : model.strategy.offPeak;
  } else if (model.strategy.kind === 'context-tiered') {
    const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    prices = inputTotal <= model.strategy.threshold ? model.strategy.short : model.strategy.long;
  } else {
    prices = model.strategy.prices;
  }

  const amount = costWith(prices, tokens);
  return {
    model,
    tokens,
    amount,
    peakAmount: peak === true ? amount : 0,
    offPeakAmount: peak === false ? amount : 0,
  };
}

export function sessionOfFile(file: string, recordSessionId?: string | null): string | null {
  const parts = file.split(/[\\/]/);
  const idx = parts.indexOf('subagents');
  if (idx > 0) return parts[idx - 1];
  if (recordSessionId) return recordSessionId;
  const base = parts[parts.length - 1];
  return base.endsWith('.jsonl') ? base.slice(0, -6) : null;
}

export function isPeak(utcTimestamp: string): boolean {
  const d = new Date(utcTimestamp);
  if (Number.isNaN(d.getTime())) return false;
  const bj = new Date(d.getTime() + 8 * 3600_000);
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return PEAK_WINDOWS_BEIJING.some(([start, end]) => hour >= start && hour < end);
}

export function beijingDate(utcTimestamp: string): string {
  const d = new Date(utcTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function yesterdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
