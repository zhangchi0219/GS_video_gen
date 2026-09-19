/**
 * M5 渲染 demo（CLAUDE.md §5「单文件 demo 优先」）。
 *
 * 除 three / spark / react 之外不依赖本仓库任何东西，整个文件拷走就能跑
 * （样式在 app.css，设计系统在 tokens.css / base.css，只消费不修改）。
 *
 * 几个不显然的地方：
 *
 * - **资产下拉是一条故障定位链**（R7「先用官方示例验证再换自己的」）：
 *   butterfly.spz 官方数据 + 官方格式 → 它都黑屏，问题在这段渲染代码；
 *   butterfly.sog 官方数据 + 本地导出器 → 只有它坏，问题在 SOG 路径；
 *   riverview.sog 自产 PLY + 本地导出器 → 只有它坏，问题在 PLY 或导出参数。
 *
 * - **飞行模式用 Spark 自带的 SparkControls**（FpsMovement + PointerControls），
 *   不是 three 的 FlyControls —— 它是 Spark 为 splat 场景调过的，带惯性和手柄支持。
 *
 * - **上传的文件不进内存长留，只存 IndexedDB**。SplatMesh 拿到 fileBytes 后可能把
 *   ArrayBuffer transfer 给 worker（buffer 被 detach、byteLength 变 0），留在 state
 *   里的那份第二次就用不了了。每次加载都从 IndexedDB 重新读一份新的副本最省心。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkControls, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

// ============================================================
// 内置资产
// ============================================================

type Builtin = { key: string; file: string; meta?: string; note: string };

const BUILTINS: Builtin[] = [
  { key: 'test.sog', file: 'test.sog', meta: 'test.json', note: '自采视频 · 45 帧' },
  { key: 'riverview.sog', file: 'riverview.sog', meta: 'riverview.json', note: '官方帧 · 本地重建' },
  { key: 'butterfly.sog', file: 'butterfly.sog', note: '官方数据 · 本地导出' },
  { key: 'butterfly.spz', file: 'butterfly.spz', note: '官方数据 · 官方格式' },
];

/** M2 预测出的一个训练相机，已由 04 转成世界坐标并随 --rotate 一起旋转过。 */
type CamPose = { pos: [number, number, number]; fwd: [number, number, number]; up: [number, number, number] };

/** 04_export.sh 写出的元数据；缺失时降级用 mesh 自报的包围盒。 */
type SceneMeta = {
  cameras?: CamPose[];
  rotate?: string;
  scene?: string;
  gaussians?: number;
  sog_mb?: number;
  center?: [number, number, number];
  radius?: number;
  bbox_min?: [number, number, number];
  bbox_max?: [number, number, number];
  actions?: string;
};

// ============================================================
// 最近打开：IndexedDB
// ============================================================

const DB_NAME = 'sawtooth-splat';
const STORE = 'recent';
const MAX_RECENT = 6;

type RecentMeta = { id: string; name: string; size: number; addedAt: number };
type RecentRec = RecentMeta & { bytes: ArrayBuffer };

/** IndexedDB 在隐私窗口、禁用站点数据时会直接抛；这里兜一层内存缓存，
 *  至少保证「这次会话里还能来回切」，只是刷新后不留。 */
const memoryFallback = new Map<string, RecentRec>();
let idbBroken = false;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open 失败'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
        t.oncomplete = () => db.close();
      }),
  );
}

async function listRecent(): Promise<RecentMeta[]> {
  if (idbBroken) return [...memoryFallback.values()].map(stripBytes).sort(byNewest);
  try {
    const all = await tx<RecentRec[]>('readonly', (s) => s.getAll() as IDBRequest<RecentRec[]>);
    return all.map(stripBytes).sort(byNewest);
  } catch {
    idbBroken = true;
    return [...memoryFallback.values()].map(stripBytes).sort(byNewest);
  }
}

const stripBytes = (r: RecentRec | RecentMeta): RecentMeta => ({
  id: r.id, name: r.name, size: r.size, addedAt: r.addedAt,
});
const byNewest = (a: RecentMeta, b: RecentMeta) => b.addedAt - a.addedAt;

async function putRecent(rec: RecentRec): Promise<'idb' | 'memory'> {
  memoryFallback.set(rec.id, rec);
  if (idbBroken) return 'memory';
  try {
    await tx('readwrite', (s) => s.put(rec));
    // 只留最近 MAX_RECENT 个：.sog 动辄十几 MB，攒几个就顶到浏览器配额了。
    const all = await listRecent();
    for (const old of all.slice(MAX_RECENT)) await dropRecent(old.id);
    return 'idb';
  } catch {
    idbBroken = true;
    return 'memory';
  }
}

async function getRecent(id: string): Promise<RecentRec | undefined> {
  if (!idbBroken) {
    try {
      const r = await tx<RecentRec | undefined>('readonly', (s) => s.get(id) as IDBRequest<RecentRec | undefined>);
      if (r) return r;
    } catch {
      idbBroken = true;
    }
  }
  return memoryFallback.get(id);
}

async function dropRecent(id: string): Promise<void> {
  memoryFallback.delete(id);
  if (idbBroken) return;
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    idbBroken = true;
  }
}

// ============================================================
// 相机：预设机位与关键帧路径
// ============================================================

type Pose = { pos: THREE.Vector3; quat: THREE.Quaternion };
type PresetKind = 'front' | 'side' | 'top' | 'wide';

const PRESETS: { kind: PresetKind; label: string; dir: [number, number, number]; zoom: number }[] = [
  { kind: 'front', label: '正面', dir: [0, 0.15, -1], zoom: 1 },
  { kind: 'side', label: '侧面', dir: [-1, 0.15, 0], zoom: 1 },
  { kind: 'top', label: '顶视', dir: [0, 1, -0.2], zoom: 1 },
  { kind: 'wide', label: '全景', dir: [0.8, 0.5, -0.9], zoom: 1.6 },
];

/** 首次取景：斜上方看，距离刚好框住包围盒（zoom = 1，不额外拉远）。
 *
 * 两条都是实测踩出来的，别改回去：
 *
 * 1. **不要用「正面」当默认。** splat 场景没有「正面」可言，重建出来的朝向是任意的。
 *    实测 riverview（AnySplat 从 12 帧重建的室内场景）时，正对着 -Z 看过去正好是
 *    实心的一面墙，画面全黑。斜上方这个角度不容易正好撞在一堵墙上。
 *
 * 2. **不要额外拉远。** 高斯相对场景可能极小：riverview 的 scale 中位数是 0.0035，
 *    而场景半径 4.11 —— 拉远到 1.25 倍时每个高斯投影到屏幕不足半个像素，会被渲染器
 *    当亚像素丢掉，整个画面变全黑；拉近一半就重新出现。butterfly 的高斯相对尺寸大
 *    得多所以没这个问题。遇到「明明加载成功却全黑」，先滚轮拉近看看。 */
const DEFAULT_VIEW = { kind: 'wide' as PresetKind, label: '默认', dir: [0.8, 0.5, -0.9] as [number, number, number], zoom: 1 };

/** 看向 target 的朝向。不能用 Object3D.lookAt —— 那个让 +Z 指向目标，
 *  而相机要的是 -Z 指向目标，正好反了。Matrix4.lookAt 才是相机的约定。 */
