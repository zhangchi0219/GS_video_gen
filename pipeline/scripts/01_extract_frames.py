#!/usr/bin/env python3
"""M1：视频（或一组照片）→ 帧序列。

用法：
  source pipeline/env/activate.sh
  python pipeline/scripts/01_extract_frames.py \
      --scene mydesk --input pipeline/data/raw/mydesk.mp4

  # 输入也可以是一个图片目录
  python pipeline/scripts/01_extract_frames.py \
      --scene riverview --input ~/gsvg/third_party/AnySplat/examples/vrnerf/riverview

两个和直觉不同、但都有实测依据的设计：

1. **不做「全局排序丢掉最糊的 15%」，改成「窗口内选最清晰」。**
   绕拍时转得快的那一段系统性偏糊，全局排序会把整段弧一次性删掉，留下覆盖空洞 ——
   正是 CLAUDE.md R6 警告的那种情况（前馈模型对未观测区域只能瞎猜）。
   这里把时长切成 target_frames 个等长窗口，每个窗口里取拉普拉斯方差最大的那一帧：
   既保证时间/角度上均匀覆盖，又在每个位置上挑到最清楚的一张。
   剔除糊帧改用**地板阈值** `blur_floor_factor`：地板 = 全局候选清晰度的中位数 × 该系数，
   某窗口连最佳候选都低于地板，才算这段弧整段都糊，丢掉并告警。
   **不用分位数**：分位数是相对排名，分布再紧密也必定丢掉那个比例。实测 riverview 的
   12 张真实照片清晰度 166~199（全可用），15 分位地板会误杀最低的 2 张；换成中位数系数
   则一张不丢，而对真有糊段的素材照样能分开（见 config 注释里的两组实测数字）。

2. **默认把帧裁成正方形。**
   AnySplat 的 `src/utils/image.py::process_image` 是先把**短边**缩到 448、再中心裁 448×448。
   所以 16:9 的输入水平方向只剩 448 / (448 × 16/9) = 56%，左右各丢 22%；4:3 留 75%；1:1 不丢。
   与其让它盲裁，不如在这里可控地裁：模型拿到正方形后 crop 变成空操作、没有额外损失，
   而且中间文件就是模型的真实输入，能直接看见它到底看到了什么。
   主体偏向一侧时用 `--crop-center` 调裁剪窗口的位置（横构图调水平、竖构图调垂直，
   参数自动作用在被裁的那个轴上）。

术语：**拉普拉斯方差**——对图像做二阶导数，方差越小说明边缘越少、越糊，
是最简单也最常用的模糊检测指标。它对分辨率敏感，所以这里统一缩到同一尺寸再算分。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
VIDEO_SUFFIXES = (".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm")
# 打分前统一缩到这个短边：拉普拉斯方差随分辨率变化，不统一就没法横向比较。
SCORE_EDGE = 512


def log(msg: str) -> None:
    print(f"[{_dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[{_dt.datetime.now():%H:%M:%S}] ⚠ {msg}", flush=True)


def load_config(path: Path) -> dict:
    import yaml
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def expand(p) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p))))


def need(tool: str) -> str:
    exe = shutil.which(tool)
    if not exe:
        raise SystemExit(f"错误：找不到 {tool}。WSL 里装：sudo apt-get install -y ffmpeg")
    return exe


def probe_video(path: Path) -> dict:
    """用 ffprobe 取时长、帧率、分辨率。"""
    out = subprocess.run(
        [need("ffprobe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    if not data.get("streams"):
        raise SystemExit(f"错误：{path} 里没有视频流")
    st = data["streams"][0]
    num, _, den = st.get("r_frame_rate", "0/1").partition("/")
    fps = float(num) / float(den) if float(den or 0) else 0.0
    duration = float(data.get("format", {}).get("duration") or 0.0)
    return {
        "width": int(st["width"]),
        "height": int(st["height"]),
        "fps": fps,
        "duration": duration,
        "nb_frames": int(st["nb_frames"]) if str(st.get("nb_frames", "")).isdigit() else None,
    }


def build_vf(rate: float, crop: str, center: float, long_edge: int) -> str:
    """拼 ffmpeg 的 -vf。裁剪和缩放都交给 ffmpeg 一次做完，避免二次重采样。"""
    parts = [f"fps={rate:.6f}"]
    if crop == "square":
        # 滤镜参数里的逗号要转义，否则 ffmpeg 会当成参数分隔符。
        s = r"min(iw\,ih)"
        # x 和 y 用同一个公式：被裁的那个轴上 (边长-S) > 0，另一个轴上恰好是 0，
        # 所以不用判断横竖，center 自动作用在**实际被裁的**那个轴上。
        parts.append(f"crop={s}:{s}:(iw-{s})*{center}:(ih-{s})*{center}")
        parts.append(f"scale={long_edge}:{long_edge}")
    else:
        parts.append(
            f"scale='if(gt(iw,ih),{long_edge},-2)':'if(gt(iw,ih),-2,{long_edge})'"
        )
    return ",".join(parts)


def extract_candidates(video: Path, tmp_dir: Path, rate: float,
                       crop: str, center: float, long_edge: int) -> list[Path]:
    tmp_dir.mkdir(parents=True, exist_ok=True)
    cmd = [need("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
           "-i", str(video),
           "-vf", build_vf(rate, crop, center, long_edge),
           "-q:v", "2",          # JPEG 质量，2 是接近无损的一档
           "-fps_mode", "passthrough",
           str(tmp_dir / "cand_%05d.jpg")]
    log(f"ffmpeg 抽候选帧：-vf {cmd[cmd.index('-vf') + 1]}")
    subprocess.run(cmd, check=True)
    return sorted(tmp_dir.glob("cand_*.jpg"))


def prepare_from_dir(src_dir: Path, tmp_dir: Path,
                     crop: str, center: float, long_edge: int) -> list[Path]:
    """图片目录输入：先统一裁剪/缩放成候选，后面的流程和视频完全一致。"""
    import cv2
    files = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
    if not files:
        raise SystemExit(f"错误：{src_dir} 里没有图片（支持 {', '.join(IMAGE_SUFFIXES)}）")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    sizes = set()
    out = []
    for i, f in enumerate(files):
        img = cv2.imread(str(f), cv2.IMREAD_COLOR)
        if img is None:
            warn(f"读不出来，跳过：{f.name}")
            continue
        sizes.add(img.shape[:2])
        dst = tmp_dir / f"cand_{i:05d}.jpg"
        cv2.imwrite(str(dst), crop_resize(img, crop, center, long_edge),
                    [cv2.IMWRITE_JPEG_QUALITY, 95])
        out.append(dst)
    if len(sizes) > 1:
        log(f"输入图片有 {len(sizes)} 种尺寸，已统一到同一裁剪/缩放后再打分")
    return out


def crop_resize(img, crop: str, center: float, long_edge: int):
    import cv2
    h, w = img.shape[:2]
    if crop == "square":
        size = min(w, h)
        # 和 build_vf 里一样：被裁的轴上 (边长-size) > 0，另一个轴上恰好是 0，
        # 所以同一个公式就能让 center 自动作用在实际被裁的那个轴上（横竖构图都对）。
        x = int(round((w - size) * center))
        y = int(round((h - size) * center))
        img = img[y:y + size, x:x + size]
        return cv2.resize(img, (long_edge, long_edge), interpolation=cv2.INTER_AREA)
    scale = long_edge / max(w, h)
    if scale >= 1:
        return img  # 本来就比 long_edge 小就不放大，放大不会凭空生出细节
    return cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def sharpness(path: Path) -> float:
    """拉普拉斯方差。先统一缩到 SCORE_EDGE 短边，否则不同分辨率之间没有可比性。"""
    import cv2
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return 0.0
    h, w = img.shape[:2]
    s = SCORE_EDGE / min(h, w)
    if s < 1:
        img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(img, cv2.CV_64F).var())


def select_by_window(cands: list[dict], target: int, floor: float) -> tuple[list[dict], list[dict]]:
    """把候选切成 target 个等长窗口，每窗口取最清晰的一帧。

    返回 (选中, 因整窗过糊而丢弃的窗口最佳)。
    """
    n = len(cands)
    per = n / target
    picked: list[dict] = []
    dropped: list[dict] = []
    for i in range(target):
        lo = int(round(i * per))
        hi = max(lo + 1, int(round((i + 1) * per)))
        window = cands[lo:min(hi, n)]
        if not window:
            continue
        best = max(window, key=lambda c: c["score"])
        best = dict(best, window=i, window_size=len(window))
        if best["score"] < floor:
            dropped.append(best)
        else:
            picked.append(best)
    return picked, dropped


def enforce_min_interval(picked: list[dict], min_interval: float) -> list[dict]:
    """窗口化之后相邻窗口仍可能各取到边界两侧挨着的帧，这里再扫一遍。

    冲突时保留更清晰的那一张，而不是简单丢掉后一张。
    """
    if min_interval <= 0:
        return picked
    kept: list[dict] = []
    for c in sorted(picked, key=lambda x: x["t"]):
        if kept and (c["t"] - kept[-1]["t"]) < min_interval:
            if c["score"] > kept[-1]["score"]:
                kept[-1] = c
            continue
        kept.append(c)
    return kept


def main() -> int:
    ap = argparse.ArgumentParser(description="M1：视频/照片 → 帧序列")
    ap.add_argument("--config", type=Path, default=REPO_ROOT / "pipeline/config/recon-5090.yaml")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--input", type=Path, required=True, help="视频文件或图片目录")
    ap.add_argument("--out-dir", type=Path, default=None, help="默认 <data_dir>/frames/<scene>")
    ap.add_argument("--target-frames", type=int, default=None)
    ap.add_argument("--long-edge", type=int, default=None)
    ap.add_argument("--crop", choices=("square", "none"), default=None)
    ap.add_argument("--crop-center", type=float, default=None,
                    help="正方形窗口中心在**被裁那个轴**上的相对位置，0~1，默认 0.5 居中。"
                         "横构图裁宽度、竖构图裁高度，这个参数自动作用在对应的轴上。")
    ap.add_argument("--candidates-per-window", type=int, default=None)
    ap.add_argument("--blur-floor-factor", type=float, default=None)
    ap.add_argument("--min-interval-sec", type=float, default=None)
    ap.add_argument("--keep-candidates", action="store_true",
                    help="保留全部候选帧，便于人工复核选帧是否合理")
    ap.add_argument("--keep-rejected", action="store_true",
                    help="把因整窗过糊而丢弃的帧另存一份到 <scene>_rejected/")
    args = ap.parse_args()

    cfg = load_config(args.config)
    ex = cfg.get("extract", {}) or {}
    pick = lambda cli, key, default: cli if cli is not None else ex.get(key, default)  # noqa: E731

    target = int(pick(args.target_frames, "target_frames", 64))
    long_edge = int(pick(args.long_edge, "long_edge", 1024))
    crop = str(pick(args.crop, "crop", "square"))
    center = float(pick(args.crop_center, "crop_center", 0.5))
    cpw = int(pick(args.candidates_per_window, "candidates_per_window", 5))
    floor_factor = float(pick(args.blur_floor_factor, "blur_floor_factor", 0.30))
    min_interval = float(pick(args.min_interval_sec, "min_interval_sec", 0.15))

    if not 0.0 <= center <= 1.0:
        raise SystemExit(f"错误：--crop-center 要在 0~1 之间，给的是 {center}")
    if target < 1:
        raise SystemExit(f"错误：target_frames 必须 >= 1，给的是 {target}")

    src = expand(args.input)
    if not src.exists():
        raise SystemExit(f"错误：输入不存在 {src}")

    data_dir = expand((cfg.get("paths", {}) or {}).get("data_dir", REPO_ROOT / "pipeline/data"))
    out_dir = expand(args.out_dir) if args.out_dir else data_dir / "frames" / args.scene
    tmp_dir = out_dir.parent / f".{args.scene}_cand"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)

    log(f"场景 {args.scene}｜输入 {src}")
    log(f"参数：target={target} long_edge={long_edge} crop={crop}@{center} "
        f"候选/窗口={cpw} 地板系数={floor_factor} 最小间隔={min_interval}s")

    is_video = src.is_file() and src.suffix.lower() in VIDEO_SUFFIXES
    meta: dict = {}

    if is_video:
        info = probe_video(src)
        meta.update(info)
        log(f"视频：{info['width']}×{info['height']} @ {info['fps']:.2f}fps，"
            f"时长 {info['duration']:.2f}s")
        if info["duration"] <= 0:
            raise SystemExit("错误：ffprobe 读不到时长，文件可能损坏")
        if crop == "square" and info["width"] != info["height"]:
            keep = min(info["width"], info["height"]) / max(info["width"], info["height"])
            log(f"非正方形输入，裁剪后长边方向保留 {keep * 100:.0f}%；"
                f"R6 的「相邻帧重叠 > 60%」要按裁剪后的视场算")

        want = target * cpw
        rate = want / info["duration"]
        if info["fps"] > 0 and rate > info["fps"]:
            rate = info["fps"]
            warn(f"视频只有 {info['fps']:.1f}fps，凑不满 {want} 个候选；"
                 f"降到按原帧率抽（约 {int(info['fps'] * info['duration'])} 帧）")
        cand_files = extract_candidates(src, tmp_dir, rate, crop, center, long_edge)
        # fps 滤镜是等间隔输出，所以第 i 个候选的时间就是 i/rate。
        cands = [{"path": p, "t": i / rate, "index": i} for i, p in enumerate(cand_files)]
    elif src.is_dir():
        cand_files = prepare_from_dir(src, tmp_dir, crop, center, long_edge)
        # 照片序列没有时间轴，用序号代替；min_interval 因此按「帧」而不是「秒」理解。
        cands = [{"path": p, "t": float(i), "index": i} for i, p in enumerate(cand_files)]
        meta["source_kind"] = "image_dir"
        if min_interval > 0:
            log("图片目录输入没有时间轴，min_interval 按「张」理解")
    else:
        raise SystemExit(f"错误：{src} 既不是支持的视频（{', '.join(VIDEO_SUFFIXES)}）也不是目录")

    if not cands:
        raise SystemExit("错误：一个候选帧都没抽出来")
    log(f"候选 {len(cands)} 帧，开始算拉普拉斯方差")

    for c in cands:
        c["score"] = sharpness(c["path"])

    scores = sorted(c["score"] for c in cands)
    q = lambda r: scores[min(len(scores) - 1, max(0, int(round(r * (len(scores) - 1)))))]  # noqa: E731
    # 地板只看中位数，不看分位数：分位数是相对排名，分布再紧密也必定丢掉那个比例，
    # 在本来就全都清晰的素材上会误杀（实测数字见 config 注释）。
    floor = q(0.5) * floor_factor
    log(f"清晰度分布：min={scores[0]:.1f} 15%={q(0.15):.1f} 中位={q(0.5):.1f} "
        f"85%={q(0.85):.1f} max={scores[-1]:.1f}")
    log(f"地板={floor:.1f}（中位 {q(0.5):.1f} × {floor_factor:.2f}）")

    if is_video and meta.get("duration") and min_interval > 0:
        win_sec = meta["duration"] / target
        if min_interval >= win_sec * 0.8:
            warn(f"最小间隔 {min_interval}s 接近甚至超过窗口宽度 {win_sec:.3f}s "
                 f"（时长 {meta['duration']:.1f}s ÷ {target} 帧），会有大量帧被合并、"
                 f"实际帧数明显少于 target。要么调小 min_interval_sec，要么减小 target_frames。")

    if len(cands) < target:
        warn(f"候选只有 {len(cands)} 帧，少于 target {target}，全部保留")
        picked = [dict(c, window=i, window_size=1) for i, c in enumerate(cands)]
        dropped: list[dict] = []
    else:
        picked, dropped = select_by_window(cands, target, floor)

    if dropped:
        warn(f"{len(dropped)} 个窗口整段都糊（最佳候选仍低于地板），已丢弃："
             f"窗口 {[d['window'] for d in dropped]}")
        warn("绕拍时这几段转得太快或对焦丢了。覆盖出现空洞会让前馈模型对未观测区域瞎猜（R6），"
             "空洞明显时建议重拍而不是硬跑。")

    before = len(picked)
    picked = enforce_min_interval(picked, min_interval)
    if len(picked) < before:
        log(f"最小间隔过滤：{before} → {len(picked)} 帧（相邻窗口取到了挨着的帧）")
        # 相邻窗口各自独立挑最清晰的一帧，两帧撞在公共边界附近是随机事件：
        # min_interval 取窗口宽度的一半时，理论上约 12% 的帧会被合并掉。
        # （有窗口被丢弃时不提示 —— 那种情况下帧数少是因为糊，不是因为合并。）
        if len(picked) < target * 0.9 and not dropped:
            msg = (f"实际帧数 {len(picked)} 比 target {target} 少了 "
                   f"{(1 - len(picked) / target) * 100:.0f}%，都是被最小间隔合并掉的。"
                   f"想更接近 target 就调小 min_interval_sec")
            if is_video and meta.get("duration"):
                msg += f"（它现在相当于窗口宽度的 {min_interval / (meta['duration'] / target):.0%}）"
            log(msg + "。")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, c in enumerate(picked):
        shutil.copyfile(c["path"], out_dir / f"{i:03d}.jpg")

    if args.keep_rejected and dropped:
        rej = out_dir.parent / f"{args.scene}_rejected"
        rej.mkdir(parents=True, exist_ok=True)
        for d in dropped:
            shutil.copyfile(d["path"], rej / f"win{d['window']:03d}.jpg")
        log(f"被丢弃的窗口最佳帧另存到 {rej}")

    picked_scores = sorted(c["score"] for c in picked)
    summary = {
        "scene": args.scene,
        "source": str(src),
        "source_kind": meta.pop("source_kind", "video" if is_video else "image_dir"),
        "timestamp": f"{_dt.datetime.now():%Y-%m-%dT%H:%M:%S}",
        "config": str(args.config.name),
        "params": {
            "target_frames": target, "long_edge": long_edge, "crop": crop,
            "crop_center": center, "candidates_per_window": cpw,
            "blur_floor_factor": floor_factor, "min_interval_sec": min_interval,
        },
        "video": meta or None,
        "candidates": len(cands),
        "frames_written": len(picked),
        "windows_dropped": [d["window"] for d in dropped],
        "sharpness": {
            "candidate_min": round(scores[0], 2),
            "candidate_median": round(q(0.5), 2),
            "candidate_max": round(scores[-1], 2),
            "floor": round(floor, 2),
            "picked_min": round(picked_scores[0], 2) if picked_scores else None,
            "picked_median": round(picked_scores[len(picked_scores) // 2], 2) if picked_scores else None,
        },
        # 每帧的时间戳留着：后面要判断覆盖是否均匀、或者和 M2 的位姿对照时用得上。
        "frames": [
            {"file": f"{i:03d}.jpg", "t": round(c["t"], 3),
             "score": round(c["score"], 2), "window": c["window"]}
            for i, c in enumerate(picked)
        ],
    }
    # 注意：这份 JSON 就放在帧目录里（数据自包含，整个目录拷走就行）。
    # M2 的 pick_frames 是按 IMAGE_SUFFIXES 过滤后缀的，所以不会把它当成一帧读进去 ——
    # 这是个隐式依赖，将来给 M2 加图片后缀时别把 .json 加进去。
    (out_dir / "_extract.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if not args.keep_candidates:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    else:
        log(f"候选帧保留在 {tmp_dir}")

    log(f"完成：{len(picked)} 帧 → {out_dir}")
    log(f"下一步：python pipeline/scripts/02_reconstruct.py --frames-dir {out_dir} "
        f"--out-ply pipeline/data/ply/{args.scene}.ply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
