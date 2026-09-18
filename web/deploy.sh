#!/usr/bin/env bash
# M6 部署：构建 + 同步到站点目录。
#
# 用法：
#   bash web/deploy.sh /var/www/sawtooth              # 先看要传什么（dry-run，不会动目标）
#   bash web/deploy.sh /var/www/sawtooth --go         # 真的传
#   bash web/deploy.sh user@host:/www/wwwroot/xxx --go
#
# 选项：
#   --go           真正执行（默认只 dry-run —— 往站点目录写是不可逆的，默认先看一眼）
#   --skip-build   跳过 vite build，直接同步现有的 dist/
#   --lean         只传主场景，把体积大的诊断参照留在本地（见下）
#
# 传完记得跑一次自检：bash web/verify-deploy.sh <站点URL>
set -euo pipefail

cd "$(dirname "$0")"

TARGET=""; GO=0; SKIP_BUILD=0; LEAN=0
for a in "$@"; do
  case "$a" in
    --go)         GO=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --lean)       LEAN=1 ;;
    -h|--help)    awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    -*)           echo "未知参数 $a（-h 看用法）" >&2; exit 2 ;;
    *)            TARGET="$a" ;;
  esac
done
[[ -z "$TARGET" ]] && { echo "要给一个目标目录，比如 /var/www/sawtooth 或 user@host:/www/wwwroot/xxx" >&2; exit 2; }

if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "== 构建 =="
  npm run build
  echo
fi
[[ -d dist ]] || { echo "没有 dist/，先跑 npm run build" >&2; exit 1; }

# 资产取舍：splat 文件是整个包的大头（代码 gzip 后才 1.1 MB，一个场景就 17 MB）。
# --lean 只留主场景和最小的那个官方参照 butterfly.spz —— 线上出问题时，
# 它能一眼分清是渲染挂了还是数据的锅（R7 的三段式诊断链，README 里有说明）。
EXCLUDES=()
if [[ $LEAN -eq 1 ]]; then
  EXCLUDES+=(--exclude 'splats/riverview.*' --exclude 'splats/butterfly.sog')
fi

echo "== 同步到 $TARGET =="
du -sh dist | sed 's/^/   本地 dist: /'
RSYNC=(rsync -av --delete "${EXCLUDES[@]}" dist/ "$TARGET/")
if [[ $GO -eq 0 ]]; then
  echo "   （dry-run，不会改动目标；确认无误后加 --go）"
  "${RSYNC[@]}" --dry-run | tail -25
  echo
  echo "以上是 dry-run。真正执行：bash web/deploy.sh $TARGET --go"
else
  "${RSYNC[@]}" | tail -25
  echo
  echo "同步完成。接着跑自检：bash web/verify-deploy.sh <站点URL>"
fi
