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

function normalizeQuestion(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[？?！!。.]+$/g, '');
}

function mockProvider(input) {
  const q = String(input.question || '').trim();
  const qNorm = normalizeQuestion(q);
  const hit =
    samples.find((s) => normalizeQuestion(s.question.title) === qNorm) ||
    samples.find((s) => qNorm.length >= 4 && normalizeQuestion(s.question.title).startsWith(qNorm));

  if (!hit) {
    const shown = q.length > 60 ? `${q.slice(0, 60)}…` : q;
    const titles = samples.map((s) => `「${s.question.title}」`).join('、');
    const err = new Error(`示例数据集没有「${shown}」这个问题。内置问题：${titles}。`);
    err.hint = '点击页面上的示例按钮，或在 .env 中配置真实凭证后分析任意问题。';
    err.status = 400;
    throw err;
  }

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
    return zhihu(input);
  }
  return mockProvider(input);
}

module.exports = { pick, mockProvider };
