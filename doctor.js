'use strict';

/**
 * Fork 链路自检
 *   node doctor.js          只检查配置，不消耗接口额度
 *   node doctor.js --live   额外实测一次知乎检索（消耗 1-2 次额度）
 */

const { execFileSync } = require('node:child_process');
const config = require('./lib/config');

config.loadEnv();
const s = config.status();
const live = process.argv.includes('--live');

const OK = '[OK]   ';
const MISS = '[缺失] ';
const WARN = '[注意] ';

console.log('\nFork 链路自检\n' + '='.repeat(46));

console.log(`${s.envFile ? OK : MISS} .env 配置文件`);
console.log(`${s.cli ? OK : MISS} 官方 CLI ${s.cli ? `(${s.cliVersion || '版本未知'})` : ''}`);
if (s.cli) console.log(`       路径：${s.cli}`);
console.log(`${s.auth ? OK : MISS} Access Secret ${s.auth ? '' : '→ 见下方步骤 2'}`);
console.log(`${s.llm ? OK : MISS} LLM 配置 ${s.llm ? `(${s.llmBase}, ${s.llmModel})` : '→ 见下方步骤 3'}`);

if (!s.cli) {
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

if (live && s.cli && s.auth) {
  console.log('\n实测知乎检索：');
  try {
    const out = execFileSync(
      s.cli,
      ['search', 'zhihu', '--query', 'AI 会取代程序员吗', '--count', '5'],
      { encoding: 'utf8', timeout: 60000 }
    );
    const data = JSON.parse(out);
    const list = data?.Data?.Items || [];
    const answers = list.filter((x) => x.ContentType === 'Answer');
    console.log(`${OK} 取到 ${answers.length} 条回答，数据链路已通`);
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    console.log(`${MISS} 检索失败：${msg.slice(0, 300)}`);
  }
} else if (live) {
  console.log(`\n${WARN} 配置不完整，跳过实测`);
}

console.log('\n' + '='.repeat(46));
if (s.ready) {
  console.log('结论：可以启动。运行 npm start，页面右上角应显示绿色的「实时」。');
} else {
  console.log('结论：还差上面的缺失项。补齐后重新运行 node doctor.js --live。');
}
console.log('');
