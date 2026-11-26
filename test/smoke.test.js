'use strict';

/**
 * 无凭证冒烟测试：强制示例数据，起一个真实服务，验证三条主链路。
 * 运行：npm test
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { anchorQuote } = require('../lib/providers/zhihu');

const ROOT = path.join(__dirname, '..');

let child;
let base;
let output = '';

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0', FORK_DATA_SOURCE: 'sample' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    const timer = setTimeout(() => fail(new Error(`服务启动超时\n${output}`)), 15000);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }

    function onData(chunk) {
      output += chunk.toString();
      const match = output.match(/localhost:(\d+)/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        base = `http://127.0.0.1:${match[1]}`;
        resolve();
      }
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => fail(new Error(`服务提前退出（code=${code}）\n${output}`)));
  });
}

before(startServer);

after(() => {
  if (child && child.exitCode === null) child.kill();
});

test('anchorQuote 在换行和多空格原文中不偏移', () => {
  const raw = '先来一段无关的引子。\n\n  这是   一段 带空白 的原文，  \n用来测试锚定是否偏移。后面还有别的内容。';
  const answers = [{ author: '测试作者', bio: '', upvotes: 1, text: raw }];
  const anchored = anchorQuote(
    { sourceIndex: 1, text: '这是一段带空白的原文，用来测试锚定是否偏移' },
    answers
  );

  assert.ok(anchored, '应能锚定到原文');
  const compact = anchored.text.replace(/\s+/g, '');
  assert.ok(compact.includes('这是一段带空白的原文'));
  assert.ok(compact.includes('用来测试锚定是否偏移'));
  assert.equal(anchored.similarity, 1);
  assert.equal(anchored.author, '测试作者');
});

test('health 在示例模式下明确标注 sample', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'sample');
  assert.equal(body.sampleMode, true);
  assert.equal(typeof body.ready, 'boolean');
});

test('/api/analyze 返回可渲染的阵营结构', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'AI 编程工具会让程序员失业吗？' })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.data && Array.isArray(body.data.camps));
  assert.ok(body.data.camps.length >= 2, '至少要有两个阵营');
  for (const camp of body.data.camps) {
    assert.ok(camp.name, '阵营要有名字');
    assert.ok(Array.isArray(camp.quotes), '阵营要有引用');
  }
  assert.ok(body.timings && Object.keys(body.timings).length >= 4, '四段耗时要齐全');
});

test('示例数据按问题匹配，第二个示例不会复用第一个', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '年轻人要不要去大城市发展？' })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.question.title, '年轻人要不要去大城市发展？');
  assert.equal(body.data.camps.length, 4);
  assert.ok(body.data.camps.some((camp) => camp.name === '机会优先派'));
  assert.ok(body.data.camps.every((camp) => camp.quotes.length >= 1));
});

test('/api/analyze/stream 逐段推送并以 result 结束', async () => {
  const res = await fetch(`${base}/api/analyze/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'AI 编程工具会让程序员失业吗？' })
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/x-ndjson/);

  const text = await res.text();
  const events = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const stages = events.filter((evt) => evt.type === 'stage');
  const started = new Set(stages.filter((evt) => evt.status === 'start').map((evt) => evt.stage));
  assert.deepEqual([...started].sort(), ['classify', 'cluster', 'extract', 'retrieve']);

  const last = events[events.length - 1];
  assert.equal(last.type, 'result');
  assert.equal(last.payload.ok, true);
  assert.ok(last.payload.data.camps.length >= 2);
});

test('知乎链接会得到明确提示，而不是被当成搜索词', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'https://www.zhihu.com/question/457144259' })
  });
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /问题标题/);
});

test('缺少问题时返回 400 而不是崩溃', async () => {
  const res = await fetch(`${base}/api/analyze/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /question/);
});

test('首页可以正常访问', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /Fork/);
});

test('favicon 可以访问', async () => {
  const res = await fetch(`${base}/favicon.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);
});
