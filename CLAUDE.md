# CLAUDE.md — sawtooth-splat（多帧 → 高斯泼溅 → 网页）

> 本文件是 Claude Code 在本仓库的常驻指令。所有回复用中文；新术语首次出现时用中文解释；
> 涉及版本号、npm 包、CUDA/PyTorch 兼容性时**先查官方文档再动手**，不凭记忆猜。
> 先出计划、经我确认后再写代码。未经确认不得新建大段实现。
>
> **版本 v2** — 相比 v1 增加双机（笔记本 5090 / 台式 5080）适配。

## 0. 项目目标（Step 1，只做静态）

把手机绕拍的一段视频（或一组照片）离线重建为静态 3D 高斯泼溅（3DGS），压缩为 SOG，
在自托管的 Vite + React + Three.js 网页里用 Spark 2.x 渲染。**本阶段不做动态/4D。**

验收标准：
1. 30～60 帧输入，在重建机上 AnySplat 推理完成（不含后优化）< 2 分钟。
2. 输出 `.sog` 单文件 < 30 MB（典型室内/桌面场景）。
3. 网页在国内网络、无任何外部 CDN、无 Google Fonts 的前提下加载并以 ≥ 30 fps 渲染（桌面）。
4. 部署为纯静态文件，BT Panel + Nginx，支持 HTTP Range（为后续 .RAD 流式预留）。

## 1. 硬件与分工（**本节是 v2 新增，动手前先读**）

我有两台机器，显存与算力的强弱关系和直觉相反，别搞混：

| | **RECON 机：笔记本 RTX 5090** | **DEV 机：台式 RTX 5080** |
|---|---|---|
| 显存 | 24 GB GDDR7 | 16 GB |
| 架构 | Blackwell（sm_120） | Blackwell（sm_120） |
| 角色 | 跑重建 M2 / M3 | 前端开发、导出 M4、部署 M6 |
| 功耗特性 | TGP 可配置 95–150 W，插电模式下跑，别用电池 | 不限 |

要点：
- **两台都是同一代架构**，所以 CUDA / PyTorch 版本要求完全一致 —— 环境验证结论通用，写一份即可。
- **笔记本显存反而更大**。重建是显存瓶颈型任务，所以重的活在笔记本上做。
- **gsplat 的 CUDA 扩展必须在每台机器上各自编译一次**，编译产物不要跨机拷贝。
- 台式机不需要装 AnySplat 全套；只要 Node + splat-transform + web 开发环境。
  除非在做 R11 的一致性验证，否则别在台式机上重复搭 Python 环境。

### 显存分档（对应下面 M2/M3 的参数）

| 场景 | 笔记本 5090（24 GB） | 台式 5080（16 GB） |
|---|---|---|
| AnySplat 输入帧上限 | **64 帧**（实测峰值 20.1 GB）；96 帧会溢出到系统内存 | **32 帧**（48 帧就要 15.8 GB，已到顶） |
| M3 后优化 | 可开 | 谨慎，需降分辨率 |
| 后续 4D（MoSca/MoVieS，Step 2+） | 首选，也未必够 | 基本不够，不要浪费时间 |

上表已按 2026-09-18 在笔记本 5090 上的实测结果修正（原先写的是「先试 96」和「5080 上限 64 帧」，实测下来都偏乐观）。
完整曲线（bf16、448²、重复帧合成输入）：12 帧 6.1 GB / 24 帧 9.3 GB / 48 帧 15.8 GB / 64 帧 20.1 GB / 96 帧 28.8 GB。
其中只有 12 帧是真实场景，其余是重复帧拼出来的合成输入。显存与耗时主要由帧数驱动、可以迁移；
但**高斯数量完全不能迁移**（24 帧的 voxelize 保留率只有 12.5%，而 12 帧是 64.8%）。
~~所以显存那一列对真实场景是偏低估的~~ —— **2026-09-18 实测推翻了这条推测**：
真实的 45 帧有 200 万高斯，只要 15.00 GB；而合成的 48 帧只有 99 万高斯却要 15.8 GB。
**显存几乎只由帧数驱动，高斯数量的影响很小**，所以这条曲线对真实场景是够用的。

所有涉及显存的参数**必须做成命令行参数并在配置文件里给两套 preset**
（`pipeline/config/recon-5090.yaml` 和 `pipeline/config/dev-5080.yaml`），
不要把数字硬编码在脚本里。

## 2. 仓库结构（monorepo，两个互不依赖的子目录）

