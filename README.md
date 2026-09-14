# 个人工具箱（PersonalToolbox）

一个本地优先的多功能桌面工具箱，用 [Tauri 2](https://v2.tauri.app/) 封装，Windows 单文件安装包不到 2 MB。

所有数据存在本地，不联网、不上传、无账号。

## 包含的工具

| 工具 | 说明 |
| --- | --- |
| **实习日志**（internlog） | 按日期记录工作内容，支持心情、标签、备注、关键词检索 |
| **无限画板**（sketch） | 画笔 / 便签 / 连线 / 选择 / 图片 / 迷你地图 / 对齐参考线 / 触屏缩放，支持导出 PNG、SVG |
| **Mermaid 编辑器**（mermaid） | 离线 Mermaid 渲染，实时预览 + 语法错误行定位，按需加载并在离开时释放内存 |
| **刷题**（quiz） | 导入题目（Excel / JSON）建题库，支持随机练习、错题重练、成绩记录与统计分析 |

首页只显示 `ENABLED_TOOLS` 白名单里的工具；下线某个工具只需从白名单移除，**数据不会丢**。

## 技术栈

- **外壳**：Tauri 2（Rust 后端 + 系统 WebView2）
- **前端**：**零构建单文件** `web/index.html`，原生 HTML/CSS/JS，**不引入 Vite / Webpack 等打包器**
- **存储**：JSON 文件，通过统一的 `AppStore` 抽象访问
- **离线依赖**：Mermaid 11、SheetJS 均已本地内置在 `web/vendor/`

### 为什么不用打包器

前端刻意保持零构建：`tauri.conf.json` 的 `frontendDist` 直接指向 `../web` 源目录，改完前端在应用里按 F5 刷新即可，没有等待构建的过程。代价是没有热重载，但换来的是整个前端只有一个文件、随时可以直接用浏览器打开调试。

### 存储抽象

`AppStore` 是唯一的存储入口，自动探测三种后端，工具代码不感知运行环境：

| 环境 | 后端 |
| --- | --- |
| Tauri 桌面端 | Rust `store_read` / `store_write` 命令 |
| Electron | `window.NativeStore` |
| 浏览器 | `localStorage` |

归档键统一使用 `toolbox:<工具>:<字段>` 前缀。写盘通过 Promise 链**串行化**，避免并发写入时后写覆盖先写。

## 目录结构

```
web/
  index.html            前端全部代码（单文件，含四个工具）
  vendor/               离线依赖：mermaid.min.js、xlsx.full.min.js
src-tauri/
  Cargo.toml            依赖声明
  tauri.conf.json       窗口 / 打包 / 安全配置
  capabilities/         权限声明
  icons/                应用图标
  src/
    main.rs             入口
    lib.rs              Rust 侧全部逻辑（存储、导出、系统状态）
tools/
  make-icons.py         重新生成全套图标（Pillow）
  verify-appstore.js    验证 AppStore 三后端行为
  verify-quizcore.js    验证刷题核心算法
  verify-mermaid-release.js  验证 mermaid 加载 / 释放
  verify-sysinfo.js     验证系统状态模块
docs/                   设计与实施方案
```

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

`src-tauri/src/lib.rs` 共注册六个命令：

| 命令 | 作用 |
| --- | --- |
| `store_read` | 读取整个存档 |
| `store_write` | 校验 JSON → 轮转备份 → 临时文件 + rename 原子替换 |
| `save_file` | 原生「另存为」对话框（前端统一走 `saveBlob()`） |
| `sysinfo` | 系统状态快照（内存 / CPU / 进程 / 磁盘），只读 |
| `dir_usage` | 递归统计目录占用 |
| `store_stats` | 统计存档文件与备份数量、总大小 |

### 数据位置

存档默认位于可执行文件同级的 `data/` 目录（由 `lib.rs` 的 `DATA_DIR` 决定），带 `.1/.2/.3` 三级轮转备份，写入节流 30 分钟。

> 注意：`bundle.identifier` 决定 WebView2 用户数据目录，**有数据后不可更改**。要迁移数据位置只需修改 `DATA_DIR` 一处。

## 开发约定

- 前端永远是零构建单文件，不引入打包器
- 归档键前缀统一 `toolbox:<工具>:<字段>`
- 前端导出统一走全局 `saveBlob(blob, name)`，自动适配桌面 / 浏览器环境
- 涉及定时器的模块必须实现完整 `dispose()`：置 `alive = false` → `clearInterval` → 解绑事件监听，且路由切换时要收面板

## 验证脚本

回归测试不依赖任何测试框架，直接用 Node 内置的 `vm` 模块加载 `index.html` 里的代码段并断言：

```bash
node tools/verify-appstore.js
node tools/verify-quizcore.js
node tools/verify-mermaid-release.js
node tools/verify-sysinfo.js
```

## 许可

个人项目，未附许可证。
