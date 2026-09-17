#!/usr/bin/env python3
"""M0 环境自检（CLAUDE.md 第 3 节 M0）。

每台机器装完环境后第一件事就是跑这个脚本；任何"这台能跑那台不行"的问题，
先 diff 两台的输出，再动别的（风险 R11 双机环境漂移）。

三个硬性通过门（不过就不要往下走）：
  gate-torch    torch 必须报告 device capability (12, 0)、arch list 里含 sm_120，
                并且真的能算一次矩阵乘法（R1：旧版 PyTorch 在 Blackwell 上会报 no kernel image）。
  gate-gsplat   gsplat 的光栅化必须跑通，且必须包含 backward。
                只导出 PLY 时根本不会调用 gsplat，坏内核会被完全掩盖（R16）。
  gate-scatter  torch_scatter.scatter_max 的结果必须和原生 torch scatter_reduce_ 一致。
                PyG 的 cu128 wheel 没有 sm_120 原生内核，只带 compute_50 的 PTX，
                靠驱动即时编译；而 AnySplat 的 voxelize 一定会调用 scatter_max。

用法：
  source pipeline/env/activate.sh
  python pipeline/scripts/00_check_env.py                    # 只打印
  python pipeline/scripts/00_check_env.py --report           # 同时写入 env/ENVIRONMENT.md
  python pipeline/scripts/00_check_env.py --machine dev-5080 # 指定机器名（默认按 GPU 型号猜）

退出码：0 = 三个硬性门全过；1 = 有硬性门失败。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import platform
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_MD = REPO_ROOT / "pipeline" / "env" / "ENVIRONMENT.md"

PASS, FAIL, SKIP, INFO = "PASS", "FAIL", "SKIP", "INFO"
HARD_GATES = {"gate-torch", "gate-gsplat", "gate-scatter"}

results: list[tuple[str, str, str]] = []  # (status, name, detail)


def record(status: str, name: str, detail: str = "") -> None:
    results.append((status, name, detail))
    line = f"[{status:4}] {name}"
    if detail:
        line += "\n         " + detail.rstrip()
    print(line, flush=True)


def run(cmd: list[str], timeout: int = 20) -> str:
    """跑一条外部命令；找不到、失败或超时都返回空串，不抛异常。"""
    if shutil.which(cmd[0]) is None and not Path(cmd[0]).exists():
        return ""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return ""
    return (out.stdout or out.stderr or "").strip()


def section(title: str) -> None:
    print("\n" + "=" * 68)
    print(title)
    print("=" * 68, flush=True)


# ---------------------------------------------------------------------------
# 1. 主机 / GPU / 供电
# ---------------------------------------------------------------------------
def check_host() -> dict:
    section("1. 主机 / GPU / 供电")
    facts: dict[str, str] = {}

    facts["kernel"] = f"{platform.system()} {platform.release()}"
    record(INFO, "内核", facts["kernel"])

    distro = ""
    osr = Path("/etc/os-release")
    if osr.exists():
        for ln in osr.read_text().splitlines():
            if ln.startswith("PRETTY_NAME="):
                distro = ln.split("=", 1)[1].strip('"')
    facts["distro"] = distro
    record(INFO, "发行版", distro)

    # WSL 分到的内存和核数：gsplat 编译是内存密集型的，MAX_JOBS 要按这个定
    mem_kb = 0
    try:
        for ln in Path("/proc/meminfo").read_text().splitlines():
            if ln.startswith("MemTotal:"):
                mem_kb = int(ln.split()[1])
    except OSError:
        pass
    facts["ram_gb"] = f"{mem_kb / 1024 / 1024:.1f}"
    facts["cpu_count"] = str(os.cpu_count())
    record(INFO, "WSL 内存 / 核数", f"{facts['ram_gb']} GB / {facts['cpu_count']} 核")

    smi = run([
        "nvidia-smi",
        "--query-gpu=name,driver_version,memory.total,power.limit,power.draw,clocks.sm",
        "--format=csv,noheader",
    ])
    facts["nvidia_smi"] = smi
    record(INFO if smi else FAIL, "nvidia-smi", smi or "调不到 nvidia-smi，WSL 里看不到 GPU")

    # R12：笔记本 5090 的 TGP 在 95-150 W 之间由厂商配置，电池模式会大幅降频。
    # 任何性能数字都必须连同供电状态一起记录，否则没有可比性。
    power = "unknown"
    ps = shutil.which("powershell.exe") or "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if Path(ps).exists():
        out = run([
            ps, "-NoProfile", "-Command",
            "$b=Get-CimInstance Win32_Battery;"
            "if($b){\"BatteryStatus=$($b.BatteryStatus) Charge=$($b.EstimatedChargeRemaining)\"}"
            "else{'no-battery'}",
        ], timeout=60)
        if "no-battery" in out:
            power = "台式机（无电池）"
        elif "BatteryStatus=" in out:
            code = out.split("BatteryStatus=")[1].split()[0].strip()
            # Win32_Battery.BatteryStatus: 1 = 放电（没插电）, 2 = 交流供电
            power = {"1": "电池放电（没插电！）", "2": "交流电"}.get(code, f"BatteryStatus={code}")
            if "Charge=" in out:
                power += " / 电量 " + out.split("Charge=")[-1].strip() + "%"
    facts["power"] = power
    if "没插电" in power:
        record(FAIL, "供电状态（R12）",
               power + " —— 编译和推理都不要在电池上跑，性能数据也不可比。请插电并开性能模式。")
    else:
        record(INFO, "供电状态（R12）", power)
    return facts


# ---------------------------------------------------------------------------
# 2. 工具链
# ---------------------------------------------------------------------------
def check_toolchain() -> dict:
    section("2. 工具链（CUDA_HOME / nvcc / host 编译器）")
    facts: dict[str, str] = {}

    cuda_home = os.environ.get("CUDA_HOME", "")
    facts["cuda_home"] = cuda_home
    if not cuda_home:
        record(FAIL, "CUDA_HOME",
               "没设。gsplat 走 torch 的 cpp_extension 编译，靠 CUDA_HOME 找 nvcc 和 "
               "cuda_runtime.h。请先 source pipeline/env/activate.sh")
    else:
        nvcc_bin = Path(cuda_home) / "bin" / "nvcc"
        header = Path(cuda_home) / "include" / "cuda_runtime.h"
        ok = nvcc_bin.exists() and header.exists()
        record(PASS if ok else FAIL, "CUDA_HOME",
               f"{cuda_home}  (bin/nvcc={'有' if nvcc_bin.exists() else '缺'}, "
               f"include/cuda_runtime.h={'有' if header.exists() else '缺'})")

    nvcc = run(["nvcc", "--version"])
    rel = next((ln.strip() for ln in nvcc.splitlines() if "release" in ln), "")
    facts["nvcc"] = rel
    record(PASS if "12.8" in rel else (FAIL if rel else SKIP), "nvcc", rel or "找不到 nvcc")

    for var in ("CC", "CXX", "NVCC_PREPEND_FLAGS", "TORCH_CUDA_ARCH_LIST", "MAX_JOBS"):
        record(INFO, var, os.environ.get(var, "<未设置>"))

    cxx = os.environ.get("CXX", "g++")
    ver_lines = run([cxx, "--version"]).splitlines()
    ver = ver_lines[0] if ver_lines else ""
    facts["host_cxx"] = f"{cxx} :: {ver}"
    # 本项目要求 gcc 13：gsplat 1.5.3 的实跑记录都是 gcc 13，gcc 14 未验证。
    # conda 会把自己的 gcc 14.4 塞进环境，activate.sh 负责压回系统 gcc-13。
    record(PASS if " 13." in ver else (FAIL if ver else SKIP), "host 编译器", facts["host_cxx"])
    return facts


# ---------------------------------------------------------------------------
# 3. torch
# ---------------------------------------------------------------------------
def check_torch() -> tuple[dict, object | None]:
    section("3. torch / CUDA 运行时")
    facts: dict[str, str] = {}
    try:
        import torch
    except Exception as exc:  # noqa: BLE001
        record(FAIL, "gate-torch", f"import torch 失败：{exc}")
        return facts, None

    facts["torch"] = torch.__version__
    facts["torch_cuda"] = str(torch.version.cuda)
    record(INFO, "torch", f"{torch.__version__}（构建用的 CUDA {torch.version.cuda}）")

    # torch 自己解析出的 CUDA_HOME —— 编 gsplat 用的是这个值，不是 shell 里的那个
    try:
        from torch.utils.cpp_extension import CUDA_HOME as TORCH_CUDA_HOME
    except Exception:  # noqa: BLE001
        TORCH_CUDA_HOME = None
    facts["torch_cuda_home"] = str(TORCH_CUDA_HOME)
    record(PASS if TORCH_CUDA_HOME else FAIL, "torch 解析的 CUDA_HOME",
           str(TORCH_CUDA_HOME) or "None —— 这样编不了 CUDA 扩展")

    if not torch.cuda.is_available():
        record(FAIL, "gate-torch", "torch.cuda.is_available() 为 False")
        return facts, torch

    name = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    archs = torch.cuda.get_arch_list()
    total = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
    facts["gpu"] = name
    facts["capability"] = str(cap)
    facts["vram_gb"] = f"{total:.1f}"
    facts["arch_list"] = " ".join(archs)
    record(INFO, "GPU", f"{name}  显存 {total:.1f} GB  capability {cap}")
    record(INFO, "torch arch list", facts["arch_list"])

    ok_cap = cap == (12, 0)
    ok_arch = "sm_120" in archs
    detail = f"capability={cap}（应为 (12, 0)）, arch_list 含 sm_120={ok_arch}"
    if ok_cap and ok_arch:
        try:
            x = torch.randn(2048, 2048, device="cuda")
            s = float((x @ x).sum())
            torch.cuda.synchronize()
            record(PASS, "gate-torch", detail + f", 矩阵乘法 OK（sum={s:.3e}）")
        except Exception as exc:  # noqa: BLE001
            record(FAIL, "gate-torch", detail + f", 但矩阵乘法失败：{exc}")
    else:
        record(FAIL, "gate-torch", detail)
    return facts, torch


# ---------------------------------------------------------------------------
# 4. gsplat（硬性门，必须含 backward）
# ---------------------------------------------------------------------------
def check_gsplat(torch) -> dict:
    section("4. gsplat 光栅化（forward + backward）")
    facts: dict[str, str] = {}
    if torch is None or not torch.cuda.is_available():
        record(SKIP, "gate-gsplat", "torch 不可用，跳过")
        return facts
    try:
        import gsplat
    except Exception as exc:  # noqa: BLE001
        record(FAIL, "gate-gsplat", f"import gsplat 失败：{exc}")
        return facts

    facts["gsplat"] = str(getattr(gsplat, "__version__", "?"))
    record(INFO, "gsplat", facts["gsplat"])

    # 确认走的是预编译产物（AOT 的 .so），而不是每次 import 都 JIT 编译一遍
    try:
        from gsplat import csrc
        loc = str(getattr(csrc, "__file__", "<无 __file__>"))
        facts["gsplat_csrc"] = loc
        record(PASS if loc.endswith(".so") else INFO, "gsplat 扩展", loc)
    except Exception as exc:  # noqa: BLE001
        record(INFO, "gsplat 扩展", f"无法直接 import csrc（{exc}），可能走 JIT 后备路径")

    n, w, h = 4096, 160, 120
    g = torch.Generator(device="cuda").manual_seed(0)
    means = (torch.rand(n, 3, device="cuda", generator=g) * 2 - 1).requires_grad_(True)
    quats = torch.zeros(n, 4, device="cuda")
    quats[:, 0] = 1.0
    quats = quats.requires_grad_(True)
    scales = (torch.rand(n, 3, device="cuda", generator=g) * 0.02 + 0.01).requires_grad_(True)
    opacities = (torch.rand(n, device="cuda", generator=g) * 0.5 + 0.5).requires_grad_(True)
    colors = torch.rand(n, 3, device="cuda", generator=g).requires_grad_(True)
    viewmats = torch.eye(4, device="cuda")[None].clone()
    viewmats[0, 2, 3] = 4.0  # 相机沿 +z 退开，保证这堆高斯落在视野里
    Ks = torch.tensor([[[float(w), 0.0, w / 2], [0.0, float(w), h / 2], [0.0, 0.0, 1.0]]], device="cuda")

    tracked = (("means", means), ("scales", scales), ("opacities", opacities), ("colors", colors))
    for mode in ("RGB", "RGB+D"):
        try:
            out = gsplat.rasterization(
                means=means, quats=quats, scales=scales, opacities=opacities, colors=colors,
                viewmats=viewmats, Ks=Ks, width=w, height=h,
                render_mode=mode, rasterize_mode="classic",
            )
            img, alpha = out[0], out[1]
            torch.cuda.synchronize()
            finite = bool(torch.isfinite(img).all())
            alpha_sum = float(alpha.detach().sum())  # detach：这些张量都开了 requires_grad
            # backward 是关键：只导 PLY 时不会走到这条路径，坏内核会被掩盖（R16）
            img.sum().backward()
            torch.cuda.synchronize()
            grads = {k: round(float(v.grad.abs().sum()), 2) for k, v in tracked if v.grad is not None}
            grads_finite = all(bool(torch.isfinite(v.grad).all()) for _, v in tracked if v.grad is not None)
            ok = finite and alpha_sum > 0 and grads_finite and len(grads) == len(tracked)
            record(PASS if ok else FAIL, f"gate-gsplat[{mode}]",
                   f"img{tuple(img.shape)} alpha_sum={alpha_sum:.1f} 像素有限={finite} "
                   f"梯度有限={grads_finite} 梯度绝对值之和={grads}")
            for _, v in tracked:
                v.grad = None
            if quats.grad is not None:
                quats.grad = None
        except Exception as exc:  # noqa: BLE001
            record(FAIL, f"gate-gsplat[{mode}]", f"{type(exc).__name__}: {exc}")
    return facts


# ---------------------------------------------------------------------------
# 5. torch_scatter（硬性门：sm_120 上只有 PTX，必须实测）
# ---------------------------------------------------------------------------
def check_scatter(torch) -> dict:
    section("5. torch_scatter.scatter_max（AnySplat voxelize 的必经之路）")
    facts: dict[str, str] = {}
    if torch is None or not torch.cuda.is_available():
        record(SKIP, "gate-scatter", "torch 不可用，跳过")
        return facts
    try:
        import torch_scatter
    except Exception as exc:  # noqa: BLE001
        record(FAIL, "gate-scatter", f"import torch_scatter 失败：{exc}")
        return facts

    facts["torch_scatter"] = str(getattr(torch_scatter, "__version__", "?"))
    record(INFO, "torch_scatter", facts["torch_scatter"])

    n, buckets = 1 << 16, 512
    # 两种形状都要测：PTX 在 sm_120 上由驱动即时编译，1-D 和 2-D 是两次不同的内核实例化，
    # 1-D 通过不代表 2-D 通过。AnySplat 的 voxelize 实际调用的是 [N, C] 这种形状
    # （每个体素一个特征向量），所以 2-D 才是推理真正走到的那条路。
    for label, channels in (("1D", None), ("2D", 32)):
        try:
            g = torch.Generator(device="cuda").manual_seed(1)
            idx = torch.randint(0, buckets, (n,), device="cuda", generator=g)
            if channels is None:
                x = torch.rand(n, device="cuda", generator=g)
                ref_shape, ref_idx = (buckets,), idx
            else:
                x = torch.rand(n, channels, device="cuda", generator=g)
                ref_shape, ref_idx = (buckets, channels), idx[:, None].expand(-1, channels)
            val, arg = torch_scatter.scatter_max(x, idx, dim=0)
            ref = torch.full(ref_shape, -float("inf"), device="cuda")
            ref = ref.scatter_reduce_(0, ref_idx, x, "amax")
            torch.cuda.synchronize()
            same = bool(torch.allclose(val, ref))
            # argmax 也要对：voxelize 用它挑每个体素的代表点
            arg_ok = bool(torch.allclose(torch.gather(x, 0, arg.clamp(max=n - 1)), val))
            record(PASS if (same and arg_ok) else FAIL, f"gate-scatter[{label}]",
                   f"形状{tuple(x.shape)} 与原生 scatter_reduce_ 一致={same}, argmax 自洽={arg_ok}, "
                   f"最大绝对误差={float((val - ref).abs().max()):.3e}")
        except Exception as exc:  # noqa: BLE001
            record(FAIL, f"gate-scatter[{label}]",
                   f"{type(exc).__name__}: {exc}\n         "
                   "很可能就是 PyG 的 cu128 wheel 缺 sm_120 原生内核。改走源码编译：\n         "
                   "FORCE_CUDA=1 TORCH_CUDA_ARCH_LIST=12.0 pip install --no-build-isolation "
                   "--no-binary=torch-scatter torch-scatter==2.1.2")
    return facts


# ---------------------------------------------------------------------------
# 6. 其它依赖（只 import，不是硬性门）
# ---------------------------------------------------------------------------
def check_optional() -> dict:
    section("6. 其它依赖 import 自检")
    facts: dict[str, str] = {}
    # 模块名 → 发行包名（不一致时用后者查元数据；plyfile 这类包没有 __version__ 属性，
    # 留个 "?" 会让 R11 的双机 diff 变得没意义）
    mods = {"numpy": "numpy", "cv2": "opencv-python", "plyfile": "plyfile", "einops": "einops",
            "jaxtyping": "jaxtyping", "safetensors": "safetensors",
            "huggingface_hub": "huggingface_hub", "xformers": "xformers",
            "colorspacious": "colorspacious", "skvideo": "scikit-video", "yaml": "PyYAML"}
    got = []
    for m, dist in mods.items():
        try:
            mod = __import__(m)
            v = str(getattr(mod, "__version__", "") or "")
            if not v:
                from importlib.metadata import version as _dist_version
                try:
                    v = _dist_version(dist)
                except Exception:  # noqa: BLE001
                    v = "?"
            got.append(f"{m}={v}")
            record(PASS, f"import {m}", v)
        except Exception as exc:  # noqa: BLE001
            record(SKIP, f"import {m}", f"{type(exc).__name__}: {exc}")
    facts["optional"] = ", ".join(got)
    return facts


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------
LABELS = [
    ("distro", "WSL 发行版"), ("kernel", "内核"),
    ("ram_gb", "WSL 内存 (GB)"), ("cpu_count", "核数"),
    ("nvidia_smi", "nvidia-smi"), ("power", "供电状态"),
    ("nvcc", "nvcc"), ("host_cxx", "host 编译器"),
    ("cuda_home", "CUDA_HOME"), ("torch_cuda_home", "torch 解析的 CUDA_HOME"),
    ("torch", "torch"), ("torch_cuda", "torch 的 CUDA 版本"),
    ("gpu", "GPU"), ("vram_gb", "显存 (GB)"),
    ("capability", "device capability"), ("arch_list", "torch arch list"),
    ("gsplat", "gsplat"), ("gsplat_csrc", "gsplat 扩展路径"),
    ("torch_scatter", "torch_scatter"),
]

HEADER = (
    "# ENVIRONMENT.md\n\n"
    "两台机器各一节，由 `pipeline/scripts/00_check_env.py --report` 生成。\n"
    "出现\"这台能跑那台报错\"时，先 diff 这两节（风险 R11）。\n"
)


def write_report(machine: str, facts: dict) -> None:
    """把这次自检写进 env/ENVIRONMENT.md 对应小节（同名小节整段替换，不堆积）。"""
    stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    hard = [(s, n, d) for s, n, d in results if n.startswith("gate-")]
    verdict = "全部通过" if hard and all(s == PASS for s, _, _ in hard) else "有失败项"
    body = [f"## {machine}", "",
            f"- 自检时间：{stamp}（`00_check_env.py`）",
            f"- 结论：**{verdict}**", ""]
    for key, label in LABELS:
        if facts.get(key):
            body.append(f"- {label}：`{facts[key]}`")
    body += ["", "硬性通过门：", ""]
    for s, n, d in hard:
        first = d.splitlines()[0] if d else ""
        body.append(f"- [{s}] `{n}` — {first}")
    if facts.get("optional"):
        body += ["", f"其它依赖：`{facts['optional']}`"]
    body.append("")
    new = "\n".join(body)

    old = ENV_MD.read_text(encoding="utf-8") if ENV_MD.exists() else HEADER
    marker = f"## {machine}"
    if marker in old:
        head, _, rest = old.partition(marker)
        _, _, tail = rest.partition("\n## ")
        old = head + new + ("\n## " + tail if tail else "")
    else:
        old = old.rstrip() + "\n\n" + new
    ENV_MD.parent.mkdir(parents=True, exist_ok=True)
    ENV_MD.write_text(old, encoding="utf-8")
    print(f"\n已写入 {ENV_MD}（小节：{machine}）")


def main() -> int:
    ap = argparse.ArgumentParser(description="M0 环境自检")
    ap.add_argument("--report", action="store_true", help="把结果写进 pipeline/env/ENVIRONMENT.md")
    ap.add_argument("--machine", default=None, help="小节名，默认按 GPU 型号猜（recon-5090 / dev-5080）")
    args = ap.parse_args()

    facts: dict[str, str] = {}
    facts.update(check_host())
    facts.update(check_toolchain())
    tfacts, torch = check_torch()
    facts.update(tfacts)
    facts.update(check_gsplat(torch))
    facts.update(check_scatter(torch))
    facts.update(check_optional())

    section("汇总")
    counts = {s: sum(1 for x, _, _ in results if x == s) for s in (PASS, FAIL, SKIP, INFO)}
    print(f"PASS={counts[PASS]}  FAIL={counts[FAIL]}  SKIP={counts[SKIP]}  INFO={counts[INFO]}")
    failed_gates = [n for s, n, _ in results if s == FAIL and n.split("[")[0] in HARD_GATES]
    other_fails = [n for s, n, _ in results if s == FAIL and n.split("[")[0] not in HARD_GATES]
    if other_fails:
        print("非硬性失败项：" + ", ".join(other_fails))
    if failed_gates:
        print("硬性门失败：" + ", ".join(failed_gates))
        print(textwrap.dedent("""
            不要绕过。按 CLAUDE.md 第 7 节，这一步没过就不进下一步；
            把失败详情追加到 CLAUDE.md 第 8 节（坑记录），注明是哪台机器。
        """).strip())
    else:
        print("三个硬性门全部通过。")

    machine = args.machine
    if machine is None:
        gpu = facts.get("gpu", "") or facts.get("nvidia_smi", "")
        machine = "recon-5090" if "5090" in gpu else ("dev-5080" if "5080" in gpu else "unknown-machine")
    if args.report:
        write_report(machine, facts)
    return 1 if failed_gates else 0


if __name__ == "__main__":
    sys.exit(main())
