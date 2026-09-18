/**
 * M5 单文件渲染 demo（CLAUDE.md §5「单文件 demo 优先」）。
 *
 * 除了 three / spark / react 之外不依赖本仓库的任何东西，整个文件拷走就能跑。
 *
 * 这一版的重点是**能定位故障**，不是好看。资产下拉里的三个条目构成一条诊断链：
 *   butterfly.spz  官方数据 + 官方格式   → 它都渲染不出来，问题在下面这段渲染代码
 *   butterfly.sog  官方数据 + 本地导出器 → 只有它坏，问题在 SOG 路径 / splat-transform（R7）
 *   riverview.sog  自产 PLY + 本地导出器 → 只有它坏，问题在 02 的 PLY 或导出参数
 * 一片黑屏时先按这个顺序试，比盯着代码猜快得多。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

type Asset = {
  key: string;
  file: string;
  /** 同名 .json（04_export.sh 产出）存在时会被读来和 mesh 自报的包围盒对账 */
  meta?: string;
  note: string;
};

const ASSETS: Asset[] = [
  { key: 'butterfly.spz', file: 'butterfly.spz', note: '官方数据 + 官方格式' },
  { key: 'butterfly.sog', file: 'butterfly.sog', note: '官方数据 + 本地导出器' },
  { key: 'riverview.sog', file: 'riverview.sog', meta: 'riverview.json', note: '自产 PLY + 本地导出器' },
];

// 默认打开主线资产而不是数组第一个：public/splats/ 下的二进制都不进 git，
// 新克隆的机器上只有跑过 04_export.sh --publish 的那个场景存在。
const DEFAULT_ASSET = 'riverview.sog';

/** 04_export.sh 写出的元数据，字段少而稳；缺失时降级用 mesh 自己的包围盒。 */
type SceneMeta = {
  scene?: string;
  gaussians?: number;
  sog_mb?: number;
  center?: [number, number, number];
  radius?: number;
  bbox_min?: [number, number, number];
  bbox_max?: [number, number, number];
  actions?: string;
};

type LoadInfo = {
  gaussians: number;
  seconds: number;
  /** mesh 自报的包围盒（对象空间，只取中心点），用来和 meta 对账 */
  box: { min: number[]; max: number[] };
  meta: SceneMeta | null;
  metaError: string | null;
};

const FOV = 60;
const fmt = (n: number, d = 2) => n.toFixed(d);
const fmtVec = (v: number[] | undefined) => (v ? v.map((x) => fmt(x)).join(', ') : '—');

