# 2026-08-23 · 按当前模型显示对应费用设计

## 背景

本 fork 现有 `display.showRmbCost` 功能只内置 DeepSeek V4 Pro/Flash 的人民币峰谷价格。费用状态机虽然按模型保存拆分数据，但渲染的是所有已计价模型的合计；当前模型没有参与费用选择。

用户从 DeepSeek 切换到中转站提供的 `gpt-5.6-sol` 后，GPT 转录因价格表中没有对应条目而被跳过，状态栏继续展示状态文件里已有的 DeepSeek Pro/Flash 金额。用户需要状态栏只显示当前正在使用模型的费用。

## 已确认需求

1. 费用视图只统计并显示当前模型；切换模型后不继续展示其他模型的金额。
2. `gpt-5.6-sol` 使用 OpenAI 官方 API 公开价，不尝试匹配中转站实际扣费。
3. 各模型使用原始计价币种：DeepSeek 显示人民币 `¥`，GPT 显示美元 `$`，不做汇率换算。
4. 采用通用模型计价目录，而不是把 GPT 硬塞进 DeepSeek 专用结构或复制第二套扫描器。
5. 保留现有 DeepSeek Pro/Flash 峰谷计价能力。
6. 继续兼容用户现有的 `display.showRmbCost: true` 配置。
7. 价格或状态结构升级后自动重建本月统计，不要求手动删除状态文件。

## 官方价格依据

来源：<https://developers.openai.com/api/docs/pricing>，核对日期为 2026-08-23。

`gpt-5.6-sol` Standard 价格，单位为美元/百万 tokens：

| 上下文档位 | 普通输入 | 缓存输入 | 缓存写入 | 输出 |
|---|---:|---:|---:|---:|
| 短上下文（输入 tokens ≤ 272,000） | $4.00 | $0.40 | $5.00 | $20.00 |
| 长上下文（输入 tokens > 272,000） | $8.00 | $0.80 | $10.00 | $30.00 |

官方价格组件进一步说明：

- 输入 token 分为 Input、Cached Input 或 Cache Write，三类互斥；缓存写入不是附加在普通输入上的第二笔费用。
- 长短上下文以请求的输入 tokens 是否超过 272K 判定。
- 输出价格包含可见输出与 reasoning tokens。
- GPT-5.6 Sol 的促销价格至少持续到 2026-11-21。

本功能采用 Standard 档，不实现 Batch、Flex、Fast、区域处理附加费或中转站倍率。`[1m]` 表示模型可使用 1M 上下文，不代表每次请求都使用长上下文价格；每条请求仍按实际输入 tokens 判档。

## 方案比较

### A. 通用模型计价目录 + 当前模型投影（采用）

统一定义模型别名、币种、token 分类、固定/峰谷/上下文分档规则。状态机扫描一次并保存各模型统计，渲染前只投影当前模型。

优点：GPT 计价口径正确；不同币种不混算；模型切换立即生效；后续扩展只需增加目录条目。

### B. 在 DeepSeek 表中硬编码 GPT（不采用）

把 GPT 写成 peak/off 同价条目。虽然改动小，但无法区分缓存写入、不能按 272K 切换价格，且现有渲染硬编码人民币符号，会产生错误金额。

### C. 单独建立 GPT 扫描器（不采用）

保留 DeepSeek 管线并复制 GPT 管线。会重复扫描 JSONL、维护两份偏移与去重状态，后续每增加厂商都继续复制。

## 架构

### 1. 通用计价模块

新增 `src/model-pricing.ts`，负责：

- 计价目录与类型；
- 当前模型和转录模型的规范化；
- token 分类；
- 根据模型策略计算单条请求费用；
- 币种、符号、短显示名和排序元数据；
- 现有北京时间日期、峰谷和会话归属纯函数。

`src/deepseek-pricing.ts` 保留为薄兼容模块：现有日期、峰谷、会话归属、显示名/排序 helper，以及旧 `tokenSplit`、`costOfTokens` 签名继续存在并委托给通用实现；新代码统一从 `model-pricing.ts` 导入。兼容层不再承载新的计价规则。