```
sawtooth-splat/
├── CLAUDE.md                 ← 本文件
├── .nvmrc                    ← 锁定 Node 版本（两台机器一致）
├── pipeline/                 ← Python，跑在 WSL2 Ubuntu 里（主力在笔记本）
│   ├── env/
│   │   ├── requirements.lock  pip freeze 结果，提交进 git
│   │   └── ENVIRONMENT.md     CUDA toolkit / 驱动 / WSL2 发行版版本号，两台各记一列
│   ├── config/
│   │   ├── recon-5090.yaml
│   │   └── dev-5080.yaml
│   ├── scripts/
│   │   ├── 01_extract_frames.py   视频 → 抽帧（ffmpeg），去模糊帧
│   │   ├── 02_reconstruct.py      AnySplat 推理 → gaussians → PLY
│   │   ├── 03_post_opt.py         （可选）AnySplat 自带 post_opt 精修
│   │   ├── 04_export.sh           PLY → SOG（splat-transform）
│   │   └── 00_check_env.py        打印 GPU 型号/显存/torch 版本/gsplat 可用性
│   ├── models/anysplat/           ← 本地权重，gitignore
│   ├── data/{raw,frames,ply,sog}/ ← 全部 gitignore
│   └── README.md
└── web/                      ← Vite + React + TypeScript + Three.js + Spark（主力在台式）
    ├── src/
    │   ├── SplatViewer.tsx        单文件可运行 demo（默认交付物）
    │   └── main.tsx
    ├── public/splats/             ← 本地 .sog 资产
    ├── package.json / package-lock.json（提交锁文件，`npm ci`）
    └── vite.config.ts
```

## 3. 模块拆解

### M0 环境自检（pipeline/scripts/00_check_env.py）— **v2 新增，每台机器第一件事**
- 打印：GPU 名称、总显存、`torch.__version__`、`torch.version.cuda`、
  `torch.cuda.get_device_capability()`（应为 (12, 0)）、gsplat 能否 import 且能跑一次最小光栅化。
- 结果追加写入 `env/ENVIRONMENT.md`，两台机器各一节。
- 任何"这台能跑那台不行"的问题，先跑这个脚本对比两份输出，再动别的。

### M1 采集与抽帧（01）
- 输入：手机视频（**画幅 1:1**，绕物体/场景一圈，10～20 秒），或一组 JPG。
  画幅很关键：AnySplat 的 `process_image` 先把短边缩到 448 再中心裁 448×448，
  所以 16:9 只有 56% 的水平视场进得了模型，4:3 是 75%，1:1 不丢。
- 选帧：**窗口内选最清晰**，不是初稿写的「全局排序丢掉最糊的 15%」。把时长切成
  `target_frames` 个等长窗口，每窗口取拉普拉斯方差最大的一帧。全局排序会把「转得快
  所以整段偏糊」的那段弧一次性删掉，留下覆盖空洞（R6）。
- 剔糊帧：地板 = 全局候选清晰度的**中位数 × `blur_floor_factor`**（默认 0.3），
  窗口最佳仍低于地板才算整段糊掉。**不用分位数** —— 分位数是相对排名，分布再紧密
  也必定丢掉那个比例，实测在 riverview 的 12 张真实照片上误杀了 2 张。
  （`blur_reject_ratio` 因此已从 config 删除。）
- 裁剪：默认 `crop: square`，提前裁成正方形对齐模型真正看到的画面；
  已验证与 AnySplat 自己裁的区域等价。主体偏一侧时用 `--crop-center` 调 ——
  横构图裁宽度、竖构图裁高度，参数自动作用在实际被裁的那个轴上。
- 统一 resize 到长边 1024；帧数上限读 config 的 `extract.target_frames`。
- 输出：`data/frames/<scene>/000.jpg …` 加一份 `_extract.json`（逐帧时间戳与清晰度）。
- 术语：**拉普拉斯方差**——对图像做二阶导数，方差越小说明边缘越少、越糊，是最简单的模糊检测。
  它对分辨率敏感，所以打分前要统一缩到同一尺寸。

### M2 前馈重建（02）
- 用 AnySplat 官方 `inference.py` 的逻辑封装成命令行：`--config --frames_dir --out_ply`。
- AnySplat 是**前馈（feed-forward）**模型：一次前向推理直接输出高斯参数和相机位姿，
  不需要 COLMAP（传统的运动恢复结构工具）也不需要逐场景优化。
- 模型权重 `lhjiang/anysplat` 必须提前下载到 `pipeline/models/anysplat/`，代码里用本地路径加载，
  禁止运行时联网拉取。
- **OOM 处理策略**：捕获 `torch.cuda.OutOfMemoryError`，打印当前帧数与显存占用，
  建议降到 config 里的 `fallback_frames`，不要静默崩溃。
- 输出：标准 3DGS `.ply`（含位置、缩放、旋转四元数、不透明度、球谐系数）。

