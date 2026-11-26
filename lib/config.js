'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENV_FILE = path.join(__dirname, '..', '.env');

/** 极简 .env 读取：只在变量未设置时写入，不覆盖真实环境变量 */
function loadEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/** 探测 zhihu-cli：优先用显式配置，其次自动找官方默认安装位置 */
function findCli() {
  const explicit = process.env.ZHIHU_CLI_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(local, 'ZhihuCLI', 'current', 'zhihu-cli.exe'),
    path.join(local, 'ZhihuCLI', 'current', 'zhihu-cli'),
    path.join(process.env.HOME || '', '.local', 'bin', 'zhihu-cli')
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

const versionCache = new Map();

function cliVersion(bin) {
  if (versionCache.has(bin)) return versionCache.get(bin);
  try {
    const out = execFileSync(bin, ['version'], { encoding: 'utf8', timeout: 10000 });
    const version = JSON.parse(out).version || null;
    if (version) versionCache.set(bin, version);
    return version;
  } catch {
    return null;
  }
}

function authStatus(bin) {
  try {
    const out = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 10000 });
    const j = JSON.parse(out);
    return {
      configured: Boolean(j.ok && (j.environment_set || (j.keychain && j.keychain !== 'not_found'))),
      detail: j
    };
  } catch (e) {
    return { configured: false, detail: { error: e.message } };
  }
}

/** 环境变量中的 Secret 是否是真实值（排除空值和占位符） */
function hasEnvSecret() {
  const s = (process.env.ZHIHU_ACCESS_SECRET || '').trim();
  return Boolean(s) && !s.includes('替换为') && !s.includes('your_') && s.length > 10;
}

/** 是否被显式要求使用示例数据 */
function forcedSample() {
  return String(process.env.FORK_DATA_SOURCE || '').toLowerCase() === 'sample';
}

const STATUS_TTL_MS = 15000;
let statusCache = null;
let statusCachedAt = 0;

function status() {
  const now = Date.now();
  // health 会被每次页面加载调用；CLI 探测要 spawn 子进程，缓存 15 秒避免打爆
  if (statusCache && now - statusCachedAt < STATUS_TTL_MS) return statusCache;

  const bin = findCli();
  const llmConfigured = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
  const auth = bin ? authStatus(bin) : { configured: false, detail: {} };
  statusCache = {
    envFile: fs.existsSync(ENV_FILE),
    cli: bin,
    cliVersion: bin ? cliVersion(bin) : null,
    auth: auth.configured || hasEnvSecret(),
    authDetail: auth.detail,
    envSecret: hasEnvSecret(),
    llm: llmConfigured,
    llmBase: process.env.LLM_BASE_URL || null,
    llmModel: process.env.LLM_MODEL || 'deepseek-chat',
    ready: Boolean((bin && auth.configured || hasEnvSecret()) && llmConfigured)
  };
  statusCachedAt = now;
  return statusCache;
}

module.exports = { loadEnv, findCli, cliVersion, authStatus, hasEnvSecret, forcedSample, status, ENV_FILE };
