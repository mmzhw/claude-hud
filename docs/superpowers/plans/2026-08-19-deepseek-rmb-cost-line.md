# DeepSeek 人民币费用行集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `~/.claude/scripts/usage-statusline.mjs` 的 DeepSeek 人民币费用统计（会话/今日/本月、峰谷分时计价、按模型拆分）内置进 claude-hud fork，替代 statusline.sh 串接。

**Architecture:** 三个新模块：`src/deepseek-pricing.ts`（定价纯函数，端口 deepseek-pricing.mjs）、`src/usage-stats.ts`（增量扫描状态机，端口 usage-statusline.mjs + 新增 perModel 拆分）、`src/render/lines/rmb-cost.ts`（费用行渲染）。`display.showRmbCost` 开启时由 `render/index.ts` 在两种布局末尾追加费用行；开启时抑制现有美元 cost 段。状态文件复用 `~/.claude/scripts/.usage-state.json`。

**Tech Stack:** TypeScript 5 / NodeNext / ESM；测试 node:test（`tests/*.test.js` 从 `dist/` 导入，`npm test` 先构建后跑测试）。

**设计文档：** `docs/superpowers/specs/2026-08-19-cost-display-design.md`（本计划的唯一需求来源）

**仓库约定：** commit message 用中文，**不加** Co-Authored-By 尾注。测试运行方式：单文件 `npm run build && node --test tests/<file>.test.js`；全量 `npm test`。

---

### Task 1: 计价纯函数模块 src/deepseek-pricing.ts

**Files:**
- Create: `src/deepseek-pricing.ts`
- Test: `tests/deepseek-pricing.test.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/deepseek-pricing.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beijingDate,
  costOfTokens,
  displayNameOf,
  isPeak,
  sessionOfFile,
  tokenSplit,
} from '../dist/deepseek-pricing.js';

test('isPeak 北京高峰时段边界（9-12、14-18）', () => {
  // 北京时间 = UTC + 8
  assert.equal(isPeak('2026-08-19T01:00:00.000Z'), true); // 北京 09:00
  assert.equal(isPeak('2026-08-19T03:59:59.000Z'), true); // 北京 11:59:59
  assert.equal(isPeak('2026-08-19T04:00:00.000Z'), false); // 北京 12:00
  assert.equal(isPeak('2026-08-19T06:00:00.000Z'), true); // 北京 14:00
  assert.equal(isPeak('2026-08-19T09:59:59.000Z'), true); // 北京 17:59:59
  assert.equal(isPeak('2026-08-19T10:00:00.000Z'), false); // 北京 18:00
  assert.equal(isPeak('2026-08-18T16:30:00.000Z'), false); // 北京 8-19 00:30（凌晨）
  assert.equal(isPeak('invalid'), false);
});

test('beijingDate 跨时区取北京日期', () => {
  assert.equal(beijingDate('2026-08-18T16:30:00.000Z'), '2026-08-19'); // UTC 前一天 16:30 → 北京次日
  assert.equal(beijingDate('2026-08-19T00:00:00.000Z'), '2026-08-19');
});

test('tokenSplit 提取计费 token 分类', () => {
  assert.deepEqual(tokenSplit({}), { miss: 0, hit: 0, out: 0 });
  assert.deepEqual(
    tokenSplit({
      input_tokens: 100,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 20,
      output_tokens: 30,
    }),
    { miss: 105, hit: 20, out: 30 },
  );
});

test('costOfTokens 按峰谷价计价', () => {
  const t = { miss: 1_000_000, hit: 1_000_000, out: 1_000_000 };
  // pro 高峰：9 + 0.3 + 27；空闲：4.5 + 0.15 + 13.5
  assert.ok(Math.abs(costOfTokens('deepseek-v4-pro', t, true) - 36.3) < 1e-9);
  assert.ok(Math.abs(costOfTokens('deepseek-v4-pro', t, false) - 18.15) < 1e-9);
  // flash 空闲：1.5 + 0.05 + 4.5
  assert.ok(Math.abs(costOfTokens('deepseek-v4-flash', t, false) - 6.05) < 1e-9);
  assert.equal(costOfTokens('unknown-model', t, true), null);
});

test('displayNameOf 用计价表短写，未知模型回退原始名', () => {
  assert.equal(displayNameOf('deepseek-v4-pro'), 'pro');
  assert.equal(displayNameOf('deepseek-v4-flash'), 'flash');
  assert.equal(displayNameOf('other-model'), 'other-model');
});

test('sessionOfFile 子代理归父会话，主会话用记录 id 或文件名', () => {
  const sub = 'C:/Users/u/.claude/projects/proj-a/sess-1/subagents/agent-x.jsonl';
  assert.equal(sessionOfFile(sub, 'agent-x'), 'sess-1');
  const main = 'C:/Users/u/.claude/projects/proj-a/sess-1.jsonl';
  assert.equal(sessionOfFile(main, 'sess-1'), 'sess-1');
  assert.equal(sessionOfFile(main, null), 'sess-1');
  // Unix 风格路径同样成立
  assert.equal(sessionOfFile('/home/u/.claude/projects/p/s2/subagents/a.jsonl', 'a'), 's2');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test tests/deepseek-pricing.test.js`
