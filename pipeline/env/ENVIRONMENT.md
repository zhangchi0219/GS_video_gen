# ENVIRONMENT.md

两台机器各一节，由 `pipeline/scripts/00_check_env.py --report` 生成。
出现"这台能跑那台报错"时，先 diff 这两节（风险 R11）。

## recon-5090

- 自检时间：2026-09-18 03:14（`00_check_env.py`）
- 结论：**全部通过**

- WSL 发行版：`Ubuntu 24.04.4 LTS`
- 内核：`Linux 6.6.87.2-microsoft-standard-WSL2`
- WSL 内存 (GB)：`47.0`
- 核数：`24`
- nvidia-smi：`NVIDIA GeForce RTX 5090 Laptop GPU, 596.21, 24463 MiB, [N/A], 7.19 W, 180 MHz`
- 供电状态：`交流电 / 电量 62%`
- nvcc：`Cuda compilation tools, release 12.8, V12.8.93`
- host 编译器：`/usr/bin/g++-13 :: g++-13 (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`
- CUDA_HOME：`/home/chizh/gsvg/cuda-home`
- torch 解析的 CUDA_HOME：`/home/chizh/gsvg/cuda-home`
- torch：`2.8.0+cu128`
- torch 的 CUDA 版本：`12.8`
- GPU：`NVIDIA GeForce RTX 5090 Laptop GPU`
- 显存 (GB)：`23.9`
- device capability：`(12, 0)`
- torch arch list：`sm_70 sm_75 sm_80 sm_86 sm_90 sm_100 sm_120`
- gsplat：`1.5.3`
- gsplat 扩展路径：`/home/chizh/miniforge3/envs/sawtooth/lib/python3.12/site-packages/gsplat/csrc.so`
- torch_scatter：`2.1.2+pt28cu128`

硬性通过门：

- [PASS] `gate-torch` — capability=(12, 0)（应为 (12, 0)）, arch_list 含 sm_120=True, 矩阵乘法 OK（sum=1.087e+05）
- [PASS] `gate-gsplat[RGB]` — img(1, 120, 160, 3) alpha_sum=7966.7 像素有限=True 梯度有限=True 梯度绝对值之和={'means': 112492.66, 'scales': 379738.44, 'opacities': 7296.25, 'colors': 23900.2}
- [PASS] `gate-gsplat[RGB+D]` — img(1, 120, 160, 4) alpha_sum=7966.7 像素有限=True 梯度有限=True 梯度绝对值之和={'means': 308594.12, 'scales': 916022.0, 'opacities': 17750.91, 'colors': 23900.2}
- [PASS] `gate-scatter[1D]` — 形状(65536,) 与原生 scatter_reduce_ 一致=True, argmax 自洽=True, 最大绝对误差=0.000e+00
- [PASS] `gate-scatter[2D]` — 形状(65536, 32) 与原生 scatter_reduce_ 一致=True, argmax 自洽=True, 最大绝对误差=0.000e+00

其它依赖：`numpy=1.26.4, cv2=4.11.0, plyfile=1.1.3, einops=0.8.2, jaxtyping=0.3.11, safetensors=0.8.0, huggingface_hub=1.32.0, xformers=0.0.32.post2, colorspacious=1.1.2, skvideo=1.1.11, yaml=6.0.3`
