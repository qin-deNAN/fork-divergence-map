'use strict';

const { execFile } = require('node:child_process');
const config = require('../config');

/**
 * 真实数据 provider：知乎开放平台
 *
 * 前置条件（赛事官方提供）：
 *  1. 下载官方 zhihu-cli Skill 并安装 CLI
 *  2. 在 https://developer.zhihu.com/profile 生成 Access Secret
 *  3. <CLI> auth set --secret-stdin 写入凭证
 *
 * 环境变量：
 *   ZHIHU_CLI_BIN        zhihu-cli 可执行文件绝对路径（可省略，自动探测）
 *   ZHIHU_ACCESS_SECRET  可选，headless 场景直接注入
 *   LLM_BASE_URL         OpenAI 兼容端点，如 https://api.deepseek.com/v1
 *   LLM_API_KEY          对应密钥
 *   LLM_MODEL            默认 deepseek-chat
 */

const ANSWER_LIMIT = 24;
const SEARCH_COUNT = 10;
const QUERY_VARIANTS = 7;
const SEARCH_TIMEOUT_MS = 30000;
const LLM_TIMEOUT_MS = 90000;
/** 与 check-quotes.js 的校验阈值保持一致 */
const MIN_COVERAGE = 0.75;

/** 让模型把一个问题改写成多个检索角度，比规则分词更可靠 */
async function expandQueries(question) {
  try {
    const res = await callLlm(
      '你是知乎搜索词生成器。用户要给一个问题找知乎上的多元观点。请生成 6 个搜索词，从完全不同的角度切入同一个议题：'
      + '第1个用问题原话；第2个换核心名词的同义词；第3个换成陈述句或结论式提问；'
      + '第4个聚焦因果关系（为什么/原因）；第5个聚焦具体场景或人群；第6个换成反方视角（质疑这个说法）。'
      + '每个 4-15 字，关键词之间用空格隔开，不要加问号。'
      + '严格只输出 JSON：{"queries":["...","...","...","...","...","..."]}',
      `原问题：${question}`
    );
    const list = Array.isArray(res.queries) ? res.queries.filter((q) => typeof q === 'string' && q.trim().length >= 3) : [];
    if (list.length >= 3) return [...new Set([question, ...list])].slice(0, QUERY_VARIANTS);
  } catch {
    /* 失败时回退到规则方案 */
  }
  return null;
}

/**
 * 从一个问题生成多组检索词。单次搜索最多 10 条且重合度高，
 * 用不同表述并行检索再合并去重，能把样本从 9 条提到 30+ 条。
 */
/** 同义词替换：换词比加后缀更能翻出不同答主 */
const SYNONYMS = [
  [/人工智?能/g, 'AI'],
  [/取代|代替|替代/g, '替代'],
  [/程序员|开发者|码农/g, '程序员'],
  [/失业|裁员|丢工作/g, '失业'],
  [/会吗|会不会/g, '会']
];

function buildQueries(question) {
  const clean = String(question || '').trim();
  const queries = [clean];

  // 1. 疑问词去掉，得到主干
  const stem = clean
    .replace(/[吗呢么][？?]?$/, '')
    .replace(/[？?]$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stem && stem !== clean && stem.length > 3) queries.push(stem);

  // 2. 同义词归一化后，再拼常见问法
  let normalized = stem;
  for (const [re, to] of SYNONYMS) normalized = normalized.replace(re, to);
  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (normalized && normalized.length > 3) queries.push(normalized);

  // 3. 抽取二字词做词序重排。中文没空格，用固定词典 + 滑动窗口兜底
  const cleanStem = normalized.replace(/[的了吗呢啊嘛？?，,。、\s]/g, '');
  const kw = [];
  // 优先用词典里认识的词
  for (const word of ['程序员', '开发者', '人工智能', 'AI', '工作', '失业', '失业了', '取代', '替代', '大城市', '年轻人', '考研', '买房', '结婚', '出海', '外贸']) {
    if (cleanStem.includes(word) && !kw.some((k) => k.includes(word) || word.includes(k))) kw.push(word);
  }
  // 词典没覆盖的，用滑动二字词补齐
  if (kw.length < 2) {
    for (let i = 0; i + 2 <= cleanStem.length; i += 2) {
      const w = cleanStem.slice(i, i + 2);
      if (/[\u4e00-\u9fa5A-Za-z]{2}/.test(w) && !kw.includes(w)) kw.push(w);
    }
  }

  if (kw.length >= 2) {
    const a = kw[0];
    const b = kw[1];
    const combos = [
      `${b} ${a}`,
      `${a} ${b}`,
      `${b}被${a}替代`,
      `${b} ${a} 失业`,
      `${a} ${b} 前景`,
      `${b}会怎样`
    ];
    for (const c of combos) {
      if (c.length > 3 && !queries.includes(c)) queries.push(c);
    }
  }

  // 4. 常见问法模板兜底
  for (const suffix of [' 知乎', ' 怎么看']) {
    const alt = `${stem}${suffix}`.trim();
    if (alt.length > 3 && !queries.includes(alt)) queries.push(alt);
  }

  return [...new Set(queries)].filter(Boolean).slice(0, QUERY_VARIANTS);
}

