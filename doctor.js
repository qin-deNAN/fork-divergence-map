'use strict';

/**
 * Fork 链路自检
 *   node doctor.js          只检查配置，不消耗接口额度
 *   node doctor.js --live   额外实测一次知乎检索（消耗 1-2 次额度）
 */

const config = require('./lib/config');
const zhihuProvider = require('./lib/providers/zhihu');

config.loadEnv();

const OK = '[OK]   ';
const MISS = '[缺失] ';
const WARN = '[注意] ';

async function liveSearch() {
  const data = await zhihuProvider.searchZhihu('AI 会取代程序员吗', 5);
  const items = data?.Data?.Items || data?.data?.Items || [];
  return items.filter((x) => /answer/i.test(String(x.ContentType || ''))).length;
}

async function main() {
  const s = config.status();
  const live = process.argv.includes('--live');

  console.log('\nFork 链路自检\n' + '='.repeat(46));

  console.log(`${s.envFile ? OK : WARN} .env 配置文件${s.envFile ? '' : '（未使用；可直接用环境变量注入）'}`);
  console.log(
    `${s.cli ? OK : s.envSecret ? WARN : MISS} 官方 CLI ` +
      `${s.cli ? `(${s.cliVersion || '版本未知'})` : s.envSecret ? '（未安装，使用环境变量 Secret）' : ''}`
  );
  if (s.cli) console.log(`       路径：${s.cli}`);
  console.log(
    `${s.auth ? OK : MISS} Access Secret ` +
      `${s.auth ? '' : s.cli ? '→ 见下方步骤 2' : '→ 设置 ZHIHU_ACCESS_SECRET，或先安装 CLI'}`
  );
  console.log(`${s.llm ? OK : MISS} LLM 配置 ${s.llm ? `(${s.llmBase}, ${s.llmModel})` : '→ 见下方步骤 3'}`);

  if (!s.cli && !s.envSecret) {
    console.log(`\n${WARN} 先安装官方 CLI：解压官方 Skill 后运行 scripts/setup.ps1`);
  }

  if (s.cli && !s.auth) {
    console.log(`\n${WARN} 写入凭证（Secret 不会显示在屏幕上）：`);
    console.log(`       "${s.cli}" auth set --secret-stdin`);
    console.log('       粘贴 Access Secret 后按回车');
    console.log('       获取地址：https://developer.zhihu.com/profile');
  }

  if (!s.llm) {
    console.log(`\n${WARN} 复制 .env.example 为 .env，填入 LLM_BASE_URL 和 LLM_API_KEY`);
  }

  if (live && s.auth) {
    console.log('\n实测知乎检索：');
    try {
      const count = await liveSearch();
      console.log(`${OK} 取到 ${count} 条回答，数据链路已通`);
    } catch (e) {
      const msg = String(e.stderr || e.message || '');
      console.log(`${MISS} 检索失败：${msg.slice(0, 300)}`);
    }
  } else if (live) {
    console.log(`\n${WARN} 凭证未配置，跳过实测`);
  }

  console.log('\n' + '='.repeat(46));
  if (s.ready) {
    console.log('结论：可以启动。运行 npm start，页面右上角应显示绿色的「实时」。');
  } else {
    console.log('结论：还差上面的缺失项。补齐后重新运行 node doctor.js --live。');
  }
  console.log('');
}

main().catch((e) => {
  console.error('自检失败:', e.message);
  process.exitCode = 1;
});
