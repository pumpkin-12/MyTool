# AI 功能模块方案

> 编写日期：2026-09-15
> 适用项目：个人工具箱（Tauri 2，`D:\Ai-file\MyTool`）
> 状态：**方案待确认，尚未实施**

---

## 1. 先说结论

**不建议一上来就做「AI 板块」。** 建议按三档推进，每档都有可见产出：

| 档位 | 做什么 | 产出 |
|---|---|---|
| **第一档** | AI 配置（base_url / key / model）+ Rust 侧 `ai_chat` 命令 + **刷题错因讲解**一个按钮 | 能真实用起来，验证手感 |
| **第二档** | 把调用逻辑抽成前端统一的 `aiCall()`，加流式、超时、错误处理；再挂 2~3 个入口（日志润色、Mermaid 生成） | 这一步同时在给「通用底座」打底 |
| **第三档** | 若常用 prompt 变多，再考虑独立的 AI 工具（对话面板 / prompt 管理） | 到这时你才知道该做成什么样 |

**为什么这个顺序**：AI 功能的真实需求，只有用起来才知道。先搭一套完整底座再想「拿它做什么」，
大概率搭完就搁置——因为底座本身没有产出。

---

## 2. 现状核对（方案的事实基础）

写方案前实测确认的几件事：

### 2.1 依赖：`reqwest` 零新增下载 ✅

```
Cargo.lock 已含：  reqwest 0.13.5
                   tokio   1.53.1
                   hyper   1.11.1
                   tower   0.5.3
```
本地缓存 `~/.cargo/registry/cache/` 里对应的 `.crate` 文件也都在
（`reqwest-0.13.5.crate` / `tokio-1.53.1.crate` / `hyper-1.11.1.crate` / `tokio-util-0.7.19.crate`）。

**结论**：和当初加 `windows-sys` 的情况一模一样 —— **零新增下载，只是需要编一次**。
`reqwest` 的默认 feature 已把 tokio / hyper / tower / serde_json 全套带齐，
且 `Cargo.lock` 里这份依赖树是完整的（`base64` / `bytes` / `http` / `tower-http` 等全在）。

⚠️ 但要注意：`Cargo.toml` 里**当前没有声明 `reqwest`**，
和 `windows-sys` 一样 —— 它在 `Cargo.lock` 里只是因为别人（tauri 生态）传递依赖引入了它。
**不显式声明就不能 `use`**，必须先加进 `[dependencies]`。

### 2.2 现有可复用的东西

| 已有 | 位置 | AI 模块怎么用 |
|---|---|---|
| `AppStore`（三后端统一存储） | `index.html:387~610` | 存 AI 配置，零学习成本 |
| `uiOverlay(inner)` | `index.html:1042` | AI 结果弹层直接用它，不用新写模态框 |
| `showToast(msg)` | `index.html:657` | 错误提示 |
| `saveBlob(blob, name)` | 全局 | AI 结果导出 |
| `store_write_key` / `store_read_key` | `lib.rs` | 配置落盘走现成的分键存储 |

### 2.3 ⚠️ 一个必须处理的安全问题：Key 会被导出

`AppStore.exportAll()`（`index.html:511`）的实现是：

```js
exportAll() {
  const out = {};
  if (native) {
    const src = mem || {};
    for (const k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = clone(src[k]);
    }
    return out;      // ← 无过滤，mem 里所有键都导出
  }
  ...
}
```

**这意味着**：如果 AI 的 API Key 存在 `toolbox:ai:key`，那么首页点「导出全部数据」时，
**Key 会被明文写进 JSON 文件**。将来若把导出文件发给别人（或传网盘），Key 就跟着走了。

> **实测确认（2026-09-15）**：桌面端实际走的 `native` 分支（`mem` → `out` 直接搬运）
> **不含任何 continue / filter / 排除逻辑**。`localStorage` 分支里那个 `continue` 只是
> 判断键是否带 `toolbox:` 前缀，**不是安全过滤**。所以这个问题在桌面端 100% 成立。

