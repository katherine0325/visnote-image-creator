#!/usr/bin/env node
/**
 * generate-image.mjs — vis-note 图片生成脚本
 * ─────────────────────────────────────────────────────────────────────────────
 * 前提：
 *   1. 在项目根目录创建 config.json，内容如下：
 *        {
 *          "apikey": "your_api_key_here"
 *        }
 *   2. 安装依赖（在本 scripts 目录下运行）：
 *        npm install playwright
 *        npx playwright install chromium
 *
 * 使用：
 *   node generate-image.mjs --template yellow --data '{"title":"我的标题","color":"#EF4444"}' --out ./cover.png
 *
 * 参数：
 *   --template  模板 id（必填），如 yellow / magazine / memo / newspaper 等
 *   --data      JSON 字符串，覆盖模板默认字段（选填）
 *   --out       输出路径（默认 ./output.png）
 *   --watermark 是否显示水印
 *   --server    服务地址（默认 https://vis-note.netlify.app）
 */

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import config from '../config.json' with { type: 'json' };

async function checkApiKeyStatus(apiKey, server) {
  try {
    const response = await fetch(`${server}/api/open/check`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const result = await response.json();

    if (!result.success) {
      console.error(`[ERROR] ${result.error}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[ERROR] VisNote 服务连接失败`);
    return false;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const TMPL = args.template;
const WITH_WATERMARK = !!args.watermark;
const OUT = path.resolve(args.out ?? './output.png');
const SERVER = args.server ?? 'https://vis-note.netlify.app';
const VISNOTE_API_KEY = config.apikey;

if (!VISNOTE_API_KEY) {
  console.error('[ERROR] 请先在 config.json 中设置 apikey');
  process.exit(1);
}

if (!TMPL) {
  console.error('[ERROR] 请指定 --template，如：--template yellow');
  process.exit(1);
}

let extraData = {};
if (args.data) {
  try { extraData = JSON.parse(args.data); }
  catch { console.error('[ERROR] --data 不是合法 JSON'); process.exit(1); }
}

console.log(`[INFO] 正在连接到VisNote...`);
const isValid = await checkApiKeyStatus(VISNOTE_API_KEY, SERVER);
if (!isValid) {
  process.exit(1);
}

function splitData(data) {
  const urlEntries = [];
  const imageEntries = [];

  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('image')) {
      urlEntries.push([key, value]);
      continue;
    }

    if (!value || value.startsWith('http')) {
      urlEntries.push([key, value]);
      continue;
    }

    imageEntries.push([key, value]);
  }

  imageEntries.sort((a, b) => {
    const getNum = (key) => key === 'image' ? 0 : parseInt(key.slice(5)) || 0;
    return getNum(a[0]) - getNum(b[0]);
  });

  const imagePaths = imageEntries.map(([, value]) => value);
  const urlData = Object.fromEntries(urlEntries);

  return { imagePaths, urlData };
}

async function handleImages(page, imagePaths) {
  if (imagePaths.length === 0) {
    return;
  }

  await page.locator('#toolbar input[type="file"]').waitFor({ state: 'attached', timeout: 30_000 });

  const uploadInputs = await page.locator('#toolbar input[type="file"]').all();

  if (uploadInputs.length === 0) {
    console.warn('[WARN] 未找到图片上传框，跳过图片上传');
    return;
  }

  for (let i = 0; i < Math.min(imagePaths.length, uploadInputs.length); i++) {
    await page.waitForTimeout(800);

    const imagePath = imagePaths[i];

    if (!existsSync(imagePath)) {
      console.warn(`[WARN] 图片文件不存在，跳过: ${imagePath}`);
      continue;
    }

    await uploadInputs[i].setInputFiles(imagePath);
  }
}

async function main() {
  const { imagePaths, urlData } = splitData(extraData);
  console.log(`[INFO] 模板: ${TMPL}`);
  console.log(`[INFO] 参数: ${JSON.stringify(urlData, null, 2)}`);

  const dataParam = encodeURIComponent(JSON.stringify(urlData));
  const url = `${SERVER}/editor?apikey=${VISNOTE_API_KEY}&template=${TMPL}&data=${dataParam}${WITH_WATERMARK ? '&watermark=true' : ''}`;

  const browser = await chromium.launch({ headless: true, slowMo: 100 });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });

  try {
    console.log(`[INFO] 开始生成图片...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await page.locator('#generate').waitFor({ state: 'visible', timeout: 60_000 });

    if (imagePaths.length > 0) {
      await handleImages(page, imagePaths);
    }

    mkdirSync(path.dirname(OUT), { recursive: true });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 480_000 }),
      page.locator('#generate').click({ timeout: 120_000 }),
    ]);
    await download.saveAs(OUT);
    console.log(`✅ 图片已保存: ${OUT}`);
  } catch (err) {
    console.error('[ERROR] 生成图片失败:', err);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
