import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICING_CATALOG_VERSION,
  calculateModelUsageCost,
  currentModelLabel,
  resolveCurrentModelPricing,
  resolveModelPricing,
  splitUsageTokens,
} from '../dist/model-pricing.js';

const tokens = (overrides = {}) => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  ...overrides,
});

const closeTo = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
};

test('catalog version changes when pricing semantics change', () => {
  assert.equal(PRICING_CATALOG_VERSION, '2026-08-23-gpt56-sol-v1');
});

test('splitUsageTokens preserves four mutually exclusive input classes', () => {
  assert.deepEqual(
    splitUsageTokens({
      input_tokens: 100,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      output_tokens: 30,
    }),
    { input: 100, cacheRead: 20, cacheWrite: 5, output: 30 },
  );
  assert.deepEqual(splitUsageTokens({}), tokens());
});

test('gpt-5.6-sol aliases resolve to one USD pricing entry', () => {
  for (const value of ['gpt-5.6-sol', 'GPT-5.6-SOL[1m]', 'GPT-5.6 Sol (1M context)']) {
    const pricing = resolveModelPricing(value);
    assert.ok(pricing);
    assert.equal(pricing.canonicalName, 'gpt-5.6-sol');
    assert.equal(pricing.displayName, 'sol');
    assert.equal(pricing.currency, 'USD');
    assert.equal(pricing.symbol, '$');
  }
});

test('current model resolution prefers id and falls back to display_name', () => {
  assert.equal(
    resolveCurrentModelPricing({ id: 'gpt-5.6-sol[1m]', display_name: 'Unknown' })?.canonicalName,
    'gpt-5.6-sol',
  );
  assert.equal(
    resolveCurrentModelPricing({ display_name: 'deepseek-v4-pro' })?.canonicalName,
    'deepseek-v4-pro',
  );
  assert.equal(currentModelLabel({ id: 'gpt-5.6-sol[1m]' }), 'gpt-5.6-sol[1m]');
  assert.equal(resolveCurrentModelPricing({ id: 'unknown-model' }), null);
});

test('gpt-5.6-sol uses short-context prices at exactly 272K input tokens', () => {
  const result = calculateModelUsageCost(
    'gpt-5.6-sol',
    tokens({ input: 272_000 }),
    '2026-08-23T01:00:00.000Z',
  );
  assert.ok(result);
  closeTo(result.amount, 272_000 * 4 / 1_000_000);
  assert.equal(result.peakAmount, 0);
  assert.equal(result.offPeakAmount, 0);
});

test('gpt-5.6-sol uses long-context prices above 272K input tokens', () => {
  const result = calculateModelUsageCost(
    'gpt-5.6-sol',
    tokens({ input: 272_001 }),
    '2026-08-23T01:00:00.000Z',
  );
  assert.ok(result);
  closeTo(result.amount, 272_001 * 8 / 1_000_000);
});

test('gpt-5.6-sol prices input, cached input, cache write, and output independently', () => {
  const short = calculateModelUsageCost(
    'gpt-5.6-sol',
    tokens({ input: 100_000, cacheRead: 20_000, cacheWrite: 10_000, output: 5_000 }),
    '2026-08-23T01:00:00.000Z',
  );
  assert.ok(short);
  closeTo(short.amount, 0.4 + 0.008 + 0.05 + 0.1);

  const long = calculateModelUsageCost(
    'gpt-5.6-sol',
    tokens({ input: 200_000, cacheRead: 50_000, cacheWrite: 30_001, output: 10_000 }),
    '2026-08-23T01:00:00.000Z',
  );
  assert.ok(long);
  closeTo(long.amount, 1.6 + 0.04 + 0.30001 + 0.3);
});

test('DeepSeek keeps cache-write-as-miss and Beijing peak/off-peak behavior', () => {
  const usage = tokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 });
  const peak = calculateModelUsageCost('deepseek-v4-pro', usage, '2026-08-23T01:30:00.000Z');
  const off = calculateModelUsageCost('deepseek-v4-pro', usage, '2026-08-23T05:00:00.000Z');
  assert.ok(peak);
  assert.ok(off);
  closeTo(peak.amount, 45.3);
  closeTo(peak.peakAmount, 45.3);
  closeTo(peak.offPeakAmount, 0);
  closeTo(off.amount, 22.65);
  closeTo(off.offPeakAmount, 22.65);
});

test('unknown models are not priced', () => {
  assert.equal(calculateModelUsageCost('unknown-model', tokens({ input: 1 }), '2026-08-23T00:00:00Z'), null);
});