### M3 可选精修（03）
- AnySplat 自带 `src/post_opt/simple_trainer.py`，以前馈结果为初值再做少量迭代优化。
- 只有 M2 结果出现明显漂浮伪影（floaters）时才启用；默认关闭。
- 只在笔记本 5090 上跑。

### M4 压缩导出（04）— **纯 CPU，两台机器都可以跑**
- 用 `@playcanvas/splat-transform`（MIT）把 PLY 转 `.sog`。**钉在 `pipeline/package.json` 里当
  devDependency 用 `npm ci` 装**，不用 `npm install -g`——全局装的版本不受 lock 约束，
  换机就漂移，与 §5「依赖锁定」冲突。（v2 初稿写的是全局装，2026-09-18 改。）
- 统计用 `--stats json`（不是初稿写的 `--summary`，那个 flag 不存在），由
  `04_summary.mjs` 整理成 `data/sog/<scene>.json`，供前端定相机初始位置。
  **注意它的 `mean`/`stdDev` 对 opacity、scale 这些需要解码的列是错的**，只能用
  `min`/`max`/`median`，见坑 6。
- 坐标系修正（`-r`）、球谐降阶（`-H`）、低不透明度过滤（`-V opacity,gt,N`，阈值是
  sigmoid 之后的 0~1）都在这一步用 splat-transform 的 action 做完。
- 术语：**SOG**——把高斯属性重排后编码成 WebP 纹理的超压缩格式，比原始 PLY 小一个量级，Spark 原生支持。

### M5 网页渲染（web/）
- `SparkRenderer` + `SplatMesh({ url: '/splats/<scene>.sog' })`，三个 Three.js 对象即可跑通。
- 相机初始位姿读 M4 的 JSON；OrbitControls 限制在包围盒内。
- 风格化（锯齿波色彩/位移）后置：Spark 的 shader graph 或 GLSL 管线，第一版不做。

### M6 部署
- `vite build` 产出 `dist/`，scp 到服务器站点目录；
  Nginx 加 `.sog` 的 `Content-Type: application/octet-stream` 与 `Accept-Ranges: bytes`；
  **不要**对 `.sog` 开 gzip（内部已是 WebP 压缩，白费 CPU）。
- 后续接入作品站时改为岛屿组件或 iframe。

## 4. 数据在两台机器间怎么走（v2 新增）

- `data/` 全部 gitignore。PLY 动辄几百 MB，**绝不进 git，也不用 git-lfs**。
- 走 NAS 共享目录或直接 scp：笔记本产出 `data/ply/<scene>.ply` → 台式取走做 M4/M5。
- 唯一跨机同步进 git 的是：`config/*.yaml`、`env/requirements.lock`、`env/ENVIRONMENT.md`、
  `data/sog/<scene>.json`（几 KB 的元数据，可以进）。
- `.sog` 成品放 `web/public/splats/`，小于 30 MB 可以进 git；超了就只在部署时上传。

## 5. 硬约束（违反即返工）

- **国内可达**：不用 jsDelivr / unpkg / cdnjs / Google Fonts / HuggingFace 运行时拉取；
  Spark、Three 一律 npm 本地打包；模型权重本地目录。
- **依赖锁定**：`package-lock.json` 提交，`npm ci` 安装；Python 侧 `pip freeze > env/requirements.lock`。
- **双机一致**：任何一台机器改了依赖版本，必须同步更新 lock 文件并在另一台跑 M0 验证。
- **不改设计系统**：`tokens.css` / `base.css` 只消费不修改。
- **静态优先**：不引入任何后端；重建全部离线完成。
- **单文件 demo 优先**：`SplatViewer.tsx` 必须能独立运行，再考虑集成。

## 6. 风险清单（按发生概率 × 影响排序）

