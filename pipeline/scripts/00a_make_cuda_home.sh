#!/usr/bin/env bash
# 造一个"标准布局"的 CUDA_HOME 目录（全是符号链接，不占空间）。
#
# 为什么需要这一步（这是本项目踩到的第一个真坑，见 CLAUDE.md 第 8 节）：
#   conda-forge 的 CUDA 包把东西分成了两处，谁都不是完整的 CUDA 安装根：
#     $CONDA_PREFIX/bin/           nvcc 本体、nvcc.profile、ptxas、cudafe++、fatbinary
#     $CONDA_PREFIX/targets/x86_64-linux/{include,lib,nvvm}
#                                  头文件（cuda_runtime.h）、库、cicc 和 libdevice
#   nvcc 靠它旁边的 nvcc.profile 才知道去哪找 cicc 和头文件：
#     TOP = $(_HERE_)/../$(_TARGET_DIR_)   # _HERE_ 是 nvcc.profile 所在目录
#     CICC_PATH = $(TOP)/nvvm/bin ; INCLUDES += -I$(TOP)/include
#   而 targets/x86_64-linux/bin/ 下只有一个指向 ../../../bin/nvcc 的符号链接，
#   没有 nvcc.profile。于是：
#     CUDA_HOME=$CONDA_PREFIX/targets/x86_64-linux  →  torch 调 $CUDA_HOME/bin/nvcc，
#         profile 没被加载，报 "sh: 1: cicc: not found" 和 "cuda_runtime.h: No such file"
#     CUDA_HOME=$CONDA_PREFIX                       →  nvcc 正常，但 $CONDA_PREFIX/include
#         里没有 cuda_runtime.h，torch 传给 g++ 的 -I 是空的，编 .cpp 时可能再翻车
#   所以两边都不能直接用，这里把两处拼成一个完整的根。
#
# 用法：
#   source pipeline/env/activate.sh   # activate.sh 会自己调用本脚本，一般不用手动跑
#   bash pipeline/scripts/00a_make_cuda_home.sh --verify
set -eu

CUDA_HOME_DIR="${SAWTOOTH_CUDA_HOME:-$HOME/gsvg/cuda-home}"
VERIFY=0
[ "${1:-}" = "--verify" ] && VERIFY=1

if [ -z "${CONDA_PREFIX:-}" ]; then
  echo "错误：CONDA_PREFIX 没设。先 conda activate sawtooth 或 source pipeline/env/activate.sh" >&2
  exit 1
fi
TARGETS="$CONDA_PREFIX/targets/x86_64-linux"
if [ ! -x "$CONDA_PREFIX/bin/nvcc" ] || [ ! -f "$TARGETS/include/cuda_runtime.h" ]; then
  echo "错误：conda 环境里没有完整的 CUDA 12.8 编译器组件。请先执行：" >&2
  echo "  conda install -n sawtooth cuda-nvcc=12.8 cuda-cudart-dev=12.8 cuda-cccl=12.8 \\" >&2
  echo "      cuda-driver-dev=12.8 cuda-profiler-api=12.8 cuda-version=12.8" >&2
  exit 1
fi

mkdir -p "$CUDA_HOME_DIR"
# bin 指向 conda 主前缀：nvcc 必须和它的 nvcc.profile 待在一起
ln -sfn "$CONDA_PREFIX/bin"        "$CUDA_HOME_DIR/bin"
ln -sfn "$TARGETS/include"         "$CUDA_HOME_DIR/include"
# torch 的 cpp_extension 先找 lib64，找不到才退到 lib；两个都给，省得猜
ln -sfn "$TARGETS/lib"             "$CUDA_HOME_DIR/lib64"
ln -sfn "$TARGETS/lib"             "$CUDA_HOME_DIR/lib"
ln -sfn "$TARGETS/nvvm"            "$CUDA_HOME_DIR/nvvm"
# 这一条是给 nvcc.profile 用的：无论 nvcc 把 _HERE_ 解析成真实路径还是这里的链接路径，
# TOP = _HERE_/../targets/x86_64-linux 都能落到正确的地方
ln -sfn "$CONDA_PREFIX/targets"    "$CUDA_HOME_DIR/targets"

if [ "$VERIFY" = "1" ]; then
  echo "CUDA_HOME_DIR = $CUDA_HOME_DIR"
  ls -l "$CUDA_HOME_DIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/probe.cu" <<'CU'
#include <cuda_runtime.h>
#include <cstdio>
__global__ void k(float *o) { o[threadIdx.x] = threadIdx.x * 2.0f; }
int main() {
  float *d; float h[64];
  cudaMalloc(&d, sizeof(h));
  k<<<1, 64>>>(d);
  cudaMemcpy(h, d, sizeof(h), cudaMemcpyDeviceToHost);
  printf("sm_120 kernel: h[7]=%.1f err=%s\n", h[7], cudaGetErrorString(cudaGetLastError()));
  return 0;
}
CU
  # 刻意用 $CUDA_HOME/bin/nvcc 调用，这正是 torch 的 cpp_extension 的调用方式
  "$CUDA_HOME_DIR/bin/nvcc" -arch=sm_120 "$tmp/probe.cu" -o "$tmp/probe"
  "$tmp/probe"
  echo "验证通过：$CUDA_HOME_DIR 可以作为 CUDA_HOME 使用"
fi
