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
  assert.match(await res.text(), /Fork/);
});