| # | 风险 | 说明 | 对策 |
|---|---|---|---|
| R1 | **Blackwell 架构与 AnySplat 固定的 PyTorch 版本冲突** | 官方 README 固定 `torch==2.2.0 + cu121`；5090/5080 都是 Blackwell（sm_120），旧版 PyTorch 没有对应 CUDA 内核，会报 "no kernel image" 或直接跑不起来。**两台机器同样受影响。** | 动手前先查 PyTorch 官方页面当前支持 sm_120 的最低版本（应为 2.7+/CUDA 12.8+），用该版本建环境，再逐个解决 API 变动。这是第一个要验证的点，先在笔记本上打通。 |
| R2 | **gsplat CUDA 扩展编译失败** | AnySplat 依赖 `gsplat`（Nerfstudio 的 CUDA 光栅化库），需本机编译；Windows 原生极易失败。 | Python 侧全部在 **WSL2 Ubuntu** 内进行；先装匹配的 CUDA toolkit 再 `pip install gsplat`。两台各编一次。 |
| R3 | **权重下载被墙/超时** | `from_pretrained("lhjiang/anysplat")` 默认从 HuggingFace 拉取。 | 手动下载到 `pipeline/models/anysplat/`，代码改本地路径；与既有权重自托管做法一致。 |
| R4 | **许可证** | AnySplat 代码为 MIT，但其几何先验蒸馏自 Meta 的 VGGT；VGGT 权重的商用条款需自行核对原始 LICENSE。 | 做客户项目前逐条核对。**未核实前不要对客户承诺可商用。** |
| R5 | **显存不足** | 5080 的 16 GB 在 64 帧以上容易 OOM；5090 的 24 GB 余量更大但也不是无限。 | 见第 1 节显存分档表；参数走 config preset，脚本要优雅处理 OOM 并给出降档建议。 |
| R6 | **前馈结果有漂浮伪影 / 背景破洞** | 前馈模型对未观测区域会猜，绕拍不完整时明显。 | 采集时保证 360° 覆盖且相邻帧重叠 > 60%；严重时启用 M3 后优化。 |
| R7 | ~~**SOG 与 Spark 版本不匹配**~~ ✅ 2026-09-18 解除 | SOG 有 bundled / unbundled 两种形态。 | 输出 `.sog` 即 bundled 单文件（输出 `meta.json` 才是 unbundled）。Spark 2.2.0 进锁文件。已实跑：官方 butterfly 的 spz 与「本地 splat-transform 转出的 sog」渲染一致。 |
| R8 | ~~**坐标系翻转**~~ ✅ 2026-09-18 解除 | 3DGS 训练坐标系与 Three.js（Y 向上）不一致，常见整个场景倒置。 | 结论从相机位姿**读**出来而非试出来：45 个训练相机的 up 全是 (0,-1,0)，即世界坐标系 Y 朝下，绕 X 转 180° 扶正。`config` 的 `export.rotate: "180,0,0"`，M4 导出时一次性烤进资产，前端不做每帧转换。已肉眼确认朝向正确。 |
| R9 | **移动端性能** | 百万级高斯在手机上掉帧。 | 导出前过滤低不透明度高斯、球谐降到 1 阶或 0 阶；移动端 DPR 限到 1.5。 |
| R10 | **Node/Vite 版本漂移** | 换机后 build 结果不一致。 | 根目录 `.nvmrc`；始终 `npm ci`。 |
| R11 | **双机环境漂移（v2 新增）** | 两台各一套 CUDA/PyTorch/gsplat，小版本差异导致"这台能跑那台报错"，排查极耗时。 | 每台跑 M0 自检并把输出记进 `env/ENVIRONMENT.md`；出问题先 diff 两份输出。依赖只从 lock 文件安装。 |
| R12 | **笔记本降频（v2 新增）** | 5090 笔记本 TGP 在 95–150 W 之间由厂商配置，电池模式或散热受限时会大幅降频，同样的任务耗时可能翻倍。 | 重建任务必须插电、开性能模式、垫高散热；性能对比数据要注明当时的供电状态，否则没有可比性。 |

## 7. 推进顺序（每步完成后停下来汇报，再进下一步）

1. **笔记本环境验证** —— ✅ **2026-09-18 完成**（提交 `7290cc7`）。
   M0 三道硬性门全过：torch 2.8.0 在 5090 上 capability (12,0)、arch_list 含 sm_120；
   gsplat 1.5.3 本机编译 53 秒、含 backward 的光栅化通过；torch-scatter 的 PTX JIT
   与原生算子逐位一致。版本组合见 `pipeline/README.md`，自检输出见 `pipeline/env/ENVIRONMENT.md`。
2. **官方示例跑通** —— ✅ **2026-09-18 完成**（提交 `7290cc7`）。
   riverview（12 帧）：推理 1.7 秒、显存 6.82 GB、156 万高斯、scene scale 0.946，
   权重加载断言 missing/unexpected 均为空，PLY 各字段分布校验通过。
   只打了一个补丁（VGGT 不联网）；opacity 转 logit 在自己的脚本里做。