### 2. 计价目录模型

目录至少包含：

- `deepseek-v4-pro`
  - 显示名 `pro`；
  - 币种 CNY、符号 `¥`；
  - 北京时间峰谷策略；
  - cache write 按 cache miss 价格处理；
  - 保留现有 2026-08-17 生效日期。
- `deepseek-v4-flash`
  - 显示名 `flash`；
  - 其余规则同现有实现。
- `gpt-5.6-sol`
  - 显示名 `sol`；
  - 币种 USD、符号 `$`；
  - Standard 上下文分档策略；
  - `gpt-5.6-sol[1m]` 等已确认变体映射到同一规范模型；
  - 价格元数据记录来源 URL、核对日期和促销说明。

采用以下核心类型边界：

```ts
interface TokenSplit {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface PriceVector {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

type PricingStrategy =
  | { kind: 'time-of-day'; peak: PriceVector; offPeak: PriceVector }
  | { kind: 'context-tiered'; threshold: number; short: PriceVector; long: PriceVector }
  | { kind: 'flat'; prices: PriceVector };

interface ModelPricing {
  canonicalName: string;
  aliases: string[];
  displayName: string;
  currency: 'CNY' | 'USD';
  symbol: '¥' | '$';
  effectiveFrom?: string;
  strategy: PricingStrategy;
}
```

实现使用上述接口名与职责边界；价格解析不得放入渲染器，状态持久化不得放入计价模块。

### 3. Token 分类与 GPT 分档

转录 usage 字段映射为：

```text
input      = input_tokens
cacheRead  = cache_read_input_tokens
cacheWrite = cache_creation_input_tokens
output     = output_tokens
```

GPT 请求的输入规模为：

```text
inputTotal = input + cacheRead + cacheWrite
```

当 `inputTotal <= 272_000` 时使用短上下文价格；当 `inputTotal > 272_000` 时使用长上下文价格。

DeepSeek 不单独销售 cache write：计算时将 `input + cacheWrite` 按 cache miss 价计费，`cacheRead` 按 cache hit 价计费，从而保持现有结果。

### 4. 模型规范化与当前模型解析

当前模型候选来源按顺序为：

1. `stdin.model.id`；
2. `stdin.model.display_name`。

每个候选先做安全清理和边界限制，再使用显式别名表匹配。只移除已知无语义包装（例如末尾 `[1m]`），不做可能把不同模型误合并的宽泛模糊匹配。

转录 `message.model` 使用同一规范化逻辑。状态键使用规范模型名，因此当前的 `gpt-5.6-sol[1m]` 能选中转录中的 `gpt-5.6-sol`。

### 5. 状态模型与不同币种隔离

当前 `ScopeState` 把各模型金额同时累加到一个总额。加入美元后该总额没有数学意义，因此新状态不再维护跨模型费用合计，费用只存在于 `perModel` 桶。

采用以下状态结构：

```ts
interface ModelUsageBucket extends TokenSplit {
  amount: number;
  peakAmount: number;
  offPeakAmount: number;
}

interface ScopeState {
  perModel: Record<string, ModelUsageBucket>;
}
```

- GPT 只增加 `amount`，峰谷字段保持零。
- DeepSeek 同时增加 `amount` 以及对应的 `peakAmount` 或 `offPeakAmount`。
- 昨天、今天、本月和会话四个视图均从各自 scope 的同一规范模型桶产生。
- 不同币种不存在求和路径。

`msgs` 中保存旧分片的规范模型、token 分类、金额和峰谷拆分。更完整流式分片到达时，先从旧模型/日期/会话桶对称扣回，再加入新贡献。

### 6. 状态升级与价格版本

状态版本从 v3 升级。状态文件新增明确的计价目录版本，例如：

```text
pricingCatalogVersion: 2026-08-23-gpt56-sol-v1
```

以下情况自动整体重建：

- 状态结构版本变化；
- 计价目录版本变化；
- 模型规范化或价格变更时开发者主动更新目录版本；
- 既有损坏、新月、会话切换等原有重建条件。

