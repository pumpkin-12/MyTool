# 个人工具箱 · 项目长期记忆

## 是什么
本地优先的个人工具箱，原为单文件网页 `index.html`，2026-09-11 迁移为 **Tauri 2 桌面应用**。
三个工具：`internlog`（实习日志）、`sketch`（无限画板）、`mermaid`（Mermaid 编辑器）。

## 目录结构与约定
```
web/index.html          前端全部代码（单文件，约 3400 行，无打包器）
web/vendor/mermaid.min.js   离线用 mermaid 11（3.5 MB）
src-tauri/              Cargo.toml / build.rs / tauri.conf.json / capabilities/ / src/ / icons/
tools/make-icons.py          重新生成图标（Pillow）
tools/verify-appstore.js     用 Node vm 验证 AppStore 双模式行为
docs/tauri-迁移方案.html      迁移方案 + 实施记录
```

**硬约定**
- **不引入 Vite/Webpack 等打包器**。前端永远是零构建单文件，`frontendDist: "../web"` 直接指向源目录。改完前端在应用里按 F5 刷新（无热重载）。
- **归档 key 前缀统一 `toolbox:<tool>:<field>`**。`AppStore` 是唯一的存储入口，三后端自动探测（Tauri / Electron NativeStore / 浏览器 localStorage），接口签名一致，工具代码不感知环境。
- 首页只显示 `ENABLED_TOOLS` 白名单里的工具；下线工具只需从白名单移除，**数据不会丢**。
- 不动 `window.NativeStore`（Electron）那段死代码，留着以备将来。

## 不可变项
- `bundle.identifier` = **`com.lijiazhen.toolbox`** —— 决定数据目录，**有数据后绝不能改**。
- 数据存档：**`D:\Ai-file\MyTool\data\store.json`**（用户 2026-09-11 指定，不放系统盘）；轮转备份 `.1/.2/.3`（30 分钟节流）。
  - 改之前在 `%APPDATA%\com.lijiazhen.toolbox\store.json`。`lib.rs` 的 `store_path()` 现硬编码 `DATA_DIR = "D:\\Ai-file\\MyTool\\data"`。
  - 首次切到新目录时，`migrate_legacy()` 会把旧 `%APPDATA%` 位置的 `store.json`(含 `.1/.2/.3`)整体拷贝过来，不丢历史；目标文件存在后不再触碰旧目录。
  - **要改数据位置只改 `DATA_DIR` 一处**；改后旧数据不会自动出现，需保留迁移逻辑或手动搬。

## 关键实现决定
- `tauri.conf.json` 四个必设：`withGlobalTauri: true`、`dragDropEnabled: false`、`frontendDist: "../web"`、`csp: null`。
  - `dragDropEnabled: false` 是 Windows 必需，否则**首页卡片拖拽排序和画板拖入图片会同时失效**（原生 OLE 吞掉 HTML5 拖放事件）。此属性只在配置文件里生效。
- Rust 三条命令（`src-tauri/src/lib.rs`）：`store_read` / `store_write`（校验 JSON → 轮转备份 → 临时文件 + rename 原子替换）/ `save_file`（原生另存为，收 base64 而非 `Vec<u8>`，必须 `async`）。
- 前端导出统一走全局 `saveBlob(blob, name)`：桌面端调 `save_file`，浏览器端 `<a download>` 兜底。旧的 `downloadBlob()` / `download()` 已删除。
- `AppStore.persist()` 用 Promise 链**串行化**写盘（防后写覆盖先写）；`set()` 返回真实写盘结果；暴露 `flush()` / `lastError()`。
- 全量迁移：首页「导出全部数据 / 导入全部数据」，用 `AppStore.exportAll()` / `importAll()`，键带前缀原样往返。

## 构建
```bash
npx -y @tauri-apps/cli@2 dev     # 迭代（cargo tauri 需先 cargo install tauri-cli）
npx -y @tauri-apps/cli@2 build   # 出包 → src-tauri/target/release/bundle/nsis/
```
release profile 开了 `lto = true` + `codegen-units = 1`，编译慢，只在出包时用。

## 本机环境（影响打包决策）
- **OS = Windows 10 专业版**（不是 Win11）。Win10 **不自带** WebView2，本机已装（pv 152.0.4191.66）。
  因此 `bundle.windows.webviewInstallMode` 的选择对「分发到别的 Win10 机器」很关键：
  当前是 `downloadBootstrapper`（安装包小，但目标机器需联网下载 WebView2）。
  若要离线安装，改成 `embedBootstrapper` 或 `offlineInstaller`。
- `%LOCALAPPDATA%\tauri` 缓存目录不存在 → **首次 `tauri build` 会联网下载 NSIS 工具链**（需访问 GitHub）。
  即使打包这步失败，`target/release/<name>.exe` 也已生成，可直接当便携版用。

## 已知缺陷（优先修）
- ~~**缺少单实例保护**~~ **已在代码里修好**（`tauri-plugin-single-instance`，`run()` 里最先注册），**但需重新 `tauri build` 才在安装包里生效**。
- ~~`save_file` 未实测~~ 已实测可用。
- 刷题工具已上线并经用户真机验证（2026-09-11）。遗留：`esc2` 无意义包装、判断题答错提示文案与选项不一致、两处 O(n²) find、Excel 导入全空行计入失败数。