function lookAtQuat(eye: THREE.Vector3, target: THREE.Vector3): THREE.Quaternion {
  const m = new THREE.Matrix4().lookAt(eye, target, THREE.Object3D.DEFAULT_UP);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function presetPose(center: THREE.Vector3, radius: number, fovDeg: number, p: (typeof PRESETS)[number]): Pose {
  // 标准取景公式：半角的正弦决定距离，再留 10% 余量。
  const dist = (radius / Math.sin((fovDeg / 2) * (Math.PI / 180))) * 1.1 * p.zoom;
  const pos = center.clone().addScaledVector(new THREE.Vector3(...p.dir).normalize(), dist);
  return { pos, quat: lookAtQuat(pos, center) };
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** 关键帧路径采样。位置走 Catmull-Rom 样条（过每个关键点且平滑），
 *  朝向在相邻两帧之间 slerp。两者用同一个 eased u，避免位置和视线不同步。 */
function samplePath(keys: Pose[], curve: THREE.CatmullRomCurve3 | null, u: number): Pose {
  const n = keys.length;
  if (n === 0) return { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  if (n === 1) return { pos: keys[0].pos.clone(), quat: keys[0].quat.clone() };
  const ue = easeInOutCubic(clamp01(u));
  const pos = curve ? curve.getPoint(ue) : keys[0].pos.clone();
  const f = ue * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const quat = new THREE.Quaternion().slerpQuaternions(keys[i].quat, keys[i + 1].quat, f - i);
  return { pos, quat };
}

// ============================================================
// 小工具
// ============================================================

const fmt = (n: number, d = 2) => n.toFixed(d);
const fmtVec = (v: number[] | THREE.Vector3 | undefined) => {
  if (!v) return '—';
  const a = Array.isArray(v) ? v : [v.x, v.y, v.z];
  return a.map((x) => fmt(x)).join(', ');
};
const fmtBytes = (b: number) => (b >= 1048576 ? `${fmt(b / 1048576, 1)} MB` : `${fmt(b / 1024, 0)} KB`);
const FOV = 60;

// ============================================================
// 测量
// ============================================================

type Vec3 = [number, number, number];
/** 一段测量。端点存在 mesh 的**对象空间**：翻转开关会改 mesh 的朝向，
 *  存世界坐标的话一勾翻转，测量线就和场景脱开了。 */
type Measure = { a: Vec3; b: Vec3 };

/** AnySplat 从普通照片前馈重建，只有相对尺度、没有米制 ——
 *  riverview 的半径 4.11 只是个模型内部的数。量真实尺寸必须先拿一段已知长度标定。 */
type Calib = { cmPerUnit: number; refCm: number };

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function fmtLen(d: number, calib: Calib | null): string {
  if (!calib) return `${fmt(d, 3)} u`;
  const cm = d * calib.cmPerUnit;
  return cm >= 100 ? `${fmt(cm / 100, 2)} m` : `${fmt(cm, 1)} cm`;
}

/** 点击和拖动的分界：按下到抬起移动超过这么多像素就当作转视角，不落点。 */
const CLICK_SLOP_PX = 4;
/** 叠加层（坐标轴、测量线）永远画在 splat 上面：splat 是半透明混合，
 *  不按深度遮挡线段，与其让线时隐时现，不如始终可见。 */
const OVERLAY_ORDER = 1000;
const AXIS_COLORS = ['#E5484D', '#46A758', '#3E7BFA'];

/** 端点的圆点贴图：画布上画一个白边红心的圆，比 PointsMaterial 默认的方块好认。 */
function makeDotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fillStyle = '#F3F0E9';
  g.fill();
  g.beginPath();
  g.arc(16, 16, 8, 0, Math.PI * 2);
  g.fillStyle = '#E63E27';
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 清空 group 并释放子对象的几何体和材质（贴图是共用的，不在这里释放）。 */
function disposeChildren(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    const o = child as THREE.Mesh;
    o.geometry?.dispose();
    (o.material as THREE.Material | undefined)?.dispose();
  }
}

/** 按当前测量结果重建叠加层：所有线段一个 LineSegments，所有端点一个 Points。 */
function buildMeasureOverlay(group: THREE.Group, dot: THREE.Texture, measures: Measure[], pending: Vec3 | null) {
  disposeChildren(group);
  const common = { depthTest: false, depthWrite: false, transparent: true } as const;

  if (measures.length) {
    const seg = new THREE.BufferGeometry();
    seg.setAttribute('position', new THREE.Float32BufferAttribute(measures.flatMap((m) => [...m.a, ...m.b]), 3));
    const line = new THREE.LineSegments(seg, new THREE.LineBasicMaterial({ color: '#E63E27', ...common }));
    line.renderOrder = OVERLAY_ORDER;
    line.frustumCulled = false;
    group.add(line);
  }

  const pts = measures.flatMap((m) => [...m.a, ...m.b]).concat(pending ?? []);
  if (pts.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: dot, alphaTest: 0.5, ...common }),
    );
    points.renderOrder = OVERLAY_ORDER + 1;
    points.frustumCulled = false;
    group.add(points);
  }
}

type Status = 'loading' | 'ready' | 'error';
type CameraMode = 'orbit' | 'fly';

/**
 * 出错要分类：不同的原因给的建议完全不同。「资产不进 git，先跑 04_export」
 * 这条只对文件缺失成立，拿去回答「浏览器没有 WebGL2」就是误导。
 *   missing       文件不在（404，或被 SPA 兜底换成了 index.html）
 *   fetch         网络 / 权限 / 服务器错误
 *   parse         拿到了字节但解析不了（损坏、截断、格式不对）
 *   webgl2        建不出 WebGL2 上下文 —— 整个查看器都用不了
 *   context-lost  跑着跑着 GPU 把上下文收回了 —— 同上，只能重载
 */
type FailKind = 'missing' | 'fetch' | 'parse' | 'webgl2' | 'context-lost';
type Failure = { kind: FailKind; msg: string; raw?: string };

/**
 * 下载十几 MB 之前先问一句：文件在不在、是不是资产。
 * 文件缺失在两种部署下表现不一样：nginx 的 /splats/ 没有兜底，缺了就是干脆的 404；
 * 而 vite dev（以及任何配了 SPA 兜底的站点）会回 200 + index.html，Spark 拿着网页字节
 * 去解析，只会报一个和「文件不存在」毫不相干的错误。后一种才是这次预检真正要抓的。
 */
async function preflight(url: string): Promise<Failure | null> {
  let r: Response;
  try {
    r = await fetch(url, { method: 'HEAD' });
  } catch (e) {
    return { kind: 'fetch', msg: '连不上服务器：网络断了，或者请求被浏览器拦下了', raw: String(e) };
  }
  // 有的服务器 / CDN 不接 HEAD。不算错，交给真正的下载去报。
  if (r.status === 405 || r.status === 501) return null;
  if (r.status === 404) return { kind: 'missing', msg: `服务器上没有这个文件：${url}` };
  if (r.status === 403) {
    return {
      kind: 'fetch',
      msg: '服务器拒绝读取（403）。多半是站点目录权限不对 —— nginx 的 worker 进不去（CLAUDE.md 坑 18）',
    };
  }
  if (!r.ok) return { kind: 'fetch', msg: `服务器出错：HTTP ${r.status} ${r.statusText}` };
  const ct = r.headers.get('content-type') ?? '';
  if (ct.startsWith('text/html')) {
    return {
      kind: 'missing',
      msg: '服务器回的是一个网页，不是 splat 资产。文件多半不存在，请求被 SPA 兜底规则转给了 index.html',
      raw: `${url} → Content-Type: ${ct}`,
    };
  }
  return null;
}

