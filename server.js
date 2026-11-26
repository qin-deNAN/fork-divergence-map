'use strict';

const config = require('./lib/config');
config.loadEnv();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('./lib/pipeline');
const { createLimiter, rateHeaders } = require('./lib/rate-limit');

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

const RATE_WINDOW_MS = 60 * 1000;
const checkRateLimit = createLimiter({ windowMs: RATE_WINDOW_MS });

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
const resultCache = new Map();

function headers(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function sendJson(res, code, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(
    code,
    headers({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, ...extra })
  );
  res.end(buf);
}

function rateLimited(res, rl) {
  return sendJson(
    res,
    429,
    { ok: false, error: '请求过于频繁，请稍后再试。' },
    { ...rateHeaders(rl), 'Retry-After': String(rl.retryAfter) }
  );
}

function sendText(res, code, text) {
  const buf = Buffer.from(text);
  res.writeHead(code, headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length }));
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    let timer;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(msg));
    };

    timer = setTimeout(() => fail('请求体读取超时'), 15000);

    req.on('data', (chunk) => {
      if (settled) return;
      raw += chunk;
      if (raw.length > 1e6) {
        fail('请求体过大');
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseQuestion(body = {}) {
  const question = String(body?.question || '').trim();
  if (body?.questionUrl && !question) {
    return { error: '暂不支持直接解析知乎链接，请粘贴问题标题。' };
  }
  if (!question) return { error: '缺少 question' };
  if (/^https?:\/\//i.test(question)) {
    return { error: '暂不支持直接解析知乎链接，请粘贴问题标题。' };
  }
  return { question };
}

function cacheKey(question) {
  return String(question).replace(/\s+/g, ' ').trim();
}

function cacheGet(key) {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (resultCache.size >= CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value);
  }
  resultCache.set(key, { at: Date.now(), value });
}

function serveStatic(res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return sendText(res, 400, 'bad request');
  }

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return sendText(res, 400, 'bad request');

  const file = path.join(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'forbidden');
  }

  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, 'not found');
    res.writeHead(
      200,
      headers({
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache'
      })
    );
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
    const rl = checkRateLimit(req);
    if (rl.limited) return rateLimited(res, rl);

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const parsed = parseQuestion(body);
    if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
    const key = cacheKey(parsed.question);

    // NDJSON 流：先把每个阶段的开始/结束实时推给前端，最后再推完整结果
    res.writeHead(
      200,
      headers({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...rateHeaders(rl)
      })
    );
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    res.on('close', () => { closed = true; });
    res.on('error', () => { closed = true; });
    const write = (obj) => {
      if (closed || res.writableEnded) return;
      res.write(JSON.stringify(obj) + '\n');
    };

    const cached = cacheGet(key);
    if (cached) {
      for (const stage of cached.stages || []) {
        write({
          type: 'stage',
          stage: stage.id,
          label: stage.label,
          status: 'done',
          ms: (cached.timings && cached.timings[stage.id]) || 0
        });
      }
      write({ type: 'result', payload: cached });
      if (!res.writableEnded) res.end();
      return;
    }

    try {
      const result = await analyze({ question: parsed.question }, {
        onStage: (evt) => write({ type: 'stage', ...evt })
      });
      // 只缓存真实链路；示例数据是演示用，不应该掩盖真实的阶段耗时
      if (result.ok && result.provider !== 'sample') cacheSet(key, result);
      write({ type: 'result', payload: result });
    } catch (err) {
      write({ type: 'result', payload: { ok: false, error: err.message } });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    const rl = checkRateLimit(req);
    if (rl.limited) return rateLimited(res, rl);

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const parsed = parseQuestion(body);
    if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
    const key = cacheKey(parsed.question);

    try {
      const cached = cacheGet(key);
      if (cached) return sendJson(res, 200, cached);

      const result = await analyze({ question: parsed.question });
      if (result.ok && result.provider !== 'sample') cacheSet(key, result);
      return sendJson(res, result.ok ? 200 : result.status || 503, result, rateHeaders(rl));
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed');
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
