# web —— SOG 渲染侧（M5）

Vite + React + TypeScript + Three.js + Spark。**主力机是台式 5080**，但这一套全是 CPU/浏览器的活，
笔记本上同样能跑（第一版就是在笔记本 5090 上搭起来的）。

## 已验证的版本组合（2026-09-18）

| 组件 | 版本 | 说明 |
|---|---|---|
| Node | 24.13.1 | 根目录 `.nvmrc` 锁定；splat-transform 要求 `>=22` |
| Vite | 8.3.0 | `base: './'`，M6 要部署到 BT Panel 子目录 |
| React | 19.3.0 | 开着 StrictMode，开发模式下 effect 挂两次，用来逼出没 dispose 的 WebGL 资源 |
| TypeScript | 7.0.2 | |
| three | 0.186.0 | Spark 2.2.0 的 peer 要求是 `>=0.180.0` |
| @sparkjsdev/spark | 2.2.0 | World Labs 出品，MIT |

依赖全部**精确钉版本**（没有 `^`），装的时候用 `npm ci`（CLAUDE.md §5）。

```bash
cd web
npm ci
npm run dev      # http://127.0.0.1:5173/
npm run build    # 产出 dist/
```

## 资产从哪来

`public/splats/` 下的二进制**都不进 git**（见根目录 `.gitignore`），只有 `.json` 进。
换一台机器后自己补齐：

```bash
# 1. 自产场景：PLY 在 pipeline/data/ply/ 下（走 NAS 或 scp 拿，不进 git）
cd pipeline && npm ci
bash scripts/04_export.sh --scene riverview --publish    # --publish 直接送到 web/public/splats/

# 2. 官方参照（一次性，只在开发期用；dist/ 里不会有它）
curl -L -o web/public/splats/butterfly.spz https://sparkjs.dev/assets/splats/butterfly.spz
cd pipeline && npx splat-transform -w ../web/public/splats/butterfly.spz ../web/public/splats/butterfly.sog
```

## SplatViewer 的三段式诊断

资产下拉框里那三条不是随便排的，是一条**故障定位链**（R7 要求「先用官方示例验证再换自己的」）：

| 资产 | 数据 | 格式路径 | 它坏了说明 |
|---|---|---|---|
| `butterfly.spz` | 官方 | 官方 | 问题在 `SplatViewer.tsx` 这段渲染代码 |
| `butterfly.sog` | 官方 | 本地 splat-transform 转的 | 问题在 SOG 路径本身（bundled 形态、Spark 版本） |
| `riverview.sog` | 自产 PLY | 本地导出 | 问题在 `02_reconstruct.py` 的 PLY 或导出参数 |

黑屏时按这个顺序点一遍，比读代码猜快得多。HUD 上同时显示 mesh 自报的包围盒和
`04_export.sh` 写的元数据包围盒，两者对不上就说明导出和加载有一方理解错了数据。

相机初始位姿**优先读元数据 JSON 的 `center` / `radius`**（CLAUDE.md M5 的要求），
HUD 的「取景依据」那一行会写明当前用的是哪一条路；官方参照资产没有 JSON，会退回
mesh 自报的包围盒。默认打开的是 `riverview.sog` 而不是下拉框第一项——
二进制都不进 git，新克隆的机器上只有跑过 `04_export.sh --publish` 的那个场景存在。

## 「绕 X 轴翻转 180°」那个勾选框

R8（坐标系翻转）的**判断工具**，不是最终方案。Spark 官方 getting-started 给 butterfly 设了
`quaternion.set(1, 0, 0, 0)`，就是绕 X 轴 180°——splat 训练坐标系 Y 向下，Three.js Y 向上。

一旦看出某个场景需要翻，就去 `04_export.sh` 加 `--rotate 180,0,0` 把它烤进资产里，
**不要**留在前端。CLAUDE.md R8 的原话：「在 M4 导出阶段一次性修正，不在前端每帧转换」。

## 已知问题

- **分 chunk 没真正生效**：`vite build` 出来 `three` chunk 只有 19.8 kB，而 `spark` 有 3.0 MB
  （gzip 1.0 MB）——three 多半被并进了 spark 的 chunk，因为 spark 依赖它。功能没影响，
  但 M6 实测国内 4G 加载时间时要把这 1 MB 算进去。
- **dev server 不发 `Content-Type`**：`.sog` 响应头里 Content-Type 是空的。浏览器不在乎，
  但 M6 的 Nginx 必须显式配 `application/octet-stream` 和 `Accept-Ranges: bytes`。