export function SplatViewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  // three 的对象放 ref 不放 state：它们变化不需要触发 React 重渲染。
  const coreRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
  } | null>(null);
  const meshRef = useRef<SplatMesh | null>(null);
  // 取景要用的元数据也放 ref：翻转开关那个 effect 需要它，但它变化不该触发重渲染。
  const metaRef = useRef<SceneMeta | null>(null);

  const [assetKey, setAssetKey] = useState(DEFAULT_ASSET);
  const [flipX, setFlipX] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [fps, setFps] = useState(0);

  const asset = ASSETS.find((a) => a.key === assetKey)!;

  /**
   * 把相机摆到能看全场景的位置，并把 OrbitControls 的活动范围限制在附近（§5）。
   *
   * 取景依据**优先用 04_export.sh 写的元数据**（CLAUDE.md M5：「相机初始位姿读 M4 的 JSON」）——
   * 那是导出时对最终资产算的，权威。官方参照资产没有 JSON，才退回 mesh 自报的包围盒。
   * 两条路都在世界空间里定位，所以翻转开关一动，跟着走的是同一套逻辑。
   */
  const frameScene = useCallback((mesh: SplatMesh, meta: SceneMeta | null) => {
    const core = coreRef.current;
    if (!core) return;
    const { camera, controls } = core;

    let center: THREE.Vector3;
    let r: number;
    if (meta?.center && typeof meta.radius === 'number' && meta.radius > 0) {
      center = new THREE.Vector3(...meta.center);
      r = meta.radius;
    } else {
      const sphere = mesh.getBoundingBox(true).getBoundingSphere(new THREE.Sphere());
      center = sphere.center;
      r = sphere.radius;
    }
    // 元数据是对象空间的；乘上 matrixWorld 之后翻转开关才会被算进去（旋转不改半径）。
    mesh.updateMatrixWorld(true);
    center.applyMatrix4(mesh.matrixWorld);
    r = Math.max(r, 1e-3);
    const sphere = new THREE.Sphere(center, r);
    // 标准取景公式：半角的正弦决定距离，再留 10% 余量。
    const dist = (r / Math.sin((FOV / 2) * (Math.PI / 180))) * 1.1;
    // 从略微偏上的斜方看过去，比正对着看更容易一眼判断场景有没有倒置。
    const dir = new THREE.Vector3(0.0, 0.25, -1).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = Math.max(r * 0.005, 1e-4);
    camera.far = r * 200;
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.minDistance = r * 0.05;
    controls.maxDistance = r * 8;
    controls.update();
  }, []);

  // ---- three 初始化：整个组件生命周期内只跑一次 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    // splat 渲染卡在填充率上，DPR 拉满等于白算一倍像素（R9）。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, host.clientWidth / host.clientHeight, 0.01, 1000);
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    coreRef.current = { renderer, scene, camera, controls };

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
    // 用 setAnimationLoop 而不是裸 rAF：它是 three 的官方入口（WebXR 下也走同一条路），
    // 传 null 等价于 cancelAnimationFrame，清理照样是配对的。
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
      frames++;
      const now = performance.now();
      if (now - lastFpsAt >= 500) {
        setFps((frames * 1000) / (now - lastFpsAt));
        frames = 0;
        lastFpsAt = now;
      }
    });

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      meshRef.current?.dispose();
      meshRef.current = null;
      scene.remove(spark);
      spark.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      coreRef.current = null;
    };
  }, []);

  // ---- 资产加载：换资产时重新走一遍 ----
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    let cancelled = false;

    setStatus('loading');
    setProgress(0);
    setError('');
    setInfo(null);

    if (meshRef.current) {
      core.scene.remove(meshRef.current);
      meshRef.current.dispose();
      meshRef.current = null;
    }

    // base 是 './'，所以代码里拼的路径必须带 BASE_URL，否则部署到子目录就 404。
    const base = import.meta.env.BASE_URL;
    const t0 = performance.now();

    const mesh = new SplatMesh({
      url: `${base}splats/${asset.file}`,
      onProgress: (e) => {
        if (cancelled) return;
        setProgress(e.lengthComputable && e.total > 0 ? e.loaded / e.total : 0);
      },
    });

    const metaPromise: Promise<{ meta: SceneMeta | null; err: string | null }> = asset.meta
      ? fetch(`${base}splats/${asset.meta}`)
          .then(async (r) =>
            r.ok ? { meta: (await r.json()) as SceneMeta, err: null } : { meta: null, err: `HTTP ${r.status}` },
          )
          .catch((e: unknown) => ({ meta: null, err: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve({ meta: null, err: null });

    void (async () => {
      try {
        await mesh.initialized;
        if (cancelled) {
          mesh.dispose();
          return;
        }
        const seconds = (performance.now() - t0) / 1000;
        meshRef.current = mesh;
        core.scene.add(mesh);
        // quaternion 由下面那个 effect 设置；这里先取一次景，翻转后会再取一次。
        mesh.updateMatrixWorld(true);
        // centers_only=true：只用高斯中心算包围盒。个别退化成超大薄片的高斯
        // （AnySplat 的 scale 分布尾巴很长）会把完整包围盒撑到没法用。
        const box = mesh.getBoundingBox(true);
        const { meta, err } = await metaPromise;
        if (cancelled) return;
        metaRef.current = meta;
        setInfo({
          gaussians: mesh.numSplats,
          seconds,
          box: { min: box.min.toArray(), max: box.max.toArray() },
          meta,
          metaError: err,
        });
        frameScene(mesh, meta);
        setStatus('ready');
      } catch (e: unknown) {
        if (cancelled) return;
        mesh.dispose();
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [asset, frameScene]);

  // ---- 坐标系翻转（R8 的现场判断工具）----
  // 官方 getting-started 给 butterfly 设了 quaternion(1,0,0,0)，也就是绕 X 轴 180°，
  // 因为 splat 训练坐标系 Y 向下而 three 是 Y 向上。这个开关只用来**看出**该不该转；
  // 一旦定下来就到 04_export.sh 用 --rotate 烤进资产里，不留在前端。
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || status !== 'ready') return;
    mesh.quaternion.set(flipX ? 1 : 0, 0, 0, flipX ? 0 : 1);
    frameScene(mesh, metaRef.current);
  }, [flipX, status, frameScene]);

  const meta = info?.meta;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '12px 14px',
          background: 'var(--hud-bg)',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.7,
          minWidth: 330,
          backdropFilter: 'blur(8px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <select
            value={assetKey}
            onChange={(e) => setAssetKey(e.target.value)}
            style={{
              flex: 1,
              background: '#1c1c20',
              color: 'var(--hud-fg)',
              border: '1px solid #33333a',
              borderRadius: 4,
              padding: '4px 6px',
              font: 'inherit',
            }}
          >
            {ASSETS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.key} — {a.note}
              </option>
            ))}
          </select>
          <span
            style={{
              color: fps >= 30 ? 'var(--hud-ok)' : 'var(--hud-accent)',
              minWidth: 54,
              textAlign: 'right',
            }}
          >
            {fmt(fps, 0)} fps
          </span>
        </div>

        {status === 'loading' && (
          <div style={{ color: 'var(--hud-dim)' }}>
            加载中 {progress > 0 ? `${fmt(progress * 100, 0)}%` : '…'}
            <div style={{ height: 3, background: '#2a2a30', borderRadius: 2, marginTop: 5 }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.max(progress * 100, 2)}%`,
                  background: 'var(--hud-accent)',
                  borderRadius: 2,
                  transition: 'width .15s',
                }}
              />
            </div>
          </div>
        )}

        {status === 'error' && (
          <div style={{ color: 'var(--hud-accent)' }}>
            加载失败：{error}
            <div style={{ color: 'var(--hud-dim)', marginTop: 4 }}>
              public/splats/ 下的二进制都不进 git。刚克隆的机器上先跑
              <code style={{ color: 'var(--hud-fg)' }}> pipeline/scripts/04_export.sh --publish </code>
              把资产生成出来（官方参照资产的取法见 web/README.md）。
              <br />
              资产确实在却还是失败时，按下拉框里的顺序换一个试，能分清是渲染代码、SOG 路径还是自产 PLY 的问题。
            </div>
          </div>
        )}

        {status === 'ready' && info && (
          <>
            <Row k="高斯数" v={info.gaussians.toLocaleString('en-US')} />
            <Row k="加载耗时" v={`${fmt(info.seconds)} s`} />
            <Row k="取景依据" v={meta?.center && meta.radius ? '元数据 JSON' : 'mesh 自报包围盒'} />
            <Row k="包围盒 min" v={fmtVec(info.box.min)} />
            <Row k="包围盒 max" v={fmtVec(info.box.max)} />
            {meta && (
              <>
                <div style={{ borderTop: '1px solid #2a2a30', margin: '6px 0' }} />
                <Row k="元数据 min" v={fmtVec(meta.bbox_min)} />
                <Row k="元数据 max" v={fmtVec(meta.bbox_max)} />
                <Row k="导出动作" v={meta.actions ?? '—'} />
                <Row k="文件大小" v={meta.sog_mb != null ? `${meta.sog_mb} MB` : '—'} />
              </>
            )}
            {info.metaError && <Row k="元数据" v={`读取失败（${info.metaError}）`} />}
          </>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)} />
          <span>绕 X 轴翻转 180°（判断 R8 坐标系用，定下来后挪到导出参数）</span>
        </label>

        <div style={{ color: 'var(--hud-dim)', marginTop: 8, fontSize: 11 }}>
          左键拖动旋转 · 右键平移 · 滚轮缩放
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ color: 'var(--hud-dim)', minWidth: 76 }}>{k}</span>
      <span style={{ flex: 1, wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}
