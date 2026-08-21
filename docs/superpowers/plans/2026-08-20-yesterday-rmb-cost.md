# 昨天 + 今天两行人民币费用显示 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `display.showRmbCost` 开启时状态栏输出昨天 + 今天两行人民币费用（昨天行在上，无数据显示 `昨¥0.00`）。

**Architecture:** 把 `usage-stats.ts` 状态机的单日累计 `totals` 升级为按北京日期为键的 `dayTotals` map（stateV 2 → 3，旧状态自动重建一次）；扫描时记录按自身日期落桶、去重扣回按旧分片日期扣；月初跨月时把"日历昨天"的桶搬进新状态（回放只重读本月记录）；渲染层 `rmb-cost.ts` 抽公共构建函数输出两行。

**Tech Stack:** TypeScript 5（ES2022, NodeNext）、Node 18+、node:test 断言、测试 JS 文件 import `dist/` 构建产物（先 build 再跑测试）。

**设计文档（唯一需求来源）：** `docs/superpowers/specs/2026-08-20-yesterday-rmb-cost-design.md`

**提交规范（用户全局规则）：** commit message 用中文，**不加 Co-Authored-By 尾注**；`git add` 只加明确列出的文件（不用 `-A`）；docs/ 目录与根目录未跟踪的 RMB-COST.md 不提交。

**测试基线：** 全量 `npm test` 有 34 个环境相关既有失败（与本改动无关）。每个任务只跑相关测试文件；最后 Task 7 跑全量对比基线。

---

### Task 1: `yesterdayOf` 纯函数（deepseek-pricing.ts）

**Files:**
- Modify: `src/deepseek-pricing.ts`（文件末尾追加）
- Test: `tests/deepseek-pricing.test.js`（import 列表追加 + 文件末尾追加测试）

- [ ] **Step 1.1: 写失败测试**

`tests/deepseek-pricing.test.js` 顶部 import 改为：

```js
import {
  beijingDate,
  costOfTokens,
  displayNameOf,
  isPeak,
  sessionOfFile,
  tokenSplit,
  yesterdayOf,
} from '../dist/deepseek-pricing.js';
```

文件末尾追加：

```js
test('yesterdayOf 纯日期运算跨日/跨月/跨年，非法日期返回空串', () => {
  assert.equal(yesterdayOf('2026-08-20'), '2026-08-19');
  assert.equal(yesterdayOf('2026-09-01'), '2026-08-31');
  assert.equal(yesterdayOf('2026-01-01'), '2025-12-31');
  assert.equal(yesterdayOf('invalid'), '');
});
```

- [ ] **Step 1.2: 运行测试确认失败**

```bash
npm run build && node --test tests/deepseek-pricing.test.js
```

Expected: FAIL — `yesterdayOf` 未导出，import 失败（或 `yesterdayOf is not a function`）。

- [ ] **Step 1.3: 实现**

`src/deepseek-pricing.ts` 文件末尾追加（放在 `displayNameOf` 之后）：

```ts
/** 昨天的北京日期（YYYY-MM-DD → YYYY-MM-DD）；纯日期运算不涉及时区换算，非法日期返回空串 */
export function yesterdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
```

- [ ] **Step 1.4: 运行测试确认通过**

```bash
npm run build && node --test tests/deepseek-pricing.test.js
```

Expected: PASS（全部 7 个测试）。

- [ ] **Step 1.5: 提交**

```bash
git add tests/deepseek-pricing.test.js src/deepseek-pricing.ts
git commit -m "feat(cost): 新增 yesterdayOf 北京日期纯函数"
```

---

### Task 2: 状态机按日累计改造（dayTotals + stateV 3）

**Files:**
- Modify: `src/usage-stats.ts`（整体结构变更，见下方完整替换）
- Test: `tests/usage-stats.test.js`（文件末尾追加两个失败测试）

- [ ] **Step 2.1: 写失败测试**

`tests/usage-stats.test.js` 文件末尾追加（复用文件顶部已有的 `assistantLine` / `makeFixture` helper）：

