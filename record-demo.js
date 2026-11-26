'use strict';

/**
 * 生成 Fork 演示视频（改进版）
 * - 预加载页面，避免开头白屏
 * - 全程平滑滚动，不用瞬间跳转
 * - 结尾停在内容丰富的结果区
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const URL = 'https://fork-divergence-map.app.workbuddy.host/?sharecode=G3YXORSPO5';
const OUT_DIR = path.join(__dirname, 'video');
const VIDEO_DIR = path.join(OUT_DIR, 'raw2');
const QUESTION = 'AI 会取代程序员吗';

/** 平滑滚动到指定 Y 位置，用分步模拟，确保录出来是连续动画 */
async function smoothScrollTo(page, targetY, steps = 20, delay = 45) {
  const current = await page.evaluate(() => window.scrollY);
  const distance = targetY - current;
  for (let i = 1; i <= steps; i++) {
    const y = current + (distance * i) / steps;
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(delay);
  }
}

/** 找到某个选择器元素的绝对 Y 位置 */
async function elementY(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return 0;
    return el.getBoundingClientRect().top + window.scrollY - 100;
  }, selector);
}

async function main() {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  // ===== 预加载：用一个不录制的页面把资源缓存好 =====
  const warmup = await browser.newPage();
  await warmup.goto(URL, { waitUntil: 'networkidle' });
  await warmup.waitForTimeout(1000);
  await warmup.close();
  console.log('[预热] 页面资源已缓存');

  // ===== 正式录制 =====
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } }
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#submit-btn').waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
  console.log('[1/6] 首页');

  // 输入问题：模拟真人打字
  await page.locator('#q').click();
  await page.locator('#q').type(QUESTION, { delay: 90 });
  await page.waitForTimeout(700);
  await page.locator('#submit-btn').click();
  console.log('[2/6] 输入并提交问题');

  await page.locator('#result').waitFor({ state: 'visible', timeout: 90000 });
  await page.waitForTimeout(2000);
  console.log('[3/6] 结果出现');

  // 平滑滚动到共识区
  let y = await elementY(page, '.qhead');
  await smoothScrollTo(page, y, 18, 50);
  await page.waitForTimeout(1800);
  console.log('[4/6] 问题头与共识区');

  // 平滑滚动到分歧点
  y = await elementY(page, '.split');
  await smoothScrollTo(page, y, 18, 50);
  await page.waitForTimeout(2200);
  console.log('[5/6] 分歧点');

  // 平滑滚动到阵营卡片
  y = await elementY(page, '#camps');
  await smoothScrollTo(page, y, 20, 50);
  await page.waitForTimeout(2500);

  // 继续平滑往下看第二排阵营和少数派
  y = await elementY(page, '.minority');
  await smoothScrollTo(page, y, 22, 45);
  await page.waitForTimeout(2500);
  console.log('[6/6] 阵营卡片与少数派');

  // 结尾：平滑滚回分歧点，停在信息最密集的位置（不回顶部）
  y = await elementY(page, '.split');
  await smoothScrollTo(page, y, 20, 45);
  await page.waitForTimeout(2000);

  const video = page.video();
  await context.close();
  const rawPath = await video.path();
  await browser.close();

  const finalPath = path.join(OUT_DIR, 'demo-raw.webm');
  fs.copyFileSync(rawPath, finalPath);
  console.log(`\n录制完成: ${finalPath}`);
  console.log(`大小: ${(fs.statSync(finalPath).size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error('录制失败:', e.message);
  process.exitCode = 1;
});