function resolveBinary() {
  return config.findCli();
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const bin = resolveBinary();
    if (!bin) return reject(new Error('zhihu-cli 未安装，请先运行官方 Skill 的 setup 脚本'));
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || stdout || err.message || '');
        if (text.includes('AUTH_REQUIRED')) {
          return reject(
            new Error(
              '知乎接口未授权。请到 https://developer.zhihu.com/profile 生成 Access Secret，' +
              '再运行 "zhihu-cli.exe auth set --secret-stdin" 写入凭证。'
            )
          );
        }
        return reject(new Error(`zhihu-cli 调用失败: ${text.slice(0, 300)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`zhihu-cli 返回非 JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * 统一的知乎搜索入口。
 * 云端部署时没有本地 CLI 和系统钥匙串，所以优先用环境变量里的 Secret 走纯 HTTP；
 * 本地开发没有该变量时，继续用 CLI（凭证在钥匙串里）。
 * 两种方式的返回结构一致，上层无需区分。
 */
async function searchZhihu(query, count) {
  const secret = process.env.ZHIHU_ACCESS_SECRET;
  if (secret && secret.trim() && !secret.includes('替换为')) {
    const url = new URL('https://developer.zhihu.com/api/v1/content/zhihu_search');
    url.searchParams.set('Query', query);
    url.searchParams.set('Count', String(Math.min(count, 10)));
    const timestamp = String(Math.floor(Date.now() / 1000));
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secret.trim()}`,
          'X-Request-Timestamp': timestamp,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`知乎搜索超时（${SEARCH_TIMEOUT_MS / 1000}s）`);
      }
      throw err;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('知乎接口鉴权失败：请检查 ZHIHU_ACCESS_SECRET 是否有效');
      }
      throw new Error(`知乎搜索接口失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }
  return runCli(['search', 'zhihu', '--query', query, '--count', String(Math.min(count, 10))]);
}

async function callLlm(system, user, options = {}) {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'deepseek-chat';
  if (!base || !key) throw new Error('未配置 LLM_BASE_URL / LLM_API_KEY，无法完成主张抽取');

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`LLM 调用超时（${LLM_TIMEOUT_MS / 1000}s）`);
    }
    throw err;
  }
  if (!res.ok) throw new Error(`LLM 调用失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

const SYSTEM = `你是一名观点结构分析师。用户会给你一个知乎问题下的多条回答，你的任务不是总结，而是还原这些回答之间的分歧结构。

严格输出 JSON，字段如下：
{
  "splitPoint": {"point": "一句话指出真正的分歧所在", "kind": "fact|value", "note": "一句话说明为什么"},
  "consensus": [{"text": "所有阵营都同意的判断", "ratio": 0-100 的整数}],
  "camps": [{
    "id": "英文短标识",
    "name": "4-6 字中文阵营名",
    "stance": "一句话立场",
    "share": 该阵营在样本中占的整数百分比,
    "claim": "该阵营的核心论证，60-100 字，用他们自己的逻辑说话，不要中立化",
    "evidenceTypes": ["论据类型，如 历史类比/行业数据/个人经验/失败案例"],
    "weakness": "这个阵营最容易被反驳的地方，40-60 字，要具体、要扎心",
    "quotes": [{"sourceIndex": 回答编号数字, "text": "从该条回答中逐字复制的连续片段 60-140 字"}]
  }],
  "minority": {"sourceIndex": 回答编号数字, "text": "逐字复制的连续片段", "why": "为什么它值得被看见，40-60 字"},
  "factChecks": [{"claim": "被反复争论的可查证断言", "verdict": "成立/部分成立/不成立", "detail": "60 字内说明", "status": "verified|disputed|needs_source"}]
}

硬性要求：
1. camps 数量 3-4 个，必须互斥，不要出现"其他观点"这种垃圾桶分类。
2. 每条 quote 必须标注 sourceIndex（即该回答在输入中的 #编号），text 必须是从那条回答里【逐字复制】的连续片段。
   绝对禁止改写、拼接、概括或编造。程序会用 sourceIndex 回到原文核对，对不上就会被丢弃。
   sourceIndex 必须是 1 到回答总数之间的整数。
3. weakness 必须针对该阵营自身逻辑的漏洞，不能是"可能不准确"这类废话。
4. consensus 只保留真正的交集，2-3 条即可。
5. 区分事实分歧与价值分歧：可被数据/证据裁决的是 fact，只能靠取舍的是 value。
6. 全部使用中文。`;

function buildUserPrompt(question, answers) {
  const body = answers
    .map((a, i) => `[#${i + 1}] 作者：${a.author}（${a.bio || '知乎用户'}） 赞同：${a.upvotes}\n${a.text}`)
    .join('\n\n---\n\n');
  return `问题：${question.title}\n\n以下是 ${answers.length} 条回答：\n\n${body}`;
}

/**
 * 去掉空白，同时记录每个字符在原文中的位置。
 * 这样滑动窗口是在去空白后的文本上算的，切回原文时不会因为换行/多空格而偏移。
 */
function stripWhitespace(text) {
  const chars = [];
  const offsets = [];
  let offset = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) {
      chars.push(ch);
      offsets.push([offset, offset + ch.length]);
    }
    offset += ch.length;
  }
  return { chars, offsets };
}

