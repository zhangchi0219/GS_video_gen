#!/usr/bin/env bash
# 本项目所有 Python 命令的唯一入口：source 这个脚本再干活。
#   source pipeline/env/activate.sh
#
# 为什么需要它（双机一致性 R11）：
#   conda 把 gcc 14.4 作为 cuda-nvcc_linux-64 的依赖装进了环境，并用 activate.d 脚本
#   把 CC/CXX/NVCC 的 -ccbin 指向 conda 自己的工具链。本项目要求 gcc 13
#   （gsplat 1.5.3 的实跑记录都是 gcc 13，gcc 14 未验证），所以这里显式压回系统 gcc-13。
#   环境里另有一份同内容的 activate.d/~~zz-sawtooth-toolchain.sh 作为兜底，
#   但那份不在 git 里；换机时以本文件为准。
set -u
: "${SAWTOOTH_CONDA_ENV:=sawtooth}"
: "${SAWTOOTH_CONDA_ROOT:=$HOME/miniforge3}"

# shellcheck disable=SC1091
source "$SAWTOOTH_CONDA_ROOT/etc/profile.d/conda.sh"
conda activate "$SAWTOOTH_CONDA_ENV"

# CUDA 根目录用 00a_make_cuda_home.sh 拼出来的聚合目录：
# conda 把 nvcc/nvcc.profile 放在 $CONDA_PREFIX/bin，而头文件、库和 cicc 放在
# $CONDA_PREFIX/targets/x86_64-linux，两边单独拿出来都不是完整的 CUDA 安装根
# （详见那个脚本开头的注释，以及 CLAUDE.md 第 8 节的坑记录）。
export CUDA_HOME="${SAWTOOTH_CUDA_HOME:-$HOME/gsvg/cuda-home}"
if [ ! -e "$CUDA_HOME/bin/nvcc" ] || [ ! -e "$CUDA_HOME/include/cuda_runtime.h" ]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/../scripts/00a_make_cuda_home.sh"
fi
export NVCC_PREPEND_FLAGS="-ccbin=/usr/bin/g++-13"
export CC=/usr/bin/gcc-13
export CXX=/usr/bin/g++-13
export TORCH_CUDA_ARCH_LIST=12.0   # sm_120 = Blackwell（5090 / 5080 同架构）
export CUDAARCHS=120
# 不要设 LD_LIBRARY_PATH：torch 的运行时库靠 wheel 里的 RPATH 定位，
# 手工插入 conda 的 lib 或 stubs 会让它加载到错误的 cudart/libcuda。
set +u