Expected: FAIL — `Cannot find module 'D:\code\others\claude-hud\dist\deepseek-pricing.js'`

- [ ] **Step 3: 写实现**

创建 `src/deepseek-pricing.ts`：

```ts
// DeepSeek V4 系列计费配置（从 ~/.claude/scripts/deepseek-pricing.mjs 移植，口径保持一致）
// 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 高峰时段：北京时间 9:00-12:00、14:00-18:00，其余为空闲时段（空闲价 = 高峰价的一半）
// 峰谷分时计价自 2026-08-17 起生效（北京时间），此前的记录按旧价格体系计费，统计时过滤
// 价格单位：元 / 百万 tokens
//
// 换模型：在 PRICES_RMB_PER_MILLION 加条目即可（displayName 为费用行短写），
// 状态机与渲染均为动态遍历，无需改其他代码。无峰谷价的模型把 peak/off 填同值即可。

/** 高峰时段窗口（北京时间小时，[起始, 结束)） */
export const PEAK_WINDOWS_BEIJING: Array<[number, number]> = [
  [9, 12],
  [14, 18],
];

/** 单个模型的峰谷单价（元 / 百万 tokens） */
export interface ModelRmbPricing {
  /** 费用行显示用短写（如 deepseek-v4-pro → pro）；缺省时显示原始模型名 */
  displayName?: string;
  cacheHit: { peak: number; off: number };
  cacheMiss: { peak: number; off: number };
  output: { peak: number; off: number };
}

/** 各模型单价（元 / 百万 tokens），键为转录里记录的原始模型名 */
export const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing> = {
  'deepseek-v4-pro': {
    displayName: 'pro',
    cacheHit: { peak: 0.3, off: 0.15 },
    cacheMiss: { peak: 9.0, off: 4.5 },
    output: { peak: 27.0, off: 13.5 },
  },
  'deepseek-v4-flash': {
    displayName: 'flash',
    cacheHit: { peak: 0.1, off: 0.05 },
    cacheMiss: { peak: 3.0, off: 1.5 },
    output: { peak: 9.0, off: 4.5 },
  },
};

/** 峰谷分时计价的生效日期（北京时间，含当天）；此前的记录按旧价格体系计费，统计时过滤 */
export const PRICING_EFFECTIVE_DATE = '2026-08-17';

/** 计费 token 分类（Anthropic 口径 usage 提取结果） */
export interface TokenSplit {
  /** 缓存未命中（含 cache_creation；DeepSeek 不单独计缓存写入） */
  miss: number;
  /** 缓存命中 */
  hit: number;
  /** 输出 */
  out: number;
}

/**
 * 从转录文件路径推导所属会话 id：
 * - 主会话文件：projects/<项目>/<sessionId>.jsonl → 记录自带的 sessionId（或文件名）
 * - 子代理文件：projects/<项目>/<sessionId>/subagents/*.jsonl → 归属父会话 <sessionId>
 *   （子代理记录自带的 sessionId 是子代理自己的 id，不能直接用）
 */
export function sessionOfFile(file: string, recordSessionId?: string | null): string | null {
  const parts = file.split(/[\\/]/);
  const idx = parts.indexOf('subagents');
  if (idx > 0) return parts[idx - 1];
  if (recordSessionId) return recordSessionId;
  const base = parts[parts.length - 1];
  return base.endsWith('.jsonl') ? base.slice(0, -6) : null;
}

/** 判断一个 UTC 时间戳是否落在北京高峰时段 */
export function isPeak(utcTimestamp: string): boolean {
  const d = new Date(utcTimestamp);
  if (Number.isNaN(d.getTime())) return false;
  const bj = new Date(d.getTime() + 8 * 3600_000);
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return PEAK_WINDOWS_BEIJING.some(([start, end]) => hour >= start && hour < end);
}

/** UTC 时间戳对应的北京日期 YYYY-MM-DD（跨时区按天分组用） */
export function beijingDate(utcTimestamp: string): string {
  return new Date(new Date(utcTimestamp).getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * 从 Anthropic 口径的 usage 提取计费 token 分类
 * - 缓存未命中 = input_tokens（不含缓存读）；DeepSeek 不单独计缓存写入，
 *   cache_creation 正常为 0，若出现按未命中价计入，避免漏计费
 * - 缓存命中 = cache_read_input_tokens
 */
export function tokenSplit(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): TokenSplit {
  return {
    miss: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    hit: usage.cache_read_input_tokens ?? 0,
    out: usage.output_tokens ?? 0,
  };
}

/**
 * 计算费用（元）
 * @param model 原始模型名（如 deepseek-v4-pro）
 * @param t token 分类（见 tokenSplit）
 * @param peak 是否高峰时段
 * @returns 未知模型无法计价时返回 null
 */
export function costOfTokens(model: string, t: TokenSplit, peak: boolean): number | null {
  const p = PRICES_RMB_PER_MILLION[model];
  if (!p) return null;
  const key = peak ? 'peak' : 'off';
  return (t.miss * p.cacheMiss[key] + t.hit * p.cacheHit[key] + t.out * p.output[key]) / 1_000_000;
}

/** 模型显示名：计价表 displayName 短写，缺省用原始模型名 */
export function displayNameOf(model: string): string {
  return PRICES_RMB_PER_MILLION[model]?.displayName ?? model;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test tests/deepseek-pricing.test.js`