/**
 * 原文锚定：把模型给的引用替换为原文中真实存在的片段。
 * 做法：在原文里找与 quote.text 重合度最高的连续窗口，取原文该窗口的内容。
 * 这样即使模型改写了几个字，最终展示的仍然是原文原话。
 */
function anchorQuote(quote, answers) {
  if (!quote || typeof quote.text !== 'string') return null;
  const idx = Number(quote.sourceIndex) - 1;
  const answer = answers[idx >= 0 && idx < answers.length ? idx : -1];
  if (!answer) return null;

  const q = stripWhitespace(quote.text);
  const t = stripWhitespace(answer.text);
  if (q.chars.length < 20 || t.chars.length < 20) return null;

  // 滑动窗口：枚举原文所有与引用等长的窗口，找字符重合度最高的
  const window = Math.min(q.chars.length, t.chars.length);
  let bestStart = 0;
  let bestScore = 0;
  for (let s = 0; s + window <= t.chars.length; s += 1) {
    let score = 0;
    for (let i = 0; i < window; i++) if (t.chars[s + i] === q.chars[i]) score++;
    if (score > bestScore) {
      bestScore = score;
      bestStart = s;
    }
  }

  const coverage = bestScore / window;
  if (coverage < MIN_COVERAGE) return null; // 对不上，宁可丢弃

  // 把去空白后的下标映射回原文，避免切错位置
  const raw = answer.text;
  const rawStart = t.offsets[bestStart][0];
  const rawEnd = t.offsets[bestStart + window - 1][1];
  const end = Math.min(raw.length, rawEnd + 20);
  let start = Math.max(0, rawStart - 40);

  // 在起点前找最近的分句符，从完整句子开始
  const before = raw.slice(0, start);
  const lastBreak = Math.max(
    before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'),
    before.lastIndexOf('\n'), before.lastIndexOf('；')
  );
  if (lastBreak >= 0 && start - lastBreak < 120) start = lastBreak + 1;

  let text = raw.slice(start, end).replace(/\s+/g, ' ').trim();

  // 结尾截到最后一个完整句子
  const lastStop = Math.max(
    text.lastIndexOf('。'), text.lastIndexOf('！'), text.lastIndexOf('？')
  );
  if (lastStop >= 60) text = text.slice(0, lastStop + 1);

  // 180 字以内，尽量不把句子拦腰截断
  if (text.length > 180) {
    const cut = text.slice(0, 180);
    const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('；'));
    text = stop >= 60 ? cut.slice(0, stop + 1) : cut;
  }

  if (text.length < 20) return null;

  return {
    author: answer.author,
    bio: answer.bio,
    upvotes: answer.upvotes,
    url: answer.url,
    text,
    verified: true,
    similarity: Number(coverage.toFixed(2))
  };
}