3. **最小 web 环境 + M4 导出** —— **2026-09-18 代码完成，差台式机上的实机确认**。
   工具链全部钉版本进 lock（`pipeline/package.json` 只有 splat-transform 3.4.2；
   `web/` 是 Vite 8 + React 19 + three 0.186 + Spark 2.2）。riverview 的 PLY → SOG 走通：
   101 MB → **16.00 MB**、3.4 秒；`SplatViewer.tsx` 类型检查和 `vite build` 都过。
   **这一步是在笔记本 5090 上做的**（M4/M5 都是 CPU/浏览器的活，CLAUDE.md M4 本就写明两台都能跑），
   代码和 lock 全部进 git。**渲染已在浏览器里实跑确认**（2026-09-18）：butterfly 的
   spz 和 sog 都正常，画面一致 → **R7 解除**；riverview 的两行包围盒一字不差，对账通过。
   **台式 5080 的 `npm ci` + 实机确认按决定先搁置**，补做那一次才算真正的双机验证（R11）。
4. **自采数据** —— ✅ **2026-09-18 完成**（提交 `c06b3e4`）。`media/test.mov`
   （1920×1080 / 60fps / 16 秒）走完 M1→M2→M4→M5：45 帧 → 200 万高斯 / 6.1 秒 /
   15.00 GB → 17.31 MB SOG → 浏览器里朝向正确、能看清室内结构。M3 未启用（可选）。
   **素材本身的教训**（下次拍要避开）：画面主体是大片无纹理白墙，3DGS 最难的情况 ——
   `fill_ratio` 88.7、`opacity` 中位 0.055，模型没把握就堆一堆半透明高斯，看起来雾蒙蒙；
   13 个窗口整段被丢、最大时间空洞 2.55 秒（绕一圈约 57° 没覆盖）；16:9 还白丢 44% 水平视场。
   **要拍有纹理的实物**（书架、桌面杂物、植物），画幅 1:1 或 4:3，慢一点匀速转。
5. **双机一致性检查**：同一份帧序列在两台上各跑一次 M2（台式用 64 帧 preset），
   比对高斯数量与 PSNR，差异过大说明环境不一致，回到 R11。
6. **单文件 demo 打磨**：相机限制、加载进度、错误提示。
7. **部署** —— **2026-09-18 本地验证完成，尚未上线**。配置与脚本三件套在
   `web/`：`nginx-sawtooth.conf`（站点配置）、`deploy.sh`（构建+rsync，默认 dry-run）、
   `verify-deploy.sh`（自检，本地和生产跑同一份）。本地 nginx 1.24 上自检 10 项全过，
   其中 **Range 返回 206 + Content-Range → 验收标准 4 达标**。
   首屏传输量 **18.53 MB**（代码 gzip 后仅 1.07 MB、字体 0.18 MB、`.sog` 17.3 MB），
   估算 4G 3 MB/s 约 6.2 秒。**瓶颈完全在 splat 资产，代码只占 6%** ——
   要压加载时间应该去减小 `.sog`，而不是折腾代码分包。
   **还差**：上线到 BT Panel，以及用手机在国内 4G 上实测（验收标准 3）。

## 8. 坑记录（症状 → 原因 → 修复；每遇到一个就追加，注明是哪台机器）

### RECON 机（笔记本 5090，WSL2 Ubuntu 24.04）— 2026-09-18

**坑 1：gsplat 编译报 `sh: 1: cicc: not found`，同时 `cuda_runtime.h: No such file`**
- 症状：`pip install gsplat==1.5.3` 在 14 秒内失败，ninja 日志里每个 .cu 目标都报 `cicc: not found`。
- 原因：conda-forge 把 CUDA 拆成两处，单独哪一处都不是完整的安装根 ——
  `$CONDA_PREFIX/bin/` 下是 nvcc 本体和 `nvcc.profile`，
  `$CONDA_PREFIX/targets/x86_64-linux/` 下才是 `include/`、`lib/`、`nvvm/`（cicc 和 libdevice）。
  nvcc 靠它旁边的 `nvcc.profile`（`TOP = $(_HERE_)/../$(_TARGET_DIR_)`）才知道去哪找 cicc 和头文件，
  而 `targets/x86_64-linux/bin/` 里只有一个指向 `../../../bin/nvcc` 的符号链接，**没有 nvcc.profile**。
  于是把 CUDA_HOME 指到 targets 时，torch 的 cpp_extension 调用 `$CUDA_HOME/bin/nvcc`，profile 不生效；
  而把 CUDA_HOME 指到 `$CONDA_PREFIX` 时，那里的 `include/` 里没有 `cuda_runtime.h`。
- 修复：`pipeline/scripts/00a_make_cuda_home.sh` 用符号链接拼出一个完整的 CUDA 根
  （`bin` → conda 主前缀，`include`/`lib64`/`nvvm`/`targets` → targets 目录），
  `CUDA_HOME` 指向它（默认 `~/gsvg/cuda-home`）。`activate.sh` 会自动创建并校验。