```js
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
    assert.ok(Math.abs(second.today.costOff - fullCost) < 1e-12);
    assert.ok(Math.abs(second.month.costOff - fullCost) < 1e-12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.2: 运行测试确认失败**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 新增两个测试 FAIL（`second.yesterday` 为 undefined，`second.yesterday.costOff` 抛 TypeError）；其余既有测试仍 PASS。

- [ ] **Step 2.3: 实现——状态结构**

`src/usage-stats.ts` 顶部模块注释（第 1-17 行）整体替换为：

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
//   会话切换（新会话 id）时整体重建，回溯当前会话的历史记录。
// 按天累计：dayTotals 以北京日期为键，记录按自身日期落桶（跨天补到的更完整分片
//   会把该消息费用从旧日期桶挪到新日期桶）。渲染取今天与昨天两个桶。
// 本月累计：monthTotal 跨天持久累加，文件偏移跨天不清零（漏开机的天数由增量消费自然补齐）；
//   新月或旧版本状态时偏移置空、全量重读本月记录一次（一次性回溯）。
//   月初跨月时"日历昨天"的桶搬运进新状态——回放只重读本月记录，上月昨天必须靠搬运保留。
// 计价生效日期：峰谷分时计价自 2026-08-17 起生效，之前的记录过滤不计入；
//   状态里记录 pricingEra，生效日期常量变更时自动整体重建，避免旧数据残留。
//
// 配置：display.showRmbCost 开启后由 render/index.ts 调用（渲染见 render/lines/rmb-cost.ts）。
// 注意：转录 JSONL 是内部格式，字段可能随 Claude Code 版本变化；任何异常只影响费用行本身。
```

第 6 行 import 块改为（在 `beijingDate` 后加 `yesterdayOf`）：

```ts
import {
  beijingDate,
  costOfTokens,
  isPeak,
  PRICING_EFFECTIVE_DATE,
  sessionOfFile,
  tokenSplit,
  yesterdayOf,
  type TokenSplit,
} from './deepseek-pricing.js';
```

`STATE_VERSION`（第 34 行）改为：

```ts
/** 状态文件版本：v2 起各层累计带 perModel 字段、msgs 记录带 model；v3 起今日层改为按天累计 dayTotals。旧版本状态整体重建一次 */
const STATE_VERSION = 3;
```

`UsageStateFile`（第 60-72 行）替换为：

```ts
/** 状态文件结构（与 usage-statusline.mjs 原格式兼容，新增 stateV/perModel/model 字段；v3 起 totals 改为 dayTotals） */
interface UsageStateFile {
  stateV: number;
  month: string;
  date: string;
  pricingEra: string;
  sessionId: string | null;
  /** 按天累计：北京日期 YYYY-MM-DD → 当日累计（含 perModel） */
  dayTotals: Record<string, ScopeState>;
  monthTotal: ScopeState;
  sessionTotals: ScopeState;
  files: Record<string, number>;
  msgs: Record<string, MsgState>;
}
```

`UsageStatsResult`（第 85-96 行）替换为：

```ts
export interface UsageStatsResult {
  today: CostBucket;
  /** 昨天累计（无数据时为零桶，配合渲染"昨¥0.00"始终显示） */
  yesterday: CostBucket;
  month: CostBucket;
  session: CostBucket;
  /** 今天按模型拆分（昨天行与今天行各用各的拆分） */
  todayPerModel: Record<string, CostBucket>;
  /** 昨天按模型拆分（无数据时为空对象） */
  yesterdayPerModel: Record<string, CostBucket>;
  /** 月/会话按模型拆分：当前渲染未使用，保留供未来扩展（如月/会话按模型拆分） */
  monthPerModel: Record<string, CostBucket>;
  /** 会话层按模型拆分：当前渲染未使用，保留供未来扩展 */
  sessionPerModel: Record<string, CostBucket>;
  sessionId: string | null;
}
```

