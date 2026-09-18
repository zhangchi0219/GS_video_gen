#!/usr/bin/env bash
# M6 部署自检：把 CLAUDE.md 对静态站点的几条硬要求逐条验掉。
#
# 用法：
#   bash web/verify-deploy.sh                          # 默认打本地 nginx
#   bash web/verify-deploy.sh https://example.com/xxx  # 上线后对生产跑同一份
#
# 检查项和它们各自的来处：
#   1. .sog 的 Content-Type 是 application/octet-stream        M6
#   2. .sog **没有**被 gzip                                     M6（内部已是 WebP，白费 CPU）
#   3. .sog 支持 Range（206 + Content-Range）                   验收标准 4，为 .RAD 流式预留
#      —— 2 和 3 是连着的：nginx 一旦 gzip 就会拒绝 Range
#   4. JS/CSS 有被 gzip
#   5. woff2 没有被 gzip（本来就是压缩格式）
#   6. index.html 不被缓存（否则重新部署后客户端还按旧 HTML 取旧资源）
#   7. 统计首屏实际传输量 —— 这个数字决定国内 4G 的加载时间
set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
pass=0; fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
head_of() { curl -sI -H 'Accept-Encoding: gzip, br' "$1" | tr -d '\r'; }
hval() { grep -i "^$2:" <<<"$1" | head -1 | cut -d' ' -f2-; }

echo "目标：$BASE"
echo

# 先从首页把带 hash 的资源名捞出来，免得写死
html=$(curl -s "$BASE/")
js=$(grep -o '[^"]*assets/[^"]*\.js' <<<"$html" | head -1 | sed 's|^\./||')
css=$(grep -o '[^"]*assets/[^"]*\.css' <<<"$html" | head -1 | sed 's|^\./||')
[[ -z "$js" ]] && { echo "取不到首页里的 JS 引用，先确认站点是否正常"; exit 1; }

# 站点里第一个 .sog（不写死场景名，换场景也能用）
sog=""
for cand in splats/test.sog splats/riverview.sog splats/butterfly.sog; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "$BASE/$cand")
  [[ "$code" == "206" || "$code" == "200" ]] && { sog="$cand"; break; }
done

echo "[1-3] splat 资产：$sog"
if [[ -n "$sog" ]]; then
  h=$(head_of "$BASE/$sog")
  ct=$(hval "$h" content-type); ce=$(hval "$h" content-encoding)
  [[ "$ct" == application/octet-stream* ]] && ok "Content-Type: $ct" || bad "Content-Type 是 '$ct'，应为 application/octet-stream"
  [[ -z "$ce" ]] && ok "没有被 gzip（Content-Encoding 为空）" || bad "被压了：Content-Encoding: $ce —— Range 会因此失效"
  rh=$(curl -s -D- -o /dev/null -r 0-99 "$BASE/$sog" | tr -d '\r')
  if grep -qi '^HTTP/[0-9.]* 206' <<<"$rh"; then
    ok "Range 可用：$(grep -i '^content-range' <<<"$rh" | head -1)"
  else
    bad "Range 不可用（没拿到 206），验收标准 4 不达标"
  fi
else
  bad "站点里没找到 .sog"
fi

echo "[4] 文本资源压缩"
for f in "$js" "$css"; do
  [[ -z "$f" ]] && continue
  ce=$(hval "$(head_of "$BASE/$f")" content-encoding)
  [[ -n "$ce" ]] && ok "$(basename "$f") → $ce" || bad "$(basename "$f") 没被压缩"
done

echo "[5] 字体"
# CSS 和字体都在 assets/ 下，所以 CSS 里写的是相对引用 url(./xxx.woff2)，
# 不带 assets/ 前缀 —— 按文件名抓，别按路径抓。
csstext=$(curl -s "$BASE/$css")
woffs=$(grep -o '[A-Za-z0-9_-]*\.woff2' <<<"$csstext" | sort -u)
if [[ -n "$woffs" ]]; then
  for w in $woffs; do
    ce=$(hval "$(head_of "$BASE/assets/$w")" content-encoding)
    [[ -z "$ce" ]] && ok "$w 没被重复压缩" || bad "$w 被 gzip 了（本来就是压缩格式）：$ce"
  done
else
  echo "  - CSS 里没引用 woff2，跳过"
fi

echo "[6] 入口缓存策略"
cc=$(hval "$(head_of "$BASE/")" cache-control)
grep -qi 'no-cache\|no-store\|max-age=0' <<<"$cc" && ok "index.html: $cc" || bad "index.html 被缓存了（$cc），重新部署后客户端会拿旧引用"
n=$(head_of "$BASE/" | grep -ci '^cache-control' || true)
[[ "$n" -le 1 ]] && ok "没有重复的 Cache-Control 头" || bad "有 $n 个 Cache-Control 头（expires 和 add_header 各生成了一份）"

echo
echo "[7] 首屏传输量（决定 4G 加载时间）"
total=0
for f in "" "$css" "$js"; do
  b=$(curl -s -o /dev/null -H 'Accept-Encoding: gzip, br' -w '%{size_download}' "$BASE/$f")
  total=$((total+b))
  printf '  %-46s %8.1f KB\n' "${f:-index.html}" "$(awk -v x="$b" 'BEGIN{print x/1024}')"
done
# 首屏还要算上：首页里其余的 JS chunk，以及 CSS 引用的三个字体。
# 字体的 unicode-range 限的是 Latin，而页面上有英文标题，所以它们首屏一定会被下载。
for f in $(grep -o '[A-Za-z0-9_-]*\.js' <<<"$html" | sort -u) $woffs; do
  [[ "assets/$f" == "$js" ]] && continue
  b=$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$BASE/assets/$f")
  [[ "$b" -eq 0 ]] && continue
  total=$((total+b))
  printf '  %-46s %8.1f KB\n' "$f" "$(awk -v x="$b" 'BEGIN{print x/1024}')"
done
if [[ -n "$sog" ]]; then
  b=$(curl -s -o /dev/null -w '%{size_download}' "$BASE/$sog")
  total=$((total+b))
  printf '  %-46s %8.1f KB\n' "$sog" "$(awk -v x="$b" 'BEGIN{print x/1024}')"
fi
printf '  %-46s %8.2f MB\n' '合计' "$(awk -v x="$total" 'BEGIN{print x/1048576}')"
echo "  估算：4G 3 MB/s 约 $(awk -v x="$total" 'BEGIN{printf "%.1f", x/1048576/3}') 秒；1 MB/s 约 $(awk -v x="$total" 'BEGIN{printf "%.1f", x/1048576}') 秒"

echo
echo "通过 $pass 项，失败 $fail 项"
[[ $fail -eq 0 ]]
