#!/usr/bin/env bash
# 在本机编译 gsplat 的 CUDA 扩展（CLAUDE.md M0 / 风险 R2）。
#
# 为什么要有这个脚本：gsplat 的 CUDA 光栅化扩展必须在每台机器上各自编译一次，
# 编译产物（.so）不要跨机拷贝。两台机器都是 sm_120，但 CUDA/驱动/glibc 的小版本
# 差异会让拷来的 .so 出现难排查的问题。
#
# 用法：
#   bash pipeline/scripts/00b_build_gsplat.sh            # 默认 MAX_JOBS=12
#   MAX_JOBS=4 bash pipeline/scripts/00b_build_gsplat.sh # 编译进程被 OOM 杀掉时降档
#
# 产物与日志：
#   pipeline/data/gsplat-build.log      完整编译日志（已 gitignore）
#   pipeline/data/gsplat-build-mem.log  每 15 秒一条的内存/负载采样，用来定 MAX_JOBS
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck disable=SC1091
source pipeline/env/activate.sh

GSPLAT_VERSION="${GSPLAT_VERSION:-1.5.3}"
export MAX_JOBS="${MAX_JOBS:-12}"

mkdir -p pipeline/data
LOG=pipeline/data/gsplat-build.log
MEMLOG=pipeline/data/gsplat-build-mem.log

echo "=== 编译前环境 ==="
echo "gsplat 目标版本 : $GSPLAT_VERSION"
echo "MAX_JOBS        : $MAX_JOBS"
echo "TORCH_CUDA_ARCH_LIST : ${TORCH_CUDA_ARCH_LIST:-<未设置>}"
echo "CUDA_HOME       : ${CUDA_HOME:-<未设置>}"
echo "host 编译器     : ${CXX:-g++} $("${CXX:-g++}" -dumpversion 2>/dev/null)"
echo "nvcc            : $(nvcc --version | sed -n 's/.*release \([0-9.]*\).*/\1/p' | tr -d '\n')"
echo "内存 / 核数     : $(free -g | awk '/^Mem:/{print $2}') GB / $(nproc) 核"
echo

# 后台采样内存与负载：编译被 OOM 杀掉时，用这份日志决定 MAX_JOBS 降到多少
(
  while true; do
    printf '%s used=%sGB avail=%sGB load=%s\n' \
      "$(date +%T)" \
      "$(free -g | awk '/^Mem:/{print $3}')" \
      "$(free -g | awk '/^Mem:/{print $7}')" \
      "$(cut -d' ' -f1 /proc/loadavg)"
    sleep 15
  done
) > "$MEMLOG" 2>&1 &
SAMPLER_PID=$!
trap 'kill "$SAMPLER_PID" 2>/dev/null || true' EXIT

START=$(date +%s)
# --no-build-isolation：用当前环境里已经装好的 torch 来编，否则 pip 会在隔离环境里
#                       重新装一个不带 CUDA 的 torch，编出来的扩展没有 sm_120 内核。
# --no-binary=gsplat  ：强制走源码包（AOT 预编译），不要 PyPI 上按别的 torch 版本编的 wheel。
# --no-cache-dir      ：避免把上一次失败的构建结果缓存下来复用。
python -m pip install -v \
  -c pipeline/env/constraints.txt \
  --no-build-isolation \
  --no-binary=gsplat \
  --no-cache-dir \
  "gsplat==$GSPLAT_VERSION" > "$LOG" 2>&1
RC=$?
ELAPSED=$(( $(date +%s) - START ))

kill "$SAMPLER_PID" 2>/dev/null || true
echo "=== 编译结束：exit=$RC 耗时=${ELAPSED}s ($((ELAPSED / 60))m$((ELAPSED % 60))s) ==="
echo "--- 日志尾部 ---"
tail -n 12 "$LOG"
echo "--- 内存峰值（used 最大的一条采样）---"
sort -t= -k2 -n "$MEMLOG" 2>/dev/null | tail -n 1

if [ "$RC" -ne 0 ]; then
  echo
  echo "编译失败。常见原因："
  echo "  1) 进程被 OOM 杀掉（日志里出现 Killed / signal 9）→ 用 MAX_JOBS=4 或 2 重跑。"
  echo "  2) host 编译器不是 gcc-13 → 检查 activate.sh 是否被 conda 的 activate.d 覆盖。"
  echo "  3) 找不到 cuda_runtime.h → CUDA_HOME 必须指向 \$CONDA_PREFIX/targets/x86_64-linux。"
  echo "完整日志：$LOG"
  exit "$RC"
fi

echo
echo "=== 确认装的是本机编译的产物，而不是 JIT 后备路径 ==="
python - <<'PY'
import gsplat
print("gsplat", gsplat.__version__)
try:
    from gsplat import csrc
    print("扩展:", csrc.__file__)
except Exception as exc:  # noqa: BLE001
    print("无法 import gsplat.csrc:", exc)
PY
echo
echo "下一步：python pipeline/scripts/00_check_env.py --report"