Expected: PASS（6 个测试全通过）

- [ ] **Step 5: 提交**

```bash
git add src/deepseek-pricing.ts tests/deepseek-pricing.test.js
git commit -m "feat(cost): 新增 DeepSeek 峰谷计价纯函数模块"
```

---

### Task 2: 增量扫描状态机 src/usage-stats.ts

**Files:**
- Create: `src/usage-stats.ts`
- Test: `tests/usage-stats.test.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/usage-stats.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// 基准"当前时间"：2026-08-19 北京 14:00（当天空闲时段）
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

test('跨天清零今日、保留本月', async () => {
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test tests/usage-stats.test.js`
Expected: FAIL — `Cannot find module 'D:\code\others\claude-hud\dist\usage-stats.js'`

- [ ] **Step 3: 写实现**

创建 `src/usage-stats.ts`：

```ts
// DeepSeek 人民币费用统计：增量扫描 ~/.claude/projects/**/*.jsonl 转录，
// 状态文件记录每个转录已消费的字节偏移，每次触发只解析新增内容。
// 从 ~/.claude/scripts/usage-statusline.mjs 移植（口径保持一致），新增按模型拆分。
//
// 计费口径：同一次 API 响应因流式输出会拆成多条 assistant 记录（中间分片 output 为 0），
//   按 message.id 去重——已见过的消息再次出现时，先扣回旧分片再计入更完整的分片，
//   保证跨多次触发也能还原 DeepSeek 实际计费。
// 会话归属：主会话文件 projects/<项目>/<sessionId>.jsonl 归该会话；
//   子代理文件 <sessionId>/subagents/*.jsonl 归父会话（会话花费含子代理）。
//   会话切换（新会话 id）时只重置会话累计、不清偏移（新会话转录尚无已消费记录）。
// 本月累计：monthTotal 跨天持久累加，文件偏移跨天不清零（漏开机的天数由增量消费自然补齐）；
//   新月或旧版本状态时偏移置空、全量重读本月记录一次（一次性回溯）。
// 计价生效日期：峰谷分时计价自 2026-08-17 起生效，之前的记录过滤不计入；
//   状态里记录 pricingEra，生效日期常量变更时自动整体重建，避免旧数据残留。
//
// 配置：display.showRmbCost 开启后由 render/index.ts 调用（渲染见 render/lines/rmb-cost.ts）。
// 注意：转录 JSONL 是内部格式，字段可能随 Claude Code 版本变化；任何异常只影响费用行本身。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  beijingDate,
  costOfTokens,
  isPeak,
  PRICING_EFFECTIVE_DATE,
  sessionOfFile,
  tokenSplit,
  type TokenSplit,
} from './deepseek-pricing.js';

/** 状态文件版本：v2 起各层累计带 perModel 字段、msgs 记录带 model；旧版本状态整体重建一次 */
const STATE_VERSION = 2;

/** 单层累计（今日/本月/会话）：token 分类 + 峰谷费用 */
export interface CostBucket {
  miss: number;
  hit: number;
  out: number;
  costPeak: number;
  costOff: number;
}

/** 带按模型拆分的一层累计 */
interface ScopeState extends CostBucket {
  perModel: Record<string, CostBucket>;
}

/** msgs 中已消费分片的记录（跨扫描去重用） */
interface MsgState extends TokenSplit {
  peak: boolean;
  cost: number;
  date: string; // 北京日期 YYYY-MM-DD
  month: string; // YYYY-MM
  session: string | null; // 归属会话 id
  model: string;
}

/** 状态文件结构（与 usage-statusline.mjs 原格式兼容，新增 stateV/perModel/model 字段） */
interface UsageStateFile {
  stateV: number;
  month: string;
  date: string;
  pricingEra: string;
  sessionId: string | null;
  totals: ScopeState;
  monthTotal: ScopeState;
  sessionTotals: ScopeState;
  files: Record<string, number>;
  msgs: Record<string, MsgState>;
}

export interface UsageStatsOptions {
  /** 当前会话 id（stdin.session_id）；null 时不统计会话层 */
  sessionId?: string | null;
  /** 转录根目录；默认 <claude 配置目录>/projects */
  projectsRoot?: string;
  /** 状态文件路径；默认 <claude 配置目录>/scripts/.usage-state.json（目录自动创建） */
  stateFile?: string;
  /** 当前 UTC ISO 时间（测试注入；默认取系统时间） */
  now?: string;
}

export interface UsageStatsResult {
  today: CostBucket;
  month: CostBucket;
  session: CostBucket;
  todayPerModel: Record<string, CostBucket>;
  monthPerModel: Record<string, CostBucket>;
  sessionPerModel: Record<string, CostBucket>;
  sessionId: string | null;
}

/** Claude 配置目录（与现有脚本的 CLAUDE_CONFIG_DIR 口径一致） */
function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

function zeroBucket(): CostBucket {
  return { miss: 0, hit: 0, out: 0, costPeak: 0, costOff: 0 };
}

function zeroScope(): ScopeState {
  return { ...zeroBucket(), perModel: {} };
}

function freshState(month: string, date: string, sessionId: string | null): UsageStateFile {
  return {
    stateV: STATE_VERSION,
    month,
    date,
    pricingEra: PRICING_EFFECTIVE_DATE,
    sessionId,
    totals: zeroScope(),
    monthTotal: zeroScope(),
    sessionTotals: zeroScope(),
    files: {},
    msgs: {},
  };
}

/**
 * 加载状态：
 * - 同月内跨天：只清零今日累计，文件偏移与本月累计保留（漏掉的天数由增量消费补齐）
 * - 会话切换：只重置会话累计（新会话的转录此前尚未消费，无需回溯）
 * - 新月、旧版本状态、计价生效日期变更或首次启用会话统计：整体重建
 *   （偏移置空，触发全量重读的一次性回溯）
 */
function loadState(stateFile: string, today: string, month: string, sessionId: string | null): UsageStateFile {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s = JSON.parse(raw) as Partial<UsageStateFile>;
    if (
      s?.stateV === STATE_VERSION
      && s.pricingEra === PRICING_EFFECTIVE_DATE
      && s.month === month
      && (sessionId == null || s.sessionId === undefined || s.sessionId === sessionId)
    ) {
      if (sessionId != null && s.sessionId === undefined) {
        // 首次启用会话统计：整体重建，回溯当前会话的历史记录
        return freshState(month, today, sessionId);
      }
      let out = s as UsageStateFile;
      if (s.date !== today) {
        out = { ...out, date: today, totals: zeroScope() };
      }
      if (sessionId != null && s.sessionId !== sessionId) {
        // 新会话：仅重置会话累计
        out = { ...out, sessionId, sessionTotals: zeroScope() };
      }
      return out;
    }
  } catch {
    // 状态文件损坏或不存在 → 重建
  }
  return freshState(month, today, sessionId);
}

/** 递归收集所有 jsonl 转录文件（目录不存在时返回空数组） */
function collectJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonl(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** 按符号累加/扣回一层累计（sign=1 计入，sign=-1 扣回），同步维护 perModel 拆分 */
function applyToScope(
  scope: ScopeState,
  sign: 1 | -1,
  t: TokenSplit,
  cost: number,
  peak: boolean,
  model: string,
): void {
  scope.miss += sign * t.miss;
  scope.hit += sign * t.hit;
  scope.out += sign * t.out;
  if (peak) scope.costPeak += sign * cost;
  else scope.costOff += sign * cost;

  const bucket = scope.perModel[model] ?? (scope.perModel[model] = zeroBucket());
  bucket.miss += sign * t.miss;
  bucket.hit += sign * t.hit;
  bucket.out += sign * t.out;
  if (peak) bucket.costPeak += sign * cost;
  else bucket.costOff += sign * cost;
}

/** 原子写入状态文件（tmp + rename，避免并发触发时写坏） */
function persistState(stateFile: string, state: UsageStateFile): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  } catch {
    // 写失败不影响本次结果：下次触发会从旧偏移重读，message.id 去重保证不重复计费
  }
}

/**
 * 增量扫描转录并更新状态，返回今日/本月/会话三层累计（含按模型拆分）。
 * 任何异常返回 null（调用方显示占位），不影响 HUD 其他行。
 */
export function updateUsageStats(options: UsageStatsOptions = {}): UsageStatsResult | null {
  try {
    const now = options.now ?? new Date().toISOString();
    const today = beijingDate(now);
    const month = today.slice(0, 7);
    const sessionId = options.sessionId ?? null;
    const stateFile = options.stateFile ?? path.join(defaultConfigDir(), 'scripts', '.usage-state.json');
    const projectsRoot = options.projectsRoot ?? path.join(defaultConfigDir(), 'projects');

    const state = loadState(stateFile, today, month, sessionId);

    // 消费单行转录：只统计本月、能计价的 assistant 记录（按 message.id 去重取最完整分片）
    const consumeLine = (line: string, file: string): void => {
      let record: {
        type?: string;
        timestamp?: string;
        sessionId?: string;
        message?: {
          id?: string;
          model?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
      };
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      if (record?.type !== 'assistant' || !record?.message?.usage || !record?.timestamp) return;
      const date = beijingDate(record.timestamp);
      if (date < PRICING_EFFECTIVE_DATE) return; // 新价格体系生效前的记录不计入
      if (date.slice(0, 7) !== state.month) return; // 非本月记录（回溯时会读到历史数据）
      const id = record.message.id;
      if (!id) return; // 无 message.id 的记录无法去重，跳过避免重复计费
      const peak = isPeak(record.timestamp);
      const t = tokenSplit(record.message.usage);
      const model = typeof record.message.model === 'string' && record.message.model
        ? record.message.model
        : 'unknown';
      const cost = costOfTokens(model, t, peak);
      if (cost == null) return;
      const session = sessionOfFile(file, record.sessionId);

      const old = state.msgs[id];
      if (old && t.out <= old.out) return; // 旧分片已完整，忽略重复/更旧的分片
      if (old) {
        // 同一消息的更新分片：先扣回旧贡献（跨天/跨会话分片只影响对应累计）
        if (old.date === today) {
          applyToScope(state.totals, -1, old, old.cost, old.peak, old.model);
        }
        if (old.month === state.month) {
          applyToScope(state.monthTotal, -1, old, old.cost, old.peak, old.model);
        }
        if (old.session === state.sessionId) {
          applyToScope(state.sessionTotals, -1, old, old.cost, old.peak, old.model);
        }
      }
      state.msgs[id] = { ...t, peak, cost, date, month, session, model };

      // 本月累计：始终计入
      applyToScope(state.monthTotal, 1, t, cost, peak, model);
      // 今日累计：仅当天记录计入
      if (date === today) {
        applyToScope(state.totals, 1, t, cost, peak, model);
      }
      // 会话累计：仅当前会话（含其子代理）计入
      if (session === state.sessionId) {
        applyToScope(state.sessionTotals, 1, t, cost, peak, model);
      }
    };

    for (const file of collectJsonl(projectsRoot)) {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      let offset = state.files[file] ?? 0;
      if (offset > size) offset = 0; // 文件被截断/重建，从头重读
      if (offset === size) continue;

      let chunk: string;
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch {
        continue;
      }

      // 只处理完整行；末尾不完整的行留到下次触发时重试，避免读到半个 JSON
      const parts = chunk.split('\n');
      const complete = chunk.endsWith('\n') ? parts.length : parts.length - 1;
      let consumed = 0;
      for (let i = 0; i < complete; i += 1) {
        consumeLine(parts[i], file);
        consumed += Buffer.byteLength(parts[i], 'utf8') + 1;
      }
      state.files[file] = offset + consumed;
    }

    persistState(stateFile, state);

    return {
      today: state.totals,
      month: state.monthTotal,
      session: state.sessionTotals,
      todayPerModel: state.totals.perModel,
      monthPerModel: state.monthTotal.perModel,
      sessionPerModel: state.sessionTotals.perModel,
      sessionId: state.sessionId,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test tests/usage-stats.test.js`