**坑 2：conda 会强行装 gcc 14.4，并把 nvcc 的 `-ccbin` 指向它**
- 症状：`conda install cuda-nvcc=12.8` 连带装了 `gcc_linux-64 14.4.0`，
  activate 时 `CC`/`CXX` 被改成 `x86_64-conda-linux-gnu-*`，`NVCC_PREPEND_FLAGS` 被追加 conda 的 ccbin。
- 原因：`cuda-nvcc_linux-64` 依赖 conda 自己的工具链，其 activate.d 脚本在环境变量之后执行，会覆盖手工设置。
- 修复：`pipeline/env/activate.sh` 显式压回系统 gcc-13（本项目的版本组合要求 gcc 13，gcc 14 未验证）；
  环境里另放一份 `activate.d/~~zz-sawtooth-toolchain.sh` 兜底（`~~` 的 ASCII 排序在 conda 自带脚本之后）。
  **不要**卸载 conda 的 gcc 14，它是 nvcc 的依赖，卸了会连带卸掉 nvcc。

**坑 3：在 Windows 侧写 shell 脚本会带 CRLF，WSL 里报 `$'\r': command not found`**
- 症状：`source pipeline/env/activate.sh` 报 `set: -: invalid option` 和 `syntax error: unexpected end of file`。
- 原因：用 Python 文本模式在 Windows 上写文件，换行 `\n` 被自动转成 `\r\n`。
- 修复：已加根目录 `.gitattributes`（`*.sh text eol=lf` 等）；用 Python 写这类文件时必须传 `newline="\n"`。

**坑 5：显存超了却不报 OOM —— WSL 的系统内存回退会悄悄让速度腰斩**
- 症状：96 帧 @ 448² 时 `torch.cuda.max_memory_allocated()` 报 28.8 GB，而这张卡只有 23.9 GB，
  但程序没有抛 `OutOfMemoryError`；只是耗时从 64 帧的 9.4 秒跳到 20.3 秒。
- 原因：NVIDIA 的 Windows 驱动默认开启 system memory fallback，显存装不下的部分会退到系统内存，
  程序照跑，代价是走 PCIe 的访问延迟。所以**不能靠"有没有 OOM"来判断帧数上限**。
- 修复：帧数上限按实测的显存曲线定（见第 1 节表格），不要等 OOM；
  发现耗时突然翻倍就先怀疑是不是溢出到了系统内存。
- 影响：台式 5080（16 GB）按这条曲线只能跑到约 32 帧，CLAUDE.md 初稿写的 64 帧过于乐观，
  `dev-5080.yaml` 已据此下调。

**坑 4：WSL 里 `git clone https://github.com/...` 超时，但 codeload 可用**
- 症状：`git ls-remote https://github.com/InternRobotics/AnySplat.git` 60 秒无响应（exit 124）；
  github.com 的网页和 API 却能访问。
- 原因：WSL 是 NAT 模式且用不上 Windows 侧的代理，git 的 HTTPS 传输被卡住。
- 修复：改用 `https://codeload.github.com/<owner>/<repo>/tar.gz/<commit-sha>`（实测 3.7 MB/s），
  按 commit 固定后解压到 `~/gsvg/third_party/AnySplat`，补丁文件进 git。

### DEV 侧（M4 导出 / M5 网页）— 2026-09-18

这一节的坑与机器无关（纯 CPU / 浏览器），虽然是在笔记本 5090 上撞到的。

**坑 6：splat-transform 的 `--stats` 里，`mean` 和 `stdDev` 对需要解码的列是错的**
- 症状：对同一份 riverview.ply，`--stats json` 报 opacity 的 mean = 0.2711，
  而 `02_reconstruct.py` 和直接读 PLY 算出来都是 0.3353。`scale_1` 更离谱：
  报 stdDev = 173.368，而那一列的 max 才 0.00148，差五个量级。
- 原因：splat-transform 读 PLY 时会先把存储值解码（`opacity` 过 sigmoid、`scale` 过 exp），
  但它算的是 `decode(mean(raw))` 而不是 `mean(decode(raw))`。验证：
  `sigmoid(-0.9889) = 0.27112`，正是它报的那个数，而 -0.9889 就是 opacity 原始列的均值。
  `min`/`max`/`median` 在单调变换下保序，所以是对的；不需要解码的列（x/y/z）则五个量全对。
- 修复：`04_summary.mjs` 只取 `min`/`max`/`median`，不取 `mean`/`stdDev`。
- 附带结论（这条是好消息）：既然它确实做了解码，`-V opacity,gt,0.1` 的阈值就是人类可读的
  0~1，**不用换算成 logit**。已逐位验证：直接读 PLY 算 `sigmoid(raw) > 0.1` 得 1,020,468 个，
  与 `-V` 的输出完全相同。