## 出包基准（2026-09-11）
- 安装包 `PersonalToolbox_0.1.0_x64-setup.exe` = **1.92 MB**（不含刷题工具；重新 build 后约 +1 MB）
- 便携版 `toolbox.exe` = **3.93 MB**（同上）
- `index.html` 现为 217 KB / 4848 行（四个工具）
- NSIS 工具链缓存：`%LOCALAPPDATA%\tauri\NSIS`（首次 build 时联网下载，之后离线可用，**勿删**）

## 磁盘占用基准（2026-09-14 实测 + 已执行清理）
- **清理前**：项目总 8 603 MB / 10 736 文件，`src-tauri/target/` 独占 8 595.8 MB（99.7%）。
- **已实际执行清理（2026-09-14）**：`cargo clean --profile dev` 删 debug（回收 6.3 GiB / 5 309 文件）+ 手工删 release 的 `deps/ build/ .fingerprint/ 各类中间文件`。
  - **清理后项目约 15 MB / 835 文件**；`target/` 现约 **7.4 MB**（仅留 `release/toolbox.exe` 4.2 MB + `release/bundle/nsis/*.exe` 2.2 MB + 少量 `release/.fingerprint/` 缓存，用户拒绝删 fingerprint，且留着无害）。
  - C 盘旧数据目录 `%APPDATA%\com.lijiazhen.toolbox` 已**归档到 `data/_archive/legacy-C盘-2026-09-11-bak0~3` 后删除**（C 盘可用 103.6 → 111.3 GB）。
  - 改动已提交 `d0cf8e2`。
- **代价**：下次 `tauri dev` 冷编译约 3~5 分钟、`tauri build` 全量重编更久（缓存已清，需重建）。**用户已知晓并确认"保持现状，不额外把 target 挪到项目外"。**
- `.cargo\registry` 1 351 MB 是**全局共享**的依赖缓存，不属本项目
- 详细方案见 `docs/内容占用优化方案.md`

## 运行期占用基准（2026-09-14 实测）
- 应用开起来是 **7 个进程**：`toolbox.exe` + 6 个 `msedgewebview2.exe`，合计约 **353 MB**。
- **WebView2 固定开销 236 MB**（浏览器主进程 124.4 + gpu 63.0 + network 32.9 + storage 20.5 + crashpad 16.1）—— **这是每个 WebView2 应用的门票，不可优化，进程数也降不下来**。
- Rust 宿主只有 **27.4 MB**（私有 7.3 MB）—— 已经很轻，无需动。
- renderer 69.2 MB 是唯一可影响的；**其中大头是 mermaid**。
- ✅ **mermaid 常驻内存已修**（2026-09-14，commit `dcc8d4a`）：`loadScript` 改为**注入前先登记**到 `injectedScripts` 集合，`dispose()` 里 `lib = null` + 清 `window.mermaid` + 移除全部注入的 `<script>`；`viaLocal`/`loadLib` 在 dispose 后完成加载则不持有引用。**未裁剪包体**（那要打包器）。
  - 踩到的坑：最初把登记放在 `onload` 之后 → **"加载中就切走"时 script 永久残留 head**，是真实缺陷，被专项测试抓出。
  - 专项测试：`tools/verify-mermaid-release.js`（23 项，覆盖 dispose 释放 / 切走再切回 / 加载中切走）
- WebView2 数据目录 `%LOCALAPPDATA%\com.lijiazhen.toolbox\EBWebView` = 38 MB，**在 C 盘，与 D 盘 store.json 无关**（已确认不含 store.json）；其中 16.1 MB（Subresource Filter / Speech Recognition / BrowserMetrics）对本应用零价值。
- 特性开关：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 必须在 `run()` 里 WebView2 初始化**之前** `set_var`。
- 系统内存：总 15.7 GB，属实偏紧（已用 74%）。

## dev 与 release 共用数据目录
`tauri dev` 和装好的应用读同一个 **`D:\Ai-file\MyTool\data\store.json`**（现由 `DATA_DIR` 硬编码决定，不再依赖 identifier），所以调试时的数据在正式版里直接可见。

## 待办（第 2 档）
- ~~**mermaid 改为按需加载 + 离开释放**~~ **已于 2026-09-14 完成**（commit `dcc8d4a`，见「运行期占用基准」）
- **画板图片外置为文件**（现在 base64 内联进 `shapes`，存档随图片膨胀；`sketch:shapes` 目前仅 0.2 KB，**插图片前必须做**：落 `data/assets/<sha1>.<ext>`，`shapes` 只存引用）
- 存档按 key 拆分，避免每次全量 stringify（`quiz:questions` 已占存档 88%，画板改一下也要重写这 160 KB）
- 自动更新 / 托盘 / 开机自启
- 清理 `index.html` 顶部 6 处 `data-page-node-id` 残留
- ~~清理 `target/`（回收 8.6 GB）~~ **已于 2026-09-14 执行，见「磁盘占用基准」**
- 归档 `docs/*.html` 两份旧格式方案（今后方案一律 `.md`）

## 迁移前的历史数据
`实习日志备份-2026-09-11.json`（项目根，4 条日志）—— 已导入桌面版。浏览器版 → 桌面版靠首页「导入全部数据」。
