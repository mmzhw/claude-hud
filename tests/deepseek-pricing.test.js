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
  assert.equal(beijingDate('invalid'), ''); // 非法时间戳返回空串，不抛 RangeError
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
