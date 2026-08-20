import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRmbCostLine } from '../dist/render/lines/rmb-cost.js';

const bucket = (costPeak, costOff) => ({ miss: 0, hit: 0, out: 0, costPeak, costOff });

function stats(overrides = {}) {
  return {
    today: bucket(3.5, 0),
    yesterday: bucket(1.23, 0),
    month: bucket(145.26, 0),
    session: bucket(7.52, 0),
    todayPerModel: {
      'deepseek-v4-pro': bucket(3.0, 0),
      'deepseek-v4-flash': bucket(0.5, 0),
    },
    yesterdayPerModel: {
      'deepseek-v4-pro': bucket(1.0, 0),
      'deepseek-v4-flash': bucket(0.23, 0),
    },
    monthPerModel: {},
    sessionPerModel: {},
    sessionId: 'sess-1',
    ...overrides,
  };
}

test('两行完整格式：昨天行在上、今天行在下（双模型拆分 + 峰 + 会话）', () => {
  assert.equal(
    renderRmbCostLine(stats()),
    '⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('昨天无数据时显示昨¥0.00，两行结构恒定', () => {
  assert.equal(
    renderRmbCostLine(stats({ yesterday: bucket(0, 0), yesterdayPerModel: {} })),
    '⚡昨¥0.00\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('昨天谷段非零时昨天行显示谷', () => {
  assert.equal(
    renderRmbCostLine(stats({ yesterday: bucket(0, 2.5), yesterdayPerModel: { 'deepseek-v4-pro': bucket(0, 2.5) } })),
    '⚡昨¥2.50(pro¥2.50) 谷¥2.50\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('今天峰谷为零时省略峰/谷段（仅今天行）', () => {
  assert.equal(
    renderRmbCostLine(stats({ today: bucket(0, 0), todayPerModel: {} })),
    '⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥0.00 月¥145.26 会话¥7.52',
  );
});

test('无会话 id 时省略会话段（仅今天行）', () => {
  assert.equal(
    renderRmbCostLine(stats({ sessionId: null })),
    '⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26',
  );
});

test('昨天零桶但有 perModel 条目时显示零额括号（与今天行既有行为一致）', () => {
  assert.equal(
    renderRmbCostLine(stats({ yesterday: bucket(0, 0), yesterdayPerModel: { 'deepseek-v4-pro': bucket(0, 0) } })),
    '⚡昨¥0.00(pro¥0.00)\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('峰谷同时非零时两天各显示两段', () => {
  assert.equal(
    renderRmbCostLine(stats({
      yesterday: bucket(0.8, 0.43),
      yesterdayPerModel: { 'deepseek-v4-pro': bucket(0.8, 0.43) },
      today: bucket(2.0, 1.5),
      todayPerModel: { 'deepseek-v4-pro': bucket(2.0, 1.5) },
    })),
    '⚡昨¥1.23(pro¥1.23) 峰¥0.80 谷¥0.43\n⚡今¥3.50(pro¥3.50) 峰¥2.00 谷¥1.50 月¥145.26 会话¥7.52',
  );
});

test('今天空闲时段费用显示谷段', () => {
  assert.equal(
    renderRmbCostLine(stats({ today: bucket(0, 2.5), todayPerModel: { 'deepseek-v4-pro': bucket(0, 2.5) } })),
    '⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥2.50(pro¥2.50) 谷¥2.50 月¥145.26 会话¥7.52',
  );
});

test('统计异常显示单行占位', () => {
  assert.equal(renderRmbCostLine(null), '⚡费用统计异常');
});