> 这个坑不处理的话，隐患是实打实的 —— 你的导出文件里本来就有日志内容，
> 大概率只会自己留档，但「以为只是备份、其实连密钥一起备了」这种事最容易出意外。

**方案**：见 §5.3，用**双轨存储**（可导出 / 绝不可导出）。

---

## 3. 架构选型：为什么走 Rust 转发

### 3.1 CORS 问题（这是最关键的技术决定）

在 Tauri 的 WebView 里，页面 origin 是 `tauri://localhost`（Windows 上实际是 `http://tauri.localhost`）。
直接 `fetch('https://api.openai.com/v1/chat/completions')` 会遭遇 **CORS 预检失败**，
因为对方不会给这个 origin 放行。

三条出路：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. Rust 转发**（**推荐**） | 加 `reqwest`，前端 `invoke('ai_chat')` | 无 CORS 问题；Key 不落前端；可控制超时/重试/流式 |
| B. 纯前端 fetch | 直接调 | 对**不校验 Origin** 的服务可行（很多国内中转站如此），但依赖对方实现，不稳 |
| C. 放开 CSP | 改 `tauri.conf.json` | **不做** —— `csp: null` 是刻意设的，放开等于交出安全性 |

**选 A。** 代价是 `reqwest` 要编一次；收益是这一层以后所有 AI 功能都能复用。

### 3.2 Key 的存放位置

**Key 只经过 Rust，不在前端持久化。** 具体：

- 前端**不把 Key 存进 `AppStore`**（否则会被 `exportAll` 带走）
- 前端只把 Key **传给 Rust**，由 Rust 写入一个独立文件
- Rust 读取 Key 时前端拿不到明文（`ai_config_get` 只返回「是否已配置」+ 脱敏尾号）

### 3.3 流式输出要不要

**第一档不做流式**，理由：

- 流式需要处理 SSE 分片解析（`data: {...}\n\n`）、`[DONE]` 终止、断线重连
- 第一档的目标是**验证「这个功能有没有用」**，不是打磨体验
- 非流式实现简单得多：一次 `POST` → 拿到完整 JSON → 渲染

**第二档再加流式**，那时用 Tauri 的 `Channel` 或 event 往前端推分片。

---

## 4. 分档详细设计

### 4.1 第一档：最小可用（约 1 天）

#### 改动清单

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | 加 `reqwest = { version = "0.13", default-features = false, features = ["json", "rustls-tls"] }` |
| `src-tauri/src/ai.rs` | **新增文件**，AI 相关命令（保持 `lib.rs` 不被继续撑大） |
| `src-tauri/src/lib.rs` | `mod ai;` + `invoke_handler` 加 3 条命令 |
| `web/index.html` | AI 配置弹层 + `aiCall()` + 刷题「讲解」按钮 |

> 💡 **为什么单独开 `ai.rs`**：`lib.rs` 已经 949 行。AI 这块预计再加 300~400 行，
> 直接塞进去会让单文件过大、`verify-*` 脚本抽源码的边界也变复杂。**分文件是必要的。**

#### Rust 侧：3 条命令

```rust
// ai.rs 骨架（示意，非最终代码）

/// 保存配置。Key 落盘到独立文件，不进 AppStore。
#[tauri::command]
pub fn ai_config_set(endpoint: String, model: String, api_key: Option<String>) -> Result<(), String>

/// 查询配置。**绝不返回 Key 明文**，只回 bool + 尾号。
#[tauri::command]
pub fn ai_config_get() -> Result<AiConfigView, String>
// AiConfigView { endpoint, model, has_key: bool, key_tail: String }

/// 发起一次对话。非流式。
#[tauri::command]
pub async fn ai_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,   // [{role, content}]
    temperature: Option<f32>,
) -> Result<AiReply, String>
// AiReply { text, model, usage: { prompt_tokens, completion_tokens } }
```

**接口按 OpenAI 兼容格式**（`POST {endpoint}/chat/completions`），这样
OpenAI / DeepSeek / 智谱 / 月之暗面 / 各类中转站**都能直接用**，不需要为每家写适配。