本次升级会把偏移归零并回放本月转录，使以前因未知价格而跳过的 GPT 请求得到补算。现有月初昨天桶搬运、dayTotals 剪枝和会话回溯语义保持不变。

促销价格到期后不自动猜测新价格或停止显示。开发者应从官方页面重新核对价格、修改目录并更新 `pricingCatalogVersion`，触发一次正确重建。

## 当前模型投影

状态机仍收集所有已支持模型，以便切换时即时显示。渲染前新增纯函数，根据规范当前模型从四个 scope 中选出：

- 昨天该模型金额；
- 今天该模型金额；
- 本月该模型金额；
- 当前会话该模型金额；
- 该模型的币种、符号、短名和是否支持峰谷拆分。

切换到 GPT 后，所有四个金额都只来自 GPT；切回 DeepSeek 后同理。模型切换不需要清空状态或重新扫描。

## 渲染与配置

### 通用渲染器

新增 `src/render/lines/model-cost.ts`。`src/render/lines/rmb-cost.ts` 改为薄兼容层，从通用模块导出 `renderModelCostLine`，并以 `renderRmbCostLine` 作为同签名别名；兼容仅保证旧模块路径和导出名仍存在，不保留“跨全部 DeepSeek 模型合计”的旧渲染语义。新渲染管线直接使用 `renderModelCostLine`。

GPT 示例：

```text
⚡昨$0.120(sol$0.120)
⚡今$0.370(sol$0.370) 月$1.84 会话$0.920
```

DeepSeek 示例：

```text
⚡昨¥1.23(pro¥1.23) 峰¥0.80 谷¥0.43
⚡今¥3.50(pro¥3.50) 峰¥3.50 月¥145.26 会话¥7.52
```

规则：

- 两行昨天/今天结构保持不变；
- 括号只显示当前模型短名和金额；
- GPT 不显示没有计费意义的峰/谷；
- DeepSeek 保留峰/谷；
- CNY 保持两位小数；
- USD 复用现有 `formatUsd` 精度规则，使小额请求不会全部显示为 `$0.00`；
- 无当前模型信息时不输出费用行；
- 当前模型无法匹配价格时显示 `⚡<模型> 暂无计价`，绝不显示其他模型旧金额；
- 整体统计异常时显示 `⚡费用统计异常`。

### 配置兼容

新增 `display.showModelCost`，默认 `false`。统一 helper 判断：

```text
showModelCost === true || showRmbCost === true
```

因此现有用户的 `showRmbCost: true` 无需立即改配置。任一开关开启时继续抑制原 `showCost` 段，避免同时显示两套不同口径的费用。

文档将 `showRmbCost` 标记为兼容别名，而不是立即删除。

## 数据流

```text
Claude Code statusline stdin
  ├─ model.id / model.display_name
  │    → 安全清理 → 当前规范模型
  └─ session_id
       → 增量扫描 ~/.claude/projects/**/*.jsonl
            → 解析 assistant usage
            → 规范化 message.model
            → TokenSplit
            → 选择该模型计价策略
            → 单条请求费用
            → message.id 去重与扣回
            → 昨/今/月/会话 perModel 桶
                 → 当前模型投影
                      → 币种感知渲染
```

## 异常处理

- 单条 JSONL 无法解析、缺少时间戳、usage 或 message id：跳过该条，避免重复计费。
- 非法模型文本：经过现有终端安全清理；无法匹配则按未知模型处理。
- 状态文件不存在或损坏：整体重建。
- 单个模型价格缺失：不计入该模型，当前模型视图显示暂无计价。
- 整体扫描异常：返回 `null`，只影响费用行。
- 不同币种：结构上禁止跨模型求和。
- 中转站实际扣费与官方估算不同：文档明确说明本功能是官方列表价估算，权威金额以中转站账单为准。

## 文件变更