Expected: PASS（10 个测试全通过）

- [ ] **Step 5: 提交**

```bash
git add src/usage-stats.ts tests/usage-stats.test.js
git commit -m "feat(cost): 新增增量扫描状态机（今日/本月/会话三层累计 + 按模型拆分）"
```

---

### Task 3: 费用行渲染 src/render/lines/rmb-cost.ts

**Files:**
- Create: `src/render/lines/rmb-cost.ts`
- Test: `tests/rmb-cost.test.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/rmb-cost.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRmbCostLine } from '../dist/render/lines/rmb-cost.js';

const bucket = (costPeak, costOff) => ({ miss: 0, hit: 0, out: 0, costPeak, costOff });

function stats(overrides = {}) {
  return {
    today: bucket(3.5, 0),
    month: bucket(145.26, 0),
    session: bucket(7.52, 0),
    todayPerModel: {
      'deepseek-v4-pro': bucket(3.0, 0),
      'deepseek-v4-flash': bucket(0.5, 0),
    },
    monthPerModel: {},
    sessionPerModel: {},
    sessionId: 'sess-1',
    ...overrides,
  };
}

test('双模型拆分 + 峰谷 + 会话完整格式', () => {
  assert.equal(
    renderRmbCostLine(stats()),
    '⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('单模型时括号只含该模型', () => {
  assert.equal(
    renderRmbCostLine(stats({ todayPerModel: { 'deepseek-v4-pro': bucket(3.5, 0) } })),
    '⚡今¥3.50(pro¥3.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('无按模型数据时省略括号', () => {
  assert.equal(
    renderRmbCostLine(stats({ todayPerModel: {} })),
    '⚡今¥3.50 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('峰谷为零时省略峰/谷段', () => {
  assert.equal(
    renderRmbCostLine(stats({ today: bucket(0, 0), todayPerModel: {} })),
    '⚡今¥0.00 月¥145.26 会话¥7.52',
  );
});

test('无会话 id 时省略会话段', () => {
  assert.equal(
    renderRmbCostLine(stats({ sessionId: null })),
    '⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26',
  );
});

test('统计异常显示占位', () => {
  assert.equal(renderRmbCostLine(null), '⚡费用统计异常');
});

test('空闲时段费用显示谷段', () => {
  assert.equal(
    renderRmbCostLine(stats({ today: bucket(0, 2.5), todayPerModel: { 'deepseek-v4-pro': bucket(0, 2.5) } })),
    '⚡今¥2.50(pro¥2.50) 谷¥2.50 月¥145.26 会话¥7.52',
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test tests/rmb-cost.test.js`
Expected: FAIL — `Cannot find module 'D:\code\others\claude-hud\dist\render\lines\rmb-cost.js'`

