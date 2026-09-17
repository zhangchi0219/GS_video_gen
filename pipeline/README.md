# pipeline —— 多帧 → 3DGS 重建侧

Python 侧全部跑在 **WSL2 Ubuntu 24.04** 里（风险 R2：gsplat 的 CUDA 扩展在 Windows 原生极易编译失败）。
主力机是笔记本 RTX 5090（24 GB）。台式 5080 平时**不需要**这套环境，只在做 R11 双机一致性验证时才装。

## 已验证的版本组合（2026-09-18，笔记本 5090）

| 组件 | 版本 | 说明 |
|---|---|---|
| 驱动（Windows） | 596.21 | WSL 内 `nvidia-smi` 可见，compute capability 12.0 |
| Ubuntu | 24.04.4（WSL2 内核 6.6.87.2） | apt 源换清华 |
| CUDA 编译器 | 12.8.93（conda-forge） | NVIDIA 的 apt 源只有约 1 MB/s，所以走 conda |
| host 编译器 | 系统 gcc/g++ **13**.3.0（apt） | 不用 conda 自带的 gcc 14.4，见 CLAUDE.md 坑 2 |
| Python | 3.12.14（Miniforge） | |
| torch | 2.8.0（PyPI 默认 wheel 即 cu128） | 从清华 PyPI 装，18 MB/s；不必走 download.pytorch.org |
| torchvision | 0.23.0 | |
| numpy | 1.26.4 | 必须 <2：colorspacious 用了 `np.row_stack` |
| gsplat | 1.5.3，本机源码编译 | `TORCH_CUDA_ARCH_LIST=12.0`，53 秒，内存峰值 5 GB |
| torch-scatter | 2.1.2+pt28cu128（PyG wheel） | 无 sm_120 原生内核，靠驱动 JIT PTX；已实测与原生算子逐位一致 |
| xformers | 0.0.32.post2（`--no-deps`） | 只被 import，不参与计算 |
| AnySplat | commit `5f5e208` | 用 codeload tar.gz 取，WSL 里 git clone 不通（坑 4） |
| 权重 | `lhjiang/anysplat` rev `d2e8c34` | sha256 `1c4de2ba…4c0c7c`，从 hf-mirror 下载 |

完整自检输出见 [env/ENVIRONMENT.md](env/ENVIRONMENT.md)（由 `00_check_env.py --report` 生成）。

## 从零搭一台机器

```bash
# 0. Windows 侧：插电、开性能模式（R12）；%USERPROFILE%\.wslconfig 写
#    [wsl2] / memory=48GB / swap=16GB，然后 wsl --shutdown
# 1. 系统包（用 root 跑，WSL 里 sudo 要密码）
wsl -d Ubuntu -u root -e bash -lc 'apt-get update && apt-get install -y \
    build-essential gcc-13 g++-13 ninja-build git wget curl ffmpeg'

# 2. Miniforge（清华镜像）
curl -L -o /tmp/Miniforge3.sh \
  https://mirrors.tuna.tsinghua.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Linux-x86_64.sh
bash /tmp/Miniforge3.sh -b -p "$HOME/miniforge3"
cat > "$HOME/.condarc" <<'EOF'
channels:
  - conda-forge
channel_alias: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud
show_channel_urls: true
EOF

# 3. conda 环境 + CUDA 12.8 编译器（只装编译需要的，运行时库由 torch 的 pip 包提供）
source "$HOME/miniforge3/etc/profile.d/conda.sh"
conda create -y -n sawtooth python=3.12
conda install -y -n sawtooth cuda-nvcc=12.8 cuda-cudart-dev=12.8 cuda-cccl=12.8 \
    cuda-driver-dev=12.8 cuda-profiler-api=12.8 cuda-version=12.8

# 4. pip 走清华源
mkdir -p ~/.config/pip && cat > ~/.config/pip/pip.conf <<'EOF'
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = pypi.tuna.tsinghua.edu.cn
timeout = 60
EOF

# 5. 之后所有命令都先激活（它会顺带拼好 CUDA_HOME 并压回 gcc-13）
cd /mnt/e/Github/GS_video_gen && source pipeline/env/activate.sh

# 6. torch（约 3 GB，含 nvidia-*-cu12 依赖，实测 11.5 分钟）
pip install -c pipeline/env/constraints.txt torch==2.8.0 torchvision==0.23.0

# 7. gsplat 本机编译（每台各编一次，产物不要跨机拷贝）
bash pipeline/scripts/00b_build_gsplat.sh        # OOM 就 MAX_JOBS=4 重跑

# 8. torch-scatter（AnySplat 的 voxelize 会调 scatter_max）
pip install -c pipeline/env/constraints.txt --only-binary=torch-scatter \
    "torch-scatter==2.1.2+pt28cu128" -f https://data.pyg.org/whl/torch-2.8.0+cu128.html

# 9. 其余依赖 + xformers
pip install -c pipeline/env/constraints.txt -r pipeline/env/requirements-m2.txt
pip install --no-deps xformers==0.0.32.post2

# 10. M0 自检：三道硬性门必须全过
python pipeline/scripts/00_check_env.py --report
```

