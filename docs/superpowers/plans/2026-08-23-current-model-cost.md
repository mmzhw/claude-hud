# Current-Model Cost Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DeepSeek-only aggregate cost line with a currency-aware cost line that shows only the current model, including correct OpenAI Standard pricing for `gpt-5.6-sol`.

**Architecture:** Add a generic model-pricing catalog that normalizes model aliases, splits all four billable token classes, and selects time-of-day or context-tiered prices per request. Keep one incremental transcript scanner with per-model state, project the four time scopes onto the current stdin model, and render that selected model in its native currency while preserving legacy configuration entry points.

**Tech Stack:** TypeScript 7 / NodeNext ESM / Node.js 18+ / `node:test`; JSONL transcript fixtures; generated `dist/` artifacts.

**Design spec:** `docs/superpowers/specs/2026-08-23-current-model-cost-design.md`

---

## File map

- Create `src/model-pricing.ts` — generic pricing catalog, model normalization, token splitting, per-request cost calculation, and existing date/time/session pure functions.
- Modify `src/deepseek-pricing.ts` — deprecated compatibility facade retaining the old DeepSeek API.
- Create `tests/model-pricing.test.js` — generic catalog and GPT/DeepSeek pricing tests.
- Modify `src/usage-stats.ts` — v4 per-model-only persisted state, mixed-currency-safe result, and current-model projection.
- Modify `tests/usage-stats.test.js` — adjust persisted-state shape assertion while retaining all DeepSeek regressions.
- Create `tests/usage-stats-models.test.js` — GPT token categories, mixed currencies, state rebuild, and current-model projection.
- Create `src/render/lines/model-cost.ts` — selected-model renderer and currency formatting.
- Modify `src/render/lines/rmb-cost.ts` — thin compatibility re-export.
- Modify `src/render/lines/index.ts` — export the generic renderer.
- Replace `tests/rmb-cost.test.js` with selected-model rendering tests.
- Modify `src/config.ts` — `showModelCost` plus shared legacy-compatible enablement helper.
- Modify `src/render/lines/cost.ts` — suppress the old cost element for either model-cost toggle.
- Modify `src/render/index.ts` — resolve the current stdin model, select its statistics, and append the generic line.
- Modify `tests/config.test.js` and `tests/cost-coverage.test.js` — configuration and suppression tests.
- Modify `tests/render.test.js` — DeepSeek compatibility and GPT current-model integration.
- Modify `README.md`, `README.zh.md`, and `RMB-COST.md` — configuration, model behavior, official-price source, and limitations.
- Generate corresponding `dist/` files with `npm run build` only after the working-tree safety check passes.

---

### Task 0: Protect the existing dirty working tree

**Files:**
- Inspect only: `dist/**`, `src/**`, `tests/**`, `README.md`, `README.zh.md`, `RMB-COST.md`

- [ ] **Step 1: Confirm branch and identify pre-existing changes**

Run:

```bash
git branch --show-current
git status --short
git diff --name-only -- src tests README.md README.zh.md RMB-COST.md
git diff --ignore-space-at-eol --exit-code -- dist
```

Expected:

- branch is `feat/current-model-cost`;
- no uncommitted `src/`, `tests/`, or target documentation changes exist before implementation;
- the last command exits `0` if existing `dist/` modifications are line-ending-only.

If the source/documentation command lists a file or the `dist` command exits non-zero, stop before running any build and report those substantive pre-existing changes to the user. Do not stash, reset, clean, or overwrite them.

- [ ] **Step 2: Record the exact baseline paths for later comparison**

Run:

```bash
git status --short > "$TEMP/claude-hud-current-model-cost-baseline.txt"
```

Expected: the baseline is written outside the repository. This file contains paths/status only, not file contents or credentials.

---

### Task 1: Add the generic pricing catalog and DeepSeek facade

**Files:**
- Create: `src/model-pricing.ts`
- Modify: `src/deepseek-pricing.ts`
- Create: `tests/model-pricing.test.js`
- Existing compatibility test: `tests/deepseek-pricing.test.js`

- [ ] **Step 1: Write the failing generic pricing tests**

Create `tests/model-pricing.test.js`:

```js
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
  closeTo(peak.amount, 45.3); // input 9 + write 9 + hit .3 + output 27
  closeTo(peak.peakAmount, 45.3);
  closeTo(peak.offPeakAmount, 0);
  closeTo(off.amount, 22.65);
  closeTo(off.offPeakAmount, 22.65);
});

test('unknown models are not priced', () => {
  assert.equal(calculateModelUsageCost('unknown-model', tokens({ input: 1 }), '2026-08-23T00:00:00Z'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build && node --test tests/model-pricing.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/model-pricing.js`.

- [ ] **Step 3: Implement the generic pricing module**

Create `src/model-pricing.ts` with this implementation:

```ts
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
```

- [ ] **Step 4: Replace the DeepSeek module with the compatibility facade**

Replace `src/deepseek-pricing.ts` with:

```ts
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

export const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing> = {
  'deepseek-v4-pro': legacyPricing('deepseek-v4-pro'),
  'deepseek-v4-flash': legacyPricing('deepseek-v4-flash'),
};

export interface TokenSplit {
  miss: number;
  hit: number;
  out: number;
}

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

export { displayNameOf, pricingOrderOf };
```

