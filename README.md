# 个人工具箱（PersonalToolbox）

一个本地优先的多功能桌面工具箱，用 [Tauri 2](https://v2.tauri.app/) 封装。实测交付物：NSIS 安装包 2.2 MB，便携版 `toolbox.exe` 4.2 MB。

所有数据存在本地，不联网、不上传、无账号。

## 包含的工具

| 工具 | 说明 |
| --- | --- |
| **实习日志**（internlog） | 按日期记录工作内容，支持心情、标签、备注、配图（粘贴 / 拖入 / 选文件），**结构化检索**（关键词 × 标签 × 日期 × 效率），贡献度热力图 + **效率趋势曲线**；正文可切 **Markdown 预览**；可导出 **Excel 台账**、周报 **.md / .html（Word 可直接打开）**，并**自动补齐缺失周报** |
| **无限画板**（sketch） | 画笔 / 便签 / 直线箭头 / 选择 / 图片 / 迷你地图 / 对齐参考线 / 触屏缩放，支持导出 PNG、SVG、JSON |
| **Mermaid 编辑器**（mermaid） | 离线 Mermaid 渲染，实时预览 + 语法错误行定位，按需加载并在离开时释放内存 |
| **刷题**（quiz） | 导入题目（Excel / JSON）建题库，支持随机练习、错题重练、成绩记录与统计分析 |
| **缺陷统计**（defect） | Excel 式网格表记录缺陷（严重程度 / 状态 / 模块 / 日期），支持从 Excel 粘贴多条、xlsx 导入导出，统计页看分布与 8 周 / 6 月新增关闭趋势 |

> 画板的"连线"目前是**自由两点形状**（`line` / `arrow`，只存 x1y1x2y2），拖到端点可改，但**不会跟着两端图形移动**。要的是绑定式连接线的话见 `docs/画板结构化绘图方案.md`，尚未实施。

首页只显示 `ENABLED_TOOLS` 白名单里的工具；下线某个工具只需从白名单移除，**数据不会丢**。

## 技术栈

- **外壳**：Tauri 2（Rust 后端 + 系统 WebView2）
- **前端**：**零构建**，原生 HTML/CSS/JS —— 页面壳 `web/index.html`（样式 + 按顺序挂的 `<script src>`）+ 按板块拆开的 `web/js/*.js`，**不引入 Vite / Webpack 等打包器**
- **存储**：JSON 文件，通过统一的 `AppStore` 抽象访问
- **离线依赖**：Mermaid 11、SheetJS 均已本地内置在 `web/vendor/`

> 一处例外要说明：mermaid 模块里保留了一个 CDN 兜底地址，只在 `vendor/mermaid.min.js` 加载失败时才用（也就是"直接用浏览器打开调试"那条路径）。桌面端走的是本地 vendor，不联网。

### 为什么不用打包器

前端刻意保持零构建：`tauri.conf.json` 的 `frontendDist` 直接指向 `../web` 源目录，改完前端在应用里按 F5 刷新即可，没有等待构建的过程；代价是没有热重载，但随时可以直接用浏览器打开 `index.html` 调试。

板块拆成 `js/*.js` 之后仍然零构建，靠的是**普通（非 module）外链脚本共用同一个全局作用域**：脚本顶层的 `const` / `function` 落在共享的全局词法环境里，后面挂的脚本能直接引用前面挂的，语义与拆分之前的单个内联 `<script>` 完全一致 —— 只要 `<script src>` 的顺序不动（`index.html` 里那份注释写明了顺序即执行顺序）。

两个刻意的取舍：
- **不改成 ES 模块**。模块要 `type="module"`、要各自作用域（跨文件得 import/export，而 `script-src 'self'` 之外没有可依赖的解析规则），换来的收益对这个体量是零；共享全局作用域才是这里想要的语义。
- **不再留内联脚本**。同源外链文件被 `script-src 'self'` 直接放行（`vendor/xlsx.full.min.js` 早就是这么加载的），于是 Tauri 构建期那套「给内联脚本算 sha256 追加进策略」的机制在这里完全用不上，也不会有"改了页面忘了同步哈希"的风险。

### 存储抽象

`AppStore` 是唯一的存储入口，自动探测三种后端，工具代码不感知运行环境：

| 环境 | 后端 | 落盘粒度 |
| --- | --- | --- |
| Tauri 桌面端 | Rust 分键命令（`store_read_all` / `store_write_key` / `store_del_key`） | **一键一个文件** |
| Electron | `window.NativeStore.readAll/writeAll` | 全量 |
| 浏览器 | `localStorage` | 一键一条 |

归档键统一使用 `toolbox:<工具>:<字段>` 前缀。

**为什么分键**：早期版本把全部键塞进一个 `store.json`，画板改一下就要把整个题库重新 stringify + 写盘。现在改一个键只重写那一个文件。

**写盘串行化**：`writeChain` Promise 链 + `dirty:Set`。批次在真正轮到执行时才结算，所以连续 3 次 `set()` 会合并成 1 次落盘；同时消除了并发写入「后写覆盖先写」的竞态。

**`set()` 不返回成功与否**。落盘是异步的，同步返回值必然滞后（旧实现返回的是*上一次*写盘的结果，`if (!AppStore.set(...))` 拿到的是过期判断）。要确认本批数据真的落盘：

```js
AppStore.set(k, v);
await AppStore.flush();
if (AppStore.lastError()) { /* 失败处理 */ }
```

失败本身总会弹 toast，不会静默。

### 内容安全策略（CSP）

`tauri.conf.json` 里不再是 `csp: null`，桌面端跑的是这条策略：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost;
object-src 'none'; base-uri 'self'; form-action 'none'
```

**`script-src 'self'` 里没有 `'unsafe-inline'`**，而前端现在**一个内联 `<script>` 都没有**（全在 `js/*.js` 里），所以这条指令只放行同源脚本文件，Tauri 构建期那套「给内联脚本算 sha256 追加进策略」（`tauri-utils` 的 `html2.rs`，行尾先按 HTML 规范 CRLF→LF 归一）在这里无事可做。拆文件之前它是必需的：主脚本内联，哈希对不上就是整页白屏。所以这个应用反而是**收得最紧**的：任何运行时注入的内联脚本都不在白名单里，跑不起来 —— mermaid 自己注入的是 `<script src="vendor/mermaid.min.js">`，走 `'self'`，照样放行。

策略里每一条豁免都对应一处真实依赖，少一条就会静默坏掉：

| 指令 | 为什么必须有 | 少了会怎样 |
| --- | --- | --- |
| `style-src 'unsafe-inline'` | mermaid 渲染时把 `<style>` 注入进 SVG；页面里大量 `style="…"` 属性 | 图还在，但全是默认黑，布局也散 |
| `img-src data:` | `asset_get` 读回的图片资产就是 data URL | 画板 / 日志的图片显示不出来 |
| `img-src blob:` | **mermaid 的 PNG 导出**把 SVG 转成 blob URL 再当图片画进 canvas | 导出静默变成「导出失败，可改用 SVG」 |
| `connect-src ipc: http://ipc.localhost` | 桌面端所有 `invoke` 走这条通道（Windows 上是 `http://ipc.localhost`，不是 `'self'`） | 应用读不到任何数据，看起来像"数据全丢" |

**另外配了 `dangerousDisableAssetCspModification: ["style-src"]`**：Tauri 默认也会给内联 `<style>` 算哈希追加进 `style-src`，而策略里一旦出现哈希，`'unsafe-inline'` 就会被浏览器忽略（CSP 规范如此），mermaid 的运行时样式反而会被拦。禁掉这一侧，`'unsafe-inline'` 才稳定生效。

**副作用是桌面端彻底失去联网能力**（这是有意的）：`connect-src` 只放行 `'self'` 与 IPC，`script-src` 不放行任何远端源。mermaid 加载里那条「本地 vendor 失败就回退 CDN」的退路在桌面端被策略封死 —— 与「不联网、不上传」的承诺一致，顺带也意味着 vendor 文件丢了会立刻暴露，而不是悄悄走 CDN。

改 CSP、换前端依赖、动导出实现之后**必须跑** `bash tools/verify-csp.sh`（见下），它会用与配置同源的策略在真机浏览器里实跑四条路径。

## 目录结构

```
web/
  index.html            页面壳（476 行）：<style> 全套样式 + 按执行顺序挂的 11 个 <script src>
  js/                   前端逻辑，板块各占一个文件（普通外链脚本，共用全局作用域，无打包器）
    store.js            AppStore —— 必须最先加载
    util.js             通用函数（esc / tabButtons / statCard / showToast / saveBlob / loadXlsx）
    sysinfo.js          系统状态面板
    ui.js               应用内对话框（askConfirm / askForm，取代禁用的 prompt/confirm）
    tools.js            工具注册表 registry + ENABLED_TOOLS
    tools/internlog.js  实习日志
    tools/sketch.js     画板
    tools/mermaid.js    mermaid 绘图
    tools/quiz.js       刷题（QuizCore + 界面）
    tools/defect.js     缺陷统计（DefectCore + 界面）
    app.js              主题 + 路由 + 全量导出导入 + 启动 —— 必须最后加载
  vendor/               离线依赖：mermaid.min.js、xlsx.full.min.js
src-tauri/
  Cargo.toml            依赖声明
  tauri.conf.json       窗口 / 打包 / 安全配置
  capabilities/         权限声明
  icons/                应用图标
  src/
    main.rs             入口
    lib.rs              Rust 侧全部逻辑（存储、资产、导出、系统状态）
tools/
  _harness.js           verify 脚本的共享地基（路径 / 抽取 / 报告 / 假绿闸门）
  verify-all.js         一条命令跑完全部回归 ← 用这个
  verify-appstore.js    前端脚本语法 + AppStore 三后端行为 + 写盘路径 + 迁移可达性
  verify-store-semantics.js  AppStore 值语义（隔离 / 往返 / 边界 / 容错）
  verify-quizcore.js    刷题核心算法
  verify-defect.js      缺陷统计核心算法（DefectCore）
  verify-mermaid-release.js  mermaid 按需加载与释放
  verify-sysinfo.js     系统状态模块
  verify-sketch-core.sh        画板 23 项（真机浏览器）
  verify-internlog-heat.sh     热力图（真机浏览器）
  verify-internlog-images.sh   日志配图（真机浏览器）
  verify-csp.sh                CSP 46 项（真机浏览器 + 与配置同源的策略）
  _csp_server.py              上者的配套静态服务：把 tauri.conf.json 的 CSP 下发进浏览器
  make-icons.py         重新生成全套图标（Pillow）
data/                   应用数据（.gitignore，不入仓）
  keys/                 每个归档键一个文件：<键名的 sha1>.json
  assets/               画板 / 日志图片：<sha1>.<ext>
  store.json.1/.2/.3    旧全量存档的轮转备份
  store.json.migrated-bak  迁移前的全量存档（回滚点，确认无误可删）
docs/                   设计与实施方案
```

分键文件的实际格式是 `{"k":"toolbox:quiz:questions","v":<原值>}` —— 键名含 `:`，Windows 不允许做文件名，所以文件名用哈希、**原始键名存在内容里**。`store_read_all` 靠它还原键名，改哈希算法也不会丢数据。

## 构建

需要 [Node.js](https://nodejs.org/) 与 [Rust 工具链](https://rustup.rs/)。

```bash
# 开发（无热重载，改完前端在应用里按 F5）
npx -y @tauri-apps/cli@2 dev

# 打包（产物在 src-tauri/target/release/bundle/nsis/）
npx -y @tauri-apps/cli@2 build
```

> `release` profile 开启了 `lto = true` 与 `codegen-units = 1`，编译较慢，仅出包时使用。

### Windows 分发提示

Windows 10 **不自带** WebView2 运行时。当前配置为 `downloadBootstrapper`：安装包体积小，但目标机器首次安装需联网下载 WebView2。若需离线安装，把 `tauri.conf.json` 里的 `bundle.windows.webviewInstallMode` 改为 `embedBootstrapper` 或 `offlineInstaller`。

## Rust 侧命令

`src-tauri/src/lib.rs` 注册 15 个命令，分四类。

**存储 —— 分键（日常路径）**

| 命令 | 作用 |
| --- | --- |
| `store_read_all` | 启动时一次读回全部键，建立内存副本（键名被哈希过，前端无法自己拼文件名逐个读）。**旧格式迁移挂在这里** |
| `store_read_key` | 读单个键，不存在返回 `"null"` |
| `store_write_key` | 写单个键：校验 JSON → 临时文件 + rename 原子替换 |
| `store_del_key` | 删单个键，不存在也算成功（幂等） |
| `store_keys` | 列出所有键名与体积，供系统状态面板展示 |

**存储 —— 全量（仅导入导出与兼容）**

| 命令 | 作用 |
| --- | --- |
| `store_read` | 读整个旧版 `store.json` |
| `store_write` | 校验 JSON → 轮转备份 → 临时文件 + rename 原子替换 |

**图片资产**（画板 + 日志配图共用一套）

| 命令 | 作用 |
| --- | --- |
| `asset_put` | base64 解码 → 按内容 sha1 命名落盘（同图天然去重），返回资产名 |
| `asset_get` | 读回为 data URL，供 `<img>` 直接用 |
| `asset_del` | 删资产，幂等 |
| `asset_stats` | 资产目录的文件数与总体积 |

**导出与只读诊断**

| 命令 | 作用 |
| --- | --- |
| `save_file` | 原生「另存为」对话框（前端统一走 `saveBlob()`） |
| `sysinfo` | 系统状态快照（内存 / CPU / 进程 / 磁盘），Win32 直取，零新增依赖 |
| `dir_usage` | 递归统计目录占用（显式栈迭代，防深目录爆栈） |
| `store_stats` | 存档分键 + 资产 + 轮转备份的数量与总大小 |

前端拿不到的东西（磁盘上的备份、资产文件）只能由 Rust 侧统计，所以有 `store_stats` / `asset_stats`。

### 数据位置

存档目录由 `lib.rs` 的 `DATA_DIR` 常量决定，当前**硬编码**为 `D:\Ai-file\MyTool\data`（刻意放在项目目录下，便于整体备份、不与源码混住）。注意它和 `tools/*.js` 里曾经出现的本机绝对路径一样，**换机器或挪目录要一起改** —— 目前只有 `tools/make-icons.py` 还留着一处硬编码路径。

> `bundle.identifier` 决定 WebView2 用户数据目录，**有数据后不可更改**。要迁移数据位置只需修改 `DATA_DIR` 一处。
>
> 轮转备份 `.1/.2/.3` 最少间隔 30 分钟（`BACKUP_INTERVAL`）：画板拖拽时每 400ms 就会写一次盘，不能每次都复制几 MB 的文件。单键写入不触发全量轮转。

## 开发约定

- 前端永远零构建、不引入打包器（脚本按板块分文件，但仍是一堆 `<script src>`，不是模块图）
- 归档键前缀统一 `toolbox:<工具>:<字段>`
- 前端导出统一走全局 `saveBlob(blob, name)`，自动适配桌面 / 浏览器环境
- **不用 `window.prompt` / `window.confirm`**：Tauri 桌面端上它们是 no-op（不弹框直接返回），拿返回值做判断会静默丢数据。用自建的 `askConfirm()` / `askForm()`
- 涉及定时器的模块，`mount()` 必须**返回一个清理闭包**：置 `mounted/alive = false` → `clearInterval` / `clearTimeout` → `disconnect` 观察器 → 解绑事件监听。路由切换时 `render()` 会调用它，Mermaid 那种大块头还要在清理里释放已注入的 `<script>`
- 要改 `AppStore` / `QuizCore` / 系统状态面板 / mermaid 模块，**必须连着 `/* ===TESTABLE:xxx:begin|end=== */` 这对标记一起移动**。verify 脚本靠它取代码，标记丢了脚本会直接崩（这是设计要求，不是缺陷）

## 验证脚本

回归不依赖任何测试框架：用 Node 内置 `vm` 把前端源码（`index.html` + `js/*.js`，由 `_harness.readFrontend()` 按 `<script src>` 清单拼成一份）里的被测段抽出来，在假 DOM 里真跑并断言。

```bash
node tools/verify-all.js        # 全部（含真机浏览器脚本）
node tools/verify-all.js --js   # 只跑无外部依赖的 6 个（CI 用）
```

零参数、结果打 stdout、退出码 0=全通过。单跑某一个也可以：`node tools/verify-appstore.js`。

**为什么需要 `--js`**：五个 `.sh` 脚本要真机浏览器（`agent-browser` + 本地静态服务），因为画板的行为全在 canvas 渲染 + pointer 事件里，静态断言查不出「拖一下到底发生了没有」；CSP 与 Markdown 预览/导出更是只有浏览器才会执行。**画板没有任何 node 侧覆盖** —— 改动画板后必须本机补跑 `bash tools/verify-sketch-core.sh`。

`verify-csp.sh` 与其它 `.sh` 略有不同：它不用 `python -m http.server`，而是用 `tools/_csp_server.py` 把 `tauri.conf.json` 里那条策略**原样**下发进浏览器（页面里若有内联 `<script>` 才复刻 Tauri 的 sha256 追加，前端全外链时就没有可追加的、策略一字不改），所以测的就是配置里那条策略，两者不会漂移。它的判据是「`securitypolicyviolation` 一条都没触发，且四条路径功能仍正常」——覆盖 mermaid 渲染、mermaid PNG 导出、画板绘制、画板 PNG 导出，并把 `data:` / `blob:` 图片加载单独拆成断言，坏掉时能直接看出是哪个 scheme 没放行。

### 假绿是这个测试体系唯一的敌人

所有脚本共用 `tools/_harness.js`，它兜住四条：

1. 路径由 `__dirname` 推导 —— 不写死 `D:/Ai-file/MyTool`
2. 读入即归一化成 LF —— 前端源码（`index.html` 与 `js/*.js`）工作区是真 CRLF，而 CI 上 checkout 可能是 LF
3. 抽取按成对 `TESTABLE` 标记，找不到就 throw，**不降级成"记一条 FAIL 然后继续跑"**
4. 每个脚本声明期望断言总数 `expected: N`，实际数对不上直接判失败

第 4 条是重点。历史上真翻过两次车：mermaid 脚本因 CRLF 匹配失败导致 `[2]~[6]` 整段被跳过，报告照旧打印"23 通过 / 0 失败"，实际只跑了 8 项；`verify-store-semantics.js` 按行号硬切，`index.html` 一改就切到 CSS 上报 SyntaxError。**改了断言数就要同步改 `expected`**，跑一下脚本它会告诉你对不上差几条。

GitHub Actions 上跑 `node tools/verify-all.js --js`，见 `.github/workflows/verify.yml`。

## 版本变更

> **约定：每次改动用户可见的行为后，在这里补一条**（按日期倒序，最新在上）。
> 当前版本 `0.1.0`（见 `src-tauri/tauri.conf.json`）。还没到按语义化版本号发布的阶段，所以先按日期记。

### 2026-09-21

- **前端从单文件拆成模块**：`index.html` 5779 → 476 行，逻辑移入 `web/js/`（`store` / `util` / `ui` / `sysinfo` / `tools` / `app`）与 `web/js/tools/<工具>.js`，共 11 个外链脚本。**原因**：CSP 收紧后 `script-src 'self'` 不再放行内联脚本，原先前只能靠 Tauri 构建期给内联脚本算 sha256 追加进策略，哈希一对不上就是整页白屏；拆成外链后页面里零内联脚本，这条脆弱约束随之作废。
- **新增工具「缺陷统计」（defect）**：Excel 式网格记录缺陷（严重程度 / 状态 / 模块 / 日期），支持从 Excel 粘贴多条、xlsx 导入导出，统计页看分布与 8 周 / 6 月新增关闭趋势。
- **安全策略收紧**：`csp` 从 `null` 改为严格策略（`script-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`form-action 'none'`）。副作用是**有意的**：桌面端彻底失去联网能力，mermaid 的 CDN 兜底在桌面端被封死。
- **测试基建**：抽出共用断言工具 `tools/_harness.js`（含「期望断言总数」校验）；新增 `tools/verify-all.js` 一条命令跑全部回归、`tools/verify-defect.js`（210 项）、`tools/verify-csp.sh`（46 项）+ `tools/_csp_server.py`。合计 634 项断言。
- **CI**：`.github/workflows/verify.yml` 跑 `node tools/verify-all.js --js`。
- **实习日志：正文支持 Markdown 预览**。工具栏「预览 / 编辑」一键切换，标题 / 代码块 / 列表 / 引用 / 表格 / 链接 / 粗斜体都能渲染。渲染器**自己写**（不引第三方库），关键是**先转义再按白名单加标签** —— 日志正文常是从网页或聊天里粘来的，必须当不可信输入；链接只放行 `http/https`，挡掉 `javascript:` 这类伪协议。预览只替换「正文」，日期/标签/效率/备注照旧可改。
- **实习日志：周报可导出 .md 与 .html**。HTML 是**自包含**的（配图内联成 data URL，换机器打开也不缺图），**Word 可直接打开**，也可以直接喂给现成的「HTML→docx」流程转成公文格式。**不生成真 .docx** —— 那要引入新依赖；而导出的 HTML 正好接得上已有流程，格式控制反而更自由。
- 新增 `tools/verify-internlog-md.sh`（**38 项**，真机浏览器）；回归脚本总数 9 个、**672 项**断言。
- **实习日志：新增四项**（都来自 `docs/实习日志功能调研.md` 的第一档）：
  - **导出 Excel 台账**：8 列（序号/日期/星期/效率/标签/正文/备注/图片数）。效率**未评留空**而不是写 0（写 0 会被读成"效率 0"）；标签/备注在导出前 join 成字符串，避免表格里出现 `[object Object]`
  - **结构化检索**：关键词（正文/备注/标签）× 标签多选（**同时满足**）× 日期范围 × 效率范围，组合过滤，落盘保持。检索条放在列表**之外**，所以输入时不会被列表重绘打断焦点、不需要防抖；热力图**不跟随筛选**（它是贡献度总览）
  - **效率趋势曲线**：零依赖手写 SVG，与热力图共用同一档区间。横轴按**真实自然日等距**（否则稀疏数据会被画成密集采样）；相邻有评分点间隔 **>7 天断笔**；**Y 轴固定 1~5 绝不自动缩放**；同日多篇取最高（与热力图口径一致）；7 日移动平均只算窗口内有评分的记录
  - **自动补齐缺失周报**：只记「哪一周处理过」（`internlog:reported`），**不存报告正文** —— 正文可由日志确定性重生成，存了会让备份翻倍、且日志一改旧周报就过期误导。提示条列出缺失周，一键「补齐并导出」合并成**一个** `.md`（每段 `## 周一 ~ 周日`）。当前周不算缺失
- 测试：新增 `tools/verify-internlog-core.js`（**108 项**，node 侧抽 `IlCore` 纯逻辑 + 真跑一遍 xlsx 生成回读）与 `tools/verify-internlog-search.sh`（**67 项**，真机）；回归脚本 **13 个、847 项**断言（node 侧 7 个 629 项 · 真机侧 6 个 218 项）。
- **给真机脚本补上「声明断言数 vs 实际数」自校验**：此前 node 侧有 `_harness` 的 `expected` 兜底、真机侧什么都没有 —— 声明数写错没人知道，真有断言被跳过也会照常打印「全绿」。现 6 个真机脚本都声明 `EXPECTED` 并在汇总处比对（顺带修正了 heat 30→29、images 14→15 两处写错的数字）。

### 2026-09-18

- 补齐**画板专项测试** `tools/verify-sketch-core.sh`（23 项，真机浏览器）—— 画板此前是唯一没有专项测试的板块。
- 已知问题（**非缺陷、不可修**）：mermaid 的内存实际**没有真正释放**。实测三轮进出 JS 堆 `1.01 → 7.91 → 14.1 → 20.3 MB` 线性增长；根因是 Chromium 会保留每次加载的编译产物（Script 对象 + 源码字符串 6.81 MB/份），不归应用代码管。缓解方案（加载一次常驻）暂未采纳。

### 2026-09-17

- 新增 `docs/画板结构化绘图方案.md`：把画板做成能画流程图/架构图的方向（图形内文字 → 形状库 → 锚点连线 → 网格），**待实施**。
- 试做 draw.io 跳转入口后**回退**。附带结论：本机 draw.io 桌面版必须带 `--disable-gpu` 启动，否则窗口白屏（已给桌面启动器 `drawio-nogpu.cmd`）。

### 2026-09-16

- **实习日志支持配图**：粘贴（Ctrl+V）/ 拖入 / 选文件；图片走与画板**共用的资产层**，内容哈希去重。移除图片只解除引用、不删文件（同图可能被多处共用）。
- **贡献度热力图改为按效率上色**：色阶由心情（效率 1~5）决定而非日志条数，同一天多篇取最大值；并新增自定义日期区间。
- 修复 `hidden` 属性被 CSS `display` 覆盖、导致日期区间框一直显示的问题（改为查计算样式断言）。
- 新增 `docs/AI功能模块方案.md`（**待拍板**）。

### 2026-09-15

- **存档按 key 拆分**：`data/keys/<sha1>.json` 每键一文件，改画板不再重写整个题库；画板图片外置为 `data/assets/<sha1>.<ext>`。迁移真机跑通，13/13 无损。
- 修复分键迁移挂在不可达路径上、导致迁移永不执行。
- 修复刷题工具 3 处遗留缺陷（答案展示、空行计数、两处 O(n²)）。
- 构建：`crate-type` 只保留 `rlib`，去掉桌面端用不到的 `staticlib` / `cdylib`。

### 2026-09-14

- 新增**系统状态模块**第一档：`sysinfo` / `dir_usage` / `store_stats` 三条只读命令 + 诊断面板。
- **mermaid 改为按需加载**：进入板块才注入，离开时清理。
- 数据目录迁移到 `D:\Ai-file\MyTool\data`（不进系统盘）。
- 刷题工具第一档功能。
- README 补充；个人数据与开发笔记移出 git 跟踪。

### 2026-09-11

- **Tauri 2 桌面化**：脚手架、原生「另存为」导出、从 `%APPDATA%` 全量迁移数据。
- 单实例保护。
- 新增**刷题**工具（quiz-app 领域逻辑的 vanilla 移植）。
- 用自建 `askConfirm()` / `askForm()` 替换 `window.prompt` / `window.confirm` —— 桌面端上它们是 no-op，不弹框直接返回，拿返回值做判断会静默丢数据。

## 许可

个人项目，未附许可证。
