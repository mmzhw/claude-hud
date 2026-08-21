# 人民币费用行使用与换厂商指南

本 fork 在 claude-hud 内置了 DeepSeek 人民币费用行（`display.showRmbCost`，opt-in）：按本地计价表把转录 token 换算成人民币花费，显示 昨天/今天两行费用与 本月/会话 累计，峰谷分时计价、按模型拆分。相关代码：

- `src/deepseek-pricing.ts` — 计价表与纯函数（**换厂商只改这里**）
- `src/usage-stats.ts` — 增量扫描状态机
- `src/render/lines/rmb-cost.ts` — 费用行渲染

## 一、启用与显示

配置在 `~/.claude/plugins/claude-hud/config.json` 的 `display.showRmbCost: true`。开启后自动抑制美元 `showCost` 段，状态栏末尾追加两行（昨天行在上、今天行在下）：

```
⚡昨¥1.23(pro¥1.00/flash¥0.23) 峰¥0.80 谷¥0.43
⚡今¥3.50(pro¥3.00/flash¥0.50) 峰¥3.50 月¥145.26 会话¥7.52
```

- `昨` = 昨天合计（昨天无数据时显示 `昨¥0.00`，两行结构恒定；月初 1 号跨月的昨天数据会自动保留）；`今` = 今日合计（括号内按模型拆分）；`峰/谷` = 对应日的分时明细（北京时间 9-12、14-18 为高峰）；`月` = 本月累计（跨天持久）；`会话` = 当前会话累计（含子代理，按目录归父会话）
- 金额是本地估算，权威对账以厂商平台账单为准
- 状态文件 `~/.claude/scripts/.usage-state.json` 由 HUD 读写，增量扫描 `~/.claude/projects/**/*.jsonl`

## 二、换厂商步骤

前提：新厂商提供 Anthropic 兼容端点（Claude Code 只能接这种协议）。

### 1. 改接入配置

`~/.claude/settings.json` 的 `env`：

```json
{
  "ANTHROPIC_BASE_URL": "https://新厂商的anthropic兼容端点",
  "ANTHROPIC_AUTH_TOKEN": "新厂商的key",
  "ANTHROPIC_MODEL": "xx-model",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "xx-model",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "xx-model",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "xx-小模型",
  "CLAUDE_CODE_SUBAGENT_MODEL": "xx-小模型"
}
```

### 2. 计价表加条目

`src/deepseek-pricing.ts` 的 `PRICES_RMB_PER_MILLION`（元/百万 tokens）：

```ts
export const PRICES_RMB_PER_MILLION: Record<string, ModelRmbPricing> = {
  // 老条目保留：历史转录仍按老价算
  'deepseek-v4-pro': { displayName: 'pro', cacheHit: { peak: 0.3, off: 0.15 }, cacheMiss: { peak: 9.0, off: 4.5 }, output: { peak: 27.0, off: 13.5 } },
  'deepseek-v4-flash': { displayName: 'flash', cacheHit: { peak: 0.1, off: 0.05 }, cacheMiss: { peak: 3.0, off: 1.5 }, output: { peak: 9.0, off: 4.5 } },
  'xx-model': {
    displayName: 'xx',                          // 费用行短写；缺省显示原始模型名
    cacheHit:  { peak: 1.2, off: 1.2 },         // 无峰谷价的厂商：peak/off 填同值
    cacheMiss: { peak: 6.0, off: 6.0 },
    output:    { peak: 12.0, off: 12.0 },
  },
};
```

- **键必须是转录里 `message.model` 的原始名**（如 DeepSeek 端点在转录里记 `deepseek-v4-pro`，不是配置里的 `deepseek-v4-pro[1m]`）。不确定时切换后跑几分钟，用 `grep -o '"model":"[^"]*"' ~/.claude/projects/<项目>/<会话>.jsonl | tail -5` 查实际值
- 无法计价的模型记录会被跳过（不显示、不计费），补齐条目后删状态文件重建即可

### 3. 重建生效

```bash
cd D:/code/others/claude-hud
npm run build
git add -A && git commit -m "feat(cost): 新增 xx 厂商计价"
cp -r dist "C:/Users/augus/.claude/plugins/cache/claude-hud/claude-hud/0.8.0/"
rm "C:/Users/augus/.claude/scripts/.usage-state.json"   # 重要：改价后旧缓存金额作废，删除触发重建
```

重启 Claude Code 即生效。

## 三、注意点

- **改价必须删状态文件**：状态里缓存着按旧价算好的金额，只改价格表不删状态文件数字不会变。`PRICING_EFFECTIVE_DATE`（全局生效日期，现为 `2026-08-17`）只过滤该日期前的记录；现在换厂商的新记录都在其之后，无需改动。若未来新厂商价格生效日期更晚且需要剔除更早记录，改此常量即触发自动重建
- **峰/谷标签**：新厂商无分时计价时，显示仍按北京时间切"峰/谷"两段——总额正确，只是分段标签没意义。如需"无峰谷价只显示合计"，给计价条目加 `flat: true` 标记（目前未实现，需要时再扩展渲染逻辑）
- **厂商原生金额**：即使端点自带 `cost.total_cost_usd`，RMB 行也始终按本地计价表算；美元 `showCost` 段在 `showRmbCost` 开启时保持抑制
- **内置 `/usage` 金额不可信**：按 Anthropic 官方列表价估算，对任何第三方厂商都无意义；token 数来自真实 API 响应、可信
- **转录仅保留 30 天**（`cleanupPeriodDays`）：更早的历史无法统计
- **价格变了同理**：改 `PRICES_RMB_PER_MILLION` 数值 + 删状态文件重建，流程与换厂商一致
- **插件缓存**：每次改完 fork 代码，除提交外必须把新 `dist/` 拷进 `~/.claude/plugins/cache/claude-hud/claude-hud/0.8.0/`，状态栏跑的是缓存里的构建产物

## 四、回滚

- 关闭费用行：`display.showRmbCost` 改 `false`（美元 `showCost` 恢复可用）
- 回到上游原版插件：卸载本 fork（`/plugin` 里操作或删除缓存目录），把 `extraKnownMarketplaces` 的 `claude-hud` 源改回 `github: jarrodwatts/claude-hud`，重新安装即可