`freshState`（第 111-124 行）的 `totals: zeroScope(),` 一行替换为 `dayTotals: {},`。

- [ ] **Step 2.4: 实现——loadState 跨天逻辑**

`loadState`（第 126-157 行）整体替换为：

```ts
/**
 * 加载状态：
 * - 同月内跨天：只更新"今天"；dayTotals 各天桶保留（今天桶天然从 0 开始）
 * - 会话切换（含首次启用会话统计）：整体重建（偏移置空、全量重读本月转录，
 *   从而回溯当前会话的历史记录；同月回放会重建各天桶）
 * - 新月：整体重建（偏移置空，触发全量重读的一次性回溯）
 * - 旧版本状态、计价生效日期变更：整体重建（偏移置空，触发全量重读的一次性回溯）
 */
function loadState(stateFile: string, today: string, month: string, sessionId: string | null): UsageStateFile {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s = JSON.parse(raw) as Partial<UsageStateFile>;
    if (s?.stateV === STATE_VERSION && s.pricingEra === PRICING_EFFECTIVE_DATE) {
      if (s.month !== month) {
        // 新月：整体重建（偏移置空、全量重读本月转录）
        return freshState(month, today, sessionId);
      }
      if (sessionId == null || s.sessionId === undefined || s.sessionId === sessionId) {
        if (sessionId != null && s.sessionId === undefined) {
          // 首次启用会话统计：整体重建，回溯当前会话的历史记录
          return freshState(month, today, sessionId);
        }
        let out = s as UsageStateFile;
        if (s.date !== today) {
          // 跨天只更新"今天"；各天桶保留，今天的桶天然从 0 开始
          out = { ...out, date: today };
        }
        return out;
      }
      // 会话切换：整体重建，回溯当前会话的历史记录（同月回放会重建各天桶）
      return freshState(month, today, sessionId);
    }
  } catch {
    // 状态文件损坏或不存在 → 重建
  }
  return freshState(month, today, sessionId);
}
```

- [ ] **Step 2.5: 实现——consumeLine 落桶与扣回**

`consumeLine` 内（第 261-287 行）从 `const old = state.msgs[id];` 到函数结尾替换为：

```ts
      const old = state.msgs[id];
      if (old && t.out <= old.out) return; // 旧分片已完整，忽略重复/更旧的分片
      if (old) {
        // 同一消息的更新分片：先扣回旧贡献（跨天/跨会话分片只影响对应累计）
        if (old.month === state.month) {
          applyToScope(state.monthTotal, -1, old, old.cost, old.peak, old.model);
        }
        if (old.session === state.sessionId) {
          applyToScope(state.sessionTotals, -1, old, old.cost, old.peak, old.model);
        }
        // 按天桶扣回：旧分片按它落桶的日期扣（跨天补到的更完整分片会把该消息费用挪到新日期桶）
        const oldDay = state.dayTotals[old.date] ?? (state.dayTotals[old.date] = zeroScope());
        applyToScope(oldDay, -1, old, old.cost, old.peak, old.model);
      }
      state.msgs[id] = { ...t, peak, cost, date, month, session, model };

      // 本月累计：始终计入
      applyToScope(state.monthTotal, 1, t, cost, peak, model);
      // 按天累计：按记录自身北京日期落桶
      const day = state.dayTotals[date] ?? (state.dayTotals[date] = zeroScope());
      applyToScope(day, 1, t, cost, peak, model);
      // 会话累计：仅当前会话（含其子代理）计入
      if (session === state.sessionId) {
        applyToScope(state.sessionTotals, 1, t, cost, peak, model);
      }
```

- [ ] **Step 2.6: 实现——结果组装**

`updateUsageStats` 函数末尾（第 324-334 行）的 `persistState` 与 `return` 替换为：

