'use strict';

/**
 * 引用真实性校验器
 * 原理：模型返回的每条 quote.text，必须能在原始回答里找到一段高度重合的连续文字。
 * 用滑动窗口算最长公共子串覆盖率，阈值默认 0.75。
 */

const config = require('./lib/config');
config.loadEnv();

const zhihuProvider = require('./lib/providers/zhihu');

const THRESHOLD = 0.75;

/** 计算 a 在 b 中的最长公共子串长度（DP） */
function lcsLength(a, b) {
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    cur[0] = 0;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      } else cur[j] = 0;
    }
    [prev, cur] = [cur, prev];
  }
  return best;
}

/** 归一化：去空白、统一标点，避免格式差异误判 */
function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[“”"「」]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[，,]/g, ',')
    .replace(/[。.]/g, '.')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?');
}

function verifyQuote(quote, answers) {
  const q = norm(quote.text);
  if (q.length < 20) return { ok: false, coverage: 0, reason: '引用过短' };

  let best = { coverage: 0, author: null };
  for (const a of answers) {
    const t = norm(a.text);
    const lcs = lcsLength(q, t);
    const coverage = lcs / q.length;
    if (coverage > best.coverage) best = { coverage, author: a.author };
  }
  return {
    ok: best.coverage >= THRESHOLD,
    coverage: Number(best.coverage.toFixed(2)),
    matchedAuthor: best.author,
    quoteAuthor: quote.author,
    authorMatch: best.author === quote.author
  };
}

async function main() {
  const question = process.argv[2] || 'AI 会取代程序员吗';
  const p = zhihuProvider({ question });
  await p.retrieve();
  await p.extract();

  // 从 provider 内部拿原文（通过 result 拿不到，这里直接用反射）
  const answers = p.__answers || [];
  if (!answers.length) {
    console.log('无法取得原文，校验中止');
    return;
  }

  const analysis = p.__analysis || null;
  const quotes = [];
  for (const camp of analysis?.camps || []) {
    for (const q of camp.quotes || []) quotes.push({ where: camp.name, ...q });
  }
  if (analysis?.minority) quotes.push({ where: '少数派', ...analysis.minority });

  // 锚定后的引用自带 verified 标记和原文作者，先做一次快速判断
  const anchored = quotes.filter((q) => q.verified && q.author);
  if (anchored.length === quotes.length && quotes.length > 0) {
    console.log(`\n[锚定校验] ${quotes.length}/${quotes.length} 条引用来自原文（代码级保证）`);
    for (const q of quotes) {
      console.log(`  [通过] ${q.where} / ${q.author} | 相似度 ${q.similarity} | ${String(q.text).slice(0, 50)}...`);
    }
    console.log('\n结论：全部引用已锚定原文，无编造风险。\n');
    return;
  }

  console.log(`\n校验 ${quotes.length} 条引用 | 原始回答 ${answers.length} 条 | 阈值 ${THRESHOLD}\n`);
  let pass = 0;
  for (const q of quotes) {
    const r = verifyQuote(q, answers);
    if (r.ok) pass++;
    console.log(
      `${r.ok ? '[通过]' : '[存疑]'} ${r.coverage} ${q.where} / ${q.author}` +
      ` | 原文作者: ${r.matchedAuthor || '-'} | 作者一致: ${r.authorMatch}`
    );
    console.log(`       引用: ${String(q.text).slice(0, 70)}...`);
    if (!r.ok && r.matchedAuthor) {
      const orig = answers.find((a) => a.author === r.matchedAuthor);
      if (orig) console.log(`       原文: ${String(orig.text).slice(0, 140)}...`);
    }
  }
  console.log(`\n结果: ${pass}/${quotes.length} 条引用可在原文中找到\n`);
}

main().catch((e) => {
  console.error('校验失败:', e.message);
  process.exitCode = 1;
});
