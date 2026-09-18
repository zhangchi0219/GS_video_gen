#!/usr/bin/env bash
# M4 压缩导出：3DGS PLY → bundled 单文件 .sog + 前端用的元数据 JSON。
#
# 纯 CPU/GPU 后处理，两台机器都能跑（CLAUDE.md §1）。依赖 pipeline/package.json
# 里钉死的 @playcanvas/splat-transform，用 `npm ci` 复现，**不要**全局安装
# （全局装的版本不受 lock 约束，换机就会悄悄漂移，违反 §5「依赖锁定」）。
#
# 用法:
#   bash scripts/04_export.sh --scene riverview
#   bash scripts/04_export.sh --scene riverview --min-opacity 0.1 --rotate -90,0,0
#
# 没在命令行给的选项，会去 config 的 export: 段找默认值（命令行优先）。
#
# 选项:
#   --config <path>       preset，默认 config/recon-5090.yaml。M4 是纯 CPU，两台机器的
#                         export 段内容相同，选哪个 preset 对结果没有影响。
#   --scene <name>        场景名，默认从 --ply 的文件名推断
#   --ply <path>          输入 PLY，默认 data/ply/<scene>.ply
#   --out-dir <dir>       输出目录，默认 data/sog
#   --min-opacity <0-1>   丢弃不透明度低于该值的高斯。**阈值是 sigmoid 之后的
#                         0~1 空间**（splat-transform 读 PLY 时已解码，不是 logit）。
#                         默认不过滤。R9 的移动端优化在这里做。
#   --sh-bands <0-3>      只保留 <= n 阶球谐。本项目 02_reconstruct.py 只写 DC
#                         （PLY 里没有 f_rest_*，band0 already 占 99.5% 能量），
#                         所以默认不传；输入换成别的管线时才用得上。
#   --rotate <x,y,z>      欧拉角修正（度），R8 的坐标系翻转在这里一次性解决，
#                         **不要**放到前端每帧转换。默认不旋转。
#   --translate <x,y,z>   平移，一般用不上。
#   --scale <f>           统一缩放，一般用不上。
#   --gpu <n|cpu>         SOG 压缩用的适配器。默认自动挑独显（见下）。
#   --sh-iterations <n>   SH 压缩迭代次数，默认 10（无 f_rest 时无意义）。
#   --keep-stats          保留中间的 stats JSON，便于排查。
#   --publish             同时把 .sog 和 .json 复制到 web/public/splats/，
#                         省得手工搬。二进制不进 git（见 .gitignore），JSON 进。
set -euo pipefail

cd "$(dirname "$0")/.."   # 切到 pipeline/，npx 要在这里才找得到本地 node_modules

CONFIG="config/recon-5090.yaml"
SCENE=""; PLY=""; OUT_DIR="data/sog"
MIN_OPACITY=""; SH_BANDS=""; ROTATE=""; TRANSLATE=""; SCALE=""
GPU=""; SH_ITER=""; KEEP_STATS=0; PUBLISH=0

die() { echo "错误: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)        CONFIG="$2"; shift 2 ;;
    --scene)         SCENE="$2"; shift 2 ;;
    --ply)           PLY="$2"; shift 2 ;;
    --out-dir)       OUT_DIR="$2"; shift 2 ;;
    --min-opacity)   MIN_OPACITY="$2"; shift 2 ;;
    --sh-bands)      SH_BANDS="$2"; shift 2 ;;
    --rotate)        ROTATE="$2"; shift 2 ;;
    --translate)     TRANSLATE="$2"; shift 2 ;;
    --scale)         SCALE="$2"; shift 2 ;;
    --gpu)           GPU="$2"; shift 2 ;;
    --sh-iterations) SH_ITER="$2"; shift 2 ;;
    --keep-stats)    KEEP_STATS=1; shift ;;
    --publish)       PUBLISH=1; shift ;;
    -h|--help)       awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *)               die "未知参数 $1（-h 看用法）" ;;
  esac
done

