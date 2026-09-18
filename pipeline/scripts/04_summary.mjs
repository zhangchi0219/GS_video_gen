// M4 辅助：把 splat-transform 的 `--stats json` 输出整理成前端要的元数据。
// 单独拆出来是因为 bash 解析 JSON 不可靠，而 Node 在这一步必然存在。
//
// 用法：node scripts/04_summary.mjs <stats.json> <out.json> <key=value>...
// stats.json 是对 **最终 .sog** 跑 `--stats json` 的结果（不是对源 PLY），
// 所以这里的包围盒反映的是有损压缩之后的实际资产。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** 绕 X→Y→Z 依次旋转（角度制），和 splat-transform 的 -r 同一套欧拉约定。
 *  本项目实际只用到 180,0,0（把 CV 的 Y-down 世界转成 three 的 Y-up），
 *  那种情况就是 (x,y,z) → (x,-y,-z)，任意角度的顺序问题没有实测验证过。 */
function rotateVec([x, y, z], [rx, ry, rz]) {
  const d = Math.PI / 180;
  if (rx) { const c = Math.cos(rx * d), s = Math.sin(rx * d); [y, z] = [y * c - z * s, y * s + z * c]; }
  if (ry) { const c = Math.cos(ry * d), s = Math.sin(ry * d); [x, z] = [x * c + z * s, -x * s + z * c]; }
  if (rz) { const c = Math.cos(rz * d), s = Math.sin(rz * d); [x, y] = [x * c - y * s, x * s + y * c]; }
  return [x, y, z].map((v) => Number(v.toFixed(5)));
}

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

let mergeFrom = '';
let rotate = '';
for (const kv of kvs) {
  const i = kv.indexOf('=');
  if (i < 0) continue;
  const key = kv.slice(0, i);
  const raw = kv.slice(i + 1);
  // 这两个是给本脚本用的指令，不写进输出
  if (key === 'merge_from') { mergeFrom = raw; continue; }
  if (key === 'rotate_applied') { rotate = raw; if (raw) out.rotate = raw; continue; }
  const num = Number(raw);
  out[key] = raw !== '' && !Number.isNaN(num) ? num : raw;
}

// 把 M2 写的相机位姿带过来：没有它，前端只能靠包围盒猜方向，而 splat 场景的朝向
// 是重建出来的、任意的（实测连着两个场景默认视角都正对一堵墙，一片黑）。
if (mergeFrom && existsSync(mergeFrom)) {
  const m2 = JSON.parse(readFileSync(mergeFrom, 'utf8'));
  const rot = rotate ? rotate.split(',').map(Number) : null;
  if (Array.isArray(m2.cameras) && m2.cameras.length) {
    out.cameras = rot
      ? m2.cameras.map((c) => ({
          pos: rotateVec(c.pos, rot),
          fwd: rotateVec(c.fwd, rot),
          up: rotateVec(c.up, rot),
        }))
      : m2.cameras;
    // 相机必须和高斯一起转，否则 --rotate 之后初始机位就指到场景外面去了。
    out.camera_convention = m2.camera_convention +
      (rot ? `；已随 --rotate ${rotate} 一同旋转` : '');
  }
  for (const k of ['frames_used', 'scene_scale', 'dtype', 'inference_seconds']) {
    if (m2[k] !== undefined) out[`m2_${k}`] = m2[k];
  }
}

// 把描述性字段排到前面，数值结论排后面，方便人读 diff。
const order = ['scene', 'source_ply', 'machine', 'timestamp', 'splat_transform', 'actions',
  'sog_bytes', 'sog_mb', 'export_seconds', 'gaussians', 'sh_bands'];
const sorted = {};
for (const k of order) if (k in out) sorted[k] = out[k];
for (const k of Object.keys(out)) if (!(k in sorted)) sorted[k] = out[k];

writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(sorted, null, 2));
