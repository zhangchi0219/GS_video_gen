# web —— SOG 渲染侧（M5）

Vite + React + TypeScript + Three.js + Spark。**主力机是台式 5080**，但这一套全是 CPU/浏览器的活，
笔记本上同样能跑（第一版就是在笔记本 5090 上搭起来的）。

## 已验证的版本组合（2026-09-18）

| 组件 | 版本 | 说明 |
|---|---|---|
| Node | 24.13.1 | 根目录 `.nvmrc` 锁定；splat-transform 要求 `>=22` |
| Vite | 8.3.0 | `base: './'`，M6 要部署到 BT Panel 子目录 |
| React | 19.3.0 | 开着 StrictMode，开发模式下 effect 挂两次，用来逼出没 dispose 的 WebGL 资源 |
| TypeScript | 7.0.2 | |
| three | 0.186.0 | Spark 2.2.0 的 peer 要求是 `>=0.180.0` |
| @sparkjsdev/spark | 2.2.0 | World Labs 出品，MIT |
| 字体 | 自托管 woff2，共 179 KB | Bricolage Grotesque 800 / JetBrains Mono 500 / Plus Jakarta Sans 400，从各自官方 GitHub 取，放 `src/fonts/`。中文走系统栈零下载 |

依赖全部**精确钉版本**（没有 `^`），装的时候用 `npm ci`（CLAUDE.md §5）。

```bash
cd web
npm ci
npm run dev      # http://127.0.0.1:5173/
npm run build    # 产出 dist/
```

## 资产从哪来

`public/splats/` 下的二进制**都不进 git**（见根目录 `.gitignore`），只有 `.json` 进。
换一台机器后自己补齐：

```bash
# 1. 自产场景：PLY 在 pipeline/data/ply/ 下（走 NAS 或 scp 拿，不进 git）
cd pipeline && npm ci
bash scripts/04_export.sh --scene riverview --publish    # --publish 直接送到 web/public/splats/

# 2. 官方参照（一次性，只在开发期用；dist/ 里不会有它）
curl -L -o web/public/splats/butterfly.spz https://sparkjs.dev/assets/splats/butterfly.spz
cd pipeline && npx splat-transform -w ../web/public/splats/butterfly.spz ../web/public/splats/butterfly.sog
```

## SplatViewer 的三段式诊断

资产下拉框里那三条不是随便排的，是一条**故障定位链**（R7 要求「先用官方示例验证再换自己的」）：

| 资产 | 数据 | 格式路径 | 它坏了说明 |
|---|---|---|---|
| `butterfly.spz` | 官方 | 官方 | 问题在 `SplatViewer.tsx` 这段渲染代码 |
| `butterfly.sog` | 官方 | 本地 splat-transform 转的 | 问题在 SOG 路径本身（bundled 形态、Spark 版本） |
| `riverview.sog` | 自产 PLY | 本地导出 | 问题在 `02_reconstruct.py` 的 PLY 或导出参数 |

黑屏时按这个顺序点一遍，比读代码猜快得多。HUD 上同时显示 mesh 自报的包围盒和
`04_export.sh` 写的元数据包围盒，两者对不上就说明导出和加载有一方理解错了数据。

**2026-09-18 实跑结论**：butterfly.spz 和 butterfly.sog 都正常渲染，画面一致 ——
**R7（SOG 与 Spark 版本不匹配）解除**，bundled `.sog` 这条路通了。riverview 的
包围盒两行一字不差（`-4.26, -0.59, 0.16` / `2.84, 0.36, 4.20`），对账通过。

相机初始位姿**优先读元数据 JSON 的 `center` / `radius`**（CLAUDE.md M5 的要求），
HUD 的「取景依据」那一行会写明当前用的是哪一条路；官方参照资产没有 JSON，会退回
mesh 自报的包围盒。默认打开的是 `riverview.sog` 而不是下拉框第一项——
二进制都不进 git，新克隆的机器上只有跑过 `04_export.sh --publish` 的那个场景存在。