**坑 7：GPU 适配器索引跨机不一致，不能写进配置**
- 症状：`splat-transform --list-gpus` 在这台笔记本上列出 `[0] Intel(R) Graphics`、
  `[1] NVIDIA GeForce RTX 5090 Laptop GPU`、`[2] Microsoft Basic Render Driver`。
  把 `-g 1` 写死，换台机器就可能选到核显或软件渲染。
- 修复：`04_export.sh` 跑一次 `--list-gpus`，按**名字**正则挑独显，挑不到就交给 splat-transform 自己选。

**坑 8：Vite 8 的 `manualChunks` 只认函数形式**
- 症状：`build.rollupOptions.output.manualChunks` 写成 `{ three: ['three'] }` 时
  `tsc --noEmit` 报 `TS2769 ... 'three' does not exist in type 'ManualChunksFunction'`。
- 修复：改成 `manualChunks(id) { if (id.includes('node_modules/three')) return 'three'; ... }`。
- 遗留：改完能编译，但**分包并没有真正生效**——`three` chunk 只有 19.8 kB，`spark` 有 3.0 MB，
  three 多半被并进了 spark 的 chunk（spark 依赖它）。不影响功能，M6 实测加载时间时再处理。

**坑 9：用 Bash 的 heredoc 写长 TSX 文件会被 shell 解析卡住**
- 症状：`cat > SplatViewer.tsx <<'TSX'` 写一个 300 行、含大量单引号和模板字符串的文件时，
  报 `unexpected EOF while looking for matching '`，文件没写成。短文件（< 150 行）没问题。
- 修复：这类文件直接用 Write 工具写，别走 heredoc。

**坑 10：从 Windows 调 `wsl.exe` 拿到的输出是 UTF-16，管道里全是乱码**
- 症状：`wsl -d Ubuntu -e bash -lc '...' | grep ...` 报 `Binary file (standard input) matches`，
  或者中文输出变成 ` ` 夹杂的乱码。
- 原因：wsl.exe 默认按 UTF-16LE 输出。
- 修复：命令前加 `WSL_UTF8=1`。这个仓库里所有跨 Windows / WSL 的调用都要带上。

**坑 11：WSL 的 `/tmp` 会在实例空闲回收后被清掉**
- 症状：上一条命令刚生成在 `/tmp` 的测试视频，下一条命令里就「输入不存在」。
- 原因：两次 `wsl -e` 之间 WSL 实例被回收重启，`/tmp` 是 tmpfs。
- 修复：跨命令要留存的中间文件放 `~/gsvg/` 之类的持久目录，别放 `/tmp`。

**坑 12：splat 加载成功、包围盒也对，画面却一片黑 —— 高斯小到亚像素被丢掉了**
- 症状：riverview.sog 在 viewer 里 `numSplats` 正常、包围盒和元数据一字不差，
  但默认取景下整个画面纯黑；滚轮拉近一半就出现了（很暗、片状、带大量拉丝伪影）。
- 排查（这条链子本身比结论更值得留）：
  1. 三段式资产链先排除渲染代码 —— butterfly 的 spz 和 sog 都正常，问题被夹在 riverview 这份数据上。
  2. 换独立渲染器交叉验证：`npx splat-transform riverview.ply out.html` 生成自带
     PlayCanvas viewer 的单文件 HTML，它渲染出的画面和 Spark **完全一致**（一个很暗的室内
     场景，沙发、书架、地毯可辨）。两个独立实现结果相同 → 数据没错，导出没错。
  3. 那就只剩取景。量一下：riverview 的 scale 中位数 0.0035，而场景半径 4.11；
     标准取景距离约 11，视口 1726 px、FOV 60° —— 单个高斯投影到屏幕约 **0.46 像素**。
- 原因：**高斯相对场景太小，远看时是亚像素，被渲染器丢掉**。butterfly 的高斯相对尺寸
  大得多，所以同样的代码它就没事。
- 修复：默认取景不再额外拉远（`zoom` 从 1.25 改回 1），方向也从「正面」改成斜上方 ——
  splat 场景的朝向是重建出来的、任意的，正对某个轴很容易正好撞在一堵墙上。
- 附带确认：riverview 画面暗是**场景本身如此**，不是颜色约定错了 ——
  输入 12 帧的平均亮度 0.148，而 PLY 里 f_dc 均值 0.144，两者吻合。

**坑 13：浏览器自动化环境里 FPS 读数和动画都不可信**
- 症状：HUD 显示 0~2 FPS，连 17 万高斯的 butterfly 也一样；用 JS 合成的 keydown 事件
  驱动不了 Spark 的 `FpsMovement`；相机 tween 点完预设机位后 camera.position 纹丝不动。
