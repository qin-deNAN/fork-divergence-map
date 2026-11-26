'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STAGES = [
  { id: 'retrieve', label: '检索该问题下的高赞回答' },
  { id: 'extract', label: '逐条抽取核心主张与论据类型' },
  { id: 'cluster', label: '按立场聚合阵营，识别共识区' },
  { id: 'classify', label: '判定每个分歧是事实分歧还是价值分歧' }
];

const KIND_LABEL = { fact: '事实分歧', value: '价值分歧' };
const STATUS_LABEL = {
  verified: ['st-verified', '可查证 · 成立'],
  disputed: ['st-disputed', '存疑'],
  needs_source: ['st-needs', '待查证']
};

let busy = false;

async function init() {
  try {
    const res = await fetch('/api/health');
    const json = await res.json();
    const badge = $('#source-badge');
    const ready = json.ready != null ? json.ready : json.detail && json.detail.ready;
    if (json.sampleMode || json.provider !== 'zhihu-openapi') {
      badge.textContent = '数据源：示例数据集';
    } else if (ready) {
      badge.textContent = '数据源：知乎开放平台 · 实时';
      badge.classList.add('live');
    } else {
      badge.textContent = '数据源：知乎开放平台 · 配置不完整';
      badge.classList.add('warn');
    }
  } catch {
    /* 忽略：徽章保持默认文案 */
  }

  $('#ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('#q').value.trim();
    if (!value) {
      $('#q').focus();
      return;
    }
    run(value);
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#q').value = chip.dataset.q;
      run(chip.dataset.q);
    });
  });

  const preset = new URLSearchParams(location.search).get('q');
  if (preset) {
    $('#q').value = preset;
    run(preset);
  }
}

async function run(question) {
  if (busy) return;
  busy = true;
  $('#submit-btn').disabled = true;
  $('#result').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const progress = renderProgress();
  $('#progress').hidden = false;
  $('#progress').replaceChildren(progress.root);

  let payload;
  try {
    payload = await streamAnalyze(question, progress.rows);
  } catch (err) {
    if (err.streamStarted) {
      payload = { ok: false, error: err.message };
    } else {
      // 服务端不支持流式（例如旧版本部署）时，退回一次性接口
      const first = progress.rows.get(STAGES[0].id);
      if (first) first.classList.add('active');
      try {
        payload = await fetchAnalyze(question);
      } catch (e) {
        payload = { ok: false, error: e.message };
      }
    }
  }
  applyTimings(progress.rows, payload.timings);

  $('#progress').hidden = true;

  if (!payload.ok) {
    const result = $('#result');
    result.hidden = false;
    result.innerHTML = `<div class="error">
      <div style="margin-bottom:8px">${esc(payload.error || '分析失败')}</div>
      ${payload.hint ? `<code>${esc(payload.hint)}</code>` : ''}
    </div>`;
  } else {
    renderResult(payload);
  }

  busy = false;
  $('#submit-btn').disabled = false;
}

function renderProgress() {
  const root = document.createElement('div');
  const rows = new Map();
  for (const stage of STAGES) {
    const row = document.createElement('div');
    row.className = 'stage';
    row.dataset.stage = stage.id;
    row.innerHTML = `<i class="dot"></i><span>${esc(stage.label)}</span><span class="ms"></span>`;
    root.appendChild(row);
    rows.set(stage.id, row);
  }
  return { root, rows };
}

/** 用服务端回传的真实阶段事件更新进度条 */
function applyStage(rows, evt) {
  const row = rows.get(evt.stage);
  if (!row) return;
  if (evt.status === 'start') {
    row.classList.add('active');
  } else if (evt.status === 'done') {
    row.classList.remove('active');
    row.classList.add('done');
    row.querySelector('.ms').textContent = `${Number(evt.ms) || 0}ms`;
  } else if (evt.status === 'error') {
    row.classList.remove('active');
    row.classList.add('failed');
  }
}

/** 一次性接口的兜底：结果返回后回填真实耗时 */
function applyTimings(rows, timings) {
  if (!timings) return;
  for (const [id, ms] of Object.entries(timings)) {
    const row = rows.get(id);
    if (!row) continue;
    row.classList.remove('active');
    row.classList.add('done');
    row.querySelector('.ms').textContent = `${Number(ms) || 0}ms`;
  }
}

async function streamAnalyze(question, rows) {
  const res = await fetch('/api/analyze/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ question, questionUrl: /^https?:/.test(question) ? question : undefined })
  });
  if (!res.ok || !res.body) throw new Error(`流式接口不可用（HTTP ${res.status}）`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let payload = null;
  let started = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        started = true;
        buffer += decoder.decode(value, { stream: true });
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === 'stage') applyStage(rows, evt);
        else if (evt.type === 'result') payload = evt.payload;
      }
      if (done) break;
    }
  } catch (err) {
    err.streamStarted = started;
    throw err;
  }

  if (!payload) {
    const err = new Error('分析流中断，没有收到结果');
    err.streamStarted = started;
    throw err;
  }
  return payload;
}

function fetchAnalyze(question) {
  return fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, questionUrl: /^https?:/.test(question) ? question : undefined })
  }).then((res) => res.json());
}