- [ ] **Step 5: Build and run generic plus compatibility tests**

Run:

```bash
npm run build && node --test tests/model-pricing.test.js tests/deepseek-pricing.test.js
```

Expected: all tests in both files PASS.

- [ ] **Step 6: Commit the pricing catalog**

Run:

```bash
git add src/model-pricing.ts src/deepseek-pricing.ts tests/model-pricing.test.js
git commit -m $'feat(cost): add generic model pricing catalog\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

Expected: commit contains only the two source files and new test file; generated `dist/` remains unstaged for the final build task.

---

### Task 2: Upgrade usage state to per-model v4 data

**Files:**
- Modify: `src/usage-stats.ts:21-392`
- Modify: `tests/usage-stats.test.js:451-482`
- Create: `tests/usage-stats-models.test.js`

- [ ] **Step 1: Write mixed-model and rebuild tests**

Create `tests/usage-stats-models.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveModelPricing } from '../dist/model-pricing.js';
import { selectModelUsage, updateUsageStats } from '../dist/usage-stats.js';

const NOW = '2026-08-23T06:00:00.000Z';

function assistantLine({ id, model, input = 0, read = 0, write = 0, output = 0, sessionId = 'sess-1' }) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        output_tokens: output,
      },
    },
    timestamp: '2026-08-23T05:00:00.000Z',
    sessionId,
  }) + '\n';
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-model-usage-'));
  const root = path.join(dir, 'projects');
  const stateFile = path.join(dir, 'state', '.usage-state.json');
  const project = path.join(root, 'proj');
  await mkdir(project, { recursive: true });
  return { dir, root, stateFile, file: path.join(project, 'sess-1.jsonl') };
}

const closeTo = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
};