- Create: `src/model-pricing.ts`
- Keep/modify compatibility entry: `src/deepseek-pricing.ts`
- Modify: `src/usage-stats.ts`
- Create: `src/render/lines/model-cost.ts`
- Modify: `src/render/lines/rmb-cost.ts`
- Modify: `src/render/lines/index.ts`
- Modify: `src/render/index.ts`
- Modify: `src/config.ts`
- Modify: `src/render/lines/cost.ts`
- Modify: `tests/deepseek-pricing.test.js` or replace with focused `tests/model-pricing.test.js` while retaining compatibility assertions
- Modify: `tests/usage-stats.test.js`
- Modify: `tests/rmb-cost.test.js` or add `tests/model-cost.test.js`
- Modify: `tests/config.test.js`
- Modify: integration/coverage tests as needed
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `RMB-COST.md`
- Generated by build: corresponding `dist/` artifacts only

具体测试文件拆分可在实现计划中按现有 node:test 习惯确定。

## 测试

### 计价纯函数

- `gpt-5.6-sol` 与 `gpt-5.6-sol[1m]` 解析为同一规范模型。
- `272_000` 输入使用短上下文价；`272_001` 使用长上下文价。
- 普通输入、缓存输入、缓存写入、输出分别使用正确单价。
- GPT 使用 USD、短名 `sol`、不启用峰谷。
- DeepSeek 既有峰谷边界、金额、日期和会话归属断言保持通过。
- 未知模型返回不可计价结果。

### 状态机

- 同一天混合 DeepSeek 与 GPT 时分别累计。
- 当前模型投影的昨天/今天/月/会话四层均只包含当前模型。
- 切换当前模型只切换投影，不重建状态。
- GPT 与 DeepSeek 金额没有跨币种总额。
- 流式分片更新对旧模型桶做对称扣回。
- v3 状态自动升级并补算此前跳过的 GPT 转录。
- 跨天、跨月、月初昨天搬运、会话切换、子代理归属不回归。

### 渲染与配置

- GPT 使用 `$`、USD 小额精度且不显示峰/谷。
- DeepSeek 使用 `¥` 且保留峰/谷。
- 未知模型显示暂无计价，不泄漏旧模型金额。
- `showModelCost` 与 `showRmbCost` 均可启用通用费用行。
- 启用通用费用行时原 `showCost` 仍被抑制。

### 集成验收

模拟完整 statusline stdin 与临时转录：

1. GPT 短上下文请求；
2. GPT 超过 272K 的长上下文请求；
3. DeepSeek/GPT 混合历史；
4. 同一状态下切换当前 stdin 模型。

当当前模型为 `gpt-5.6-sol[1m]` 时，输出必须包含 `sol` 与 `$`，不得包含 `pro`、`flash` 或 `¥`。

运行：

```bash
npm run build
npm test
```

并执行针对临时转录的 CLI smoke test。

## 验收标准

- 当前使用 GPT 时只显示 GPT 官方 Standard 美元估算。
- 每条 GPT 请求按实际输入 tokens 自动选择 272K 长短上下文档位。
- 当前使用 DeepSeek 时只显示相应 DeepSeek 人民币估算。
- 模型切换后不残留显示其他模型。
- 不同币种永不合计。
- 状态升级自动补算本月 GPT 历史。
- 所有既有与新增测试通过。
- 不覆盖工作区中用户已有的非本任务修改。

## 明确不做

- 不登录或查询中转站账户。
- 不保存用户提供的中转站凭据。
- 不按中转站渠道价格、分组倍率或实际扣费计价。
- 不实时抓取 OpenAI 官方价格。
- 不做汇率换算。
- 不支持 Batch、Flex、Fast 或区域处理附加费。
- 本次不添加 GPT-5.6 Terra、Luna、Cyber 等其他模型。
- 不自动猜测促销结束后的新价格。
- 不做与费用模型选择无关的状态栏重构。

## 部署注意

实现后需构建新的 `dist/` 并确保实际安装的 claude-hud 插件缓存使用该构建。本任务只改仓库及其构建产物，不主动修改用户的中转站、Claude Code 凭据或第三方服务配置。