# config 是我们自己维护的、结构固定的 YAML，所以这里用 awk 取标量就够了，
# 不引入 YAML 解析依赖 —— M4 也可能在 Windows 的 git bash 里跑，那边没有 PyYAML。
# 取不到、或值是 null / ~ 时一律返回空串，交给下面的「空则不加这个 action」逻辑。
cfg_get() {
  [[ -f "$CONFIG" ]] || return 0
  awk -v sec="$1:" -v key="$2:" '
    /^[^[:space:]#]/ { insec = ($1 == sec) }
    insec && $1 == key {
      line = $0
      sub(/^[[:space:]]*[^:]*:[[:space:]]*/, "", line)
      sub(/[[:space:]]*#.*$/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      # YAML 里带引号的标量（比如 rotate: "180,0,0"）要把引号剥掉，
      # 否则值里混着引号传下去，Number("\"180") 得到 NaN 而 NaN 是 falsy，
      # 旋转会被静默跳过 —— 不报错，只是不生效。
      gsub(/^["'"'"']|["'"'"']$/, "", line)
      if (line == "null" || line == "~") line = ""
      print line
      exit
    }
  ' "$CONFIG"
}

# 命令行没给的，才去 config 拿
[[ -z "$MIN_OPACITY" ]] && MIN_OPACITY="$(cfg_get export opacity_threshold)"
[[ -z "$SH_BANDS"    ]] && SH_BANDS="$(cfg_get export sh_degree)"
[[ -z "$ROTATE"      ]] && ROTATE="$(cfg_get export rotate)"

[[ -z "$SCENE" && -n "$PLY" ]] && SCENE="$(basename "$PLY" .ply)"
[[ -z "$SCENE" ]] && die "必须给 --scene 或 --ply"
[[ -z "$PLY" ]] && PLY="data/ply/${SCENE}.ply"
[[ -f "$PLY" ]] || die "找不到输入 PLY: $PLY"

[[ -d node_modules/@playcanvas/splat-transform ]] || \
  die "splat-transform 没装。先在 pipeline/ 下跑 npm ci"

# GPU 适配器索引**跨机不一致**（这台笔记本上 [0] 是 Intel 核显、[1] 才是 5090），
# 所以不能把数字写进 config，按名字挑独显才能两台机器行为一致。
if [[ -z "$GPU" ]]; then
  GPU="$(npx splat-transform --list-gpus 2>/dev/null \
         | grep -iE '^\[[0-9]+\] .*(NVIDIA|AMD Radeon|Intel\(R\) Arc)' \
         | head -1 | sed -E 's/^\[([0-9]+)\].*/\1/' || true)"
  if [[ -n "$GPU" ]]; then
    echo "自动选中 GPU 适配器 [$GPU]"
  else
    echo "没找到独立 GPU，交给 splat-transform 自行选择"
  fi
fi

mkdir -p "$OUT_DIR"
SOG="${OUT_DIR}/${SCENE}.sog"
META="${OUT_DIR}/${SCENE}.json"
STATS_TMP="${OUT_DIR}/.${SCENE}.stats.json"

# ACTIONS 的顺序就是执行顺序：先剔废高斯再做几何变换，省一点计算。
ACTIONS=(-N)                      # 总是先滤 NaN/Inf/零模四元数，成本低、能防脏数据
[[ -n "$MIN_OPACITY" ]] && ACTIONS+=(-V "opacity,gt,${MIN_OPACITY}")
[[ -n "$SH_BANDS"    ]] && ACTIONS+=(-H "$SH_BANDS")
[[ -n "$TRANSLATE"   ]] && ACTIONS+=(-t "$TRANSLATE")
[[ -n "$ROTATE"      ]] && ACTIONS+=(-r "$ROTATE")
[[ -n "$SCALE"       ]] && ACTIONS+=(-s "$SCALE")

GLOBAL=(--no-tty --memory -w)
[[ -n "$GPU"     ]] && GLOBAL+=(-g "$GPU")
[[ -n "$SH_ITER" ]] && GLOBAL+=(-i "$SH_ITER")

echo "preset : $CONFIG"
echo "输入   : $PLY ($(du -h "$PLY" | cut -f1))"
echo "动作   : ${ACTIONS[*]}"
echo "输出   : $SOG"
echo

START=$(date +%s.%N)
npx splat-transform "${GLOBAL[@]}" "$PLY" "${ACTIONS[@]}" "$SOG"
ELAPSED=$(awk -v a="$START" -v b="$(date +%s.%N)" 'BEGIN{printf "%.2f", b-a}')

# 统计跑在**输出的 .sog** 上，这样元数据反映的是前端真正加载的那份资产
# （有损压缩后包围盒会有微小变化），而不是源 PLY。
npx splat-transform -q --no-tty "$SOG" --stats json null > "$STATS_TMP"

SOG_BYTES=$(stat -c%s "$SOG")
# 注意：splat-transform 把版本号打到 stderr，不能 2>/dev/null。
ST_VER=$(npx splat-transform --version 2>&1 | head -1)

node scripts/04_summary.mjs "$STATS_TMP" "$META" \
  "scene=${SCENE}" \
  "source_ply=$(basename "$PLY")" \
  "machine=${SAWTOOTH_MACHINE:-$(hostname)}" \
  "timestamp=$(date +%Y-%m-%dT%H:%M:%S)" \
  "splat_transform=${ST_VER}" \
  "actions=${ACTIONS[*]}"   "config=$(basename "$CONFIG")"   "merge_from=${PLY%.ply}.json"   "rotate_applied=${ROTATE}" \
  "sog_bytes=${SOG_BYTES}" \
  "sog_mb=$(awk -v s="$SOG_BYTES" 'BEGIN{printf "%.2f", s/1048576}')" \
  "export_seconds=${ELAPSED}" > /dev/null

[[ $KEEP_STATS -eq 1 ]] || rm -f "$STATS_TMP"

if [[ $PUBLISH -eq 1 ]]; then
  WEB_DIR="../web/public/splats"
  mkdir -p "$WEB_DIR"
  cp "$SOG" "$META" "$WEB_DIR/"
  echo "已复制到 $WEB_DIR/"
fi

echo
echo "完成: $SOG  $(awk -v s="$SOG_BYTES" 'BEGIN{printf "%.2f MB", s/1048576}')  用时 ${ELAPSED}s"
echo "元数据: $META"
awk -v s="$SOG_BYTES" 'BEGIN{ if (s > 30*1048576) print "\n⚠ 超过 CLAUDE.md §0 验收标准的 30 MB 上限，考虑 --min-opacity 或 --sh-bands 降档" }'
