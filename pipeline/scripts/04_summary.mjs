// M4 辅助：把 splat-transform 的 `--stats json` 输出整理成前端要的元数据。
// 单独拆出来是因为 bash 解析 JSON 不可靠，而 Node 在这一步必然存在。
//
// 用法：node scripts/04_summary.mjs <stats.json> <out.json> <key=value>...
// stats.json 是对 **最终 .sog** 跑 `--stats json` 的结果（不是对源 PLY），
// 所以这里的包围盒反映的是有损压缩之后的实际资产。

import { readFileSync, writeFileSync } from 'node:fs';

const [statsPath, outPath, ...kvs] = process.argv.slice(2);
if (!statsPath || !outPath) {
  console.error('用法: node 04_summary.mjs <stats.json> <out.json> [key=value]...');
  process.exit(2);
}

const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
const lod0 = stats.stats?.[0];
if (!lod0) {
  console.error('stats JSON 里没有 stats[0]，splat-transform 的输出格式可能变了');
  process.exit(1);
}

const col = (name) => {
  const i = lod0.columns.indexOf(name);
  if (i < 0) throw new Error(`统计里找不到列 ${name}`);
  return i;
};
const round = (v, n = 4) => Number(v.toFixed(n));

const [ix, iy, iz] = ['x', 'y', 'z'].map(col);
const bboxMin = [lod0.data.min[ix], lod0.data.min[iy], lod0.data.min[iz]];
const bboxMax = [lod0.data.max[ix], lod0.data.max[iy], lod0.data.max[iz]];
const center = bboxMin.map((v, i) => (v + bboxMax[i]) / 2);
// 前端用它定 OrbitControls 的距离和 near/far；取包围盒对角线的一半。
const radius = Math.hypot(...bboxMax.map((v, i) => v - bboxMin[i])) / 2;

// 只取 median，**不要取 mean/stdDev**：对于需要解码的列（opacity 走 sigmoid、
// scale 走 exp），splat-transform 3.4.2 算的是 decode(mean(raw)) 而不是
// mean(decode(raw))，数值是错的（实测 opacity 报 0.2711，真值 0.3353）。
// min/max/median 在单调变换下保序，所以可信。详见 CLAUDE.md 坑 6。
const iOpacity = col('opacity');

const out = {
  bbox_min: bboxMin.map((v) => round(v)),
  bbox_max: bboxMax.map((v) => round(v)),
  center: center.map((v) => round(v)),
  radius: round(radius),
  gaussians: lod0.numGaussians,
  sh_bands: stats.shBands,
  // fillRatio = 平均每个像素被多少个高斯覆盖（overdraw），越高越吃填充率。
  fill_ratio: round(lod0.fillRatio, 3),
  opacity_median: round(lod0.data.median[iOpacity]),
  opacity_min: round(lod0.data.min[iOpacity], 6),
  opacity_max: round(lod0.data.max[iOpacity], 6),
  nan_count: lod0.data.nanCount.reduce((a, b) => a + b, 0),
  inf_count: lod0.data.infCount.reduce((a, b) => a + b, 0),
};

for (const kv of kvs) {
  const i = kv.indexOf('=');
  if (i < 0) continue;
  const key = kv.slice(0, i);
  const raw = kv.slice(i + 1);
  const num = Number(raw);
  out[key] = raw !== '' && !Number.isNaN(num) ? num : raw;
}

// 把描述性字段排到前面，数值结论排后面，方便人读 diff。
const order = ['scene', 'source_ply', 'machine', 'timestamp', 'splat_transform', 'actions',
  'sog_bytes', 'sog_mb', 'export_seconds', 'gaussians', 'sh_bands'];
const sorted = {};
for (const k of order) if (k in out) sorted[k] = out[k];
for (const k of Object.keys(out)) if (!(k in sorted)) sorted[k] = out[k];

writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(sorted, null, 2));
