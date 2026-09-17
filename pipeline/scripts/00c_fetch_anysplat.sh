#!/usr/bin/env bash
# 取 AnySplat 源码（固定 commit）+ 权重（固定 revision）+ 应用本项目的补丁。
#
# 为什么不用 git submodule：WSL 里 `git clone https://github.com/...` 会超时
# （NAT 模式用不上 Windows 侧的代理，CLAUDE.md 坑 4），而 codeload 的 tar.gz 能跑到 3.7 MB/s。
# 所以源码目录本身 gitignore，只把补丁文件和这个脚本提交进 git。
#
# 用法：
#   bash pipeline/scripts/00c_fetch_anysplat.sh              # 源码 + 补丁 + 权重
#   SKIP_WEIGHTS=1 bash pipeline/scripts/00c_fetch_anysplat.sh   # 只要源码
set -euo pipefail

# 固定版本（改这里之前先确认补丁还能干净应用）
ANYSPLAT_SHA="${ANYSPLAT_SHA:-5f5e208a7dd57d52e43ea0d553a95eab526e8775}"
WEIGHTS_REPO="${WEIGHTS_REPO:-lhjiang/anysplat}"
WEIGHTS_REV="${WEIGHTS_REV:-d2e8c343672646041ad4ea518184968f94362f01}"
WEIGHTS_SHA256="1c4de2ba5a29c540b899af901bf02107395b5f0617655d347e262f814b4c0c7c"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="${SAWTOOTH_ANYSPLAT_SRC:-$HOME/gsvg/third_party/AnySplat}"
MODEL_DIR="${SAWTOOTH_MODEL_DIR:-$HOME/gsvg/models/anysplat}"
# 不要用 /tmp：WSL 里 /tmp 会被清理，缓存留不住
CACHE_DIR="$HOME/gsvg/cache"
PATCH_DIR="$REPO_ROOT/pipeline/patches"

mkdir -p "$CACHE_DIR" "$SRC_DIR" "$MODEL_DIR"

TARBALL="$CACHE_DIR/anysplat-$ANYSPLAT_SHA.tar.gz"
if [ ! -f "$TARBALL" ]; then
  echo "=== 下载源码 commit $ANYSPLAT_SHA ==="
  curl -L --fail --max-time 600 -o "$TARBALL" \
    "https://codeload.github.com/InternRobotics/AnySplat/tar.gz/$ANYSPLAT_SHA"
fi
echo "tar.gz: $(du -h "$TARBALL" | cut -f1)"

# 干净解压：残留的旧文件会让补丁应用结果变得不可预测
if [ -n "$(ls -A "$SRC_DIR" 2>/dev/null)" ]; then
  echo "=== $SRC_DIR 非空，先清空（只删解压出来的东西，目录本身保留）==="
  find "$SRC_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
fi
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
echo "解压完成：$(find "$SRC_DIR" -type f | wc -l) 个文件"

echo "=== 应用补丁 ==="
shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
if [ ${#patches[@]} -eq 0 ]; then
  echo "（$PATCH_DIR 下没有补丁）"
else
  for p in "${patches[@]}"; do
    echo "--- $(basename "$p")"
    # --forward：已经打过的补丁不要反向应用；失败就停下，不要带着半套补丁往下走
    patch -p1 -d "$SRC_DIR" --forward < "$p"
  done
fi

if [ "${SKIP_WEIGHTS:-0}" = "1" ]; then
  echo "=== 跳过权重下载（SKIP_WEIGHTS=1）==="
  exit 0
fi

if [ -f "$MODEL_DIR/model.safetensors" ] && \
   [ "$(sha256sum "$MODEL_DIR/model.safetensors" | cut -d' ' -f1)" = "$WEIGHTS_SHA256" ]; then
  echo "=== 权重已就位且校验通过，跳过下载 ==="
  exit 0
fi

echo "=== 下载权重 $WEIGHTS_REPO @ $WEIGHTS_REV（走 hf-mirror，huggingface.co 在国内不可达）==="
HF_ENDPOINT=https://hf-mirror.com python - "$WEIGHTS_REPO" "$WEIGHTS_REV" "$MODEL_DIR" <<'PY'
import sys
from huggingface_hub import snapshot_download
repo, rev, out = sys.argv[1], sys.argv[2], sys.argv[3]
print("下载到:", snapshot_download(repo, revision=rev, local_dir=out))
PY

got="$(sha256sum "$MODEL_DIR/model.safetensors" | cut -d' ' -f1)"
if [ "$got" != "$WEIGHTS_SHA256" ]; then
  echo "错误：权重 sha256 不匹配" >&2
  echo "  期望 $WEIGHTS_SHA256" >&2
  echo "  实际 $got" >&2
  exit 1
fi
echo "权重 sha256 校验通过"
echo
echo "下一步：python pipeline/scripts/02_reconstruct.py --frames-dir <帧目录> --out-ply <输出.ply>"
