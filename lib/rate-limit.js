'use strict';

/**
 * 极简限流：每 IP 每分钟 + 全站每分钟双阈值。
 * 默认不信任代理头；只有 TRUST_PROXY=1 时才读取 X-Forwarded-For / X-Real-IP。
 */

const WINDOW_MS = 60 * 1000;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    if (forwarded) return forwarded;
    const real = String((req.headers && req.headers['x-real-ip']) || '').trim();
    if (real) return real;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createLimiter(options = {}) {
  const perIpLimit = positiveInt(options.perIp, positiveInt(process.env.RATE_LIMIT_PER_MIN, 30));
  const globalLimit = Math.max(
    perIpLimit,
    positiveInt(options.global, positiveInt(process.env.RATE_LIMIT_GLOBAL_PER_MIN, 120))
  );
  const windowMs = positiveInt(options.windowMs, WINDOW_MS);
  const trustProxy =
    options.trustProxy != null
      ? Boolean(options.trustProxy)
      : /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));

  const buckets = new Map();
  const globalBucket = { count: 0, reset: 0 };

  function take(bucket, limit, now) {
    if (now >= bucket.reset) {
      bucket.count = 0;
      bucket.reset = now + windowMs;
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      reset: bucket.reset
    };
  }

  return function check(req, now = Date.now()) {
    const ip = clientIp(req, trustProxy);
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { count: 0, reset: 0 };
      buckets.set(ip, bucket);
    }

    const perIp = take(bucket, perIpLimit, now);
    const global = take(globalBucket, globalLimit, now);

    if (buckets.size > 2000) {
      for (const [key, value] of buckets) if (now >= value.reset) buckets.delete(key);
    }

    const reset = Math.max(perIp.reset, global.reset);
    return {
      limited: !perIp.allowed || !global.allowed,
      ip,
      limit: perIpLimit,
      remaining: Math.min(perIp.remaining, global.remaining),
      retryAfter: Math.max(1, Math.ceil((reset - now) / 1000)),
      reset: Math.floor(reset / 1000)
    };
  };
}

function rateHeaders(result) {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset)
  };
}

module.exports = { createLimiter, rateHeaders, WINDOW_MS };
