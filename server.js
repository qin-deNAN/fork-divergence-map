'use strict';

const config = require('./lib/config');
config.loadEnv();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('./lib/pipeline');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health') {
    const s = config.status();
    const sampleMode = config.forcedSample();
    // provider 表示「下一次分析实际会走哪条路」：与 providers.pick() 保持一致，
    // 只要装了 CLI 或注入了 Secret 就走真实链路（未授权时明确报错，而不是回退示例）。
    const realPath = Boolean(s.cli || s.envSecret);
    return sendJson(res, 200, {
      ok: true,
      provider: sampleMode || !realPath ? 'sample' : 'zhihu-openapi',
      ready: s.ready,
      sampleMode,
      detail: {
        cli: Boolean(s.cli),
        cliVersion: s.cliVersion,
        auth: s.auth,
        llm: s.llm,
        ready: s.ready
      }
    });
  }

  if (url.pathname === '/api/analyze/stream' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    if (!body.question && !body.questionUrl) {
      return sendJson(res, 400, { ok: false, error: '缺少 question 或 questionUrl' });
    }

    // NDJSON 流：先把每个阶段的开始/结束实时推给前端，最后再推完整结果
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    res.on('close', () => { closed = true; });
    res.on('error', () => { closed = true; });
    const write = (obj) => {
      if (closed || res.writableEnded) return;
      res.write(JSON.stringify(obj) + '\n');
    };

    try {
      const result = await analyze(body, {
        onStage: (evt) => write({ type: 'stage', ...evt })
      });
      write({ type: 'result', payload: result });
    } catch (err) {
      write({ type: 'result', payload: { ok: false, error: err.message } });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.question && !body.questionUrl) {
        return sendJson(res, 400, { ok: false, error: '缺少 question 或 questionUrl' });
      }
      const result = await analyze(body);
      return sendJson(res, result.ok ? 200 : 503, result);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  const s = config.status();
  const mode = config.forcedSample() || !(s.cli || s.envSecret) ? '示例数据集' : '知乎开放平台';
  const actualPort = server.address().port;
  console.log(`Fork 已启动：http://localhost:${actualPort}  (数据源：${mode})`);
  if (!s.ready) console.log('提示：运行 node doctor.js 查看还缺什么配置。');
});