/** 预检之后仍然可能失败（下载中断、文件损坏），把 Spark 抛的原始异常翻成人话。 */
function explainLoadError(e: unknown): Failure {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // Spark 2.2 的下载错误格式：Failed to fetch "<url>": <status> <statusText>
  const m = /Failed to fetch ".*?": (\d+)/.exec(raw);
  if (m) {
    return m[1] === '404'
      ? { kind: 'missing', msg: '服务器上没有这个文件（404）', raw }
      : { kind: 'fetch', msg: `下载失败：HTTP ${m[1]}`, raw };
  }
  // 浏览器自己的网络错误（断网、下载到一半连接被掐）是 TypeError
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) {
    return { kind: 'fetch', msg: '下载中途断了。网络不稳时大文件容易这样，重试一次', raw };
  }
  return { kind: 'parse', msg: '文件读到了，但解析不了：可能损坏、没传完，或者不是它后缀声称的格式', raw };
}

type LoadInfo = {
  gaussians: number;
  seconds: number;
  box: { min: number[]; max: number[] };
  meta: SceneMeta | null;
  metaError: string | null;
};

// ============================================================
// 组件
// ============================================================

export function SplatViewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // three 的东西放 ref：它们变化不需要触发 React 重渲染。
  const coreRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    orbit: OrbitControls;
    spark: SparkControls;
  } | null>(null);
  const meshRef = useRef<SplatMesh | null>(null);
  const metaRef = useRef<SceneMeta | null>(null);
  /** 世界空间的取景参数，预设机位和「回到全景」都靠它 */
  const frameRef = useRef<{ center: THREE.Vector3; radius: number }>({
    center: new THREE.Vector3(),
    radius: 1,
  });

  const [sourceKey, setSourceKey] = useState<string>(`builtin:${BUILTINS[0].key}`);
  const [recents, setRecents] = useState<RecentMeta[]>([]);
  const [storageNote, setStorageNote] = useState('');

  const [status, setStatus] = useState<Status>('loading');
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** 渲染器已经不能用了（没有 WebGL2 / 上下文丢失）。load effect 要读，所以放 ref。 */
  const fatalRef = useRef(false);
  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [fps, setFps] = useState(0);
  /** 渲染循环停着（页面隐藏 / 画布不在视口）。这时 FPS 读数没有意义，别显示成红色的 0。 */
  const [paused, setPaused] = useState(false);

  const [mode, setMode] = useState<CameraMode>('orbit');
  const [flipX, setFlipX] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [keys, setKeys] = useState<Pose[]>([]);
  const [playing, setPlaying] = useState(false);
  const [loopPlay, setLoopPlay] = useState(true);
  const [secPerLeg, setSecPerLeg] = useState(2.5);

  // 渲染循环里要读这些的最新值，而循环是在初始化 effect 里建的闭包，
  // 拿不到后来的 state —— 所以镜像一份到 ref。
  const keysRef = useRef<Pose[]>([]);
  const curveRef = useRef<THREE.CatmullRomCurve3 | null>(null);
  const playRef = useRef<{ t0: number; dur: number; loop: boolean } | null>(null);
  const tweenRef = useRef<{ from: Pose; to: Pose; t0: number; dur: number } | null>(null);
  const modeRef = useRef<CameraMode>('orbit');

  // ---- 测量 ----
  const [measureOn, setMeasureOn] = useState(false);
  const [showAxes, setShowAxes] = useState(true);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [pending, setPending] = useState<Vec3 | null>(null);
  const [pickOpacity, setPickOpacity] = useState(0.2);
  const [pickNote, setPickNote] = useState('');
  const [calib, setCalib] = useState<Calib | null>(null);
  const [calibIdx, setCalibIdx] = useState(0);
  const [calibCm, setCalibCm] = useState('');

  const measureOnRef = useRef(false);
  const measuresRef = useRef<Measure[]>([]);
  const pendingRef = useRef<Vec3 | null>(null);
  const overlayRef = useRef<{ axes: THREE.AxesHelper; group: THREE.Group; dot: THREE.Texture } | null>(null);
  /** 画布上的 HTML 标签，由渲染循环每帧投影定位，不走 React 重渲染。 */
  const measureLabelEls = useRef<(HTMLDivElement | null)[]>([]);
  const axisLabelEls = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    measureOnRef.current = measureOn;
    if (!measureOn) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [measureOn]);
  useEffect(() => {
    measuresRef.current = measures;
  }, [measures]);
  useEffect(() => {
    if (meshRef.current) meshRef.current.minRaycastOpacity = pickOpacity;
  }, [pickOpacity, status]);
  useEffect(() => {
    if (!pickNote) return;
    const t = setTimeout(() => setPickNote(''), 2500);
    return () => clearTimeout(t);
  }, [pickNote]);

  useEffect(() => {
    keysRef.current = keys;
    curveRef.current =
      keys.length >= 2 ? new THREE.CatmullRomCurve3(keys.map((k) => k.pos.clone()), false, 'catmullrom', 0.5) : null;
  }, [keys]);

  useEffect(() => {
    listRecent().then(setRecents).catch(() => setRecents([]));
  }, []);

  const builtin = useMemo(
    () => (sourceKey.startsWith('builtin:') ? BUILTINS.find((b) => b.key === sourceKey.slice(8)) ?? null : null),
    [sourceKey],
  );
  const recent = useMemo(
    () => (sourceKey.startsWith('local:') ? recents.find((r) => r.id === sourceKey.slice(6)) ?? null : null),
    [sourceKey, recents],
  );

  /** 取一个训练相机当机位。它是拍摄者真站过的位置，必然看得见东西。 */
  const trainingPose = useCallback((cams: CamPose[], idx: number): { pose: Pose; target: THREE.Vector3 } => {
    const mesh = meshRef.current;
    const c = cams[Math.min(cams.length - 1, Math.max(0, idx))];
    const pos = new THREE.Vector3(...c.pos);
    const fwd = new THREE.Vector3(...c.fwd);
    const up = new THREE.Vector3(...c.up);
    // 元数据是资产自身坐标系里的；翻转开关一勾，相机也得跟着走。
    if (mesh) {
      mesh.updateMatrixWorld(true);
      pos.applyMatrix4(mesh.matrixWorld);
      fwd.transformDirection(mesh.matrixWorld);
      up.transformDirection(mesh.matrixWorld);
    }
    const { center, radius } = frameRef.current;
    // OrbitControls 会强制相机看向 target，所以 target 必须落在这条视线上，
    // 否则刚摆好的朝向下一帧就被拧走了。
    const dist = Math.max(radius * 0.5, pos.distanceTo(center) * 0.6);
    const target = pos.clone().addScaledVector(fwd, dist);
    const m = new THREE.Matrix4().lookAt(pos, target, up);
    return { pose: { pos, quat: new THREE.Quaternion().setFromRotationMatrix(m) }, target };
  }, []);

  /** 按当前的取景参数摆相机，并把 OrbitControls 的活动范围限制在附近（§5）。
   *
   * 优先站到**中间那个训练相机**的位置上（CLAUDE.md M5：相机初始位姿读 M4 的 JSON）。
   * 靠包围盒猜方向连着坑过两个场景：splat 的朝向是重建出来的、完全任意的，
   * riverview 和 test 的默认视角都正对着一堵墙，一片漆黑。 */
  const applyFraming = useCallback(() => {
    const core = coreRef.current;
    if (!core) return;
    const { center, radius } = frameRef.current;
    const cams = metaRef.current?.cameras;

    let pose: Pose;
    let target: THREE.Vector3;
    if (cams?.length) {
      const r = trainingPose(cams, Math.floor(cams.length / 2));
      pose = r.pose;
      target = r.target;
    } else {
      pose = presetPose(center, radius, FOV, DEFAULT_VIEW);
      target = center.clone();
    }

    core.camera.position.copy(pose.pos);
    core.camera.quaternion.copy(pose.quat);
    core.camera.near = Math.max(radius * 0.005, 1e-4);
    core.camera.far = radius * 200;
    core.camera.updateProjectionMatrix();
    core.orbit.target.copy(target);
    core.orbit.minDistance = radius * 0.02;
    core.orbit.maxDistance = radius * 8;
    core.orbit.update();
    // 飞行速度要跟着场景尺度走，否则大场景里挪不动、小场景里一按就飞出去。
    core.spark.fpsMovement.moveSpeed = radius * 0.6;
  }, [trainingPose]);

  /** 从 mesh + 元数据算出世界空间的 center / radius。
   *  元数据优先（CLAUDE.md M5：相机初始位姿读 M4 的 JSON），没有才退回 mesh 自报的包围盒。 */
  const computeFraming = useCallback((mesh: SplatMesh, meta: SceneMeta | null) => {
    let center: THREE.Vector3;
    let radius: number;
    if (meta?.center && typeof meta.radius === 'number' && meta.radius > 0) {
      center = new THREE.Vector3(...meta.center);
      radius = meta.radius;
    } else {
      // centers_only=true：只用高斯中心。个别退化成超大薄片的高斯会把完整包围盒撑到没法用。
      const sphere = mesh.getBoundingBox(true).getBoundingSphere(new THREE.Sphere());
      center = sphere.center;
      radius = sphere.radius;
    }
    mesh.updateMatrixWorld(true);
    center.applyMatrix4(mesh.matrixWorld); // 元数据是对象空间的，翻转开关要算进去
    frameRef.current = { center, radius: Math.max(radius, 1e-3) };
  }, []);

  /** 平滑飞到某个机位。播放路径时不接受新的 tween。 */
  const flyTo = useCallback((to: Pose, dur = 900) => {
    const core = coreRef.current;
    if (!core || playRef.current) return;
    tweenRef.current = {
      from: { pos: core.camera.position.clone(), quat: core.camera.quaternion.clone() },
      to,
      t0: performance.now(),
      dur,
    };
  }, []);

  // ---- three 初始化：整个组件生命周期内只跑一次 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // three r163 起只支持 WebGL2，建不出上下文就在构造函数里直接抛。不接住的话，
    // 异常会从 effect 里冒出去，React 把整棵树卸掉 —— 用户看到的是一张白纸。
    let renderer: THREE.WebGLRenderer;
    try {
      // 开发时用 ?simulate=no-webgl2 走这条分支；Chrome 已经没有单独关 WebGL2 的开关了。
      if (import.meta.env.DEV && new URLSearchParams(location.search).get('simulate') === 'no-webgl2') {
        throw new Error('（模拟）Error creating WebGL context.');
      }
      renderer = new THREE.WebGLRenderer({ antialias: false });
    } catch (e) {
      fatalRef.current = true;
      const noApi = typeof WebGL2RenderingContext === 'undefined';
      setFailure({
        kind: 'webgl2',
        msg: noApi
          ? '这个浏览器不支持 WebGL2。换一个新版的 Chrome / Edge / Firefox / Safari（2021 年以后的版本都行）'
          : '浏览器支持 WebGL2，但建不出上下文：多半是硬件加速被关了，或者显卡驱动被浏览器列入了黑名单',
        raw: e instanceof Error ? e.message : String(e),
      });
      setStatus('error');
      return;
    }
    fatalRef.current = false;
    // splat 渲染卡在填充率上，DPR 拉满等于白算一倍像素（R9）。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, host.clientWidth / host.clientHeight, 0.01, 1000);
    const sparkRenderer = new SparkRenderer({ renderer });
    scene.add(sparkRenderer);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;

    // Spark 自带的飞行控制：WASD 移动 + QE 滚转 + 指针转视角，都带惯性。
    const spark = new SparkControls({ canvas: renderer.domElement });
    spark.fpsMovement.enable = false;
    spark.pointerControls.enable = false;

    coreRef.current = { renderer, scene, camera, orbit, spark };

    // ---- 叠加层：坐标轴放世界空间，测量线的 group 每帧拷 mesh 的世界矩阵 ----
    const axes = new THREE.AxesHelper(1);
    const axesMat = axes.material as THREE.LineBasicMaterial;
    axesMat.depthTest = false;
    axesMat.depthWrite = false;
    axesMat.transparent = true;
    axes.renderOrder = OVERLAY_ORDER;
    axes.visible = false;
    axes.setColors(...(AXIS_COLORS.map((c) => new THREE.Color(c)) as [THREE.Color, THREE.Color, THREE.Color]));
    scene.add(axes);

    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    scene.add(group);
    overlayRef.current = { axes, group, dot: makeDotTexture() };

    // ---- 点击落测量点。OrbitControls / SparkControls 也在同一个 canvas 上听拖动，
    //      所以只认「按下和抬起几乎在同一处」的点击，拖动照常交给它们转视角。 ----
    const raycaster = new THREE.Raycaster();
    const down = { x: 0, y: 0 };
    const onPointerDown = (e: PointerEvent) => {
      down.x = e.clientX;
      down.y = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0 || !measureOnRef.current || playRef.current) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
      const mesh = meshRef.current;
      if (!mesh) return;
      // Spark 的射线拾取按 context.numSplats 遍历，而这个值要等 SparkRenderer 渲染过
      // 一帧才填上。刚切资产、还没出第一帧就点，会静默地什么都打不中。
      if (!mesh.context?.numSplats?.value) {
        setPickNote('场景还没渲染出来，稍等一下再点');
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // 结果按距离排好序，第一个就是视线上最近的、不透明度过线的高斯。
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (!hit) {
        setPickNote('没点中。可能是点在了空处，可能是高斯不够不透明（调低阈值），也可能是高斯太小、射线从缝里穿过去了 —— 最后一种调阈值没用，换个更近的表面再点');
        return;
      }
      mesh.updateMatrixWorld(true);
      const p = mesh.worldToLocal(hit.point.clone()).toArray() as Vec3;
      const a = pendingRef.current;
      if (a) {
        pendingRef.current = null;
        setPending(null);
        setMeasures((m) => [...m, { a, b: p }]);
      } else {
        pendingRef.current = p;
        setPending(p);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const tmp = new THREE.Vector3();
    /** 把世界坐标投到画布上，摆一个 HTML 标签；在相机背后就藏起来。 */
    const placeLabel = (el: HTMLDivElement | null | undefined, world: THREE.Vector3) => {
      if (!el) return;
      tmp.copy(world).project(camera);
      if (tmp.z > 1 || tmp.z < -1) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      const x = ((tmp.x + 1) / 2) * host.clientWidth;
      const y = ((1 - tmp.y) / 2) * host.clientHeight;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    };
    const mid = new THREE.Vector3();

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    let frames = 0;
    let lastFpsAt = performance.now();
    const frame = () => {
      const now = performance.now();
      const play = playRef.current;
      const tween = tweenRef.current;

      if (play) {
        // 关键帧路径播放：相机完全由路径驱动，两个控制器都让开。
        const u = (now - play.t0) / play.dur;
        if (u >= 1 && !play.loop) {
          const end = samplePath(keysRef.current, curveRef.current, 1);
          camera.position.copy(end.pos);
          camera.quaternion.copy(end.quat);
          playRef.current = null;
          setPlaying(false);
        } else {
          if (u >= 1) play.t0 = now;
          const s = samplePath(keysRef.current, curveRef.current, u % 1);
          camera.position.copy(s.pos);
          camera.quaternion.copy(s.quat);
        }
      } else if (tween) {
        const t = clamp01((now - tween.t0) / tween.dur);
        const e = easeInOutCubic(t);
        camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
        camera.quaternion.slerpQuaternions(tween.from.quat, tween.to.quat, e);
        if (t >= 1) {
          tweenRef.current = null;
          // 落位之后把 orbit 的 target 拉回场景中心，不然下一次拖动会绕着旧目标转。
          orbit.target.copy(frameRef.current.center);
          orbit.update();
        }
      } else if (modeRef.current === 'fly') {
        spark.update(camera);
      } else {
        orbit.update();
      }

      // 测量线跟着 mesh 走（翻转开关只改 mesh 的朝向）
      const mesh = meshRef.current;
      if (mesh) {
        group.matrix.copy(mesh.matrixWorld);
        group.matrixWorldNeedsUpdate = true;
      }
      group.visible = !!mesh;

      renderer.render(scene, camera);

      // 标签在 render 之后摆：此时 matrixWorld 和相机都是这一帧的最终值。
      if (mesh) {
        const ms = measuresRef.current;
        for (let i = 0; i < ms.length; i++) {
          mid.set(
            (ms[i].a[0] + ms[i].b[0]) / 2,
            (ms[i].a[1] + ms[i].b[1]) / 2,
            (ms[i].a[2] + ms[i].b[2]) / 2,
          ).applyMatrix4(group.matrixWorld);
          placeLabel(measureLabelEls.current[i], mid);
        }
      }
      if (axes.visible) {
        for (let i = 0; i < 3; i++) {
          mid.set(i === 0 ? 1.08 : 0, i === 1 ? 1.08 : 0, i === 2 ? 1.08 : 0).applyMatrix4(axes.matrixWorld);
          placeLabel(axisLabelEls.current[i], mid);
        }
      }

      frames++;
      if (now - lastFpsAt >= 500) {
        setFps((frames * 1000) / (now - lastFpsAt));
        frames = 0;
        lastFpsAt = now;
      }
    };

    // ---- 看不见就不画 ----
    // 后台标签页浏览器本来就会停掉 rAF（坑 13），这里多管的是两件事：
    //   1. 页面可见、但画布被滚出视口 —— 以后嵌进作品站当岛屿组件 / iframe 时（M6）
    //      就是这种情况，浏览器不会替我们停，几百万高斯照画不误。
    //   2. 恢复时把时钟接上。路径播放、机位过渡、FPS 统计、Spark 的飞行惯性都拿
    //      performance.now() 算经过的时间；停了半分钟回来，路径会直接跳到终点，
    //      FPS 头一个读数接近 0，飞行模式按一次键会冲出去半个场景。
    let running = false;
    let pausedAt = 0;
    let onScreen = true;
    let lost = false;
    const syncRunning = () => {
      const want = !document.hidden && onScreen && !lost;
      // 放在相等判断之前：页面一打开就在后台时 running 和 want 都是 false，照样要标成已暂停
      setPaused(!want);
      if (want === running) return;
      running = want;
      if (!want) {
        pausedAt = performance.now();
        // 用 setAnimationLoop 而不是裸 rAF：它是 three 的官方入口（WebXR 下也走同一条路），
        // 传 null 等价于 cancelAnimationFrame，清理照样是配对的。
        renderer.setAnimationLoop(null);
        return;
      }
      if (pausedAt) {
        // 只挪暂停之前就在跑的动画；暂停期间才开始的（t0 晚于 pausedAt）本来就没少走时间
        const gap = performance.now() - pausedAt;
        const play = playRef.current;
        const tween = tweenRef.current;
        if (play && play.t0 < pausedAt) play.t0 += gap;
        if (tween && tween.t0 < pausedAt) tween.t0 += gap;
      }
      spark.lastTime = 0; // Spark 见到 0 会把这一帧的 deltaTime 当成 0
      frames = 0;
      lastFpsAt = performance.now();
      renderer.setAnimationLoop(frame);
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      syncRunning();
    });
    io.observe(host);
    document.addEventListener('visibilitychange', syncRunning);
    syncRunning();

    // ---- GPU 上下文丢失 ----
    // 显存吃紧（手机上加载百万级高斯最常见，R9）或驱动重置时，浏览器会把整个
    // WebGL 上下文收回，之后画面静默变黑。不去原地恢复：Spark 内部的纹理和
    // 渲染目标能不能跟着重建，从外面验证不了；给一张说明卡 + 重载按钮最可靠。
    const onContextLost = (e: Event) => {
      // 不 preventDefault 的话上下文就彻底死了，restored 事件永远不会来。
      // 我们不靠它恢复，但留着这条路不碍事。
      e.preventDefault();
      lost = true;
      syncRunning();
      // Chrome 会把失去上下文的画布画成一整块白，舞台上的浅色说明文字就看不见了
      renderer.domElement.style.visibility = 'hidden';
      fatalRef.current = true;
      setFailure({
        kind: 'context-lost',
        msg: '显卡把绘图上下文收回了，画面停在这里。通常是显存不够（场景太大、同时开了别的 3D 页面），也可能是显卡驱动重置了',
      });
      setStatus('error');
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    return () => {
      renderer.setAnimationLoop(null);
      io.disconnect();
      document.removeEventListener('visibilitychange', syncRunning);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      disposeChildren(group);
      axes.dispose();
      overlayRef.current?.dot.dispose();
      overlayRef.current = null;
      orbit.dispose();
      meshRef.current?.dispose();
      meshRef.current = null;
      scene.remove(sparkRenderer);
      sparkRenderer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      coreRef.current = null;
    };
  }, []);

  // ---- 相机模式切换 ----
  useEffect(() => {
    modeRef.current = mode;
    const core = coreRef.current;
    if (!core) return;
    const fly = mode === 'fly';
    core.orbit.enabled = !fly;
    core.spark.fpsMovement.enable = fly;
    core.spark.pointerControls.enable = fly;
    // 轨道模式下 spark.update 不被调用，lastTime 停在切走的那一刻；
    // 不清零的话，切回来第一帧的 deltaTime 就是整段轨道模式的时长。
    if (fly) core.spark.lastTime = 0;
    if (!fly) {
      // 从飞行切回轨道：把 target 放到相机正前方一个场景半径处，
      // 否则 OrbitControls 会绕着上次那个早已不在视野里的目标转。
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(core.camera.quaternion);
      core.orbit.target.copy(core.camera.position).addScaledVector(dir, frameRef.current.radius);
      core.orbit.update();
    }
  }, [mode]);

  // ---- 资产加载 ----
  useEffect(() => {
    const core = coreRef.current;
    // 渲染器坏了就别再往上面加载东西：状态保持 error，说明卡留在原地。
    if (!core || fatalRef.current) return;
    let cancelled = false;

    setStatus('loading');
    setProgress(0);
    setFailure(null);
    setInfo(null);
    playRef.current = null;
    tweenRef.current = null;
    setPlaying(false);
    // 测量和标定都只属于上一个场景：每个场景的尺度都不一样。
    pendingRef.current = null;
    setPending(null);
    setMeasures([]);
    setCalib(null);

    if (meshRef.current) {
      core.scene.remove(meshRef.current);
      meshRef.current.dispose();
      meshRef.current = null;
    }

    const t0 = performance.now();
    const base = import.meta.env.BASE_URL; // base 是 './'，代码里拼的路径必须带它

    void (async () => {
      try {
        let mesh: SplatMesh;
        let metaPromise: Promise<{ meta: SceneMeta | null; err: string | null }> =
          Promise.resolve({ meta: null, err: null });

        if (sourceKey.startsWith('builtin:')) {
          const b = BUILTINS.find((x) => x.key === sourceKey.slice(8));
          if (!b) throw new Error(`没有这个内置资产：${sourceKey}`);
          const url = `${base}splats/${b.file}`;
          const pre = await preflight(url);
          if (cancelled) return;
          if (pre) {
            setFailure(pre);
            setStatus('error');
            return;
          }
          mesh = new SplatMesh({
            url,
            onProgress: (e) => {
              if (!cancelled) setProgress(e.lengthComputable && e.total > 0 ? e.loaded / e.total : 0);
            },
          });
          if (b.meta) {
            metaPromise = fetch(`${base}splats/${b.meta}`)
              .then(async (r) =>
                r.ok ? { meta: (await r.json()) as SceneMeta, err: null } : { meta: null, err: `HTTP ${r.status}` },
              )
              .catch((e: unknown) => ({ meta: null, err: e instanceof Error ? e.message : String(e) }));
          }
        } else {
          const id = sourceKey.slice(6);
          const rec = await getRecent(id);
          if (!rec) {
            setFailure({ kind: 'missing', msg: '这个文件已经不在浏览器缓存里了，重新拖一次' });
            setStatus('error');
            return;
          }
          if (cancelled) return;
          // 本地文件没有下载阶段，onProgress 不会触发；解析期间只能给个忙碌态。
          setProgress(0);
          mesh = new SplatMesh({ fileBytes: rec.bytes, fileName: rec.name });
        }

        await mesh.initialized;
        if (cancelled) {
          mesh.dispose();
          return;
        }
        const seconds = (performance.now() - t0) / 1000;
        meshRef.current = mesh;
        mesh.quaternion.set(flipX ? 1 : 0, 0, 0, flipX ? 0 : 1);
        core.scene.add(mesh);

        const box = mesh.getBoundingBox(true);
        const { meta, err } = await metaPromise;
        if (cancelled) return;
        metaRef.current = meta;
        computeFraming(mesh, meta);
        applyFraming();
        setInfo({
          gaussians: mesh.numSplats,
          seconds,
          box: { min: box.min.toArray(), max: box.max.toArray() },
          meta,
          metaError: err,
        });
        setStatus('ready');
      } catch (e: unknown) {
        // 上下文丢失时 Spark 也可能跟着抛错，别让它盖掉更要紧的那张说明卡
        if (cancelled || fatalRef.current) return;
        setFailure(explainLoadError(e));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
    // flipX 故意不在依赖里：它由下面那个 effect 单独处理，
    // 放进来会让每次勾选都重新下载一遍十几 MB 的资产。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, applyFraming, computeFraming]);

  // ---- 坐标系翻转（R8 的现场判断工具）----
  // Spark 官方 getting-started 给 butterfly 设了 quaternion(1,0,0,0)，也就是绕 X 轴 180°，
  // 因为 splat 训练坐标系 Y 向下而 three 是 Y 向上。这个开关只用来**看出**该不该转；
  // 一旦定下来就到 04_export.sh 用 --rotate 烤进资产里，不留在前端。
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || status !== 'ready') return;
    mesh.quaternion.set(flipX ? 1 : 0, 0, 0, flipX ? 0 : 1);
    computeFraming(mesh, metaRef.current);
    applyFraming();
  }, [flipX, status, applyFraming, computeFraming]);

  // ---- 坐标轴：放在取景中心，长度取场景半径的一半 ----
  // 必须排在上面那个翻转 effect 之后：它先重算 frameRef，这里再读。
  useEffect(() => {
    const axes = overlayRef.current?.axes;
    if (!axes) return;
    const ready = status === 'ready' && showAxes;
    axes.visible = ready;
    if (!ready) return;
    const { center, radius } = frameRef.current;
    axes.position.copy(center);
    axes.scale.setScalar(radius * 0.5);
  }, [showAxes, status, flipX]);

  // ---- 测量线 ----
  useEffect(() => {
    const ov = overlayRef.current;
    if (!ov) return;
    buildMeasureOverlay(ov.group, ov.dot, measures, pending);
  }, [measures, pending]);

  // 测量中按 Esc 丢掉已选的起点
  useEffect(() => {
    if (!measureOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pendingRef.current = null;
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [measureOn]);


  const applyCalib = useCallback(() => {
    // 删掉几段后 calibIdx 可能越界，和下拉框显示的一样夹到最后一段。
    const m = measures[Math.min(calibIdx, measures.length - 1)];
    const cm = Number(calibCm);
    if (!m || !(cm > 0)) return;
    const d = dist3(m.a, m.b);
    if (d <= 0) return;
    setCalib({ cmPerUnit: cm / d, refCm: cm });
  }, [measures, calibIdx, calibCm]);

  // ---- 上传 ----
  const acceptFiles = useCallback(async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const ok = /\.(sog|ply|spz|splat|ksplat)$/i.test(f.name);
    if (fatalRef.current) return;
    if (!ok) {
      setFailure({ kind: 'parse', msg: `不认识的后缀：${f.name}。支持 .sog / .ply / .spz / .splat / .ksplat` });
      setStatus('error');
      return;
    }
    const bytes = await f.arrayBuffer();
    const rec: RecentRec = {
      id: `${f.name}:${f.size}:${f.lastModified}`,
      name: f.name,
      size: f.size,
      addedAt: Date.now(),
      bytes,
    };
    const where = await putRecent(rec);
    setStorageNote(where === 'idb' ? '' : '浏览器不让存，刷新后这个文件会丢');
    setRecents(await listRecent());
    setSourceKey(`local:${rec.id}`);
  }, []);

  const removeRecent = useCallback(
    async (id: string) => {
      await dropRecent(id);
      const list = await listRecent();
      setRecents(list);
      if (sourceKey === `local:${id}`) setSourceKey(`builtin:${BUILTINS[0].key}`);
    },
    [sourceKey],
  );

  // ---- 关键帧 ----
  const addKey = useCallback(() => {
    const core = coreRef.current;
    if (!core) return;
    // 正在飞向某个预设机位时，先让它落位再记 —— 否则记下的是半路上那一帧的位置。
    // 低帧率下尤其明显：tween 还没推进几帧，记到的几乎就是出发点。
    const tw = tweenRef.current;
    if (tw) {
      core.camera.position.copy(tw.to.pos);
      core.camera.quaternion.copy(tw.to.quat);
      tweenRef.current = null;
      core.orbit.target.copy(frameRef.current.center);
      core.orbit.update();
    }
    setKeys((prev) => [
      ...prev,
      { pos: core.camera.position.clone(), quat: core.camera.quaternion.clone() },
    ]);
  }, []);

  const togglePlay = useCallback(() => {
    if (playRef.current) {
      playRef.current = null;
      setPlaying(false);
      return;
    }
    const n = keysRef.current.length;
    if (n < 2) return;
    tweenRef.current = null;
    playRef.current = { t0: performance.now(), dur: secPerLeg * (n - 1) * 1000, loop: loopPlay };
    setPlaying(true);
  }, [secPerLeg, loopPlay]);

  const meta = info?.meta;
  const canPlay = keys.length >= 2;

  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar">
        <div className="identity">
          <span className="label">SAWTOOTH-SPLAT</span>
          <span className="label">M5 · VIEWER</span>
        </div>

        <div>
          <h1 className="hero">Gaussian Splats</h1>
          <p className="hero-sub">
            拖一个 .sog / .ply / .spz 进右边的画面，或从下面挑一个。
            {storageNote && <span className="err"> {storageNote}</span>}
          </p>
        </div>

        {/* ---- 资产 ---- */}
        <section className="section">
          <div className="section-head">
            <span className="label">资产 / SOURCE</span>
            <span className="label">{BUILTINS.length + recents.length}</span>
          </div>

          <div className="cards">
            {BUILTINS.map((b) => (
              <button
                key={b.key}
                className="card"
                data-active={sourceKey === `builtin:${b.key}`}
                onClick={() => setSourceKey(`builtin:${b.key}`)}
              >
                <div className="card-meta">
                  <span className="label">内置</span>
                  <span className="label">{b.note}</span>
                </div>
                <div className="card-title">{b.key}</div>
                <span className="card-go" aria-hidden="true">↘</span>
              </button>
            ))}

            {recents.map((r) => (
              <button
                key={r.id}
                className="card"
                data-active={sourceKey === `local:${r.id}`}
                onClick={() => setSourceKey(`local:${r.id}`)}
              >
                <div className="card-meta">
                  <span className="label">最近打开</span>
                  <span className="label">{fmtBytes(r.size)}</span>
                </div>
                <div className="card-title">{r.name}</div>
                <span
                  className="card-go"
                  role="button"
                  tabIndex={0}
                  title="从浏览器缓存里删掉"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeRecent(r.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      void removeRecent(r.id);
                    }
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>

          <div className="row">
            {/* 整屏唯一的 hot 块 */}
            <button className="btn btn-hot" onClick={() => fileInputRef.current?.click()}>
              上传文件 →
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".sog,.ply,.spz,.splat,.ksplat"
              hidden
              onChange={(e) => {
                void acceptFiles(e.target.files);
                e.target.value = ''; // 允许连续选同一个文件
              }}
            />
          </div>
        </section>

        {/* ---- 相机 ---- */}
        <section className="section">
          <div className="section-head">
            <span className="label">相机 / CAMERA</span>
            <span className="label">{mode === 'fly' ? 'FLY' : 'ORBIT'}</span>
          </div>

          <div className="row">
            <button className="btn" data-on={mode === 'orbit'} onClick={() => setMode('orbit')}>
              轨道
            </button>
            <button className="btn" data-on={mode === 'fly'} onClick={() => setMode('fly')}>
              飞行 WASD
            </button>
          </div>

          <div className="row">
            {info?.meta?.cameras?.length ? (
              <button
                className="btn"
                disabled={status !== 'ready'}
                title="回到中间那个拍摄机位"
                onClick={() => {
                  const cams = metaRef.current?.cameras;
                  if (cams?.length) flyTo(trainingPose(cams, Math.floor(cams.length / 2)).pose);
                }}
              >
                拍摄点
              </button>
            ) : null}
            {PRESETS.map((p) => (
              <button
                key={p.kind}
                className="btn"
                disabled={status !== 'ready'}
                onClick={() => {
                  const { center, radius } = frameRef.current;
                  flyTo(presetPose(center, radius, FOV, p));
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </section>

        {/* ---- 测量 ---- */}
        <section className="section">
          <div className="section-head">
            <span className="label">测量 / MEASURE</span>
            <span className="label unit">{calib ? `标定 ${fmt(calib.cmPerUnit, 2)} cm/u` : '场景单位 u'}</span>
          </div>

          <div className="row">
            <button
              className="btn"
              data-on={measureOn}
              disabled={status !== 'ready'}
              onClick={() => setMeasureOn((v) => !v)}
            >
              {measureOn ? '测量中' : '开始测量'}
            </button>
            <button className="btn" data-on={showAxes} onClick={() => setShowAxes((v) => !v)}>
              XYZ 轴
            </button>
            <button
              className="btn"
              disabled={measures.length === 0 && !pending}
              onClick={() => {
                pendingRef.current = null;
                setPending(null);
                setMeasures([]);
              }}
            >
              清空
            </button>
          </div>

          {status === 'ready' && info && (
            <div className="meta-row">
              <span className="label">包围盒 X×Y×Z</span>
              <span>
                {[0, 1, 2]
                  .map((i) => fmtLen(Math.abs(info.box.max[i] - info.box.min[i]), calib))
                  .join(' × ')}
              </span>
            </div>
          )}

          {measures.length > 0 && (
            <div className="keys">
              {measures.map((m, i) => {
                // 各轴分量取绝对值。端点虽在对象空间，但翻转开关只是绕 X 转 180°，
                // 只改 y/z 的符号，取了绝对值就和世界轴上的分量一样。
                const [dx, dy, dz] = [0, 1, 2].map((k) => Math.abs(m.b[k] - m.a[k]));
                return (
                  <div className="key measure" key={i}>
                    <span className="label key-i">{String(i + 1).padStart(2, '0')}</span>
                    <span className="measure-body">
                      <span className="measure-len">{fmtLen(dist3(m.a, m.b), calib)}</span>
                      <span className="label unit measure-axes">
                        <i style={{ color: AXIS_COLORS[0] }}>X</i> {fmtLen(dx, calib)}{' '}
                        <i style={{ color: AXIS_COLORS[1] }}>Y</i> {fmtLen(dy, calib)}{' '}
                        <i style={{ color: AXIS_COLORS[2] }}>Z</i> {fmtLen(dz, calib)}
                      </span>
                    </span>
                    <button
                      className="key-x"
                      title="删掉这一段"
                      onClick={() => setMeasures((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {measures.length > 0 && (
            <div className="field">
              <span className="label">标定</span>
              <select
                className="input"
                value={Math.min(calibIdx, measures.length - 1)}
                onChange={(e) => setCalibIdx(Number(e.target.value))}
              >
                {measures.map((_, i) => (
                  <option key={i} value={i}>
                    #{String(i + 1).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <span className="label">实长</span>
              <input
                className="input"
                type="number"
                min={0}
                step="any"
                placeholder="cm"
                value={calibCm}
                onChange={(e) => setCalibCm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyCalib();
                }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="btn"
                disabled={!(Number(calibCm) > 0)}
                onClick={applyCalib}
              >
                设定
              </button>
            </div>
          )}
          {calib && (
            <div className="row">
              <span className="label unit" style={{ flex: 1 }}>
                1 u = {fmt(calib.cmPerUnit, 2)} cm（按 {fmt(calib.refCm, 1)} cm 的参照）
              </span>
              <button className="btn" onClick={() => setCalib(null)}>
                取消标定
              </button>
            </div>
          )}

          <div className="field">
            <span className="label">拾取阈值</span>
            <input
              type="range"
              min={0.02}
              max={0.9}
              step={0.01}
              value={pickOpacity}
              onChange={(e) => setPickOpacity(Number(e.target.value))}
            />
            <span className="label">{fmt(pickOpacity, 2)}</span>
          </div>
          <span className="label">
            {measures.length === 0
              ? '重建没有真实尺度：量一段已知长度（门宽、A4 纸）填进「实长」，之后读数换成厘米'
              : '点中的是视线上第一个不透明度过线的高斯；落在雾上就调高阈值'}
          </span>
        </section>

        {/* ---- 关键帧路径 ---- */}
        <section className="section">
          <div className="section-head">
            <span className="label">关键帧 / PATH</span>
            <span className="label">{keys.length} 帧</span>
          </div>

          {keys.length > 0 && (
            <div className="keys">
              {keys.map((k, i) => (
                <div className="key" key={i} data-current={playing}>
                  <span className="label key-i">{String(i + 1).padStart(2, '0')}</span>
                  <span className="label key-pos">{fmtVec(k.pos)}</span>
                  <button
                    className="key-x"
                    title="删掉这一帧"
                    onClick={() => setKeys((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="row">
            <button className="btn" disabled={status !== 'ready'} onClick={addKey}>
              记下当前机位 +
            </button>
            <button className="btn" data-on={playing} disabled={!canPlay} onClick={togglePlay}>
              {playing ? '停' : '播放'}
            </button>
            <button className="btn" disabled={keys.length === 0 || playing} onClick={() => setKeys([])}>
              清空
            </button>
          </div>

          <div className="field">
            <span className="label">每段</span>
            <input
              type="range"
              min={0.5}
              max={8}
              step={0.5}
              value={secPerLeg}
              onChange={(e) => setSecPerLeg(Number(e.target.value))}
            />
            <span className="label">{fmt(secPerLeg, 1)}s</span>
          </div>

          <label className="check">
            <input type="checkbox" checked={loopPlay} onChange={(e) => setLoopPlay(e.target.checked)} />
            <span className="label">循环播放</span>
          </label>

          {!canPlay && (
            <span className="label">先摆好机位、按「记下当前机位」存两个以上才能播</span>
          )}
        </section>

        {/* ---- 底部 meta ---- */}
        <div className="meta">
          <div className="section-head" style={{ border: 'none', paddingBottom: 0 }}>
            <span className="label">状态 / STATUS</span>
            <span className="label" style={{ color: paused || fps >= 30 ? undefined : 'var(--hot)' }}>
              {paused ? '已暂停' : `${fmt(fps, 0)} FPS`}
            </span>
          </div>

          {status === 'loading' && (
            <>
              <div className="meta-row">
                <span className="label">加载中</span>
                <span>{progress > 0 ? `${fmt(progress * 100, 0)}%` : '解析中…'}</span>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.max(progress * 100, 6)}%` }} />
              </div>
            </>
          )}

          {status === 'error' && failure && (
            <div className="meta-row">
              <span className="label err">出错</span>
              <span className="err">{FAIL_TITLE[failure.kind]}</span>
            </div>
          )}

          {status === 'ready' && info && (
            <>
              <Row k="高斯数" v={info.gaussians.toLocaleString('en-US')} />
              <Row k="加载耗时" v={`${fmt(info.seconds)} s`} />
              <Row
                k="取景依据"
                v={
                  meta?.cameras?.length
                    ? `训练相机 ${Math.floor(meta.cameras.length / 2) + 1}/${meta.cameras.length}`
                    : meta?.center && meta.radius
                      ? '元数据包围盒'
                      : 'mesh 包围盒'
                }
              />
              {meta?.rotate && <Row k="坐标系修正" v={`--rotate ${meta.rotate}`} />}
              <Row k="包围盒 min" v={fmtVec(info.box.min)} />
              <Row k="包围盒 max" v={fmtVec(info.box.max)} />
              {meta && (
                <>
                  <Row k="元数据 min" v={fmtVec(meta.bbox_min)} />
                  <Row k="元数据 max" v={fmtVec(meta.bbox_max)} />
                  <Row k="导出动作" v={meta.actions ?? '—'} />
                </>
              )}
              {info.metaError && <Row k="元数据" v={`读取失败（${info.metaError}）`} />}
            </>
          )}

          <label className="check" style={{ marginTop: 'var(--s3)' }}>
            <input type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)} />
            <span className="label">绕 X 翻转 180°（R8 判断用）</span>
          </label>
        </div>
      </aside>

      {/* ---- 画布 ---- */}
      <main
        className="stage"
        data-measure={measureOn && status === 'ready'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void acceptFiles(e.dataTransfer.files);
        }}
      >
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

        {/* 画布上的标签：位置由渲染循环每帧写 transform */}
        {status === 'ready' && (
          <div className="stage-labels">
            {showAxes &&
              ['X', 'Y', 'Z'].map((a, i) => (
                <div
                  key={a}
                  className="axis-label"
                  style={{ color: AXIS_COLORS[i] }}
                  ref={(el) => {
                    axisLabelEls.current[i] = el;
                  }}
                >
                  {a}
                </div>
              ))}
            {measures.map((m, i) => (
              <div
                key={i}
                className="measure-label"
                ref={(el) => {
                  measureLabelEls.current[i] = el;
                }}
              >
                {fmtLen(dist3(m.a, m.b), calib)}
              </div>
            ))}
          </div>
        )}

        {measureOn && status === 'ready' && (
          <div className="stage-hint stage-hint-left">
            {pending ? '已选起点 · 再点一下终点 · ESC 取消' : '点两下量一段 · 拖动照常转视角'}
            {pickNote && (
              <>
                <br />
                <span className="err">{pickNote}</span>
              </>
            )}
          </div>
        )}

        <button className="stage-toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '展开面板 →' : '← 收起面板'}
        </button>

        {(dragOver || status !== 'ready') && (
          <div className="stage-overlay" data-drop={dragOver}>
            {dragOver ? (
              <span className="label">松手即可加载</span>
            ) : status === 'loading' ? (
              <span className="label">
                {builtin?.key ?? recent?.name ?? ''} 加载中{progress > 0 ? ` ${fmt(progress * 100, 0)}%` : '…'}
              </span>
            ) : failure ? (
              <FailureCard failure={failure} builtin={!!builtin} />
            ) : null}
          </div>
        )}

        {mode === 'fly' && status === 'ready' && (
          <div className="stage-hint">
            WASD 平移 · QE 滚转 · 拖动转视角
            <br />
            SHIFT 加速 · CTRL 减速
          </div>
        )}
      </main>
    </div>
  );
}

const FAIL_TITLE: Record<FailKind, string> = {
  missing: '找不到资产',
  fetch: '下载失败',
  parse: '解析失败',
  webgl2: 'WebGL2 用不了',
  'context-lost': 'GPU 上下文丢失',
};

/** 画布中央的出错说明：原因 + 按类别给的下一步 + 原始报错（排查用）。 */
function FailureCard({ failure, builtin }: { failure: Failure; builtin: boolean }) {
  const small = { marginTop: 'var(--s3)', fontSize: '0.875rem', opacity: 0.75 } as const;
  return (
    <div style={{ maxWidth: '46ch' }}>
      <div className="label err" style={{ marginBottom: 'var(--s3)' }}>{FAIL_TITLE[failure.kind]}</div>
      <p style={{ margin: 0, fontSize: '0.9375rem' }}>{failure.msg}</p>

      {failure.kind === 'missing' && builtin && (
        <p style={small}>
          public/splats/ 下的二进制都不进 git。刚克隆的机器先跑
          <code> pipeline/scripts/04_export.sh --publish </code>
          把资产生成出来。线上出现这个，就是部署时漏传了 splats/ 目录。
        </p>
      )}
      {failure.kind === 'parse' && builtin && (
        <p style={small}>
          按资产列表从上到下换着试，能分清是渲染代码、SOG 格式还是自产 PLY 的问题。
        </p>
      )}
      {failure.kind === 'webgl2' && (
        <p style={small}>
          Chrome / Edge：设置 → 系统 → 打开「使用图形加速功能」后重启浏览器；
          地址栏打开 <code>chrome://gpu</code> 能看到 WebGL2 是不是被禁用了。
        </p>
      )}
      {failure.kind === 'context-lost' && (
        <>
          <p style={small}>关掉别的 3D 页面再重载；手机上建议换一个高斯更少的资产。</p>
          <button
            className="btn"
            style={{ marginTop: 'var(--s3)' }}
            onClick={() => window.location.reload()}
          >
            重新加载页面
          </button>
        </>
      )}

      {failure.raw && (
        <p style={{ ...small, fontFamily: 'var(--font-mono)', fontSize: '0.75rem', wordBreak: 'break-all' }}>
          {failure.raw}
        </p>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="meta-row">
      <span className="label">{k}</span>
      <span>{v}</span>
    </div>
  );
}
