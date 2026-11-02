/**
 * 构建期图片优化：把仓库内的 JPG/PNG 转成同目录同名 WebP。
 * - 质量 80，保留透明通道（alpha），尺寸不变、不裁剪不缩放
 * - 默认不写入任何元数据，EXIF/GPS 等信息全部清除（ICC 色彩配置保留，避免偏色）
 * - 已生成且比源图新的 WebP 直接跳过，支持重复构建
 * 用法：npm run build（npm start 前也会自动执行）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUALITY = 80;
const EXTS = new Set(['.jpg', '.jpeg', '.png']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'media']);

function walk(dir, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, list);
    } else if (EXTS.has(path.extname(entry.name).toLowerCase())) {
      list.push(full);
    }
  }
  return list;
}

function kb(bytes) {
  return (bytes / 1024).toFixed(0) + 'KB';
}

async function optimize(file) {
  const target = file.replace(/\.(jpe?g|png)$/i, '.webp');
  const srcStat = fs.statSync(file);
  if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= srcStat.mtimeMs) {
    return { skipped: true };
  }

  const meta = await sharp(file).metadata();
  await sharp(file)
    .webp({ quality: QUALITY, alphaQuality: 100, effort: 4 })
    .keepIccProfile()
    .toFile(target);

  const outStat = fs.statSync(target);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const ratio = outStat.size < srcStat.size ? '-' + Math.round((1 - outStat.size / srcStat.size) * 100) + '%' : '+' + Math.round((outStat.size / srcStat.size - 1) * 100) + '%';
  return {
    skipped: false,
    rel,
    size: kb(srcStat.size) + ' → ' + kb(outStat.size) + ' (' + ratio + ')',
    geometry: meta.width + '×' + meta.height,
    alpha: meta.hasAlpha ? 'alpha 已保留' : '无透明通道'
  };
}

const files = walk(ROOT);
let converted = 0;
let skipped = 0;
for (const file of files) {
  try {
    const r = await optimize(file);
    if (r.skipped) {
      skipped++;
    } else {
      converted++;
      console.log('[webp] ' + r.rel + ' ' + r.geometry + ' ' + r.size + ' ' + r.alpha);
    }
  } catch (err) {
    console.error('[webp] 转换失败: ' + path.relative(ROOT, file) + ' — ' + err.message);
    process.exitCode = 1;
  }
}
console.log('[webp] 完成：新转换 ' + converted + ' 张，跳过已是最新 ' + skipped + ' 张，质量 ' + QUALITY);