#### Key 落盘位置（关键）

```
D:\Ai-file\MyTool\data\ai\config.json     ← 配置
D:\Ai-file\MyTool\data\ai\secret.json     ← 只有 Key
```

**为什么单独一个目录**：`data/keys/` 是 `AppStore` 的地盘，**它的文件会被 `exportAll` 导出**。
把密钥放进 `data/ai/`（`AppStore` 不管理的目录），从物理上杜绝被导出。

#### 前端侧：`aiCall()` 雏形

```js
/* AI 调用统一入口。第一档只做非流式；
 * 第二档在这里加流式分支，调用方不用改。 */
async function aiCall(systemPrompt, userText, opts) {
  opts = opts || {};
  if (!window.__TAURI__) {
    showToast('AI 功能需要桌面端');
    return null;
  }
  try {
    const r = await window.__TAURI__.core.invoke('ai_chat', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText }
      ],
      temperature: opts.temperature == null ? 0.7 : opts.temperature
    });
    return r.text;
  } catch (e) {
    showToast('AI 调用失败：' + (e && e.message ? e.message : e));
    return null;
  }
}
```

#### 第一个入口：刷题「错因讲解」

**为什么选它做第一个**：
- 输入输出都是纯文本，无图片、无结构转换
- 你题库里已有 `question` / `answer` / `explanation` 字段，**上下文现成**
- 对备考（软考 + 嵌入式 Linux）的实际价值最高 —— 答错后知道「为什么错」比看答案有用

**交互**：答题结果页 / 错题本里，每道错题旁加「AI 讲解」按钮 → 点开 `uiOverlay` 显示讲解。

**Prompt 设计要点**：
- system：明确「你是软考/计算机基础课程助教，只讲这道题为什么错，不扩展无关内容」
- user：拼上题干 + 选项 + 正确答案 + 用户所选项
- **限制输出长度**（否则容易写一大篇废话）

### 4.2 第二档：可复用层（约 1~2 天）

| 项 | 内容 |
|---|---|
| 流式输出 | Rust 用 `reqwest` 的 `bytes_stream()`，通过 Tauri `Channel` 往前端推；前端打字机渲染 |
| 超时与重试 | `reqwest` 的 `.timeout()`；对 429 / 5xx 做一次退避重试 |
| 统一错误分类 | 把 `401 密钥无效` / `429 限流` / `网络不通` 分成不同提示，而不是笼统「调用失败」 |
| 用量统计 | 每次调用的 token 数记进 `toolbox:ai:usage`，面板里能看到花了多少 |
| 更多入口 | 日志润色、Mermaid 自然语言生成、便签整理 |

**这一档做完，其实路线 C（通用底座）就已经成型了** —— 只是以「被三个功能用着」的形态存在，
而不是先搭一个没人用的抽象层。

### 4.3 第三档：独立 AI 工具（按需）

**触发条件**（不满足就不做）：
- 常用 prompt 超过 8~10 条，靠记住不现实
- 需要多轮对话（而不是一次性问答）
- 想把题库/日志当资料库来问答

**形态**：`registerTool({ id: 'ai', ... })` 加为第 5 个工具。
⚠️ 注意它会让 `index.html` 再涨 1000+ 行（届时约 6500 行，仍在 8000 警戒线内）。

---

## 5. 需要特别处理的三件事

### 5.1 后端流式别用「假流式」

如果第二档做流式，**不要在前端用 `setInterval` 逐字显示完整结果**来冒充流式。
那样首字延迟依然是完整生成时间（长回答要等十几秒），反而更糟。
**要真流式**：Rust 侧 `bytes_stream()` 边收边推。

### 5.2 网络不可用的降级

桌面应用可能离线。要求：
- 调用前不预检网络（会白等一次），**直接调，超时给明确提示**
- 超时设 **60 秒**（长文本生成可能较久，不要设 10 秒就断）
- 错误提示要能区分「超时」和「连不上」，便于排查

