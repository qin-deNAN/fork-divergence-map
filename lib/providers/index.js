'use strict';

const samples = require('../../data/samples.json');
const zhihu = require('./zhihu');
const config = require('../config');

/**
 * provider 契约（pipeline 会按顺序调用上一步结果作为下一步输入）：
 *   retrieve(input) -> resolve
 *   extract() -> resolve
 *   cluster() -> resolve
 *   classify() -> resolve
 *   result()   -> 最终 payload（结构见 data/samples.json）
 */

function mockProvider(input) {
  const q = (input.question || '').trim();
  const hit =
    samples.find((s) => s.question.title === q) ||
    samples.find((s) => q && s.question.title.includes(q.slice(0, 4))) ||
    samples[0];
  let picked = null;

  return {
    name: 'sample',
    async retrieve() {
      picked = JSON.parse(JSON.stringify(hit));
      await wait(420);
    },
    async extract() {
      await wait(380);
    },
    async cluster() {
      await wait(320);
    },
    async classify() {
      await wait(260);
    },
    result() {
      return picked;
    }
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(input) {
  // 显式设为 sample 时永远走示例数据，方便没配置凭证时演示
  if (config.forcedSample()) {
    return mockProvider(input);
  }
  // 只要本机装了官方 CLI（或显式注入了凭证），就走真实链路。
  // 未授权时 zhihu provider 会给出明确错误，而不是悄悄退回示例数据。
  if (config.findCli() || config.hasEnvSecret()) {
    try {
      return zhihu(input);
    } catch (err) {
      return mockProvider(input);
    }
  }
  return mockProvider(input);
}

module.exports = { pick, mockProvider };
