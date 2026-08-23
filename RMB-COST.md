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