```ts
    persistState(stateFile, state);

    const yesterdayKey = yesterdayOf(today);
    const todayBucket = state.dayTotals[today] ?? zeroScope();
    const yesterdayBucket = state.dayTotals[yesterdayKey] ?? zeroScope();
    return {
      today: todayBucket,
      yesterday: yesterdayBucket,
      month: state.monthTotal,
      session: state.sessionTotals,
      todayPerModel: todayBucket.perModel,
      yesterdayPerModel: yesterdayBucket.perModel,
      monthPerModel: state.monthTotal.perModel,
      sessionPerModel: state.sessionTotals.perModel,
      sessionId: state.sessionId,
    };
```

- [ ] **Step 2.7: 运行测试确认通过**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 全部 PASS（既有 12 个 + 新增 2 个）。注意：既有 '新月滚动整体重建' 测试的 fixture 是 stateV 2（旧版）→ 走整体重建分支，仍应 PASS。

- [ ] **Step 2.8: 提交**

```bash
git add tests/usage-stats.test.js src/usage-stats.ts
git commit -m "feat(cost): 状态机按天累计化（dayTotals + stateV 3），支持昨天费用留存"
```

---

### Task 3: 昨天零桶与 v2→v3 升级测试（Task 2 实现已覆盖行为，补测试）

**Files:**
- Test: `tests/usage-stats.test.js`（文件末尾追加两个测试；无需改实现）

- [ ] **Step 3.1: 追加测试**

```js
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
```

- [ ] **Step 3.2: 运行测试确认通过**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 全部 PASS（16 个）。

- [ ] **Step 3.3: 提交**

```bash
git add tests/usage-stats.test.js
git commit -m "test(cost): 昨天零桶与 v2→v3 状态升级重建用例"
```

---

### Task 4: 月初跨月搬运昨天桶

**Files:**
- Modify: `src/usage-stats.ts`（loadState 新月分支追加搬运）
- Test: `tests/usage-stats.test.js`（文件末尾追加失败测试）

- [ ] **Step 4.1: 写失败测试**

```js
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
```

- [ ] **Step 4.2: 运行测试确认失败**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 新增测试 FAIL（`second.yesterday.costOff` 为 0，期望 18——新月重建丢了 8-31 桶）；其余 PASS。

- [ ] **Step 4.3: 实现搬运**

`loadState` 的新月分支（Task 2.4 中 `if (s.month !== month)` 块）替换为：

```ts
      if (s.month !== month) {
        // 新月：整体重建（偏移置空、全量重读本月转录）。
        // "日历昨天"的桶跨月搬运：回放只重读本月记录，上月昨天的累计必须靠搬运保留，
        // 否则月初 1 号的昨天行会错误归零。
        const fresh = freshState(month, today, sessionId);
        const yesterdayKey = yesterdayOf(today);
        const carried = s.dayTotals?.[yesterdayKey];
        if (carried) fresh.dayTotals[yesterdayKey] = carried;
        return fresh;
      }
```

同时把 `loadState` 的 JSDoc 注释里"- 新月：……（见 updateUsageStats 中 Task 4 的搬运逻辑，此处先整体重建）"一句改为：

```ts
 * - 新月：整体重建（偏移置空，触发全量重读的一次性回溯）；"日历昨天"的桶跨月搬运保留
```

- [ ] **Step 4.4: 运行测试确认通过**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 全部 PASS（17 个）。

- [ ] **Step 4.5: 提交**

```bash
git add tests/usage-stats.test.js src/usage-stats.ts
git commit -m "feat(cost): 月初跨月搬运日历昨天桶，月初 1 号昨天行不归零"
```

---

### Task 5: 持久化前剪枝

**Files:**
- Modify: `src/usage-stats.ts`（persistState 前加剪枝循环）
- Test: `tests/usage-stats.test.js`（import 行加 readFile + 文件末尾追加失败测试）

- [ ] **Step 5.1: 写失败测试**

`tests/usage-stats.test.js` 顶部 import 改为：

```js
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
```

文件末尾追加：