- [ ] **Step 3: 写实现**

创建 `src/render/lines/rmb-cost.ts`：

```ts
import { displayNameOf } from '../../deepseek-pricing.js';
import type { UsageStatsResult } from '../../usage-stats.js';

/**
 * 渲染 DeepSeek 人民币费用行（display.showRmbCost 开启时由 render/index.ts
 * 在 expanded / compact 两种布局末尾追加）。
 *
 * 格式：⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
 * - 括号内为今日按模型拆分（动态遍历实际出现的模型，用计价表 displayName 短写）
 * - 峰/谷仅非零时显示；会话段仅当前会话有值时显示
 * - stats 为 null（统计异常）时显示占位，不影响 HUD 其他行
 * - 行内文字硬编码中文（个人 fork，与现有脚本显示一致，不进 i18n 表）
 */
export function renderRmbCostLine(stats: UsageStatsResult | null): string {
  if (!stats) {
    return '⚡费用统计异常';
  }

  const todayCost = stats.today.costPeak + stats.today.costOff;
  const monthCost = stats.month.costPeak + stats.month.costOff;
  const sessionCost = stats.session.costPeak + stats.session.costOff;

  let todayPart = `⚡今¥${todayCost.toFixed(2)}`;
  const models = Object.keys(stats.todayPerModel);
  if (models.length > 0) {
    const detail = models
      .map((model) => {
        const bucket = stats.todayPerModel[model];
        const cost = bucket.costPeak + bucket.costOff;
        return `${displayNameOf(model)}¥${cost.toFixed(2)}`;
      })
      .join('/');
    todayPart += `(${detail})`;
  }

  const parts = [todayPart];
  if (stats.today.costPeak > 0) parts.push(`峰¥${stats.today.costPeak.toFixed(2)}`);
  if (stats.today.costOff > 0) parts.push(`谷¥${stats.today.costOff.toFixed(2)}`);
  parts.push(`月¥${monthCost.toFixed(2)}`);
  if (stats.sessionId) parts.push(`会话¥${sessionCost.toFixed(2)}`);
  return parts.join(' ');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test tests/rmb-cost.test.js`
