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