AnySplat 源码、权重和补丁，一条命令搞定（都放 WSL 的 ext4，不要放 /mnt/e，那边 I/O 慢一个量级）：

```bash
bash pipeline/scripts/00c_fetch_anysplat.sh      # 源码 + 补丁 + 权重（校验 sha256）
# SKIP_WEIGHTS=1 bash pipeline/scripts/00c_fetch_anysplat.sh   # 权重已有时只更新源码
```

它固定 commit `5f5e208` 和权重 revision `d2e8c34`，用 codeload 的 tar.gz 而不是 git clone
（WSL 里 clone 不通，坑 4），解压后应用 `pipeline/patches/` 下的补丁，最后校验
`model.safetensors` 的 sha256 必须是 `1c4de2ba…4c0c7c`。源码目录本身 gitignore，
只有补丁文件进 git。

目前只有一个补丁 `0001-vggt-no-network.patch`：AnySplat 的 encoder 在 `__init__` 里写死了
`VGGT.from_pretrained("facebook/VGGT-1B")`，会在运行时再联网拉一份约 5 GB 的权重（R3）。
改成 `VGGT()` 只取网络结构——那些参数随后会被 AnySplat 自己的 checkpoint 整体覆盖，
`02_reconstruct.py` 的 missing/unexpected 断言就是用来保证这一点的。

## 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/00_check_env.py` | M0 自检，三道硬性门；`--report` 写入 `env/ENVIRONMENT.md` |
| `scripts/00a_make_cuda_home.sh` | 拼出一个标准布局的 `CUDA_HOME`（conda 的 CUDA 分散在两处，见坑 1） |
| `scripts/00b_build_gsplat.sh` | 本机编译 gsplat，带内存采样日志 |
| `scripts/00c_fetch_anysplat.sh` | 取源码（固定 commit）+ 权重（固定 revision，校验 sha256）+ 打补丁 |
| `scripts/02_reconstruct.py` | M2 前馈重建：帧目录 → PLY + 统计 JSON，含 OOM 降档建议 |
| `scripts/02b_inspect_ply.py` | 交给 splat-transform 之前检查 PLY 各字段的取值分布 |
| `patches/*.patch` | 对 AnySplat 源码的改动，由 `00c_fetch_anysplat.sh` 应用 |
| `env/activate.sh` | **所有** Python 命令的入口，统一环境变量 |
| `env/constraints.txt` | 全局版本约束，每次 `pip install` 都要带 `-c` |
| `env/requirements-m2.txt` | M2 依赖（从 AnySplat 官方清单裁剪而来，逐条注明原因） |

## M2 实测结果（2026-09-18，笔记本 5090，交流电）

官方示例 `examples/vrnerf/riverview`（12 张 JPG）：

| 指标 | fp32 | bf16 |
|---|---|---|
| 推理耗时 | 1.89 s | 1.8 s |
| 显存峰值 | 6.82 GB | 6.06 GB |
| 高斯数量 | 1,559,959（voxelize 前 2,408,448，保留 64.8%） | 同 |
| PLY 大小 | 101 MB（只存 SH 的 DC 带） | 同 |
| scene scale | 0.946 | 同 |

两个用来判断"结果是否可信"的旁证：

- 加载权重时 **missing / unexpected 键均为空**。这一点必须断言：`hub mixin` 用 `strict=False`
  时键名不匹配会静默保留随机初始化，社区里出现过 scene scale 变成 0.086 的案例。
  本次 scene scale 是 0.946，属于正常量级。
