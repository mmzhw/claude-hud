# 2026-08-19 · DeepSeek 人民币费用行集成进 claude-hud 设计

## 背景

用户的 Claude Code 通过 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` 接入 DeepSeek
后端（主模型 `deepseek-v4-pro[1m]`，子代理 `deepseek-v4-flash`）。计费走 DeepSeek 平台，自
2026-08-17 起为峰谷分时计价（北京时间 9-12、14-18 为高峰，空闲价 = 高峰价一半）。

现状（2026-08-19 已搭建）：状态栏由 `~/.claude/scripts/statusline.sh` 串接「claude-hud 输出
（上）+ `usage-statusline.mjs` 费用行（下）」。费用脚本用增量偏移状态机扫描
`~/.claude/projects/**/*.jsonl`，实时显示今日/本月/会话人民币花费（`~/.claude/scripts/`
下有配套 `deepseek-pricing.mjs` 计价模块、`usage-daily.mjs` 日报表、一键安装脚本）。

**目标**：把费用显示从外部脚本串接改为**内置于 fork 的 claude-hud 插件**（本仓库），替代
`statusline.sh` 串接，settings.json 的 statusLine 直接指回 HUD。

## 需求（已与用户确认）

1. **独立费用行**：HUD 新增 opt-in 行，不侵入现有美元 `showCost` 逻辑；开启时自动抑制美元
   cost 段避免同屏矛盾显示。
2. **显示按模型拆分**：`⚡今¥3.50(pro¥3.00/flash¥0.50) ...`，主模型与子代理花费各自可见。
3. **DeepSeek 硬编码定价**：价格表作为内置常量模块（个人 fork），不进外部配置文件。
4. **换模型可扩展**：日后换模型只需在计价表加一条目、无需改状态机；按模型汇总与显示动态
   遍历实际出现的模型名，不写死 pro/flash；平峰谷价的模型填相同的 peak/off 值即可。

## 方案选择

| 方案 | 结论 |
|---|---|
| A. 完整移植状态机进 HUD（3 新模块：定价纯函数 + 增量状态机 + 费用行渲染） | ✅ 采用 |
| B. HUD 内 shell 调用现有 usage-statusline.mjs | ❌ 仍依赖外部脚本、每次触发多 spawn 进程 |
| C. 扩展 HUD 现有 transcript/cost 模块 | ❌ 现有解析只面向单会话文件，"今日/本月"需全量扫描，与架构冲突 |

## 架构

### 新增文件

```
src/deepseek-pricing.ts      # 计价纯函数（端口 deepseek-pricing.mjs）
src/usage-stats.ts           # 增量扫描状态机（端口 usage-statusline.mjs）
src/render/lines/rmb-cost.ts # 费用行渲染
tests/deepseek-pricing.test.ts
tests/usage-stats.test.ts
tests/render/rmb-cost.test.ts
```

### 修改文件

- `src/types.ts` — `StdinData` 增加 `session_id?: string`
- `src/stdin.ts` — 解析 stdin JSON 的 `session_id`（当前 HUD 丢弃了该字段）
- `src/config.ts` — `display.showRmbCost`（默认 false）：Display 接口 + DEFAULT_CONFIG +
  migration 校验，沿用 `showSessionTokens` 三处模式
- `src/render/lines/cost.ts` — `showRmbCost === true` 时 `renderCostEstimate` 返回 null
  （抑制美元 cost 段）
- `src/render/index.ts` — expanded 与 compact 两种布局末尾均追加费用行（compact 放在单行
  会话信息之后，输出换行）

### src/deepseek-pricing.ts（纯函数，无 IO）

端口 `deepseek-pricing.mjs` 全部内容并加 TS 类型：

- `PEAK_WINDOWS_BEIJING` / `PRICING_EFFECTIVE_DATE` 常量
- `PRICES_RMB_PER_MILLION: Record<string, { cacheHit/cacheMiss/output: { peak/off } }>` —
  换模型 = 在此表加条目；表格注释注明价格来源 URL
- `sessionOfFile(file, recordSessionId)` — 子代理文件（路径含 `subagents/`）归父会话
- `isPeak(utcTimestamp)` / `beijingDate(utcTimestamp)` — 北京时间换算
- `tokenSplit(usage)` / `costOfTokens(model, t, peak)` — 未知模型返回 null（跳过不计价）

### src/usage-stats.ts（状态机，端口自 usage-statusline.mjs）

- `collectJsonl(PROJECTS_ROOT)` — 递归收集 `~/.claude/projects/**/*.jsonl`（`CLAUDE_CONFIG_DIR`
  优先，与现有脚本口径一致）
- 状态文件：**复用 `~/.claude/scripts/.usage-state.json`**（同路径、字段兼容——在原格式上
  新增 `perModel` 字段，旧脚本按原字段读取不受影响 → 从串接方案切换无缝，历史数字不断）；
  目录不存在自动创建（新机器只装 fork 也能用）；原子写（tmp+rename）
- `loadState` 重建规则照搬：同月跨天只清今日、会话切换只清会话累计、新月 / pricingEra 变更
  / 旧版本状态 → 整体重建（偏移置空全量回溯一次）
- `consumeLine` 口径照搬：
  - 只统计 `type === 'assistant'` 且有 usage/timestamp 的记录
  - `beijingDate(timestamp) < PRICING_EFFECTIVE_DATE` 或非本月的记录跳过
  - 按 `message.id` 去重：旧分片 `out` 更大时忽略；更完整分片先扣回旧贡献再计入新贡献
  - 三层累计：今日（当天）/ 本月（跨天持久）/ 会话（`sessionOfFile` 归属当前 session_id，
    含子代理）
- **新增**：三层累计各附带 `perModel: Record<model, {miss,hit,out,costPeak,costOff}>`
  动态键模型名，支持按模型拆分显示；`msgs` 记录里保留 model 字段用于扣回
- 异常兜底：任何扫描/计价异常 → 渲染占位 `⚡费用统计异常`，不影响 HUD 其他行

### src/render/lines/rmb-cost.ts（渲染）

```ts
renderRmbCostLine(stats: UsageStatsResult | null): string   // stats 为 null 时返回占位 "⚡费用统计异常"
```

> 签名说明（与实际实现同步）：showRmbCost 门控由 render/index.ts 调用方负责
> （`ctx.config.display.showRmbCost === true` 时才调用并追加到输出末尾），函数本身
> 不感知配置；stats 为 null（统计异常）时函数返回占位字符串。

输出格式（峰/谷仅非零显示，会话仅当前会话有值时显示，按模型拆分动态遍历）：

```
⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
```

- 模型名短写：计价表每条目加可选 `displayName` 字段（如 `deepseek-v4-pro` → `pro`、
  `deepseek-v4-flash` → `flash`）；未配 displayName 的模型直接显示原始名。perModel 只会
  出现可计价的模型（无法计价的记录在 costOfTokens 处已跳过），括号内不会出现无价模型名
- 行内中文（今/月/会话/峰/谷/⚡/¥）硬编码，不进 i18n 表（个人 fork，与现有脚本显示一致）
- 原脚本的 `ctxN%` 不迁移（HUD 自身 context 行已覆盖）

## 数据流

```
Claude Code → stdin JSON（含 session_id）
  → index.ts 组装 RenderContext
  → usage-stats 增量扫描 ~/.claude/projects/**/*.jsonl（只读新增字节）
  → 更新 ~/.claude/scripts/.usage-state.json（原子写）
  → rmb-cost 行渲染 → 追加到 stdout 末尾