```js
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
    assert.ok(!('2026-07-30' in persisted.dayTotals));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5.2: 运行测试确认失败**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 新增测试 FAIL（`'2026-07-30' in persisted.dayTotals` 仍为 true）；其余 PASS。

- [ ] **Step 5.3: 实现剪枝**

`updateUsageStats` 里 `persistState(stateFile, state);` 前插入：

```ts
    // 剪枝：dayTotals 只保留本月各天 + 日历昨天，防跨月残留膨胀（最多 ~32 个桶）
    const yesterdayKey = yesterdayOf(today);
    for (const key of Object.keys(state.dayTotals)) {
      if (key !== yesterdayKey && key.slice(0, 7) !== state.month) {
        delete state.dayTotals[key];
      }
    }

```

- [ ] **Step 5.4: 运行测试确认通过**

```bash
npm run build && node --test tests/usage-stats.test.js
```

Expected: 全部 PASS（18 个）。

- [ ] **Step 5.5: 提交**

```bash
git add tests/usage-stats.test.js src/usage-stats.ts
git commit -m "feat(cost): dayTotals 持久化前剪枝，只保留本月与日历昨天"
```

---

### Task 6: 渲染昨天 + 今天两行（rmb-cost.ts）

**Files:**
- Modify: `src/render/lines/rmb-cost.ts`（整体重写，见下方）
- Test: `tests/rmb-cost.test.js`（整体重写，见下方）

- [ ] **Step 6.1: 写失败测试**

`tests/rmb-cost.test.js` 整体替换为：

```js
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
    '昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('昨天无数据时显示昨¥0.00，两行结构恒定', () => {
  assert.equal(
    renderRmbCostLine(stats({ yesterday: bucket(0, 0), yesterdayPerModel: {} })),
    '昨¥0.00\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('昨天谷段非零时昨天行显示谷', () => {
  assert.equal(
    renderRmbCostLine(stats({ yesterday: bucket(0, 2.5), yesterdayPerModel: { 'deepseek-v4-pro': bucket(0, 2.5) } })),
    '昨¥2.50(pro¥2.50) 谷¥2.50\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52',
  );
});

test('今天峰谷为零时省略峰/谷段（仅今天行）', () => {
  assert.equal(
    renderRmbCostLine(stats({ today: bucket(0, 0), todayPerModel: {} })),
    '昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥0.00 月¥145.26 会话¥7.52',
  );
});

test('无会话 id 时省略会话段（仅今天行）', () => {
  assert.equal(
    renderRmbCostLine(stats({ sessionId: null })),
    '昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26',
  );
});

test('今天空闲时段费用显示谷段', () => {
  assert.equal(
    renderRmbCostLine(stats({ today: bucket(0, 2.5), todayPerModel: { 'deepseek-v4-pro': bucket(0, 2.5) } })),
    '昨¥1.23(pro¥1.00/flash¥0.23) 峰¥1.23\n⚡今¥2.50(pro¥2.50) 谷¥2.50 月¥145.26 会话¥7.52',
  );
});

test('统计异常显示单行占位', () => {
  assert.equal(renderRmbCostLine(null), '⚡费用统计异常');
});
```

- [ ] **Step 6.2: 运行测试确认失败**

```bash
npm run build && node --test tests/rmb-cost.test.js
```

Expected: 前 6 个 FAIL（`stats.yesterday` 为 undefined → 抛 TypeError，或输出仍为单行）；'统计异常显示单行占位' PASS。

- [ ] **Step 6.3: 实现**

`src/render/lines/rmb-cost.ts` 整体替换为：

```ts
import { displayNameOf } from '../../deepseek-pricing.js';
import type { CostBucket, UsageStatsResult } from '../../usage-stats.js';

