# 2026-08-20 · 昨天 + 今天两行人民币费用显示设计

## 背景

fork 的 claude-hud 已内置 DeepSeek 人民币费用行（`display.showRmbCost`，2026-08-19 上线，
设计见 [2026-08-19-cost-display-design.md](./2026-08-19-cost-display-design.md)）。当前
`usage-stats.ts` 状态机只有今日（`totals`）/ 本月 / 会话三层累计，**跨天时今日层被清零
丢弃**，昨天费用没有留存，渲染层无法推算（月累计没有日期维度）。

**目标**：在 `showRmbCost` 开启时输出**昨天 + 今天两行**费用，昨天行与今天行同格式。

## 需求（已与用户确认）

1. **始终两行**：昨天无数据（昨天没开 Claude Code、首次启用当天等）时仍显示
   `昨¥0.00`，两行结构恒定。
2. **绑定现有开关**：无新配置项，`display.showRmbCost` 开启即两行；expanded / compact
   布局都追加（现有挂载点 `render/index.ts` 末尾不变）。
3. **昨天行同格式**（昨天行在上、今天行在下，示例）：

   ```
   ⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥0.80 谷¥0.43
   ⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
   ```

   - 昨天行与今天行同构：总额 + 按模型拆分（有数据时）+ 峰/谷仅非零时显示；无数据时
     只有 `昨¥0.00`；两行都带 `⚡` 前缀
   - 今天行完全不变（月/会话段保留）；月/会话只属于今天行
   - 统计异常（stats 为 null）时维持现状：单行占位 `⚡费用统计异常`

## 方案选择

| 方案 | 结论 |
|---|---|
| A. 状态机升级为按日累计 `dayTotals` map（日期为键） | ✅ 采用 |
| B. 昨日专项字段 `yesterday = { date, total }` | ❌ 扫描/扣回/回放/跨月四条路径都要单独照顾该字段，特例多；扩展多天需推倒重来 |
| C. 渲染层推算昨天（如月累计减今日） | ❌ 不可行：月累计无日期维度，且月初 1 号公式失效 |

方案 A 把「按天拆分」做成状态机的原生能力：记录按自身北京日期直接落桶，去重扣回也按
`old.date` 落桶，现在「今日/其他日期」的 if 特判全部消失；会话切换整体重建时回放天然
重建本月每一天。

## 架构

### 修改文件

- `src/usage-stats.ts` — 状态机按日累计化（详见下）
- `src/deepseek-pricing.ts` — 新增 `yesterdayOf(date)` 纯函数
- `src/render/lines/rmb-cost.ts` — 渲染两行（两行都带 `⚡` 前缀，2026-08-20 用户确认对齐调整）
- `tests/usage-stats.test.ts` / `tests/render/rmb-cost.test.ts` — 新增用例 + fixture v3 化
- `RMB-COST.md`（仓库根，未跟踪）— 更新费用行格式说明
- `src/config.ts` / `src/render/index.ts` / `src/types.ts` — **不改**（无新配置项，
  挂载点与结果消费方式不变）

### src/usage-stats.ts（状态机）

- **stateV: 2 → 3**。旧状态自动整体重建一次（沿用 v2 上线的既有模式：版本不匹配 →
  freshState → 偏移置空全量回溯）。
- 状态结构：删除 `totals: ScopeState`，新增
  `dayTotals: Record<string, ScopeState>`（北京日期 YYYY-MM-DD → 当日累计，含 perModel）；
  `date` 字段保留表示「今天」。
- `loadState` 变更：
  - 有效状态且同月跨天：只更新 `date = today`，不再清零（今天的桶天然从 0 开始，
    昨天的桶留在 map 里）
  - 月初跨月（`s.month !== month`）：freshState 后，把旧状态里「日历昨天」
    `dayTotals[yesterdayOf(today)]` 的桶**搬进新状态**——回放只重读本月记录，上月昨天
    必须靠搬运，否则 09-01 的昨天行会错误显示 ¥0.00。会话切换与跨月同时发生时走
    同一条搬运路径
  - 会话切换重建（同月）：不搬任何桶，回放自然重建本月所有日期（含昨天）
- 扫描 `consumeLine` 变更（其余口径不变：assistant 记录、计价生效日过滤、本月过滤、
  message.id 去重取最完整分片）：
  - 计入：`applyToScope(dayTotals[date] ??= zeroScope(), +1, ...)`（date 为记录自身
    北京日期）
  - 扣回旧分片：`applyToScope(dayTotals[old.date] ??= zeroScope(), -1, ...)`——替代
    现在的 `old.date === today` 特判；跨天补到的更完整分片会把该消息费用从旧日期桶
    挪到新日期桶，与现有月累计扣回语义一致
  - 月累计 / 会话累计逻辑不变