## 「绕 X 轴翻转 180°」那个勾选框

R8（坐标系翻转）的**判断工具**，不是最终方案。Spark 官方 getting-started 给 butterfly 设了
`quaternion.set(1, 0, 0, 0)`，就是绕 X 轴 180°——splat 训练坐标系 Y 向下，Three.js Y 向上。

一旦看出某个场景需要翻，就去 `04_export.sh` 加 `--rotate 180,0,0` 把它烤进资产里，
**不要**留在前端。CLAUDE.md R8 的原话：「在 M4 导出阶段一次性修正，不在前端每帧转换」。

## 界面

3/7 分栏：左边是 house style 的暖色控制面板，右边是深色 3D 画布（画布是「内容」不是 UI，
所以不跟着设计系统的暖色底走）。画面左上角可以收起面板让画布占满。

- **上传**：把 `.sog` / `.ply` / `.spz` / `.splat` / `.ksplat` 拖进画面，或点那个红色按钮。
  纯前端解析，不经服务器（§5「不引入任何后端」）。
- **最近打开**：文件存进浏览器的 IndexedDB，最多留 6 个（`.sog` 动辄十几 MB，攒几个就顶到配额）。
  隐私窗口里 IndexedDB 会直接抛，代码兜了一层内存缓存，刷新前还能用，界面会提示。
- **相机**：轨道（OrbitControls）/ 飞行（Spark 自带的 `SparkControls`，WASD 平移、QE 滚转、
  拖动转视角、Shift 加速）。用 Spark 的而不是 three 的 `FlyControls`，因为它是为 splat 场景调过的。
- **预设机位**：正面 / 侧面 / 顶视 / 全景，点一下平滑飞过去（900 ms，easeInOutCubic）。
- **关键帧路径**：「记下当前机位」存一帧，两帧以上可播放。位置走 Catmull-Rom 样条、
  朝向逐段 slerp，两者共用同一个 eased 参数以免视线和位置不同步。

## 「加载成功了却一片黑」怎么查

2026-09-18 在 riverview 上真的撞到过，链条值得记住：

1. **先确认不是渲染代码的问题** —— 按上面的三段式点一遍。butterfly 两个都正常，
   就说明渲染和 SOG 路径都没事。
2. **换个角度看**。splat 场景没有「正面」可言，重建出来的朝向是任意的。riverview 正对
   -Z 看过去正好是实心的一面墙，顶视立刻就看见了东西。
3. **滚轮拉近**。这是最反直觉的一条：riverview 的高斯 scale 中位数只有 0.0035，而场景
   半径 4.11 —— 在标准取景距离上每个高斯投影到屏幕**不足半个像素**，会被当亚像素丢掉，
   于是整个画面全黑；拉近一半就重新出现。butterfly 的高斯相对尺寸大得多，没这个问题。
4. **拿另一个渲染器交叉验证**。`npx splat-transform <场景>.ply out.html` 会吐一个自带
   PlayCanvas viewer 的单文件 HTML。实测它和 Spark 渲染出的东西完全一致 —— 两个独立
   实现结果相同，就能断定数据没错，问题在取景或参数。

顺带一提 riverview 本身就很暗：输入的 12 帧平均亮度只有 0.148（0~1），
而 PLY 里 f_dc 的均值是 0.144，两者吻合 —— 画面暗是场景如此，不是颜色约定错了。

## 部署（M6）

三个文件配套使用：

| 文件 | 作用 |
|---|---|
| `nginx-sawtooth.conf` | 站点配置。上线时把 `server{}` 里的几个 location 搬进 BT Panel，`root` 换成站点目录 |
| `deploy.sh` | 构建 + rsync。**默认 dry-run**，要显式加 `--go` 才真传 |
| `verify-deploy.sh` | 部署自检，把 CLAUDE.md 对静态站点的硬要求逐条验掉。本地和生产跑同一份 |