- 原因：浏览器对后台标签页会节流甚至完全暂停 `requestAnimationFrame`；合成事件的
  `isTrusted` 为 false，且键盘监听可能挂在别的目标上。
- 影响：**动画、帧率、键盘交互这三类必须人在前台窗口里亲自验证**，自动化只能验证到
  「UI 状态切换正确、资产加载正确、数值对账正确」这一层。
- 顺带修了个真 bug：`addKey` 在 tween 途中会记下半路上的位置，现在先让 tween 落位再记。

**坑 14：AnySplat 的 extrinsic 是 camera-to-world，而它依赖的 VGGT docstring 写的是 world-to-camera**
- 症状：按 docstring 的 w2c 公式（位置 = -Rᵀt、前向 = R 第 3 行）算出来的相机，
  有一部分落在场景包围盒**外面**，而且**背对着场景**看 —— 前端拿它当初始机位，一片黑。
- 原因：`vggt/utils/pose_enc.py` 的 docstring 确实写着「representing camera from world
  transformation」，但 AnySplat 在交给 decoder 之前已经转成了 c2w。三处铁证：
  `decoder_splatting_cuda.py:66` 写 `test_w2c_i = extrinsics[i].inverse()`（取逆才是 w2c）、
  `cuda_splatting.py:88` 同样 `extrinsics.inverse()`、`gaussian_adapter.py:72` 的变量
  直接叫 `c2w_rotations`。**以调用方的代码为准，别信上游库的 docstring。**
- 修复（c2w 下，矩阵的列就是相机各轴在世界中的方向）：
  位置 = 平移列；前向 = 第 3 列；上方向 = **负的**第 2 列（OpenCV 的 y 朝下）。
- 自检：改完之后 45 个相机**全部**落进场景包围盒内（改之前有跑到外面的），
  相邻相机位移中位数 0.049、连续无跳变。这个「相机该在场景里」的检查很便宜，值得每次都做。

**坑 15：config 里带引号的 YAML 标量会把引号一起传下去，而且不报错**
- 症状：`rotate: "180,0,0"` 经 `04_export.sh` 的 awk 取出来仍带引号，传给 splat-transform
  变成 `-r "180,0,0"`；下游 `Number('"180')` 得到 NaN，而 **NaN 是 falsy**，
  旋转分支被静默跳过 —— 不报错、不告警，只是不生效。
- 修复：`cfg_get` 里 `gsub(/^["']|["']$/, "", line)` 把引号剥掉。
- 自检：导出后对比 PLY 与 SOG 的包围盒 —— 绕 X 转 180° 后 y/z 应当取反并互换 min/max，
  相机 up 应当从 (0,-1,0) 变成 (0,1,0)。对不上就是没生效。

**坑 16：nginx 的 `gzip` 一旦作用到响应上，Range 请求就会失效**
- 这条把 M6 的两条要求连成了一件事：「`.sog` 不要 gzip」和「要支持 Range（验收标准 4）」
  并不是两个独立的配置项 —— 压缩过的响应 nginx 不会发 `Accept-Ranges`，也会拒绝 206。
- 所以 `location /splats/` 里的 `gzip off` 是**功能性**的，不只是省 CPU。
  `web/verify-deploy.sh` 把这两项连着测，就是为了防止哪天有人「顺手」把它打开。

**坑 17：`expires` 和 `add_header Cache-Control` 同时用，会发出两个 Cache-Control 头**
- 症状：`curl -I` 能看到两行 `Cache-Control`（一行来自 `expires` 自动生成，一行来自
  `add_header`）。不报错，浏览器也大致能work，但语义含糊、配置难 review。
- 修复：`expires off` 关掉自动生成，只留 `add_header`（`immutable` 也只能这么给）。
- 顺带：**nginx 静态文件本来就会发 `Accept-Ranges`**，再手动 `add_header` 同样会重复。

**坑 18：nginx 站点目录放在 `/home/<user>/` 下会 403**
- 原因：worker 以 `www-data` 身份跑，而 `/home/<user>` 默认权限 750，进不去。
  403 出现在最外层，很容易误以为是配置写错了。
- 修复：站点放 `/var/www/`（BT Panel 用的 `/www/wwwroot/` 同理）。

## 9. 明确不做的事

- 不做 4D / 动态场景（MoVieS、MoSca 属于 Step 2/3，另立文件）。
- 不重训 AnySplat。
- 不在台式机上重复搭完整 Python 重建环境（除非做 R11 一致性验证）。
- 不引入 WebGPU-only 的渲染库；目标是 WebGL2 覆盖。
- 不在浏览器内跑重建。
