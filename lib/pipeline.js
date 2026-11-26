'use strict';

/**
 * Fork 分析流水线
 * 四段式：retrieve（取回答） → extract（抽主张） → cluster（聚阵营） → classify（判分歧性质）
 * 每段都返回统一的中间结构，便于单独替换与调试。
 */

const providers = require('./providers');

const STAGES = [
  { id: 'retrieve', label: '检索该问题下的高赞回答' },
  { id: 'extract', label: '逐条抽取核心主张与论据类型' },
  { id: 'cluster', label: '按立场聚合阵营，识别共识区' },
  { id: 'classify', label: '判定每个分歧是事实分歧还是价值分歧' }
];

function normalize(payload) {
  const camps = [...payload.camps].sort((a, b) => b.share - a.share);
  const totalShare = camps.reduce((sum, c) => sum + c.share, 0);
  return {
    ...payload,
    camps: camps.map((camp) => ({
      ...camp,
      share: Math.round((camp.share / totalShare) * 100),
      quotes: [...camp.quotes].sort((a, b) => b.upvotes - a.upvotes)
    })),
    meta: {
      ...payload.meta,
      campCount: camps.length,
      sampled: payload.question.sampled,
      coverage: payload.meta && payload.meta.coverage ? payload.meta.coverage : null
    }
  };
}

async function analyze(input, hooks = {}) {
  const started = Date.now();
  const emit = typeof hooks.onStage === 'function' ? hooks.onStage : () => {};
  const timings = {};
  let provider;

  try {
    provider = providers.pick(input);
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      hint: err.hint,
      status: err.status || 400
    };
  }

  let current = null;

  if (!provider) {
    return {
      ok: false,
      error:
        '尚未配置知乎开放平台凭证。请在环境变量中设置 ZHIHU_ACCESS_SECRET，或改用内置示例数据集。',
      hint: '先运行 node doctor.js --live 检查链路，或运行 npm test 用示例数据验证页面。'
    };
  }

  try {
    for (const stage of STAGES) {
      current = stage.id;
      emit({ stage: stage.id, label: stage.label, status: 'start' });
      const t0 = Date.now();
      await provider[stage.id](input);
      const ms = Date.now() - t0;
      timings[stage.id] = ms;
      emit({ stage: stage.id, status: 'done', ms });
      current = null;
    }
  } catch (err) {
    if (current) emit({ stage: current, status: 'error', error: err.message || String(err) });
    return {
      ok: false,
      provider: provider.name,
      error: err.message || String(err),
      timings
    };
  }

  const payload = provider.result();
  return {
    ok: true,
    provider: provider.name,
    stages: STAGES,
    timings,
    elapsedMs: Date.now() - started,
    data: normalize(payload)
  };
}

module.exports = { analyze, STAGES };