/**
 * 渲染 DeepSeek 人民币费用行（display.showRmbCost 开启时由 render/index.ts
 * 在 expanded / compact 两种布局末尾追加）。
 *
 * 两行输出：昨天行在上、今天行在下；昨天无数据时显示昨¥0.00，两行结构恒定：
 *   昨¥1.23(pro¥1.00/flash¥0.23) 峰¥0.80 谷¥0.43
 *   ⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
 * - 括号内为按模型拆分（动态遍历实际出现的模型，用计价表 displayName 短写）
 * - 峰/谷仅非零时显示；会话段仅当前会话有值时显示，且只属于今天行
 * - stats 为 null（统计异常）时显示单行占位，不影响 HUD 其他行
 * - 行内文字硬编码中文（个人 fork，与现有脚本显示一致，不进 i18n 表）
 */

/** 构建一天的费用段：总额 + 按模型拆分（有数据时）+ 峰/谷（非零时） */
function renderDayCost(
  label: '今' | '昨',
  total: CostBucket,
  perModel: Record<string, CostBucket>,
): string {
  const cost = total.costPeak + total.costOff;
  let part = `${label}¥${cost.toFixed(2)}`;
  const models = Object.keys(perModel);
  if (models.length > 0) {
    const detail = models
      .map((model) => {
        const bucket = perModel[model];
        const modelCost = bucket.costPeak + bucket.costOff;
        return `${displayNameOf(model)}¥${modelCost.toFixed(2)}`;
      })
      .join('/');
    part += `(${detail})`;
  }
  const parts = [part];
  if (total.costPeak > 0) parts.push(`峰¥${total.costPeak.toFixed(2)}`);
  if (total.costOff > 0) parts.push(`谷¥${total.costOff.toFixed(2)}`);
  return parts.join(' ');
}

/** 渲染昨天 + 今天两行费用（以 \n 连接；render/index.ts 会按物理行拆分输出） */
export function renderRmbCostLine(stats: UsageStatsResult | null): string {
  if (!stats) {
    return '⚡费用统计异常';
  }

  const monthCost = stats.month.costPeak + stats.month.costOff;
  const sessionCost = stats.session.costPeak + stats.session.costOff;

  const yesterdayLine = renderDayCost('昨', stats.yesterday, stats.yesterdayPerModel);
  const todayParts = [`⚡${renderDayCost('今', stats.today, stats.todayPerModel)}`, `月¥${monthCost.toFixed(2)}`];
  if (stats.sessionId) todayParts.push(`会话¥${sessionCost.toFixed(2)}`);

  return `${yesterdayLine}\n${todayParts.join(' ')}`;
}
```

- [ ] **Step 6.4: 运行测试确认通过**

```bash
npm run build && node --test tests/rmb-cost.test.js
```

Expected: 全部 PASS（7 个）。

- [ ] **Step 6.5: 提交**

```bash
git add tests/rmb-cost.test.js src/render/lines/rmb-cost.ts
git commit -m "feat(cost): 费用行渲染昨天+今天两行（昨天无数据显示昨¥0.00）"
```

---

### Task 7: render.test.js 集成断言更新 + 全量测试

**Files:**
- Modify: `tests/render.test.js:4403-4418`

- [ ] **Step 7.1: 更新集成断言**

`tests/render.test.js` 第 4403-4418 行替换为：

```js
    // 注意：render 里的 updateUsageStats 用"当前真实时间"算 today/month（无注入点），
    // 记录落在本月时费用非零、落不到（更晚的月份）时费用为零——断言放宽为
    // 倒数第二行匹配 /^昨¥/、末行匹配 /^⚡今¥/（两行费用行出现即可），不锁具体金额。
    const ctx = baseContext();
    ctx.stdin = { ...ctx.stdin, session_id: 'sess-1' };
    ctx.config.display.showRmbCost = true;

    // expanded（两行费用：昨天行在上、今天行在下）
    ctx.config.lineLayout = 'expanded';
    const out1 = withTerminal(200, () => captureRenderLines(ctx));
    assert.match(out1[out1.length - 2], /^昨¥/, `expanded 布局倒数第二行应为昨天费用行，got: ${out1[out1.length - 2]}`);
    assert.match(out1[out1.length - 1], /^⚡今¥/, `expanded 布局末行应为费用行，got: ${out1[out1.length - 1]}`);

    // compact（复用同一 ctx，第二次触发走状态文件累计，费用行仍应追加）
    ctx.config.lineLayout = 'compact';
    const out2 = withTerminal(200, () => captureRenderLines(ctx));
    assert.match(out2[out2.length - 2], /^昨¥/, `compact 布局倒数第二行应为昨天费用行，got: ${out2[out2.length - 2]}`);
    assert.match(out2[out2.length - 1], /^⚡今¥/, `compact 布局末行应为费用行，got: ${out2[out2.length - 1]}`);
