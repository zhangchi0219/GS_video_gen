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
但**高斯数量完全不能迁移**（24 帧的 voxelize 保留率只有 12.5%，而 12 帧是 64.8%），
所以显存那一列对真实场景是**偏低估**的，拿到自采数据后（第 4 步）必须重测。

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
- 输入：手机视频（建议 4K30，绕物体/场景一圈，10～20 秒），或一组 JPG。
- 处理：ffmpeg 按固定间隔抽帧；用拉普拉斯方差剔除模糊帧；统一 resize 到长边 1024。
- 帧数上限读 config 的 `max_frames`（5090 preset = 96，5080 preset = 64）。
- 输出：`data/frames/<scene>/000.jpg …`
- 术语：**拉普拉斯方差**——对图像做二阶导数，方差越小说明边缘越少、越糊，是最简单的模糊检测。

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
- 用 `@playcanvas/splat-transform`（MIT，`npm install -g @playcanvas/splat-transform`）把 PLY 转 `.sog`。
- 同时输出 `--summary` 统计（高斯数量、包围盒）写进 `data/sog/<scene>.json`，供前端定相机初始位置。
- 坐标系修正、球谐降阶、低不透明度过滤都在这一步用 splat-transform 的 action 做完。
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
| R7 | **SOG 与 Spark 版本不匹配** | SOG 有 bundled / unbundled 两种形态。 | 输出 bundled `.sog`；Spark 固定到当时 npm 最新稳定版并写进锁文件；先用官方示例 `.sog` 验证再换自己的。 |
| R8 | **坐标系翻转** | 3DGS 训练坐标系与 Three.js（Y 向上）不一致，常见整个场景倒置。 | 在 M4 导出阶段用 `--rotate` 一次性修正，不在前端每帧转换。 |
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
3. **台式机最小环境** —— ⬅️ **下一步**。只装 Node + splat-transform；PLY → SOG → 用 Spark 官方 getting-started 示例
   （改为本地 npm 依赖）加载验证。
4. **自采数据**：拍一段 15 秒视频，笔记本走 M1→M3，台式走 M4→M5。
5. **双机一致性检查**：同一份帧序列在两台上各跑一次 M2（台式用 64 帧 preset），
   比对高斯数量与 PSNR，差异过大说明环境不一致，回到 R11。
6. **单文件 demo 打磨**：相机限制、加载进度、错误提示。
7. **部署**：BT Panel 静态目录 + Nginx 配置，国内 4G 网络实测加载时间。

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

## 9. 明确不做的事

- 不做 4D / 动态场景（MoVieS、MoSca 属于 Step 2/3，另立文件）。
- 不重训 AnySplat。
- 不在台式机上重复搭完整 Python 重建环境（除非做 R11 一致性验证）。
- 不引入 WebGPU-only 的渲染库；目标是 WebGL2 覆盖。
- 不在浏览器内跑重建。