Expected: PASS（7 个测试全通过）

- [ ] **Step 5: 提交**

```bash
git add src/render/lines/rmb-cost.ts tests/rmb-cost.test.js
git commit -m "feat(cost): 新增人民币费用行渲染（按模型拆分）"
```

---

### Task 4: 接线与配置（session_id + showRmbCost + 抑制美元段 + 追加费用行）

**Files:**
- Modify: `src/types.ts`（StdinData 加字段）
- Modify: `src/config.ts`（Display 接口 / DEFAULT_CONFIG / migration 三处）
- Modify: `src/render/lines/cost.ts`（抑制逻辑）
- Modify: `src/render/index.ts`（两种布局末尾追加费用行）
- Test: `tests/config.test.js`（追加 3 个测试）
- Test: `tests/cost-coverage.test.js`（追加 2 个测试）

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.js` 末尾追加（文件顶部已导入 `DEFAULT_CONFIG` 与 `mergeConfig`）：

```js
test('DEFAULT_CONFIG.display.showRmbCost defaults to false', () => {
  assert.equal(DEFAULT_CONFIG.display.showRmbCost, false);
});

test('mergeConfig carries display.showRmbCost true', () => {
  const config = mergeConfig({ display: { showRmbCost: true } });
  assert.equal(config.display.showRmbCost, true);
});