### 5.3 Key 不出导出文件（**必须做**）

三层防护：

1. **物理隔离**：Key 存 `data/ai/secret.json`，不进 `data/keys/` → `exportAll` 天然拿不到
2. **导出过滤**（防御性）：给 `exportAll` 加一道保险，即使将来有人把 Key 写进了 `AppStore`：

   ```js
   /* 这些键永不导出：含密钥/凭据。加白名单式排除，不靠"记得别存"。 */
   const NEVER_EXPORT = /^toolbox:ai:(key|secret|token)/;
   exportAll() {
     // ... 原有逻辑，取值时加一句：
     if (NEVER_EXPORT.test(k)) continue;
   }
   ```
3. **UI 提示**：配置弹层里写明「密钥仅存本机，不会随导出文件外传」

⚠️ **第 2 条要做，且要加测试**：`verify-appstore.js` 里加一条断言 ——
`exportAll` 的返回值中不含匹配 `NEVER_EXPORT` 的键。

---

## 6. 测试计划

沿用项目现有的「验证脚本」纪律（新增断言**必须反向验证**）：

| 脚本 | 新增内容 |
|---|---|
| **新增** `tools/verify-ai.js` | ① `ai.rs` 存在且命令已注册进 `generate_handler` ② `ai_config_get` **不返回 Key 明文字段** ③ 前端 `aiCall` 存在且非流式路径可解析 ④ prompt 拼接含题干/答案 |
| `verify-appstore.js` | 加 `[导出安全]` 段：`exportAll` 结果不含 `toolbox:ai:key` |

**反向验证**（照项目惯例，必须做）：
- 把 `NEVER_EXPORT` 判断删掉 → 导出安全断言应报 FAIL
- 让 `ai_config_get` 返回 `api_key` → 「不返回明文」断言应报 FAIL

> 🔴 **别重蹈 `verify-mermaid-release.js` 的覆辙**：新脚本写完，先确认
> **报告文件真的产出、项数对得上**，再做反向验证。9-15 那次就是脚本假绿了两天没人发现。

---

## 7. 决策点（需要你拍板）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 用哪家 API？ | 按 **OpenAI 兼容格式**实现，具体用哪家你随时可在配置里改 endpoint |
| 2 | 第一档做哪个入口？ | **刷题错因讲解**（纯文本、上下文现成、对你备考最有用） |
| 3 | 接受加 `reqwest`？ | **建议接受**，零新增下载只需编一次；否则只能纯前端 fetch，不稳 |
| 4 | 流式输出？ | 第一档不做，第二档做真流式 |
| 5 | Key 双轨存储 | 建议按 §5.3 三层防护 |

---

## 8. 风险与限制

| 风险 | 说明 | 应对 |
|---|---|---|
| `reqwest` 编译时间 | 新增一个较重的依赖树参与编译 | 一次性的，之后增量编译无感 |
| CORS（若走纯前端） | 部分服务不放行 `tauri://localhost` | 走 Rust 转发即无此问题 |
| 费用不可控 | 云端 API 按 token 计费 | 第二档加用量统计；第一档靠控制 prompt 长度 |
| 数据外传 | 日志/题库内容会发给第三方 | 若在意，后续可加「本地模型（Ollama）」作为可切换 provider |
| `index.html` 继续膨胀 | 第三档会让它破 6000 行 | 仍在 8000 警戒线内；届时再评估是否拆多个 `<script>` |

---

## 9. 下一步

方案确认后，**先出第一档的代码改动**：

1. `Cargo.toml` 加 `reqwest`
2. 新建 `src-tauri/src/ai.rs`
3. `lib.rs` 注册 3 条命令
4. `index.html` 加 AI 配置弹层 + `aiCall()` + 刷题讲解按钮
5. 新增 `tools/verify-ai.js`；`verify-appstore.js` 加导出安全断言
6. **需要重新编译**（Rust 改动），成功标志是配置弹层能保存、讲解按钮能出结果

---

*本方案为 Markdown 文档，按项目约定存放于 `docs/`。*