```

- [ ] **Step 7.2: 跑相关测试文件**

```bash
npm run build && node --test tests/render.test.js tests/rmb-cost.test.js tests/usage-stats.test.js tests/deepseek-pricing.test.js tests/cost-coverage.test.js tests/config.test.js
```

Expected: 全部 PASS。

- [ ] **Step 7.3: 跑全量测试对比基线**

```bash
npm test
```

Expected: 与改动相关（usage-stats / rmb-cost / deepseek-pricing / render / cost-coverage / config）全部 PASS；全量失败数与基线一致（基线为 34 个环境相关既有失败，如失败数变化需逐一确认非本次改动引入）。

- [ ] **Step 7.4: 提交**

```bash
git add tests/render.test.js
git commit -m "test(cost): 集成断言覆盖昨天+今天两行费用输出"
```

---

### Task 8: 更新 RMB-COST.md 使用说明

**Files:**
- Modify: `RMB-COST.md`（仓库根，未跟踪文件，**不提交**）

- [ ] **Step 8.1: 更新第 3 行简介与"一、启用与显示"**

第 3 行"显示 会话/今日/本月 三层累计"改为"显示 昨天/今天两行费用与 本月/会话 累计"。

"一、启用与显示"中第 11-18 行（代码块 + 三条 bullet）替换为：

```markdown
配置在 `~/.claude/plugins/claude-hud/config.json` 的 `display.showRmbCost: true`。开启后自动抑制美元 `showCost` 段，状态栏末尾追加两行（昨天行在上、今天行在下）：

```
昨¥1.23(pro¥1.00/flash¥0.23) 峰¥0.80 谷¥0.43
⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
```

- `昨` = 昨天合计（昨天无数据时显示 `昨¥0.00`，两行结构恒定；月初 1 号跨月的昨天数据会自动保留）；`今` = 今日合计（括号内按模型拆分）；`峰/谷` = 对应日的分时明细（北京时间 9-12、14-18 为高峰）；`月` = 本月累计（跨天持久）；`会话` = 当前会话累计（含子代理，按目录归父会话）
- 金额是本地估算，权威对账以厂商平台账单为准
- 状态文件 `~/.claude/scripts/.usage-state.json` 由 HUD 读写，增量扫描 `~/.claude/projects/**/*.jsonl`
```

- [ ] **Step 8.2: 不提交**（该文件未跟踪，随用户习惯处理；无需 git 操作）

---

### Task 9: 构建部署与实时验证

**Files:**
- 构建产物 `dist/`（生成）；插件缓存目录 `C:/Users/augus/.claude/plugins/cache/claude-hud/claude-hud/0.8.0/`（拷贝）

- [ ] **Step 9.1: 构建**

```bash
cd D:/code/others/claude-hud && npm run build
```

Expected: 无 TS 编译错误。

- [ ] **Step 9.2: 拷入插件缓存（状态栏跑的是缓存里的构建产物）**

```bash
cp -r dist "C:/Users/augus/.claude/plugins/cache/claude-hud/claude-hud/0.8.0/"
```

（注意：本次**无需删状态文件**——没有改价，stateV 升级由状态机自动整体重建一次。）

- [ ] **Step 9.3: 实时验证**

重启 Claude Code（或等下一次状态栏触发），确认状态栏末尾出现两行：昨天行 `昨¥...`、今天行 `⚡今¥... 月¥... 会话¥...`；跨天后再确认昨天行数字正确、今天行从 0 重新累计。
