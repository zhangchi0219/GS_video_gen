#!/usr/bin/env python3
"""M2：AnySplat 前馈重建（一组帧 → 标准 3DGS PLY）。

AnySplat 是**前馈（feed-forward）**模型：一次前向推理直接输出高斯参数和相机位姿，
不需要 COLMAP（传统的运动恢复结构工具），也不需要逐场景优化。

用法：
  source pipeline/env/activate.sh
  python pipeline/scripts/02_reconstruct.py \
      --config pipeline/config/recon-5090.yaml \
      --frames-dir ~/gsvg/third_party/AnySplat/examples/vrnerf/riverview \
      --out-ply pipeline/data/ply/riverview.ply

为什么不直接用官方 inference.py（三处必须改的地方）：
  1. 权重路径写死成 `from_pretrained("lhjiang/anysplat")`，运行时会联网拉 HuggingFace
     （R3：国内不可达）。这里改成本地目录，并且**断言 missing/unexpected 键都为空** ——
     hub mixin 在键名不匹配时会静默使用随机权重，社区里出现过 scene scale 变成 0.086 的案例。
  2. 官方 `export_ply` 把 opacity 原样写进 PLY，**没有转 logit**。而 3DGS 的 PLY 约定里
     opacity 存的是 logit（渲染器会自己做 sigmoid），所以原样写入会被二次 sigmoid，
     在 Spark / splat-transform 里表现为一大片半透明漂浮碎片。这里在导出时转回 logit。
  3. 官方脚本无条件调用 `save_interpolated_video`，推理之外还要多花时间和显存；默认跳过。

显存不足（R5）时不会静默崩溃：捕获 OOM，打印当前帧数与显存占用，并建议退到
config 里的 `fallback_frames`。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 禁止任何运行时联网拉取（硬约束：模型权重必须来自本地目录）
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("WANDB_MODE", "disabled")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")


def log(msg: str) -> None:
    print(f"[{_dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def load_config(path: Path) -> dict:
    import yaml
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def expand(p: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p))))


def power_state() -> str:
    """R12：性能数字必须连同供电状态一起记录，否则没有可比性。"""
    ps = shutil.which("powershell.exe") or "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if not Path(ps).exists():
        return "unknown"
    try:
        out = subprocess.run(
            [ps, "-NoProfile", "-Command",
             "$b=Get-CimInstance Win32_Battery;"
             "if($b){\"BatteryStatus=$($b.BatteryStatus)\"}else{'no-battery'}"],
            capture_output=True, text=True, timeout=60,
        ).stdout
    except (subprocess.TimeoutExpired, OSError):
        return "unknown"
    if "no-battery" in out:
        return "台式机（无电池）"
    if "BatteryStatus=" in out:
        code = out.split("BatteryStatus=")[1].split()[0].strip()
        return {"1": "电池放电（没插电，性能数据不可比）", "2": "交流电"}.get(code, f"BatteryStatus={code}")
    return "unknown"


def pick_frames(frames_dir: Path, max_frames: int) -> list[Path]:
    """按文件名排序取帧；超过上限时**均匀采样**而不是截断前 N 张
    （截断会丢掉后半段视角，等于只重建了半圈）。"""
    files = sorted(p for p in frames_dir.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
    if not files:
        raise SystemExit(f"错误：{frames_dir} 里没有图片（支持 {', '.join(IMAGE_SUFFIXES)}）")
    if len(files) <= max_frames:
        return files
    step = len(files) / max_frames
    idx = sorted({min(len(files) - 1, int(i * step)) for i in range(max_frames)})
    log(f"帧数 {len(files)} 超过上限 {max_frames}，均匀采样到 {len(idx)} 帧")
    return [files[i] for i in idx]


def load_model(model_dir: Path, device: str):
    """加载本地权重，并断言键名完全匹配。"""
    from src.model.model.anysplat import AnySplat
    import safetensors.torch as st

    if not (model_dir / "model.safetensors").exists():
        raise SystemExit(f"错误：{model_dir} 下找不到 model.safetensors。"
                         f"请按 pipeline/README.md 从 hf-mirror 下载权重。")
    log(f"加载权重：{model_dir}")
    model = AnySplat.from_pretrained(str(model_dir))

    # 关键断言（R6 类问题）：hub mixin 用 strict=False 时，键名不匹配会静默保留随机初始化，
    # 表现为重建结果尺度离谱但程序不报错。这里再显式加载一次并检查两个列表都为空。
    missing, unexpected = st.load_model(model, str(model_dir / "model.safetensors"), strict=False)
    if missing or unexpected:
        raise SystemExit(
            "错误：权重键名不匹配，加载出来的模型里有随机初始化的参数，结果不可信。\n"
            f"  missing（模型里有、权重里没有）: {len(missing)} 个，前 5 个 = {list(missing)[:5]}\n"
            f"  unexpected（权重里有、模型里没有）: {len(unexpected)} 个，前 5 个 = {list(unexpected)[:5]}"
        )
    log("权重键名完全匹配（missing / unexpected 均为空）")

    model = model.to(device).eval()
    for param in model.parameters():
        param.requires_grad = False
    return model


def export_ply(out_path: Path, means, scales, rotations, harmonics, opacities,
               save_sh_dc_only: bool = True) -> dict:
    """写标准 3DGS PLY。逻辑照搬 AnySplat 的 src/model/ply_export.py，
    只有一处不同：opacity 转成 logit（见文件头说明 2）。"""
    import numpy as np
    import torch
    from einops import rearrange
    from plyfile import PlyData, PlyElement
    from scipy.spatial.transform import Rotation as R

    n = means.shape[0]
    # 四元数：AnySplat 存 xyzw，PLY 约定 wxyz；走一遍 scipy 顺带做归一化
    rot = R.from_quat(rotations.detach().cpu().numpy()).as_quat()
    x, y, z, w = rearrange(rot, "g xyzw -> xyzw g")
    rot_wxyz = np.stack((w, x, y, z), axis=-1)

    f_dc = harmonics[..., 0]                      # [N, 3]
    f_rest = harmonics[..., 1:].flatten(start_dim=1)

    # opacity → logit。AnySplat 输出的是 sigmoid 之后的 [0,1] 概率，
    # 而 PLY 里的 opacity 字段是 logit，渲染器会再做一次 sigmoid。
    p = opacities.detach().float().clamp(1e-6, 1.0 - 1e-6)
    opacity_logit = torch.log(p / (1.0 - p))

    attrs = ["x", "y", "z", "nx", "ny", "nz"]
    attrs += [f"f_dc_{i}" for i in range(3)]
    if not save_sh_dc_only:
        attrs += [f"f_rest_{i}" for i in range(f_rest.shape[1])]
    attrs += ["opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)]

    columns = [
        means.detach().cpu().numpy(),
        np.zeros((n, 3), dtype=np.float32),       # 法线占位，3DGS 不用
        f_dc.detach().cpu().contiguous().numpy(),
    ]
    if not save_sh_dc_only:
        columns.append(f_rest.detach().cpu().contiguous().numpy())
    columns += [
        opacity_logit[..., None].cpu().numpy(),
        scales.detach().cpu().log().numpy(),      # PLY 里的 scale 是 log 空间
        rot_wxyz,
    ]
    data = np.concatenate(columns, axis=1).astype(np.float32)

    elements = np.empty(n, dtype=[(a, "f4") for a in attrs])
    elements[:] = list(map(tuple, data))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    PlyData([PlyElement.describe(elements, "vertex")]).write(out_path)

    # 球谐各阶的能量（RMS）：决定 M4 能把 sh_degree 降到几阶而不明显掉画质。
    # AnySplat 用 sh_degree=4（25 个系数），而只存 DC 带会把高阶全丢掉；
    # 如果高阶能量占比很低，说明丢了也无所谓；占比高就意味着颜色会偏离。
    d_sh = int(harmonics.shape[-1])
    sh_energy: dict[str, float] = {}
    # 每个 band 的能量 = 该 band 所有系数的平方和（注意各 band 的系数个数不同：1,3,5,7,9），
    # 不能直接拿 RMS 比大小。这里两个都记：RMS 便于直观比较幅度，能量占比才是可加的。
    band_energy: list[float] = []
    k = 0
    while (k + 1) ** 2 <= d_sh:
        lo, hi = k ** 2, min((k + 1) ** 2, d_sh)
        band = harmonics[..., lo:hi].detach().float()
        width = hi - lo
        sh_energy[f"band{k}_rms"] = round(float(band.pow(2).mean().sqrt()), 5)
        band_energy.append(float(band.pow(2).mean()) * width)   # ∝ 该 band 的平方和
        k += 1
    total_energy = sum(band_energy)
    if total_energy > 0:
        for i, e in enumerate(band_energy):
            sh_energy[f"band{i}_energy_share"] = round(e / total_energy, 6)
    # 自检：逐 band 的能量之和应当等于全体系数的均方乘以系数个数。
    # 不相等说明 band 的切分或权重写错了（这个数会被写进 README 并用来决定 M4 降几阶，不能想当然）。
    total_ms_times_n = float(harmonics.detach().float().pow(2).mean()) * d_sh
    sh_energy["energy_identity_ok"] = bool(abs(total_energy - total_ms_times_n) <= 1e-4 * max(1.0, total_ms_times_n))

    mins = means.detach().cpu().numpy().min(axis=0)
    maxs = means.detach().cpu().numpy().max(axis=0)
    return {
        "gaussians": int(n),
        "sh_degree_model": int(round(d_sh ** 0.5)) - 1,
        "sh_coeffs_model": d_sh,
        "sh_bands_saved": 1 if save_sh_dc_only else d_sh,
        "sh_energy": sh_energy,
        "bbox_min": [round(float(v), 4) for v in mins],
        "bbox_max": [round(float(v), 4) for v in maxs],
        "center": [round(float((a + b) / 2), 4) for a, b in zip(mins, maxs)],
        "opacity_mean_after_sigmoid": round(float(p.mean()), 4),
        "ply_bytes": out_path.stat().st_size,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="M2：AnySplat 前馈重建")
    ap.add_argument("--config", type=Path, default=REPO_ROOT / "pipeline/config/recon-5090.yaml")
    ap.add_argument("--frames-dir", type=Path, required=True)
    ap.add_argument("--out-ply", type=Path, required=True)
    ap.add_argument("--max-frames", type=int, default=None, help="覆盖 config 里的 reconstruct.max_frames")
    ap.add_argument("--dtype", choices=("fp32", "bf16"), default=None, help="覆盖 config 里的 reconstruct.dtype")
    ap.add_argument("--summary-json", type=Path, default=None,
                    help="统计写到哪（默认与 PLY 同名的 .json）")
    ap.add_argument("--no-ply", action="store_true",
                    help="只做推理并记录耗时/显存，不写 PLY（用于显存标定，省掉几百 MB 的写盘）")
    ap.add_argument("--save-all-sh", action="store_true",
                    help="保存全部球谐系数（SH degree 4，文件会大一个量级；默认只存 DC 带）")
    args = ap.parse_args()

    cfg = load_config(args.config)
    rec = cfg.get("reconstruct", {})
    paths = cfg.get("paths", {})
    max_frames = args.max_frames or int(rec.get("max_frames", 64))
    dtype_name = args.dtype or str(rec.get("dtype", "fp32"))
    fallback = int(rec.get("fallback_frames", max(8, max_frames // 2)))

    anysplat_src = expand(paths.get("anysplat_src", "~/gsvg/third_party/AnySplat"))
    model_dir = expand(paths.get("model_dir", "~/gsvg/models/anysplat"))
    if not (anysplat_src / "src").is_dir():
        raise SystemExit(f"错误：AnySplat 源码不在 {anysplat_src}（见 pipeline/README.md）")
    sys.path.insert(0, str(anysplat_src))

    import torch
    from src.utils.image import process_image

    power = power_state()
    log(f"机器 ={cfg.get('machine', {}).get('name', '?')}  供电 ={power}")
    if cfg.get("machine", {}).get("require_ac_power") and "没插电" in power:
        log("警告（R12）：当前是电池供电，笔记本会大幅降频，这次的耗时数据没有可比性。")

    frames = pick_frames(expand(args.frames_dir), max_frames)
    log(f"输入 {len(frames)} 帧，来自 {args.frames_dir}")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        raise SystemExit("错误：看不到 CUDA 设备。先跑 00_check_env.py 排查。")

    model = load_model(model_dir, device)

    # process_image 会中心裁剪到 448²（16:9 的画面左右两侧会被裁掉，这是已知取舍）
    t0 = time.perf_counter()
    images = torch.stack([process_image(str(p)) for p in frames], dim=0).unsqueeze(0).to(device)
    log(f"预处理完成 {tuple(images.shape)}（[B, V, 3, 448, 448]），耗时 {time.perf_counter() - t0:.1f}s")

    torch.cuda.reset_peak_memory_stats()
    amp_dtype = {"fp32": None, "bf16": torch.bfloat16}[dtype_name]
    log(f"开始推理：dtype={dtype_name}")
    t0 = time.perf_counter()
    try:
        with torch.no_grad():
            if amp_dtype is None:
                gaussians, pred_pose = model.inference((images + 1) * 0.5)
            else:
                with torch.autocast(device_type="cuda", dtype=amp_dtype):
                    gaussians, pred_pose = model.inference((images + 1) * 0.5)
        torch.cuda.synchronize()
    except torch.cuda.OutOfMemoryError as exc:
        peak = torch.cuda.max_memory_allocated() / 1024 ** 3
        total = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
        log(f"显存不足（R5）：{len(frames)} 帧 @ 448²，峰值已用 {peak:.1f} GB / 共 {total:.1f} GB")
        log(f"建议：--max-frames {fallback}（config 的 fallback_frames），或改用 --dtype bf16")
        log(f"原始异常：{type(exc).__name__}: {str(exc).splitlines()[0]}")
        return 2
    infer_s = time.perf_counter() - t0
    peak_gb = torch.cuda.max_memory_allocated() / 1024 ** 3
    log(f"推理完成：{infer_s:.1f}s，显存峰值 {peak_gb:.2f} GB")

    if args.no_ply:
        stats = {"gaussians": int(gaussians.means[0].shape[0]), "ply_bytes": 0, "skipped_ply": True}
        log(f"按 --no-ply 跳过导出（{stats['gaussians']:,} 个高斯）")
    else:
        stats = export_ply(args.out_ply, gaussians.means[0], gaussians.scales[0],
                           gaussians.rotations[0], gaussians.harmonics[0], gaussians.opacities[0],
                           save_sh_dc_only=not args.save_all_sh)
        log(f"已写出 {args.out_ply}（{stats['gaussians']:,} 个高斯，{stats['ply_bytes'] / 1024 ** 2:.1f} MB）")

    summary = {
        "scene": args.out_ply.stem,
        "machine": cfg.get("machine", {}).get("name"),
        "gpu": torch.cuda.get_device_name(0),
        "power_state": power,
        "frames_used": len(frames),
        "frames_dir": str(args.frames_dir),
        "resolution": 448,
        "dtype": dtype_name,
        "inference_seconds": round(infer_s, 2),
        "vram_peak_gb": round(peak_gb, 2),
        "torch": torch.__version__,
        "timestamp": _dt.datetime.now().isoformat(timespec="seconds"),
        **stats,
    }
    # 位姿也留一份：M4 生成前端相机初值时要用。
    #
    # 这不是锦上添花 —— 没有它，前端只能靠包围盒猜一个方向，而 splat 场景的朝向是重建
    # 出来的、完全任意的。实测连着三个场景（riverview、test）默认视角都正对着一堵墙，
    # 一片黑。用「拍摄者真站过的位置」当初值，必然看得见东西。
    #
    # 约定 —— **这里有个坑，别照 docstring 写**：
    # vggt/utils/pose_enc.py 的 docstring 说 extrinsic 是 world-to-camera，但 AnySplat
    # 传给 decoder 之前已经转成了 **camera-to-world**。三处铁证：
    #   decoder_splatting_cuda.py:66  test_w2c_i = extrinsics[i].inverse()   ← 取逆才是 w2c
    #   cuda_splatting.py:88          view_matrix = extrinsics.inverse()
    #   gaussian_adapter.py:72        c2w_rotations = extrinsics[..., :3, :3] ← 直接叫 c2w
    # 按 docstring 的 w2c 公式算出来，相机会跑到包围盒外面、而且背对着场景看（实测过）。
    #
    # c2w 下（OpenCV 相机轴：x 右、y 下、z 前，矩阵的列就是各轴在世界中的方向）：
    #   相机世界位置 = 平移列
    #   前向（+Z）    = 第 3 列
    #   上方向        = -第 2 列（OpenCV 的 y 朝下，取负才是「上」）
    # 前端（three.js，y 朝上、看 -Z）拿 pos/fwd/up 走一次 lookAt 就行，不用自己推矩阵。
    try:
        ext = pred_pose["extrinsic"][0].detach().float().cpu().numpy()
        cams = []
        for m in ext:
            rot = m[:3, :3]
            cams.append({
                "pos": [round(float(v), 5) for v in m[:3, 3]],
                "fwd": [round(float(v), 5) for v in rot[:, 2]],
                "up": [round(float(v), 5) for v in -rot[:, 1]],
            })
        summary["cameras"] = cams
        summary["camera_convention"] = (
            "源自 camera-to-world / OpenCV(x右 y下 z前)；pos/fwd/up 已是世界坐标，"
            "可直接喂给 three.js 的 lookAt"
        )
        summary["pred_extrinsic_shape"] = list(pred_pose["extrinsic"].shape)
        summary["pred_intrinsic_shape"] = list(pred_pose["intrinsic"].shape)
    except Exception as exc:  # noqa: BLE001
        log(f"警告：相机位姿没能导出（{type(exc).__name__}: {exc}），前端只能靠包围盒猜视角")

    sj = args.summary_json or args.out_ply.with_suffix(".json")
    sj.parent.mkdir(parents=True, exist_ok=True)
    sj.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"统计写入 {sj}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