/**
 * 把模型输出的引用逐条锚定回原文，并记录校验统计。
 * 锚定不通过或阵营被清空时，由调用方决定是否重试。
 */
function applyQuotes(analysis, answers) {
  let total = 0;
  let verified = 0;

  analysis.camps = (analysis.camps || []).slice(0, 4).map((camp, i) => {
    const quotes = (camp.quotes || [])
      .slice(0, 2)
      .map((quote) => {
        total++;
        const anchored = anchorQuote(quote, answers);
        if (anchored) verified++;
        return anchored;
      })
      .filter(Boolean);
    return { ...camp, id: camp.id || `camp-${i}`, quotes };
  });

  if (analysis.minority) {
    total++;
    const anchored = anchorQuote(analysis.minority, answers);
    if (anchored) verified++;
    analysis.minority = anchored ? { ...anchored, why: analysis.minority.why } : null;
  }

  // 没有可用引用的阵营剔除，避免页面出现空卡片
  analysis.camps = analysis.camps.filter((camp) => camp.quotes.length > 0);
  return { total, verified };
}

/** 解析 search zhihu 返回的 Items：它带作者、赞同数和正文，比 question answers 的纯 Summary 更适合做观点分析 */
function toAnswers(raw) {
  const data = raw?.Data || raw?.data || raw;
  const items = Array.isArray(data?.Items) ? data.Items : [];
  return items
    .filter((it) => it.ContentType === 'Answer' || it.ContentType === 'answer')
    .map((it, i) => ({
      author: it.AuthorName || `答主 ${i + 1}`,
      bio: it.AuthorBadgeText || '',
      upvotes: Number(it.VoteUpCount || 0),
      text: String(it.ContentText || it.Summary || '')
        .replace(/\[图片\]/g, '')
        .replace(/<[^>]+>/g, '')
        .trim(),
      url: (it.Url || '').split('?')[0]
    }))
    .filter((a) => a.text.length > 40);
}

