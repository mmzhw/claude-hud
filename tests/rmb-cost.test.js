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
