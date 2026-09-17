#!/usr/bin/env python3
"""检查一个 3DGS PLY 是否"看起来正常"，在交给 splat-transform（M4）之前跑一遍。

为什么需要它：PLY 里的几个字段都是经过变换存的，写错了不会报错，只会在网页里
表现成"一团半透明的雪花"或者"整个场景是空的"，到那一步再回头排查非常费时：
  opacity  存 logit，渲染器会做 sigmoid          → 存成 [0,1] 概率的话会被二次 sigmoid
  scale    存 log(scale)，渲染器会做 exp         → 存成线性值的话高斯会大到糊住整个画面
  rot      存 wxyz 且应当是单位四元数
  f_dc     球谐 DC 带系数（不是直接的 RGB）

用法：
  python pipeline/scripts/02b_inspect_ply.py pipeline/data/ply/riverview.ply
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from plyfile import PlyData


def pct(a: np.ndarray, q: float) -> float:
    return float(np.percentile(a, q))


def main() -> int:
    ap = argparse.ArgumentParser(description="3DGS PLY 合法性检查")
    ap.add_argument("ply", type=Path)
    args = ap.parse_args()

    ply = PlyData.read(str(args.ply))
    v = ply["vertex"]
    names = list(v.data.dtype.names)
    n = len(v.data)
    size_mb = args.ply.stat().st_size / 1024 ** 2
    print(f"文件      : {args.ply}  ({size_mb:.1f} MB)")
    print(f"高斯数量  : {n:,}")
    print(f"字段      : {len(names)} 个 → {', '.join(names[:12])}{' …' if len(names) > 12 else ''}")

    problems: list[str] = []

    xyz = np.stack([v[k] for k in ("x", "y", "z")], axis=1)
    print(f"包围盒    : min={np.round(xyz.min(0), 3).tolist()}  max={np.round(xyz.max(0), 3).tolist()}")
    if not np.isfinite(xyz).all():
        problems.append("位置里有 NaN/Inf")

    if "opacity" in names:
        o = np.asarray(v["opacity"], dtype=np.float64)
        sig = 1.0 / (1.0 + np.exp(-o))
        print(f"opacity   : 原始 [{o.min():.2f}, {o.max():.2f}] 中位数 {np.median(o):.2f}  "
              f"→ sigmoid 后 均值 {sig.mean():.3f} 中位数 {np.median(sig):.3f}")
        if o.min() >= 0.0 and o.max() <= 1.0:
            problems.append("opacity 全部落在 [0,1]，很可能存的是 sigmoid 之后的概率而不是 logit —— "
                            "渲染器会再 sigmoid 一次，画面会变成一片半透明碎片")
        if sig.mean() < 0.02:
            problems.append(f"sigmoid 后的平均不透明度只有 {sig.mean():.4f}，几乎全透明")

    scale_keys = [k for k in names if k.startswith("scale_")]
    if scale_keys:
        s = np.stack([v[k] for k in scale_keys], axis=1).astype(np.float64)
        lin = np.exp(s)
        print(f"scale     : log 空间 [{s.min():.2f}, {s.max():.2f}]  "
              f"→ exp 后 中位数 {np.median(lin):.4f}，p99 {pct(lin, 99):.4f}")
        if s.min() >= 0:
            problems.append("scale 没有负值，可能存的是线性尺度而不是 log —— 高斯会大得糊住画面")
        if not np.isfinite(s).all():
            problems.append("scale 里有 NaN/Inf")

    rot_keys = [k for k in names if k.startswith("rot_")]
    if len(rot_keys) == 4:
        q = np.stack([v[k] for k in rot_keys], axis=1).astype(np.float64)
        norm = np.linalg.norm(q, axis=1)
        print(f"rot       : 四元数模长 中位数 {np.median(norm):.4f}（应为 1.0），"
              f"范围 [{norm.min():.4f}, {norm.max():.4f}]")
        if abs(float(np.median(norm)) - 1.0) > 0.05:
            problems.append("四元数不是单位长度")

    dc_keys = [k for k in names if k.startswith("f_dc_")]
    if dc_keys:
        dc = np.stack([v[k] for k in dc_keys], axis=1).astype(np.float64)
        # 3DGS 约定：rgb ≈ 0.5 + C0 * f_dc，其中 C0 = 0.28209479177387814
        rgb = 0.5 + 0.28209479177387814 * dc
        print(f"f_dc      : [{dc.min():.2f}, {dc.max():.2f}] → 推回 RGB 约 "
              f"[{rgb.min():.2f}, {rgb.max():.2f}]，均值 {np.round(rgb.mean(0), 3).tolist()}")
        if rgb.mean() < 0.02 or rgb.mean() > 0.98:
            problems.append("由 f_dc 推回的 RGB 几乎全黑或全白，颜色可能没写对")
    rest_keys = [k for k in names if k.startswith("f_rest_")]
    print(f"球谐      : DC 3 个 + f_rest {len(rest_keys)} 个"
          f"（{'只存了 DC 带' if not rest_keys else '含高阶'}）")

    print()
    if problems:
        print("发现问题：")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("检查通过：各字段的取值分布都符合 3DGS PLY 的约定。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
