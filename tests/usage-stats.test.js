import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { updateUsageStats } from '../dist/usage-stats.js';

/** 构造一条 assistant 转录行（字段口径与 Claude Code 转录一致） */
function assistantLine({ id, model = 'deepseek-v4-pro', ts, miss = 0, hit = 0, out = 0, sessionId }) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      usage: {
        input_tokens: miss,
        cache_read_input_tokens: hit,
        output_tokens: out,
        cache_creation_input_tokens: 0,
      },
    },
    timestamp: ts,
    sessionId,
  }) + '\n';
}

/** 建临时 projects 目录结构，返回 { dir, root, stateFile } */
async function makeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-usage-'));
  const root = path.join(dir, 'projects');
  const stateFile = path.join(dir, 'state', '.usage-state.json');
  await mkdir(root, { recursive: true });
  return { dir, root, stateFile };
}

// 基准"当前时间"：2026-08-19 北京 14:00
const NOW = '2026-08-19T06:00:00.000Z';

test('单条记录计入今日/本月/会话三层累计并维护 perModel 拆分', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      // 北京 13:00 空闲：pro miss 4.5 + out 13.5 = 18 元
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.today.costOff, 18);
    assert.equal(result.today.costPeak, 0);
    assert.equal(result.month.costOff, 18);
    assert.equal(result.session.costOff, 18);
    assert.equal(result.todayPerModel['deepseek-v4-pro'].costOff, 18);

    // 再次触发：偏移推进，不重复计费
    const again = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(again);
    assert.equal(again.today.costOff, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同 message.id 的流式分片按最完整分片计费（跨触发扣回）', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    // 第一次触发：只有中间分片（output=0）
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000, out: 0, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(first);
    const midCost = first.session.costOff; // 1000 * 4.5 / 1e6 = 0.0045

    // 追加完整分片（output=200）后再次触发：扣回旧分片、计入完整分片
    await appendFile(file, assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 2_000, out: 200, sessionId: 'sess-1' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(second);
    const fullCost = (2_000 * 4.5 + 200 * 13.5) / 1e6; // 0.0117
    assert.ok(Math.abs(second.session.costOff - fullCost) < 1e-12);
    assert.ok(Math.abs(second.today.costOff - fullCost) < 1e-12);
    assert.ok(second.session.costOff > midCost);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('高峰时段记录计入 costPeak', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      // 北京 09:30 高峰：miss 1M = 9 元
      assistantLine({ id: 'm1', ts: '2026-08-19T01:30:00.000Z', miss: 1_000_000, out: 0, sessionId: 'sess-1' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.today.costPeak, 9);
    assert.equal(result.today.costOff, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('会话切换只重置会话累计，今日/本月保留', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(first);
    assert.equal(first.session.costOff, 18);

    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-2', now: NOW });
    assert.ok(second);
    assert.equal(second.session.costOff, 0);
    assert.equal(second.today.costOff, 18);
    assert.equal(second.month.costOff, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨天今天桶从零开始、昨天桶留存、本月累计延续', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-19T06:00:00.000Z' });
    assert.ok(first);
    assert.equal(first.today.costOff, 18);

    // 8-20 同月新记录
    await appendFile(file, assistantLine({ id: 'm2', ts: '2026-08-20T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-20T06:00:00.000Z' });
    assert.ok(second);
    assert.equal(second.today.costOff, 18); // 只有 8-20 的记录
    assert.equal(second.month.costOff, 36);
    assert.equal(second.session.costOff, 36);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('计价生效日期前的记录不计入', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-16T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.today.costOff, 0);
    assert.equal(result.month.costOff, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('非本月记录不计入', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-07-30T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.month.costOff, 0);
    assert.equal(result.today.costOff, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('子代理转录按目录归属父会话', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a', 'sess-1', 'subagents'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1', 'subagents', 'agent-x.jsonl'),
      // flash 空闲：miss 1.5 + out 4.5 = 6 元
      assistantLine({ id: 'm1', model: 'deepseek-v4-flash', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'agent-x' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.session.costOff, 6);
    assert.equal(result.today.costOff, 6);
    assert.equal(result.todayPerModel['deepseek-v4-flash'].costOff, 6);

    // 其他会话视角：会话累计为 0，本月保留
    const other = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'other', now: NOW });
    assert.ok(other);
    assert.equal(other.session.costOff, 0);
    assert.equal(other.month.costOff, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('无计价模型的记录跳过不计费', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', model: 'some-other-model', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.session.costOff, 0);
    assert.deepEqual(Object.keys(result.todayPerModel), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('旧版本状态（无 stateV）整体重建后按转录重算', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    // 伪造的旧格式状态：同月同日、pricingEra 正确，但累计是假值且无 stateV
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      month: '2026-08',
      date: '2026-08-19',
      pricingEra: '2026-08-17',
      sessionId: 'sess-1',
      totals: { miss: 999, hit: 0, out: 0, costPeak: 123, costOff: 456 },
      files: {},
      msgs: {},
    }));
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    // 伪造值被整体重建覆盖，按转录重算为 18 元
    assert.equal(result.today.costOff, 18);
    assert.equal(result.month.costOff, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('非法时间戳的记录被跳过而非毒化统计', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: 'not-a-date', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result); // 不返回 null
    assert.equal(result.today.costOff, 0);
    assert.equal(result.month.costOff, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('新月滚动整体重建：上月状态被全量重读覆盖', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    // 伪造的上月状态：stateV/pricingEra 均正确，但 month 为上月 → 触发新月整体重建，偏移置空重读本月记录
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      stateV: 2,
      month: '2026-07',
      date: '2026-07-31',
      pricingEra: '2026-08-17',
      sessionId: 'sess-1',
      totals: { miss: 999, hit: 0, out: 0, costPeak: 123, costOff: 456 },
      files: {},
      msgs: {},
    }));
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    // 伪造的上月累计被整体重建覆盖，按本月转录重算为 18 元
    assert.equal(result.month.costOff, 18);
    assert.equal(result.today.costOff, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨天留存昨天桶：昨天费用进 yesterday，今天费用进 today', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    // 8-19 空闲：pro miss 1M + out 1M = 18 元
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-19T06:00:00.000Z' });
    assert.ok(first);
    assert.equal(first.today.costOff, 18);

    // 8-20 同月新记录：flash 空闲 miss 1M + out 1M = 6 元
    await appendFile(file, assistantLine({ id: 'm2', model: 'deepseek-v4-flash', ts: '2026-08-20T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-20T06:00:00.000Z' });
    assert.ok(second);
    assert.equal(second.today.costOff, 6);      // 只有 8-20 的 flash 记录
    assert.equal(second.yesterday.costOff, 18); // 8-19 的 pro 记录留存为昨天
    assert.equal(second.month.costOff, 24);     // 18 + 6
    assert.equal(second.yesterdayPerModel['deepseek-v4-pro'].costOff, 18);
    assert.equal(second.todayPerModel['deepseek-v4-flash'].costOff, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨天去重扣回按日期落桶：旧分片从昨天桶扣、完整分片进今天桶', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    // 8-19 中间分片（output=0）
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000, out: 0, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-19T06:00:00.000Z' });
    assert.ok(first);

    // 8-20 同一 message.id 的更完整分片（时间戳落在次日）
    await appendFile(file, assistantLine({ id: 'm1', ts: '2026-08-20T05:00:00.000Z', miss: 2_000, out: 200, sessionId: 'sess-1' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-20T06:00:00.000Z' });
    assert.ok(second);
    const fullCost = (2_000 * 4.5 + 200 * 13.5) / 1e6;
    // 昨天的桶扣回旧分片归零；完整分片按新日期计入今天
    assert.equal(second.yesterday.costOff, 0);
    // 昨天桶按模型拆分同步扣回（applyToScope 对称维护 perModel）
    assert.equal(second.yesterdayPerModel['deepseek-v4-pro']?.costOff, 0);
    assert.ok(Math.abs(second.today.costOff - fullCost) < 1e-12);
    assert.ok(Math.abs(second.month.costOff - fullCost) < 1e-12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('昨天无数据时返回零桶与空 perModel（配合渲染显示昨¥0.00）', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    // 首次扫描（昨天没有任何记录）
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    assert.equal(result.today.costOff, 18);
    assert.equal(result.yesterday.costPeak, 0);
    assert.equal(result.yesterday.costOff, 0);
    assert.deepEqual(Object.keys(result.yesterdayPerModel), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 状态升级 v3 整体重建：伪造累计被覆盖、昨天按转录重算', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    // 伪造 v2 状态：stateV=2（有 totals 无 dayTotals），累计为假值
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      stateV: 2,
      month: '2026-08',
      date: '2026-08-19',
      pricingEra: '2026-08-17',
      sessionId: 'sess-1',
      totals: { miss: 999, hit: 0, out: 0, costPeak: 123, costOff: 456, perModel: {} },
      files: {},
      msgs: {},
    }));
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    // 伪造值被整体重建覆盖，按转录重算为 18 元；昨天（8-18）无记录为零桶
    assert.equal(result.today.costOff, 18);
    assert.equal(result.month.costOff, 18);
    assert.equal(result.yesterday.costOff, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('月初跨月搬运昨天桶：9-01 的昨天行保留 8-31 累计', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    // 8-31 北京 13:00 空闲：18 元
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-31T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-31T06:00:00.000Z' });
    assert.ok(first);
    assert.equal(first.today.costOff, 18);

    // 9-01：新月触发整体重建（回放只重读 9 月记录），8-31 桶须靠搬运保留
    await appendFile(file, assistantLine({ id: 'm2', ts: '2026-09-01T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-09-01T06:00:00.000Z' });
    assert.ok(second);
    assert.equal(second.today.costOff, 18);     // 9-01 新记录
    assert.equal(second.yesterday.costOff, 18); // 8-31 桶被搬运保留
    assert.equal(second.month.costOff, 18);     // 9 月只有 9-01 的记录
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨月与会话切换同时发生时昨天桶仍被搬运，会话累计归新会话', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    // 8-31 以 sess-1 建状态
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-31T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-31T06:00:00.000Z' });
    assert.ok(first);
    assert.equal(first.today.costOff, 18);

    // 9-01 以 sess-2 触发：跨月 + 会话切换同时发生（走新月分支，freshState 用新 sessionId）
    await appendFile(file, assistantLine({ id: 'm2', ts: '2026-09-01T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-2' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-2', now: '2026-09-01T06:00:00.000Z' });
    assert.ok(second);
    assert.equal(second.yesterday.costOff, 18); // 8-31 桶仍被搬运
    assert.equal(second.today.costOff, 18);     // 9-01 新记录
    assert.equal(second.session.costOff, 18);   // 会话累计归新会话 sess-2
    assert.equal(second.month.costOff, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('持久化前剪枝：非本月且非日历昨天的桶被移除', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    await writeFile(
      path.join(root, 'proj-a', 'sess-1.jsonl'),
      assistantLine({ id: 'm1', ts: '2026-08-19T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }),
    );
    // 伪造 v3 状态：dayTotals 里塞一个上月残留桶（正常流程只会经搬运产生日历昨天桶）
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      stateV: 3,
      month: '2026-08',
      date: '2026-08-19',
      pricingEra: '2026-08-17',
      sessionId: 'sess-1',
      dayTotals: {
        '2026-07-30': { miss: 1, hit: 0, out: 0, costPeak: 0, costOff: 1, perModel: {} },
      },
      monthTotal: { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0, perModel: {} },
      sessionTotals: { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0, perModel: {} },
      files: {},
      msgs: {},
    }));
    const result = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: NOW });
    assert.ok(result);
    // 本次扫描计入 8-19 桶；上月残留桶被剪掉
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.ok(persisted.dayTotals['2026-08-19']);
    assert.equal(persisted.dayTotals['2026-08-19'].perModel['deepseek-v4-pro'].costOff, 18);
    assert.equal('costOff' in persisted.dayTotals['2026-08-19'], false);
    assert.ok(!('2026-07-30' in persisted.dayTotals));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('月初当天会话切换不回退昨天：9-01 换会话后昨天桶仍保留', async () => {
  const { dir, root, stateFile } = await makeFixture();
  try {
    await mkdir(path.join(root, 'proj-a'), { recursive: true });
    const file = path.join(root, 'proj-a', 'sess-1.jsonl');
    // 8-31 以 sess-1 建状态
    await writeFile(file, assistantLine({ id: 'm1', ts: '2026-08-31T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const first = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-08-31T06:00:00.000Z' });
    assert.ok(first);
    assert.equal(first.today.costOff, 18);

    // 9-01 首次触发：跨月搬运
    await appendFile(file, assistantLine({ id: 'm2', ts: '2026-09-01T05:00:00.000Z', miss: 1_000_000, out: 1_000_000, sessionId: 'sess-1' }));
    const second = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-1', now: '2026-09-01T06:00:00.000Z' });
    assert.ok(second);
    assert.equal(second.yesterday.costOff, 18);

    // 9-01 当天切换会话：同月会话重建，昨天在上月需再次搬运
    const third = updateUsageStats({ projectsRoot: root, stateFile, sessionId: 'sess-2', now: '2026-09-01T07:00:00.000Z' });
    assert.ok(third);
    assert.equal(third.yesterday.costOff, 18); // 8-31 桶不回退
    assert.equal(third.today.costOff, 18);
    assert.equal(third.session.costOff, 0);    // sess-2 无自己会话的记录
    assert.equal(third.month.costOff, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