```bash
bash web/deploy.sh /var/www/sawtooth            # 先看要传什么
bash web/deploy.sh /var/www/sawtooth --go       # 真传
bash web/verify-deploy.sh http://127.0.0.1:8080 # 自检
```

`--lean` 只传主场景，把 `riverview.sog` 和 `butterfly.sog` 留在本地（44 MB → 22 MB），
但保留最小的那个官方参照 `butterfly.spz`，线上出问题时仍能用三段式诊断链定位。

### 配置里最要紧的一条

`.sog` 必须 `gzip off`。两个理由，**第二个更要命**：

1. SOG 内部已经是 WebP 压缩，再压一遍几乎压不动，纯耗 CPU（CLAUDE.md M6 明写）
2. **nginx 一旦 gzip 了响应，就会丢掉 `Accept-Ranges` 并拒绝 Range 请求** ——
   而 Range 是验收标准 4（为后续 `.RAD` 流式加载预留）的前提

所以「不要 gzip」和「支持 Range」这两条其实是同一件事，`verify-deploy.sh` 把它们连着测。

### 本地实测结果（2026-09-18，nginx 1.24 / WSL2）

自检 10 项全过：`.sog` 的 Content-Type 为 `application/octet-stream`、未被 gzip、
Range 返回 `206 + Content-Range`；JS/CSS 有 gzip；三个 woff2 都没被重复压缩；
`index.html` 是 `no-cache`；没有重复的响应头。

首屏传输量 **18.53 MB**：

| | 传输量 |
|---|---|
| 代码（HTML+CSS+JS，gzip 后） | 1.07 MB |
| 三个自托管字体 | 0.18 MB |
| `test.sog`（不可压缩） | 17.3 MB |

估算 4G 3 MB/s 约 6.2 秒、1 MB/s 约 18.5 秒。**真正的瓶颈是 splat 资产本身**，
代码只占 6%。要压首屏时间，方向是减小 `.sog`（`--min-opacity` 过滤、降低帧数），
而不是折腾代码分包。

生产构建在浏览器里实测：页面 292 ms 就绪，三个自托管字体全部加载成功，渲染正常。
**4G 实测还没做** —— 要上线或局域网访问后用手机实测（验收标准 3）。

### 本地起 nginx 测试时踩的两个坑

- **站点目录别放 `/home/<user>/` 下面**。nginx 的 worker 以 `www-data` 跑，而 `/home/<user>`
  默认权限是 750，进不去，表现为莫名其妙的 403。放 `/var/www/` 就好。
- **`expires` 和 `add_header Cache-Control` 同时用会产生两个 Cache-Control 头**。
  语义含糊，配置也不好 review。要么只用 `expires`，要么 `expires off` + 只用 `add_header`
  （本配置选了后者，因为 `immutable` 只能靠 `add_header` 给）。

另外从 Windows 侧访问 WSL 里的 nginx，`localhost:8080` 可能不通（系统代理没镜像到 WSL），
用 `hostname -I` 拿到的 WSL IP 直连即可；浏览器若也走系统代理，就改用
`npm run preview` 在 Windows 侧验证构建产物。

## 已知问题

- **分 chunk 没真正生效**：`vite build` 出来 `three` chunk 只有 19.8 kB，而 `spark` 有 3.0 MB
  （gzip 1.0 MB）——three 多半被并进了 spark 的 chunk，因为 spark 依赖它。功能没影响，
  但 M6 实测国内 4G 加载时间时要把这 1 MB 算进去。
- **dev server 不发 `Content-Type`**：`.sog` 响应头里 Content-Type 是空的。浏览器不在乎，
  但 M6 的 Nginx 必须显式配 `application/octet-stream` 和 `Accept-Ranges: bytes`。
- **HUD 上的 FPS 在自动化环境里不可信**：浏览器对后台标签页会节流甚至完全暂停
  `requestAnimationFrame`，实测读数掉到 0~2，连 17 万高斯的 butterfly 也一样。
  要看真实帧率，自己把窗口放到前台。