test('mixed DeepSeek/GPT usage stays in separate native-currency model buckets', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file,
      assistantLine({ id: 'deepseek', model: 'deepseek-v4-pro', input: 1_000_000, output: 1_000_000 })
      + assistantLine({ id: 'gpt', model: 'gpt-5.6-sol', input: 100_000, read: 20_000, write: 10_000, output: 5_000 }),
    );
    const result = updateUsageStats({ projectsRoot: f.root, stateFile: f.stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.today, null, 'legacy aggregate is null when currencies differ');
    assert.equal(result.todayPerModel['deepseek-v4-pro'].amount, 18);
    closeTo(result.todayPerModel['gpt-5.6-sol'].amount, 0.558);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('current-model projection filters all four scopes without rebuilding', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file,
      assistantLine({ id: 'deepseek', model: 'deepseek-v4-pro', input: 1_000_000, output: 1_000_000 })
      + assistantLine({ id: 'gpt', model: 'gpt-5.6-sol', input: 100_000, output: 5_000 }),
    );
    const result = updateUsageStats({ projectsRoot: f.root, stateFile: f.stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    const gpt = resolveModelPricing('gpt-5.6-sol');
    const deepseek = resolveModelPricing('deepseek-v4-pro');
    assert.ok(gpt);
    assert.ok(deepseek);
    const gptView = selectModelUsage(result, gpt);
    const deepseekView = selectModelUsage(result, deepseek);
    closeTo(gptView.today.amount, 0.5);
    closeTo(gptView.month.amount, 0.5);
    closeTo(gptView.session.amount, 0.5);
    assert.equal(deepseekView.today.amount, 18);
    assert.equal(deepseekView.month.amount, 18);
    assert.equal(deepseekView.session.amount, 18);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('v3 state rebuilds with catalog version and recovers formerly skipped GPT records', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, assistantLine({ id: 'gpt', model: 'gpt-5.6-sol', input: 100_000, output: 5_000 }));
    await mkdir(path.dirname(f.stateFile), { recursive: true });
    await writeFile(f.stateFile, JSON.stringify({
      stateV: 3,
      month: '2026-08',
      date: '2026-08-23',
      pricingEra: '2026-08-17',
      sessionId: 'sess-1',
      dayTotals: {},
      monthTotal: { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0, perModel: {} },
      sessionTotals: { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0, perModel: {} },
      files: { [f.file]: 999_999 },
      msgs: {},
    }));

    const result = updateUsageStats({ projectsRoot: f.root, stateFile: f.stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    closeTo(result.todayPerModel['gpt-5.6-sol'].amount, 0.5);
    const persisted = JSON.parse(await readFile(f.stateFile, 'utf8'));
    assert.equal(persisted.stateV, 4);
    assert.equal(persisted.pricingCatalogVersion, '2026-08-23-gpt56-sol-v1');
    assert.ok(persisted.dayTotals['2026-08-23'].perModel['gpt-5.6-sol']);
    assert.equal('costOff' in persisted.dayTotals['2026-08-23'], false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
npm run build && node --test tests/usage-stats-models.test.js
```

Expected: FAIL because `ModelUsageBucket.amount`, `selectModelUsage`, state v4, and `pricingCatalogVersion` do not exist.

- [ ] **Step 3: Replace usage-state imports and types**

First replace the header comment in `src/usage-stats.ts` with:

```ts
// Currency-aware model cost statistics: incrementally scan Claude Code JSONL
// transcripts once, keep independent per-model buckets, and persist byte offsets.
// Pricing and model normalization live in model-pricing.ts; this module owns only
// transcript scanning, stream-fragment deduplication, time scopes, and state IO.
// Different currencies are never added together. Rendering selects one current
// model from the per-model scopes.
```

Then replace the pricing import and state/type declarations through `UsageStatsResult` with:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeConfigDir } from './claude-config-dir.js';
import {
  PRICING_CATALOG_VERSION,
  beijingDate,
  calculateModelUsageCost,
  resolveModelPricing,
  sessionOfFile,
  splitUsageTokens,
  yesterdayOf,
  type ModelPricing,
  type TokenSplit,
} from './model-pricing.js';

const STATE_VERSION = 4;

/** Legacy same-currency aggregate retained for callers/tests; null means mixed currencies. */
export interface CostBucket {
  miss: number;
  hit: number;
  out: number;
  costPeak: number;
  costOff: number;
}

export interface ModelUsageBucket extends TokenSplit {
  amount: number;
  costPeak: number;
  costOff: number;
}

interface ScopeState {
  perModel: Record<string, ModelUsageBucket>;
}

interface MsgState extends ModelUsageBucket {
  date: string;
  month: string;
  session: string | null;
  model: string;
}

interface UsageStateFile {
  stateV: number;
  month: string;
  date: string;
  pricingCatalogVersion: string;
  sessionId: string | null;
  dayTotals: Record<string, ScopeState>;
  monthTotal: ScopeState;
  sessionTotals: ScopeState;
  files: Record<string, number>;
  msgs: Record<string, MsgState>;
}

export interface UsageStatsOptions {
  sessionId?: string | null;
  projectsRoot?: string;
  stateFile?: string;
  now?: string;
}

export interface UsageStatsResult {
  today: CostBucket | null;
  yesterday: CostBucket | null;
  month: CostBucket | null;
  session: CostBucket | null;
  todayPerModel: Record<string, ModelUsageBucket>;
  yesterdayPerModel: Record<string, ModelUsageBucket>;
  monthPerModel: Record<string, ModelUsageBucket>;
  sessionPerModel: Record<string, ModelUsageBucket>;
  sessionId: string | null;
}

export interface SelectedModelUsageStats {
  model: ModelPricing;
  today: ModelUsageBucket;
  yesterday: ModelUsageBucket;
  month: ModelUsageBucket;
  session: ModelUsageBucket;
  sessionId: string | null;
}
```

- [ ] **Step 4: Replace zero/fresh-state helpers and state validation**

Replace the old zero helpers and `freshState` with:

```ts
function zeroModelBucket(): ModelUsageBucket {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, amount: 0, costPeak: 0, costOff: 0 };
}

function zeroScope(): ScopeState {
  return { perModel: {} };
}

function zeroLegacyBucket(): CostBucket {
  return { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0 };
}

function freshState(month: string, date: string, sessionId: string | null): UsageStateFile {
  return {
    stateV: STATE_VERSION,
    month,
    date,
    pricingCatalogVersion: PRICING_CATALOG_VERSION,
    sessionId,
    dayTotals: {},
    monthTotal: zeroScope(),
    sessionTotals: zeroScope(),
    files: {},
    msgs: {},
  };
}
```

Replace `rebuildCarryingYesterday` and `loadState` with the complete v4 versions:

```ts
function rebuildCarryingYesterday(
  s: Partial<UsageStateFile>,
  month: string,
  today: string,
  sessionId: string | null,
): UsageStateFile {
  const fresh = freshState(month, today, sessionId);
  const yesterdayKey = yesterdayOf(today);
  if (yesterdayKey.slice(0, 7) !== month) {
    const carried = s.dayTotals?.[yesterdayKey];
    if (carried) fresh.dayTotals[yesterdayKey] = carried;
  }
  return fresh;
}

function loadState(stateFile: string, today: string, month: string, sessionId: string | null): UsageStateFile {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s = JSON.parse(raw) as Partial<UsageStateFile>;
    if (
      s?.stateV === STATE_VERSION
      && s.pricingCatalogVersion === PRICING_CATALOG_VERSION
    ) {
      if (s.month !== month) {
        return rebuildCarryingYesterday(s, month, today, sessionId);
      }
      if (sessionId == null || s.sessionId === undefined || s.sessionId === sessionId) {
        if (sessionId != null && s.sessionId === undefined) {
          return rebuildCarryingYesterday(s, month, today, sessionId);
        }
        let out = s as UsageStateFile;
        if (s.date !== today) {
          out = { ...out, date: today };
        }
        return out;
      }
      return rebuildCarryingYesterday(s, month, today, sessionId);
    }
  } catch {
    // Missing or corrupt state is rebuilt from transcript history.
  }
  return freshState(month, today, sessionId);
}
```

The old v3 `pricingEra` field is deliberately absent from the v4 condition, so a v3 file always causes a full replay.

- [ ] **Step 5: Replace scope mutation and add mixed-currency-safe aggregation**

Replace `applyToScope` with:

```ts
function applyToScope(
  scope: ScopeState,
  sign: 1 | -1,
  model: string,
  contribution: ModelUsageBucket,
): void {
  const bucket = scope.perModel[model] ?? (scope.perModel[model] = zeroModelBucket());
  bucket.input += sign * contribution.input;
  bucket.cacheRead += sign * contribution.cacheRead;
  bucket.cacheWrite += sign * contribution.cacheWrite;
  bucket.output += sign * contribution.output;
  bucket.amount += sign * contribution.amount;
  bucket.costPeak += sign * contribution.costPeak;
  bucket.costOff += sign * contribution.costOff;
}

function legacyAggregate(scope: ScopeState): CostBucket | null {
  const entries = Object.entries(scope.perModel);
  if (entries.length === 0) return zeroLegacyBucket();
  const currencies = new Set(entries.map(([model]) => resolveModelPricing(model)?.currency).filter(Boolean));
  if (currencies.size > 1) return null;

  const total = zeroLegacyBucket();
  for (const [, bucket] of entries) {
    total.miss += bucket.input + bucket.cacheWrite;
    total.hit += bucket.cacheRead;
    total.out += bucket.output;
    total.costPeak += bucket.costPeak;
    total.costOff += bucket.costOff;
  }
  return total;
}
```

- [ ] **Step 6: Replace the pricing part of `consumeLine`**

Inside `consumeLine`, retain JSON parsing, month filtering, message-id checks, session ownership, and file-offset logic. Replace the block beginning at the old `const peak = isPeak(...)` through contribution application with:

```ts
const tokens = splitUsageTokens(record.message.usage);
const rawModel = typeof record.message.model === 'string' && record.message.model
  ? record.message.model
  : 'unknown';
const priced = calculateModelUsageCost(rawModel, tokens, record.timestamp);
if (!priced) return;
const model = priced.model.canonicalName;
const session = sessionOfFile(file, record.sessionId);
const contribution: ModelUsageBucket = {
  ...tokens,
  amount: priced.amount,
  costPeak: priced.peakAmount,
  costOff: priced.offPeakAmount,
};

const old = state.msgs[id];
if (old && tokens.output <= old.output) return;
if (old) {
  if (old.month === state.month) {
    applyToScope(state.monthTotal, -1, old.model, old);
  }
  if (old.session === state.sessionId) {
    applyToScope(state.sessionTotals, -1, old.model, old);
  }
  const oldDay = state.dayTotals[old.date] ?? (state.dayTotals[old.date] = zeroScope());
  applyToScope(oldDay, -1, old.model, old);
}

state.msgs[id] = {
  ...contribution,
  date,
  month,
  session,
  model,
};

applyToScope(state.monthTotal, 1, model, contribution);
const day = state.dayTotals[date] ?? (state.dayTotals[date] = zeroScope());
applyToScope(day, 1, model, contribution);
if (session === state.sessionId) {
  applyToScope(state.sessionTotals, 1, model, contribution);
}
```

Remove the old global `PRICING_EFFECTIVE_DATE` filter; `calculateModelUsageCost` applies model-specific effective dates.

- [ ] **Step 7: Return per-model state and add the projection helper**

Replace the final return block and append `selectModelUsage`:

```ts
const todayBucket = state.dayTotals[today] ?? zeroScope();
const yesterdayBucket = state.dayTotals[yesterdayKey] ?? zeroScope();
return {
  today: legacyAggregate(todayBucket),
  yesterday: legacyAggregate(yesterdayBucket),
  month: legacyAggregate(state.monthTotal),
  session: legacyAggregate(state.sessionTotals),
  todayPerModel: todayBucket.perModel,
  yesterdayPerModel: yesterdayBucket.perModel,
  monthPerModel: state.monthTotal.perModel,
  sessionPerModel: state.sessionTotals.perModel,
  sessionId: state.sessionId,
};
```

Add after `updateUsageStats`:

```ts
export function selectModelUsage(stats: UsageStatsResult, model: ModelPricing): SelectedModelUsageStats {
  const pick = (scope: Record<string, ModelUsageBucket>): ModelUsageBucket => (
    scope[model.canonicalName] ?? zeroModelBucket()
  );
  return {
    model,
    today: pick(stats.todayPerModel),
    yesterday: pick(stats.yesterdayPerModel),
    month: pick(stats.monthPerModel),
    session: pick(stats.sessionPerModel),
    sessionId: stats.sessionId,
  };
}
```

- [ ] **Step 8: Update the persisted-state pruning assertion**

In `tests/usage-stats.test.js`, replace:

```js
assert.equal(persisted.dayTotals['2026-08-19'].costOff, 18);
```

with:

```js
assert.equal(persisted.dayTotals['2026-08-19'].perModel['deepseek-v4-pro'].costOff, 18);
assert.equal('costOff' in persisted.dayTotals['2026-08-19'], false);
```

- [ ] **Step 9: Run usage-state tests**

Run:

```bash
npm run build && node --test tests/usage-stats.test.js tests/usage-stats-models.test.js
```

Expected: all existing state-machine tests and all three new model tests PASS.

- [ ] **Step 10: Commit the state upgrade**

Run:

```bash
git add src/usage-stats.ts tests/usage-stats.test.js tests/usage-stats-models.test.js
git commit -m $'feat(cost): track native-currency usage per model\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

---

### Task 3: Render the selected model in its native currency

**Files:**
- Create: `src/render/lines/model-cost.ts`
- Modify: `src/render/lines/rmb-cost.ts`
- Modify: `src/render/lines/index.ts`
- Replace: `tests/rmb-cost.test.js`

- [ ] **Step 1: Replace renderer tests with selected-model cases**

Replace `tests/rmb-cost.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelPricing } from '../dist/model-pricing.js';
import { renderModelCostLine } from '../dist/render/lines/model-cost.js';
import { renderRmbCostLine } from '../dist/render/lines/rmb-cost.js';

const bucket = (amount, costPeak = 0, costOff = 0, tokenCount = 1) => ({
  input: tokenCount,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  amount,
  costPeak,
  costOff,
});

function selected(modelName, overrides = {}) {
  const model = resolveModelPricing(modelName);
  assert.ok(model);
  return {
    model,
    yesterday: bucket(0.12),
    today: bucket(0.37),
    month: bucket(1.84),
    session: bucket(0.92),
    sessionId: 'sess-1',
    ...overrides,
  };
}

test('GPT renders dollars with adaptive precision and no peak/off-peak labels', () => {
  const output = renderModelCostLine({ kind: 'ready', stats: selected('gpt-5.6-sol') });
  assert.equal(
    output,
    '⚡昨$0.120(sol$0.120)\n⚡今$0.370(sol$0.370) 月$1.84 会话$0.920',
  );
  assert.doesNotMatch(output, /峰|谷|¥|pro|flash/);
});

test('DeepSeek renders RMB and peak/off-peak details for only the selected model', () => {
  const output = renderModelCostLine({
    kind: 'ready',
    stats: selected('deepseek-v4-pro', {
      yesterday: bucket(1.23, 0.8, 0.43),
      today: bucket(3.5, 3.5, 0),
      month: bucket(145.26),
      session: bucket(7.52),
    }),
  });
  assert.equal(
    output,
    '⚡昨¥1.23(pro¥1.23) 峰¥0.80 谷¥0.43\n⚡今¥3.50(pro¥3.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
  assert.doesNotMatch(output, /flash|\$/);
});

test('zero day omits the redundant model breakdown', () => {
  assert.equal(
    renderModelCostLine({
      kind: 'ready',
      stats: selected('gpt-5.6-sol', { yesterday: bucket(0, 0, 0, 0) }),
    }),
    '⚡昨$0.0000\n⚡今$0.370(sol$0.370) 月$1.84 会话$0.920',
  );
});

test('missing session id omits only the session segment', () => {
  assert.equal(
    renderModelCostLine({ kind: 'ready', stats: selected('gpt-5.6-sol', { sessionId: null }) }),
    '⚡昨$0.120(sol$0.120)\n⚡今$0.370(sol$0.370) 月$1.84',
  );
});

test('unknown and error states never show stale model costs', () => {
  assert.equal(renderModelCostLine({ kind: 'unknown', modelName: 'gpt-x' }), '⚡gpt-x 暂无计价');
  assert.equal(renderModelCostLine({ kind: 'error' }), '⚡费用统计异常');
});

test('legacy renderer export is the same-signature alias', () => {
  const input = { kind: 'ready', stats: selected('gpt-5.6-sol') };
  assert.equal(renderRmbCostLine(input), renderModelCostLine(input));
});
```

- [ ] **Step 2: Run the renderer test to verify it fails**

Run:

```bash
npm run build && node --test tests/rmb-cost.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/render/lines/model-cost.js`.

- [ ] **Step 3: Implement the generic renderer**

Create `src/render/lines/model-cost.ts`:

```ts
import { formatUsd } from '../../cost.js';
import type { SelectedModelUsageStats, ModelUsageBucket } from '../../usage-stats.js';

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
    todayParts.push(`会话${formatAmount(stats.session.amount, stats)}`);
  }
  return `${yesterdayLine}\n${todayParts.join(' ')}`;
}
```

- [ ] **Step 4: Replace the legacy renderer with a thin alias and export the new renderer**

Replace `src/render/lines/rmb-cost.ts` with:

```ts
export {
  renderModelCostLine,
  renderModelCostLine as renderRmbCostLine,
  type ModelCostRenderInput,
} from './model-cost.js';
```

Append to `src/render/lines/index.ts`:

```ts
export { renderModelCostLine, type ModelCostRenderInput } from './model-cost.js';
```

- [ ] **Step 5: Run renderer tests**

Run:

```bash
npm run build && node --test tests/rmb-cost.test.js
```

Expected: all six renderer tests PASS.

- [ ] **Step 6: Commit the renderer**

Run:

```bash
git add src/render/lines/model-cost.ts src/render/lines/rmb-cost.ts src/render/lines/index.ts tests/rmb-cost.test.js
git commit -m $'feat(cost): render only the selected model currency\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

---

### Task 4: Add the generic toggle and wire current-model selection

**Files:**
- Modify: `src/config.ts:191-291,318-383,850-903`
- Modify: `src/render/lines/cost.ts:1-25`
- Modify: `src/render/index.ts:8-23,653-657`
- Modify: `tests/config.test.js:1304-1316`
- Modify: `tests/cost-coverage.test.js:314-330`

- [ ] **Step 1: Write failing config and suppression tests**

Append to `tests/config.test.js`:

```js
test('DEFAULT_CONFIG.display.showModelCost defaults to false', () => {
  assert.equal(DEFAULT_CONFIG.display.showModelCost, false);
});

test('mergeConfig carries display.showModelCost true', () => {
  assert.equal(mergeConfig({ display: { showModelCost: true } }).display.showModelCost, true);
});

test('mergeConfig rejects non-boolean showModelCost', () => {
  assert.equal(mergeConfig({ display: { showModelCost: 'yes' } }).display.showModelCost, false);
});
```

Append to `tests/cost-coverage.test.js`:

```js
test('showModelCost suppresses the old cost segment', () => {
  const ctx = {
    config: { display: { showCost: true, showModelCost: true, showRmbCost: false } },
    stdin: { model: { display_name: 'gpt-5.6-sol' }, cost: { total_cost_usd: 0.5 } },
    transcript: { sessionTokens: undefined },
  };
  assert.equal(renderCostEstimate(ctx), null);
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
npm run build && node --test tests/config.test.js tests/cost-coverage.test.js
```

Expected: FAIL because `showModelCost` is undefined and does not suppress `renderCostEstimate`.

- [ ] **Step 3: Add config field, default, validation, and shared helper**

In `HudConfig.display`, immediately before `showRmbCost`, add:

```ts
    // Currency-aware per-model cost line. showRmbCost remains a legacy alias.
    showModelCost: boolean;
```

In `DEFAULT_CONFIG.display`, immediately before `showRmbCost`, add:

```ts
    showModelCost: false,
```

In `migrateConfig` immediately before the `showRmbCost` block, add:

```ts
    showModelCost: typeof migrated.display?.showModelCost === 'boolean'
      ? migrated.display.showModelCost
      : DEFAULT_CONFIG.display.showModelCost,
```

After `DEFAULT_CONFIG`, add:

```ts
export function isModelCostEnabled(display?: {
  showModelCost?: boolean;
  showRmbCost?: boolean;
} | null): boolean {
  return display?.showModelCost === true || display?.showRmbCost === true;
}
```

- [ ] **Step 4: Use the shared helper in the old cost element**

Update imports and suppression in `src/render/lines/cost.ts`:

```ts
import type { RenderContext } from '../../types.js';
import { isModelCostEnabled } from '../../config.js';
import { resolveSessionCost, formatUsd } from '../../cost.js';
```

Replace the old `showRmbCost` condition with:

```ts
  if (isModelCostEnabled(ctx.config?.display)) {
    return null;
  }
```

- [ ] **Step 5: Wire model resolution and selected statistics into render**

In `src/render/index.ts`, merge the helper into the existing config import:

```ts
import type { HudElement } from '../config.js';
import { DEFAULT_ELEMENT_ORDER, DEFAULT_MERGE_GROUPS, isModelCostEnabled } from '../config.js';
```

Then replace the old usage/RMB-renderer imports with:

```ts
import { currentModelLabel, resolveCurrentModelPricing } from '../model-pricing.js';
import { selectModelUsage, updateUsageStats } from '../usage-stats.js';
import { renderModelCostLine } from './lines/model-cost.js';
```

Replace the block at the end of `render` with:

```ts
  if (isModelCostEnabled(ctx.config?.display)) {
    const modelName = currentModelLabel(ctx.stdin.model);
    if (modelName) {
      const pricing = resolveCurrentModelPricing(ctx.stdin.model);
      if (!pricing) {
        lines.push(renderModelCostLine({ kind: 'unknown', modelName }));
      } else {
        const stats = updateUsageStats({ sessionId: ctx.stdin.session_id });
        lines.push(renderModelCostLine(
          stats
            ? { kind: 'ready', stats: selectModelUsage(stats, pricing) }
            : { kind: 'error' },
        ));
      }
    }
  }
```

- [ ] **Step 6: Run config and cost tests**

Run:

```bash
npm run build && node --test tests/config.test.js tests/cost-coverage.test.js
```

Expected: all tests PASS, including the existing `showRmbCost` compatibility tests.

- [ ] **Step 7: Commit configuration and wiring**

Run:

```bash
git add src/config.ts src/render/lines/cost.ts src/render/index.ts tests/config.test.js tests/cost-coverage.test.js
git commit -m $'feat(cost): select cost view from current stdin model\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

---

### Task 5: Prove current-model behavior through render integration

**Files:**
- Modify: `tests/render.test.js:4379-4429`

- [ ] **Step 1: Update the legacy DeepSeek integration setup**

In the existing `showRmbCost` integration test, replace:

```js
ctx.stdin = { ...ctx.stdin, session_id: 'sess-1' };
```

with:

```js
ctx.stdin = {
  ...ctx.stdin,
  session_id: 'sess-1',
  model: { id: 'deepseek-v4-pro[1m]', display_name: 'deepseek-v4-pro' },
};
```

This preserves the existing `¥` assertions while proving the legacy toggle selects the current DeepSeek model.

- [ ] **Step 2: Add a GPT mixed-history integration test**

Append to `tests/render.test.js`:

```js
test('showModelCost selects GPT dollars and excludes DeepSeek history', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hud-render-model-cost-'));
  const oldConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    const projectsDir = path.join(tmp, '.claude', 'projects', 'proj-a');
    await mkdir(projectsDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const line = (id, model, usage) => JSON.stringify({
      type: 'assistant',
      message: { id, model, usage },
      timestamp,
      sessionId: 'sess-1',
    }) + '\n';
    await writeFile(
      path.join(projectsDir, 'sess-1.jsonl'),
      line('deepseek', 'deepseek-v4-pro', {
        input_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 1_000_000,
      }) + line('gpt', 'gpt-5.6-sol', {
        input_tokens: 100_000,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 10_000,
        output_tokens: 5_000,
      }),
      'utf8',
    );
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');

    const ctx = baseContext();
    ctx.stdin = {
      ...ctx.stdin,
      session_id: 'sess-1',
      model: { id: 'gpt-5.6-sol[1m]', display_name: 'GPT-5.6 Sol (1M context)' },
    };
    ctx.config.display.showModelCost = true;
    ctx.config.display.showRmbCost = false;
    ctx.config.lineLayout = 'expanded';

    const output = withTerminal(200, () => captureRenderLines(ctx));
    const yesterday = output[output.length - 2];
    const today = output[output.length - 1];
    assert.match(yesterday, /^⚡昨\$/);
    assert.match(today, /^⚡今\$/);
    assert.match(today, /sol\$/);
    assert.doesNotMatch(`${yesterday}\n${today}`, /pro|flash|¥|峰|谷/);
  } finally {
    if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldConfigDir;
    await rm(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run focused render tests**

Run:

```bash
npm run build && node --test tests/render.test.js
```

Expected: the existing DeepSeek expanded/compact integration and new GPT mixed-history integration both PASS.

- [ ] **Step 4: Commit integration coverage**

Run:

```bash
git add tests/render.test.js
git commit -m $'test(cost): cover runtime model switching output\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

---

### Task 6: Update documentation, build artifacts, and run full verification

**Files:**
- Modify: `README.md:210`
- Modify: `README.zh.md:192`
- Modify: `RMB-COST.md:1-87`
- Generate: `dist/model-pricing.js`, `dist/model-pricing.d.ts`, and corresponding changed `dist/` modules

- [ ] **Step 1: Update the English configuration table**

Replace the existing `display.showRmbCost` row in `README.md` with these two rows:

```markdown
| `display.showModelCost` | boolean | false | Show yesterday/today/month/session estimated cost for only the current model, using the model's native currency. Includes DeepSeek RMB peak/off-peak pricing and OpenAI Standard USD pricing for `gpt-5.6-sol`; suppresses the legacy `showCost` segment |
| `display.showRmbCost` | boolean | false | Deprecated compatibility alias for `display.showModelCost`; existing configurations continue to work |
```

- [ ] **Step 2: Update the Chinese configuration table**

Replace the existing `display.showRmbCost` row in `README.zh.md` with:

```markdown
| `display.showModelCost` | boolean | false | 只显示当前模型的昨天/今天/本月/会话估算费用，并使用模型原币种。支持 DeepSeek 人民币峰谷价和 `gpt-5.6-sol` OpenAI Standard 官方美元价；开启时抑制旧 `showCost` 段 |
| `display.showRmbCost` | boolean | false | `display.showModelCost` 的兼容别名；现有配置无需立即修改 |
```

- [ ] **Step 3: Replace the provider-switch guide with the generic model-cost guide**

Rewrite `RMB-COST.md` with these sections and facts:

```markdown
# 当前模型费用行使用指南

本 fork 通过 `display.showModelCost`（或兼容别名 `display.showRmbCost`）扫描 Claude Code 转录，按本地计价目录估算费用。状态栏只显示当前 `stdin.model` 对应模型的昨天、今天、本月和当前会话费用，不会把不同模型或不同币种相加。

## 当前支持

| 模型 | 币种 | 计价方式 | 价格来源 |
|---|---|---|---|
| `deepseek-v4-pro` | CNY | 北京时间峰谷价 | DeepSeek 官方价格页 |
| `deepseek-v4-flash` | CNY | 北京时间峰谷价 | DeepSeek 官方价格页 |
| `gpt-5.6-sol` | USD | OpenAI Standard，按每条请求输入 tokens 的 272K 阈值选择长短上下文价 | OpenAI API Pricing |

`gpt-5.6-sol` 价格核对于 2026-08-23：短上下文每百万 tokens 为 Input $4.00、Cached Input $0.40、Cache Write $5.00、Output $20.00；长上下文为 $8.00、$0.80、$10.00、$30.00。官方注明促销价至少持续到 2026-11-21。

## 配置

```json
{
  "display": {
    "showModelCost": true
  }
}
```

现有 `showRmbCost: true` 继续有效。任一开关开启时，旧 `showCost` 段会被抑制。

## 输出

GPT：

```text
⚡昨$0.120(sol$0.120)
⚡今$0.370(sol$0.370) 月$1.84 会话$0.920
```

DeepSeek：

```text
⚡昨¥1.23(pro¥1.23) 峰¥0.80 谷¥0.43
⚡今¥3.50(pro¥3.50) 峰¥3.50 月¥145.26 会话¥7.52
```

## 模型切换和状态

费用状态保留所有已支持模型的独立桶，渲染时只选择当前模型。切换模型不需要删除状态文件。计价目录或状态版本变化会自动回放本月转录。

## 口径限制

- 金额是本地估算，第三方中转站的渠道价、倍率和实际账单可能不同。
- GPT 使用 Standard 价格，不包含 Batch、Flex、Fast、区域处理附加费或汇率换算。
- `[1m]` 只作为模型别名后缀；每条 GPT 请求仍按实际输入 tokens 是否超过 272K 判档。
- 促销期后需要重新核对 OpenAI 官方价格并更新 `PRICING_CATALOG_VERSION`。
- 转录中未知模型显示“暂无计价”，不会回退显示其他模型费用。

## 价格维护

价格目录位于 `src/model-pricing.ts`。修改任何价格、别名或计价语义时，同时更新 `PRICING_CATALOG_VERSION`，下一次 HUD 触发会自动重建统计。
```

- [ ] **Step 4: Run formatting-neutral build and focused cost suite**

Run:

```bash
npm run build
node --test tests/model-pricing.test.js tests/deepseek-pricing.test.js tests/usage-stats.test.js tests/usage-stats-models.test.js tests/rmb-cost.test.js tests/config.test.js tests/cost-coverage.test.js tests/render.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 5: Run the complete test suite**

Run:

```bash
npm test
```

Expected: exit code `0`; no failed tests. If a test fails, keep this task in progress, report the exact failure, and fix the implementation before continuing.

- [ ] **Step 6: Run a CLI smoke test with isolated GPT history**

Run:

```bash
TMP_ROOT="$(mktemp -d)"
CLAUDE_CONFIG_DIR="$TMP_ROOT/.claude" node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const configDir = process.env.CLAUDE_CONFIG_DIR;
const projects = join(configDir, 'projects', 'proj');
mkdirSync(projects, { recursive: true });
writeFileSync(join(projects, 'sess-1.jsonl'), JSON.stringify({
  type: 'assistant',
  message: {
    id: 'gpt-smoke',
    model: 'gpt-5.6-sol',
    usage: {
      input_tokens: 100000,
      cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 10000,
      output_tokens: 5000,
    },
  },
  timestamp: new Date().toISOString(),
  sessionId: 'sess-1',
}) + '\n');
const { render } = await import('./dist/render/index.js');
const { DEFAULT_CONFIG } = await import('./dist/config.js');
const config = structuredClone(DEFAULT_CONFIG);
config.display.showModelCost = true;
render({
  stdin: {
    session_id: 'sess-1',
    model: { id: 'gpt-5.6-sol[1m]', display_name: 'GPT-5.6 Sol (1M context)' },
  },
  transcript: { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] },
  config,
});
NODE
rm -rf "$TMP_ROOT"
```

Expected: the final two physical lines begin with `⚡昨$` and `⚡今$`; the today line contains `sol$0.558`; output contains no `pro`, `flash`, `¥`, `峰`, or `谷`.

- [ ] **Step 7: Compare final status against the baseline**

Run:

```bash
git status --short
```

Expected: only task source/tests/docs and generated matching `dist/` paths differ in addition to the exact pre-existing baseline paths. No `.claude/`, `AGENTS.md`, settings, credential, or relay-site file is staged.

- [ ] **Step 8: Commit documentation**

Run:

```bash
git add README.md README.zh.md RMB-COST.md docs/superpowers/plans/2026-08-23-current-model-cost.md
git commit -m $'docs(cost): document current-model pricing\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

- [ ] **Step 9: Commit only corresponding generated artifacts**

Run:

```bash
git add \
  dist/model-pricing.js dist/model-pricing.d.ts \
  dist/deepseek-pricing.js dist/deepseek-pricing.d.ts \
  dist/usage-stats.js dist/usage-stats.d.ts \
  dist/config.js dist/config.d.ts \
  dist/render/index.js dist/render/index.d.ts \
  dist/render/lines/cost.js dist/render/lines/cost.d.ts \
  dist/render/lines/model-cost.js dist/render/lines/model-cost.d.ts \
  dist/render/lines/rmb-cost.js dist/render/lines/rmb-cost.d.ts \
  dist/render/lines/index.js dist/render/lines/index.d.ts
git diff --cached --name-only
git commit -m $'build: compile current-model cost artifacts\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

Expected: the cached-name list contains exactly the listed generated modules. Do not use `git add dist` or `git add -A` because the working tree began with unrelated `dist/` modifications.

---

### Task 7: Final review checkpoint

**Files:**
- Review: all files changed by Tasks 1-6

- [ ] **Step 1: Verify branch diff scope**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Expected: design/plan, pricing, usage-state, renderer, configuration, focused tests, documentation, and corresponding generated artifacts only.

- [ ] **Step 2: Re-run final verification after all commits**

Run:

```bash
npm test
```

Expected: exit code `0` and zero failed tests.

- [ ] **Step 3: Request code review**

Invoke `superpowers:requesting-code-review` and provide:

- design spec path;
- implementation plan path;
- base commit before implementation;
- current branch HEAD;
- explicit review focus: mixed-currency isolation, GPT 272K boundary, v3→v4 rebuild, streamed-fragment subtraction, current-model-only rendering, and preservation of pre-existing working-tree changes.

If review reports findings, stop at this checkpoint and follow `superpowers:receiving-code-review` before modifying code; completion requires a subsequent focused regression test and `npm test` pass for every confirmed finding.