- 持久化前剪枝：`dayTotals` 只保留「本月所有日期」+「日历昨天」，防跨月残留膨胀
  （最多 ~32 个桶）。
- 结果接口：
  - `today` = `dayTotals[today] ?? 零桶`（语义不变）
  - 新增 `yesterday: CostBucket` = `dayTotals[yesterdayOf(today)] ?? 零桶`
    （无数据即零桶，配合「始终显示 ¥0.00」）
  - 新增 `yesterdayPerModel: Record<string, CostBucket>`（昨天行按模型拆分用；
    无数据为空对象）
  - `month` / `session` / `monthPerModel` / `sessionPerModel` 不变

### src/deepseek-pricing.ts

新增纯函数：

```ts
/** 昨天的北京日期（YYYY-MM-DD → YYYY-MM-DD）；与 beijingDate 同处，方便测试 */
export function yesterdayOf(date: string): string
```

实现为纯日期运算（解析为 UTC 0 点减一天，不涉及时区换算——入参已是北京日期）。

### src/render/lines/rmb-cost.ts（渲染）

函数签名不变 `renderRmbCostLine(stats: UsageStatsResult | null): string`，返回两行
（以 `\n` 连接；`render/index.ts` 的 `physicalLines = lines.flatMap(line =>
line.split('\n'))` 会拆成物理行）。stats 为 null 时返回单行占位（现状不变）。

昨天行渲染与今天行共用同一段构建逻辑（提取为内部 helper，总额 + 按模型拆分 + 峰/谷
非零显示），入参为 `{ label: '昨', total, perModel }` / `{ label: '今', ... }`；
两行都带 `⚡` 前缀（用户确认的对齐调整）；今天行额外追加月/会话段。行内中文硬编码，
不进 i18n 表（延续既有决策）。

## 数据流（不变）

```
Claude Code → stdin JSON → render/index.ts（showRmbCost 门控）
  → updateUsageStats 增量扫描转录 → dayTotals 按日期落桶 → 状态文件原子写
  → rmb-cost 渲染两行 → 追加到 stdout 末尾
```

## 测试

- `deepseek-pricing`：`yesterdayOf` 跨日/跨月/跨年边界、非法日期返回空串
- `usage-stats` 新增：
  - 跨天留存昨天桶（昨天有费用、今天累加后两桶并存）
  - 昨天无数据 → `yesterday` 为零桶、`yesterdayPerModel` 为空
  - 月初跨月搬运昨天桶（旧状态 dayTotals 含昨天 → 新状态保留）
  - 跨天去重扣回按日期落桶（旧分片从昨天桶扣、更完整分片进今天桶）
  - v2 状态升级 v3 → 整体重建一次性回溯
  - 剪枝：非本月且非昨天的桶被移除
- `rmb-cost` 新增：两行输出快照（含按模型拆分/峰谷）、昨天零桶只显示 `昨¥0.00`、
  stats null 单行占位
- fixture 更新：既有测试的状态文件结构 v3 化（stateV=3、dayTotals 替换 totals）
- 全量测试跑一遍，与基线一致（既有 34 个环境相关失败属预期）

## 部署（实现完成后执行）

1. `npm run build` 产出 dist
2. 新 dist 拷入插件缓存目录（既定流程：dist/src/commands/.claude-plugin →
   plugins/cache/claude-hud/claude-hud/0.8.0）
3. 实时验证：状态栏出现昨天 + 今天两行；跨天后昨天行数字正确

## 风险与代价

- v2 → v3 状态整体重建为一次性回溯：**升级当天若恰逢月初 1 号**，v2 状态没有
  dayTotals，昨天桶无法搬运，昨天行显示 ¥0.00 一次（仅升级当天发生，可接受）
- 转录清理窗口 `cleanupPeriodDays` 默认 30 天，昨天记录必然仍在窗口内，无影响
- 状态文件删掉重建时昨天桶丢失（与现有「数字异常删状态文件」的既有代价一致）
- 跨天补到的更完整分片会把消息费用在日期桶之间挪动（与现有月累计扣回语义一致，
  非 bug）

## 明确不做（YAGNI）

- 不做「最近 N 天」通用多天显示（dayTotals 已预留扩展能力，本次只取昨天）
- 不做昨天行独立配置开关（绑定 showRmbCost）
- 不做昨天行日期标注（如 `昨(08-19)`）——无数据仍显示 `昨¥0.00`，无需日期佐证
- 不进 i18n 表；不动 `usage-daily.mjs` 日报表