function renderResult(payload) {
  const d = payload.data;
  const result = $('#result');
  result.hidden = false;
  result.innerHTML = `
    ${renderHead(d, payload)}
    <div class="section-label">共识区 · 各阵营都同意的部分</div>
    ${renderConsensus(d.consensus)}
    ${renderSplit(d.splitPoint)}
    <div class="camps" id="camps">${d.camps.map(renderCamp).join('')}</div>
    ${renderMinority(d.minority)}
    ${renderChecks(d.factChecks)}
  `;
  const pool = d.meta.rawCandidates ? ` · 从 ${d.meta.rawCandidates} 条候选中筛选` : '';
  const queries = d.meta.queries && d.meta.queries.length ? ` · ${d.meta.queries.length} 组检索词` : '';
  const verified = d.meta.quoteTotal ? ` · 引用 ${d.meta.quoteVerified}/${d.meta.quoteTotal} 条已核对原文` : '';
  $('#foot-meta').textContent = `抽样 ${d.meta.sampled} 条回答${pool}${queries}${verified} · 耗时 ${(payload.elapsedMs / 1000).toFixed(1)}s`;
}

function renderHead(d, payload) {
  return `<div class="qhead">
    <h2>${esc(d.question.title)}</h2>
    <div class="qmeta">
      <span>${esc(String(d.question.answerCount))} 个回答</span>
      <span>${esc(String(d.question.followers))} 人关注</span>
      <span>抽样 ${esc(String(d.meta.sampled))} 条</span>
      <span>拆出 ${esc(String(d.camps.length))} 个阵营</span>
      ${d.question.url ? `<a href="${esc(d.question.url)}" target="_blank" rel="noopener">查看原问题 ↗</a>` : ''}
    </div>
  </div>`;
}

function renderConsensus(list) {
  if (!list || !list.length) return '<p class="lede">本次样本内没有找到明确的共识项。</p>';
  const items = list
    .map(
      (c) => `<div class="cons-item">
        <p>${esc(c.text)}</p>
        <div class="cons-bar"><span style="width:${Number(c.ratio) || 0}%"></span></div>
        <div class="cons-ratio">${Number(c.ratio) || 0}% 的回答持有此判断</div>
      </div>`
    )
    .join('');
  return `<div class="consensus">${items}</div>`;
}

function renderSplit(split) {
  const kind = split.kind === 'fact' ? 'fact' : 'value';
  return `<div class="split">
    <div class="split-top">
      <span class="split-kind kind-${kind}">${KIND_LABEL[kind]}</span>
      <span class="split-label">分歧的真正位置</span>
    </div>
    <h3>${esc(split.point)}</h3>
    <p>${esc(split.note || '')}</p>
  </div>`;
}

function renderCamp(camp, i) {
  const quotes = (camp.quotes || [])
    .map(
      (q) => `<div class="quote">
        ${esc(q.text)}
        <div class="quote-meta">
          <b>${esc(q.author)}</b>
          <span>${esc(q.bio || '知乎用户')}</span>
          <span>· ${Number(q.upvotes) || 0} 赞同</span>
          ${q.verified ? '<span class="verified-tag">已核对原文</span>' : ''}
          ${q.url ? `<a class="source-link" href="${esc(q.url)}" target="_blank" rel="noopener">原文 ↗</a>` : ''}
        </div>
      </div>`
    )
    .join('');

  return `<article class="camp">
    <div class="camp-head">
      <span class="camp-index">${String(i + 1).padStart(2, '0')}</span>
      <span class="camp-name">${esc(camp.name)}</span>
      <span class="camp-share">${Number(camp.share) || 0}% 回答</span>
    </div>
    <p class="camp-stance">${esc(camp.stance)}</p>
    <p class="camp-claim">${esc(camp.claim)}</p>
    <div class="tags">${(camp.evidenceTypes || []).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join('')}</div>
    <div class="weak">
      <div class="weak-label">这个阵营的软肋</div>
      <p>${esc(camp.weakness)}</p>
    </div>
    <div class="quotes">${quotes}</div>
  </article>`;
}

function renderMinority(m) {
  if (!m) return '';
  return `<div class="minority">
    <h3>沉默的少数派</h3>
    <p class="hint">赞同 ${Number(m.upvotes) || 0} 次，排序永远起不来，但换了个坐标系。</p>
    <blockquote>${esc(m.text)}</blockquote>
    <div class="quote-meta" style="margin:0 0 12px"><b>${esc(m.author)}</b><span>${esc(m.bio || '知乎用户')}</span></div>
    <div class="why"><span>为什么值得被看见 · </span>${esc(m.why)}</div>
  </div>`;
}

function renderChecks(list) {
  if (!list || !list.length) return '';
  const rows = list
    .map((c) => {
      const [cls, label] = STATUS_LABEL[c.status] || STATUS_LABEL.needs_source;
      return `<div class="check">
        <span class="check-status ${cls}">${label}</span>
        <div>
          <h4>${esc(c.claim)}</h4>
          <p class="verdict">${esc(c.verdict || '')}</p>
          <p>${esc(c.detail || '')}</p>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="section-label">被反复争论的事实断言</div><div class="checks">${rows}</div>`;
}

init();
