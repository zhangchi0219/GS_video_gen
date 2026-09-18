# sawtooth-splat

把一段手持视频离线重建成 3D 高斯泼溅（3DGS），压成单文件资产，在自托管的网页里实时渲染。

全程不联网、不依赖任何后端，产物是一堆静态文件。

---

## 这是什么，不是什么

**是**「单个视频输入」—— 你只需要交一段绕着拍的视频，剩下的抽帧、重建、压缩、渲染全自动。

**不是**「单视角生成」。模型吃的是**多视角图像**，视频只是获取多视角的便利手段：管线会从视频里
抽出几十个不同机位的帧喂给模型。**相机必须真的移动**——原地转动镜头拍出来的视频没有视差，
重建一定失败。

它真正省掉的是 **COLMAP**。传统 3DGS 要先用运动恢复结构（SfM）解算相机位姿，再逐场景优化几十
分钟；这里用的 AnySplat 是**前馈**模型，一次推理同时吐出高斯参数和相机位姿 —— 实测 45 帧只要
**6.1 秒**。

---

## 用到的模型

| | |
|---|---|
| **重建模型** | [AnySplat](https://github.com/InternRobotics/AnySplat)，commit `5f5e208` |
| **权重** | `lhjiang/anysplat`，revision `d2e8c34`（sha256 校验后本地加载，**运行时不联网**） |
| **几何先验来源** | 权重蒸馏自 Meta 的 **VGGT-1B**（见下方许可证一节） |
| **输入规格** | 内部固定 448×448，先把短边缩到 448 再中心裁 |
| **球谐** | 模型是 sh_degree=4（25 系数），但 DC 带占 **99.5%** 能量，所以只导出 DC |

模型不做任何训练或微调，纯推理。

### 工具链

| 环节 | 组件 | 版本 |
|---|---|---|
| 抽帧 | ffmpeg + OpenCV | 6.1.1 / 4.11.0.86 |
| 推理 | PyTorch | 2.8.0 + cu128 |
| 光栅化 | [gsplat](https://github.com/nerfstudio-project/gsplat) | 1.5.3（本机编译） |
| 压缩 | [@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform) | 3.4.2 |
| 网页渲染 | [Spark](https://sparkjs.dev/)（World Labs） + three.js | 2.2.0 / 0.186.0 |
| 前端 | Vite + React + TypeScript | 8.3 / 19.3 / 7.0 |

完整的版本矩阵和搭建步骤见 [`pipeline/README.md`](pipeline/README.md)。

---

## 硬件

重建这一步是**显存瓶颈型**任务，实测 45 帧峰值 **15.0 GB**。

| 帧数 | 显存 | 耗时 |
|---|---|---|
| 12 | 6.1 GB | 1.8 s |
| 45（真实场景） | 15.0 GB | 6.1 s |
| 64 | 20.1 GB | 9.4 s |

**显存几乎只由帧数驱动，高斯数量影响很小**（实测：45 帧 200 万高斯只要 15.0 GB，而 48 帧
99 万高斯却要 15.8 GB）。24 GB 显存可跑到 64 帧，16 GB 建议 32 帧封顶。

Python 侧全部跑在 **WSL2 Ubuntu** 里（gsplat 的 CUDA 扩展在 Windows 原生极易编译失败）。
导出和网页是纯 CPU/浏览器的活，任何机器都能跑。

---

## 快速上手

### 0. 环境

一次性搭建见 [`pipeline/README.md`](pipeline/README.md)。之后每次开工：

```bash
cd /mnt/e/Github/GS_video_gen          # WSL 里
source pipeline/env/activate.sh        # 所有 Python 命令的统一入口
python pipeline/scripts/00_check_env.py   # 三道硬性门，出问题先跑它
```

### 1. 拍摄

这一步决定了后面所有环节的上限，**比调参重要得多**。

- **竖着拍**。模型会把输入裁成正方形，裁掉的永远是长边方向 —— 横拍 16:9 会丢掉 **44% 的水平
  视场**，竖拍则把损失转嫁到垂直方向，水平一点不丢。绕拍时决定质量的正是水平覆盖。
- **绕着主体走一圈**，10～20 秒，匀速，别停顿也别突然加速。
- **拍有纹理的东西**。大片白墙是最难的情况：没有特征就估不出深度，模型只能堆一堆半透明高斯，
  看起来雾蒙蒙的。
- 主体保持在画面中央，避开强反光、镜面和透明物体。

把视频放到 `media/` 或任意路径（都已 gitignore）。

### 2. 抽帧

```bash
python pipeline/scripts/01_extract_frames.py --scene mydesk --input media/mydesk.mov
```

把时长切成 64 个等长窗口，每个窗口里挑拉普拉斯方差最大（最清晰）的一帧，
再剔掉整段糊掉的窗口。输出 `pipeline/data/frames/mydesk/000.jpg …` 和一份 `_extract.json`。

**跑完先看那份 JSON 再往下走**：`windows_dropped` 非空、或 `frames_written` 明显少于 64，
就是覆盖有空洞的信号 —— 重拍比硬跑划算。

### 3. 重建

```bash
python pipeline/scripts/02_reconstruct.py \
    --frames-dir pipeline/data/frames/mydesk \
    --out-ply pipeline/data/ply/mydesk.ply
```

输出标准 3DGS PLY，外加一份统计 JSON（高斯数、包围盒、显存峰值、**每个训练相机的位姿**）。

### 4. 压缩导出

```bash
(cd pipeline && npm ci)        # 只有第一次需要
bash pipeline/scripts/04_export.sh --scene mydesk --publish
```

PLY → 单文件 `.sog`（约小一个数量级），`--publish` 直接送到 `web/public/splats/`。
坐标系修正、球谐降阶、低不透明度过滤都在这一步做完。

### 5. 网页

```bash
cd web && npm ci && npm run dev     # http://127.0.0.1:5173/
```

把新场景加进 `web/src/SplatViewer.tsx` 的 `BUILTINS` 数组即可。也可以直接把 `.sog`
拖进页面 —— 支持 `.sog` / `.ply` / `.spz` / `.splat` / `.ksplat`，纯前端解析。

查看器带轨道/飞行（WASD）双模式、预设机位、关键帧路径录制。详见
[`web/README.md`](web/README.md)。

---

## 实测数据

`media/test.mov`（1920×1080 / 60fps / 16 秒，室内）：

| 阶段 | 结果 |
|---|---|
| 抽帧 | 320 候选 → 45 帧，6.2 s |
| 重建 | **200 万高斯**，6.1 s，显存 15.0 GB |
| 导出 | **17.31 MB**（PLY 130 MB → SOG，压缩约 7.5×） |
| 网页首屏 | 18.53 MB（代码 gzip 后仅 1.07 MB，**93% 是 splat 资产**） |

首屏时间的瓶颈完全在资产本身，不在代码 —— 要压加载时间应该去减小 `.sog`
（`--min-opacity` 过滤实测可省 36%），而不是折腾代码分包。

---

## 目录结构

```
├── CLAUDE.md          项目常驻指令 + 完整的踩坑记录（18 条）
├── media/             原始视频（gitignore）
├── pipeline/          Python 重建侧，跑在 WSL2 里
│   ├── config/        两套机器 preset，所有显存相关参数只在这里改
│   ├── scripts/       00 自检 / 01 抽帧 / 02 重建 / 04 导出
│   ├── env/           环境锁文件与自检报告
│   └── data/          帧、PLY、SOG（gitignore，只有元数据 JSON 进 git）
└── web/               Vite + React + Spark 查看器
    ├── src/SplatViewer.tsx   单文件 demo，拷走就能跑
    ├── nginx-sawtooth.conf   站点配置
    ├── deploy.sh             构建 + rsync（默认 dry-run）
    └── verify-deploy.sh      部署自检，本地和生产跑同一份
```

---

## 许可证

**做商业项目前必须自行核对，目前尚未核实。**

AnySplat 的代码是 MIT，但它的权重蒸馏自 Meta 的 VGGT-1B，而 VGGT 的权重条款是非商用
（AnySplat 源码里 `src/utils/image.py` 就带着 CC BY-NC-SA 的文件头）。**在逐条核实之前，
不要对客户承诺这套管线的产物可以商用。**

本仓库自己的代码没有附加限制；第三方依赖各自的许可证见各自项目。

---

## 当前状态

已完成：环境验证、官方示例跑通、M1→M5 全链路、自采素材实跑、部署配置与自检。

未完成：

- **未上线**。`web/` 下的部署三件套已在本地 nginx 上验证通过（10 项自检全过，
  Range 返回 206），但还没传到服务器。
- **未做 4G 实测**，需要真机。
- **未做双机一致性验证**（台式 5080 上的 `npm ci` + 重建复现）。
- **不做动态/4D**，本阶段只做静态场景。