- `02b_inspect_ply.py` 检查通过：opacity 反 sigmoid 回来是 0.335（与推理日志打印的 0.33549 吻合，
  说明 logit 转换没写反），四元数模长 1.0000，scale 在 log 空间，
  由 `f_dc` 推回的 RGB 均值 0.136 与输入图像中心裁剪后的平均亮度 0.148 相符
  （比值 0.88–0.94，所以画面偏暗是场景本身如此，不是颜色约定错了）。

### 球谐能量分布 → M4 可以降到 0 阶

模型是 sh_degree=4（25 个系数）。各 band 的系数个数不同（1/3/5/7/9），所以 RMS 只能看幅度，
要比大小得看能量占比（= 该 band 所有系数的平方和 ÷ 总平方和，脚本里带恒等式自检）：

| | band0 (DC) | band1 | band2 | band3 | band4 |
|---|---|---|---|---|---|
| RMS | 1.347 | 0.0515 | 0.0127 | 0.0022 | 0.0012 |
| 能量占比 | **99.516%** | 0.437% | 0.044% | 0.002% | 0.001% |

**DC 带占了 99.5% 的能量**，高阶几乎是噪声。所以 M4 里把球谐降到 0 阶（只留 DC）
几乎不会改变外观，却能显著减小文件——CLAUDE.md M4 / R9 里"球谐降到 1 阶或 0 阶"的选择，
按这份数据可以直接选 0 阶。也因此 M2 默认只导出 DC 带（`--save-all-sh` 可以导全部）。

### 显存 / 耗时曲线（bf16、448²）

24/48/64/96 帧是用 riverview 的 12 帧**重复拼出来的合成输入**，只有 12 帧那一行是真实场景。

| 帧数 | 耗时 | 显存峰值 | 高斯数 | voxelize 保留率 | 说明 |
|---|---|---|---|---|---|
| 12（真实） | 1.8 s | 6.1 GB | 1.56 M | 64.8% | |
| 24 | 2.9 s | 9.3 GB | 0.60 M | 12.5% | |
| 48 | 6.6 s | 15.8 GB | 0.99 M | — | 5080（16 GB）的天花板 |
| 64 | 9.4 s | 20.1 GB | 1.24 M | — | 5090 的默认档，余量约 3.8 GB |
| 96 | 20.3 s | 28.8 GB | 1.66 M | — | **超过物理显存**，靠系统内存回退才没 OOM，耗时翻倍 |

**这份数据哪些能迁移到真实场景，哪些不能**（别把整张表当成统一的"保守估计"用）：

- **显存和耗时**主要由帧数驱动（编码器的跨视角注意力），这部分应当可以迁移。
- **高斯数量完全不能迁移**。注意 24 帧只有 0.60 M，比 12 帧的 1.56 M 还少：重复帧生成的高斯
  在空间上完全重合，被体素化合并掉了，保留率从 64.8% 暴跌到 12.5%（pixel-wise 481 万 → 60 万），
  而 scene scale 几乎没变（0.946 → 0.933）。
- 因此**显存那一列对真实场景是偏低估的**：真实的 24 帧场景保留率若仍在 60% 上下，
  会有约 3 M 个高斯，而表里只有 0.60 M，与高斯数量相关的那部分显存会明显更高。
  真实数据到手后（第 4 步）必须重测这条曲线。

对照 CLAUDE.md 的验收标准 1（30～60 帧推理 < 2 分钟）：64 帧只用 9.4 秒，余量很大；
即便真实场景的高斯多几倍，耗时也远到不了 2 分钟。

## 注意事项

- **显存参数只在 `config/*.yaml` 里改**，脚本里不许硬编码（CLAUDE.md 第 1 节）。
- `max_frames` 默认 **64**，不是 CLAUDE.md 初稿写的 96：维护者说训练时视角数不超过 24、
  可用上限约 64，96 有质量风险，只作为实验档（`experimental_max_frames`）。
- 许可证（R4）：权重衍生自非商用的 VGGT-1B，`src/utils/image.py` 带 CC BY-NC-SA 文件头。
  **法务逐条核对前，不要对客户承诺可商用。**
- 重建任务必须插电 + 性能模式；性能数据要连同供电状态一起记（R12）。