```

## 测试

- `deepseek-pricing`：峰谷边界（9/12/14/18 点整）、北京时间跨时区日期、tokenSplit 空字段、
  costOfTokens 未知模型 null、sessionOfFile 主/子代理路径
- `usage-stats`：fixture 转录目录验证 message.id 去重（先旧后新扣回）、跨天只清今日、
  新月重建、pricingEra 变更重建、会话切换清零、perModel 汇总正确
- `rmb-cost`：快照测试（含只出现单一模型、峰谷为零、无 session_id 三种场景）

## 部署与切换（实现完成后执行）

1. `npm ci && npm run build` 产出 dist
2. settings.json 的 `statusLine` 从 `statusline.sh` 指回 HUD 的 setup 命令
   （`/claude-hud:setup` 或按备份 `settings.json.bak-20260819` 恢复后加配置）
3. 启用 `display.showRmbCost: true`
4. `statusline.sh` 停用不删（回滚备用）；`usage-daily.mjs` 报表保持原样独立使用
5. 本地安装 fork：`extraKnownMarketplaces` 加 directory 源 → `/plugin` 安装（记忆已记录路线）

## 风险与代价

- 上游更新需手动合并（已接受）
- 转录 JSONL 为内部格式，字段变化需同步检查（与现有脚本同等风险；状态文件可删重建）
- 首次启用全量回溯本月稍慢（一次性）
- 换模型时：计价表加条目即可；若新模型无峰谷价，peak/off 填同值；若价格体系变更日期不同，
  需把全局 `PRICING_EFFECTIVE_DATE` 改为按模型分段的扩展（本次不做，预留注释说明）

## 明确不做（YAGNI）

- 不进 i18n 表；不做外部定价文件；不做 config 自定义单价（个人 fork）
- 不动 `usage-daily.mjs` 日报表（独立脚本继续用）
- 不删除 `~/.claude/scripts/` 下任何现有脚本