test('mergeConfig falls back when showRmbCost is not boolean', () => {
  const config = mergeConfig({ display: { showRmbCost: 'yes' } });
  assert.equal(config.display.showRmbCost, false);
});
```

在 `tests/cost-coverage.test.js` 顶部导入区追加一行 import（其余 import 保持不变）：

```js
import { renderCostEstimate } from '../dist/render/lines/cost.js';
```

在文件末尾追加：

```js
test('showRmbCost 开启时抑制美元 cost 段', () => {
  const ctx = {
    config: { display: { showCost: true, showRmbCost: true } },
    stdin: { model: { display_name: 'deepseek-v4-pro' }, cost: { total_cost_usd: 0.5 } },
    transcript: { sessionTokens: undefined },
  };
  assert.equal(renderCostEstimate(ctx), null);
});

test('showRmbCost 关闭时美元 cost 段正常渲染', () => {
  const ctx = {
    config: { display: { showCost: true, showRmbCost: false } },
    stdin: { model: { display_name: 'Opus' }, cost: { total_cost_usd: 0.5 } },
    transcript: { sessionTokens: undefined },
  };
  assert.ok(typeof renderCostEstimate(ctx) === 'string');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test tests/config.test.js tests/cost-coverage.test.js`
Expected: FAIL — config 测试：`DEFAULT_CONFIG.display.showRmbCost` 为 undefined，`assert.equal(undefined, false)` 不通过；cost 测试：抑制断言不通过（当前无抑制逻辑，renderCostEstimate 返回非 null）

- [ ] **Step 3: 改 types.ts**

`src/types.ts` 的 `StdinData` 接口，在 `transcript_path?: string;` 之后加：

```ts
  // 会话 id（Claude Code 通过 statusline stdin 提供）。人民币费用统计用它把
  // 子代理转录归属到父会话；被 usage-stats.ts 与 render/index.ts 使用。
  // 注意：readStdin 将整个 stdin JSON 直接 cast 为本接口，无需额外解析逻辑。
  session_id?: string;
```

- [ ] **Step 4: 改 config.ts（三处）**

① Display 接口，在 `showSessionTokens: boolean;` 行之后插入：

```ts
    // DeepSeek 人民币费用行（opt-in，个人 fork 扩展）：会话/今日/本月花费，
    // 峰谷分时计价 + 按模型拆分。开启时自动抑制 showCost 美元段。
    // 价格表见 src/deepseek-pricing.ts；换模型时在表中加条目即可。
    showRmbCost: boolean;
```

② DEFAULT_CONFIG.display，在 `showSessionTokens: false,` 行之后插入：

```ts
    showRmbCost: false,
```

③ migration（`migrateConfig` 内 display 组装），在 `showSessionTokens: ...` 三元块之后插入：

```ts
    showRmbCost: typeof migrated.display?.showRmbCost === 'boolean'
      ? migrated.display.showRmbCost
      : DEFAULT_CONFIG.display.showRmbCost,
```

- [ ] **Step 5: 改 src/render/lines/cost.ts 抑制逻辑**

`renderCostEstimate` 函数开头，在 `showCost` 检查之后插入：

```ts
  // 开启人民币费用行（display.showRmbCost）时抑制美元 cost 段，
  // 避免同屏出现两个矛盾的"费用"
  if (ctx.config?.display?.showRmbCost === true) {
    return null;
  }
```

- [ ] **Step 6: 改 src/render/index.ts 接线**

① 顶部导入区加两行（放在现有 `./lines/index.js` 导入之后）：

```ts
import { updateUsageStats } from '../usage-stats.js';
import { renderRmbCostLine } from './lines/rmb-cost.js';
```

② 在 `render` 函数里，compact 分支的 `lines.push(...activityLines);` 结束、`const physicalLines = ...` 之前插入：

```ts
  // DeepSeek 人民币费用行（opt-in）：增量扫描转录后追加到输出末尾
  if (ctx.config?.display?.showRmbCost === true) {
    const stats = updateUsageStats({ sessionId: ctx.stdin.session_id });
    lines.push(renderRmbCostLine(stats));
  }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm run build && node --test tests/config.test.js tests/cost-coverage.test.js`
Expected: PASS（原有用例 + 新增 5 个全通过）

- [ ] **Step 8: 手动验证接线（模拟状态栏触发）**

Run（Git Bash）：

```bash
npm run build && CLAUDE_CONFIG_DIR="$(mktemp -d)/.claude" node --input-type=module -e "
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const root = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'proj-a');
mkdirSync(root, { recursive: true });
writeFileSync(
  join(root, 'sess-1.jsonl'),
  JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'deepseek-v4-pro', usage: { input_tokens: 1000000, cache_read_input_tokens: 0, output_tokens: 1000000, cache_creation_input_tokens: 0 } }, timestamp: '2026-08-19T05:00:00.000Z', sessionId: 'sess-1' }) + '\n',
);
const { render } = await import('./dist/render/index.js');
render({
  stdin: { session_id: 'sess-1', model: { display_name: 'deepseek-v4-pro' } },
  transcript: {},
  config: { display: { showRmbCost: true } },
});
"
```

Expected: 输出最后一行为 `⚡今¥18.00(pro¥18.00) 谷¥18.00 月¥18.00 会话¥18.00`（北京 13:00 空闲价：miss 4.5 + out 13.5 = 18 元）

- [ ] **Step 9: 提交**

```bash
git add src/types.ts src/config.ts src/render/lines/cost.ts src/render/index.ts tests/config.test.js tests/cost-coverage.test.js
git commit -m "feat(cost): 接入人民币费用行配置与渲染管线"
```

---

### Task 5: 文档与全量回归

**Files:**
- Modify: `README.md`（配置表加一行）
- Modify: `README.zh.md`（配置表加一行）

- [ ] **Step 1: README.md 配置表**

在 `README.md:209`（`display.showRoutedCost` 行）之后插入：

```markdown
| `display.showRmbCost` | boolean | false | Show a DeepSeek RMB cost line (session/today/month totals with peak/off-peak pricing and per-model breakdown). Suppresses the `showCost` USD segment when enabled. Pricing table lives in `src/deepseek-pricing.ts`; add an entry there to support other models |
```

- [ ] **Step 2: README.zh.md 配置表**

在 `README.zh.md:191`（`display.showRoutedCost` 行）之后插入：

```markdown
| `display.showRmbCost` | boolean | false | 显示 DeepSeek 人民币费用行（会话/今日/本月，峰谷分时计价、按模型拆分）。开启时自动抑制 `showCost` 美元段。价格表见 `src/deepseek-pricing.ts`，换模型时加条目即可 |
```

- [ ] **Step 3: 全量回归**

Run: `npm test`
Expected: 全部测试通过（含既有快照/覆盖率测试；若出现既有快照断言失败需人工查看 diff，理论上本次改动不影响既有快照）

- [ ] **Step 4: 提交**

```bash
git add README.md README.zh.md
git commit -m "docs: 补充 display.showRmbCost 配置说明"
```

---

### Task 6: 部署切换（手动执行，不涉及提交）

实现全部完成后，在本机执行（逐项确认）：

1. `npm ci && npm run build` 确保 dist 最新
2. 本地安装 fork 插件：`~/.claude/settings.json` 的 `extraKnownMarketplaces` 加本地 directory 源（指向本仓库），`/plugin` 安装本仓库（记忆已记录路线）
3. 在 `~/.claude/claude-hud.json` 加 `{"display":{"showRmbCost":true}}`（per-directory override 文件，见 config.ts 的 getConfigOverridePath）
4. `~/.claude/settings.json` 的 `statusLine` 从 `statusline.sh` 改回 claude-hud 的 setup 命令（参考备份 `settings.json.bak-20260819`）
5. 重启 Claude Code 会话，验证：状态栏 = HUD 各行 + 末尾 `⚡今¥... 月¥... 会话¥...`，数字与原 statusline.sh 串接方案一致（同一状态文件，应为无缝切换）
6. `statusline.sh` / `usage-statusline.mjs` 停用不删（回滚备用）；`usage-daily.mjs` 报表继续独立使用
7. 验证通过后按用户习惯决定是否推送 fork 到 GitHub

**回滚**：settings.json 的 statusLine 指回 `bash "$HOME/.claude/scripts/statusline.sh"` 即恢复串接方案；状态文件两边兼容（HUD 写的 stateV=2 状态，旧脚本按原字段读取不受影响）。