function zhihuProvider(input) {
  const state = { question: null, answers: [], analysis: null };

  return {
    name: 'zhihu-openapi',

    // 供引用校验器读取中间产物
    get __answers() { return state.answers; },
    get __analysis() { return state.analysis; },

    async retrieve() {
      // 真实链路的检索词扩展就要用 LLM；先失败，避免白跑 7 次搜索再报错
      if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY) {
        throw new Error(
          'LLM 未配置：真实链路需要 LLM_BASE_URL 与 LLM_API_KEY。' +
          '想先看效果，请在 .env 里设置 FORK_DATA_SOURCE=sample。'
        );
      }

      // 用搜索拿带作者与赞同数的回答；question answers 只有 Summary，字段不够
      const rawQuestion = String(input.question || '').trim();
      if (/^https?:\/\//i.test(rawQuestion)) {
        // 开放平台没有问题详情接口，链接无法解析成标题；在入口处明确拒绝，避免白跑检索
        throw new Error('暂不支持直接解析知乎链接，请改用问题标题。');
      }
      const query = rawQuestion;
      const queries = (await expandQueries(query)) || buildQueries(query);

      // 并发检索，逐个兜底：某一组失败不影响整体
      const results = await Promise.all(
        queries.map((q) =>
          searchZhihu(q, SEARCH_COUNT)
            .then(toAnswers)
            .catch(() => [])
        )
      );

      // 按回答 ID 去重，保留赞同数最高的那份
      const byId = new Map();
      for (const batch of results) {
        for (const a of batch) {
          const m = (a.url || '').match(/answer\/(\d+)/);
          const key = m ? m[1] : `${a.author}|${a.text.slice(0, 40)}`;
          const prev = byId.get(key);
          if (!prev || a.upvotes > prev.upvotes) byId.set(key, a);
        }
      }

      // 按赞同数降序，截取 top N
      state.answers = [...byId.values()]
        .sort((a, b) => b.upvotes - a.upvotes)
        .slice(0, ANSWER_LIMIT);

      if (!state.answers.length) {
        throw new Error('搜索没有返回可用回答。试试更具体的问题描述，或直接输入问题标题。');
      }

      const firstUrl = state.answers[0].url || '';
      const id = (firstUrl.match(/question\/(\d+)/) || [])[1] || '';
      state.question = {
        title: query || '未命名问题',
        url: id ? `https://www.zhihu.com/question/${id}` : firstUrl,
        // 开放平台不返回问题维度的关注数/总回答数；宁可留空，也不要显示假的 0
        answerCount: null,
        followers: null,
        sampled: state.answers.length
      };
      state.queryInfo = { queries, rawCandidates: byId.size };
    },

    async extract() {
      state.analysis = await callLlm(SYSTEM, buildUserPrompt(state.question, state.answers));
    },

    async cluster() {
      // 阵营聚合已由 LLM 一次性完成，这里做结构校验、引用锚定与兜底重试
      let analysis = state.analysis;
      let stats = { total: 0, verified: 0 };

      if (analysis && Array.isArray(analysis.camps) && analysis.camps.length >= 2) {
        stats = applyQuotes(analysis, state.answers);
      }

      if (!analysis || !Array.isArray(analysis.camps) || analysis.camps.length < 2) {
        // 引用锚定后阵营被清空，或模型没给出足够阵营：提高温度重试一次
        console.log(`[fork] 可用阵营不足（${stats.total} 条引用 / ${stats.verified} 条通过），重试一次`);
        try {
          const retried = await callLlm(SYSTEM, buildUserPrompt(state.question, state.answers), { temperature: 0.5 });
          if (retried && Array.isArray(retried.camps) && retried.camps.length >= 2) {
            analysis = retried;
            stats = applyQuotes(analysis, state.answers);
          }
        } catch (err) {
          console.warn(`[fork] 重试失败：${err.message || err}`);
        }
      }

      if (!analysis || !Array.isArray(analysis.camps) || analysis.camps.length < 2) {
        const count = analysis && Array.isArray(analysis.camps) ? analysis.camps.length : 0;
        throw new Error(
          `这次只拆出 ${count} 个可用阵营（${stats.total} 条引用中 ${stats.verified} 条通过原文校验）。` +
          '请重试一次，或换一个回答更多的问题。'
        );
      }

      state.analysis = analysis;
      state.quoteStats = stats;
    },

    async classify() {
      if (!state.analysis.splitPoint) {
        state.analysis.splitPoint = { point: '样本内未形成明确分歧', kind: 'value', note: '' };
      }
      state.analysis.minority = state.analysis.minority || null;
      state.analysis.factChecks = state.analysis.factChecks || [];
    },

    result() {
      return {
        question: state.question,
        splitPoint: state.analysis.splitPoint,
        consensus: state.analysis.consensus || [],
        camps: state.analysis.camps,
        minority: state.analysis.minority,
        factChecks: state.analysis.factChecks,
        meta: {
          source: 'zhihu-openapi',
          generatedAt: new Date().toISOString(),
          sampled: state.question.sampled,
          queries: state.queryInfo ? state.queryInfo.queries : [],
          rawCandidates: state.queryInfo ? state.queryInfo.rawCandidates : 0,
          quoteVerified: state.quoteStats ? state.quoteStats.verified : 0,
          quoteTotal: state.quoteStats ? state.quoteStats.total : 0
        }
      };
    }
  };
}

module.exports = zhihuProvider;
// 供 doctor / 单元测试复用，不影响 provider 契约
module.exports.anchorQuote = anchorQuote;
module.exports.searchZhihu = searchZhihu;
module.exports.toAnswers = toAnswers;
