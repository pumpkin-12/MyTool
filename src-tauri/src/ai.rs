//! AI 功能（第一档）：配置读写 + 一次非流式对话。
//!
//! 为什么走 Rust 转发而不是前端直接 fetch：
//!   · WebView 里的页面 origin 是 `http://tauri.localhost`，直接 fetch 外部 API 会栽在
//!     CORS 预检上（对方不会给这个 origin 放行）
//!   · 而且现在的 CSP 是 `connect-src 'self' ipc: http://ipc.localhost`，
//!     外部域名根本连不出去 —— 这一层已经不是"更优选择"，是**唯一选择**
//!
//! 🔴 两条硬纪律：
//!   1. **Key 不落 AppStore**。它在 `data/ai/secret.json`，而 `AppStore` 只管 `data/keys/`。
//!      `exportAll()` 是"把内存里所有键原样搬运"、没有任何过滤，所以只要 Key 不进去，
//!      就绝对导不出去 —— 这是物理隔离，比任何白名单都可靠。
//!   2. **`ai_config_get` 绝不返回 Key 明文**，只回 `has_key` + 尾 4 位。
//!      所以 `AiConfigView` 结构体里**根本没有 api_key 字段**（verify-ai.js 有断言钉着）。
//!
//! 接口按 **OpenAI 兼容**格式（`POST {endpoint}/chat/completions`），
//! 这样 OpenAI / DeepSeek / 智谱 / 月之暗面 / 各类中转站都能直接用，不用逐家适配。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/* ---------- 落盘位置 ----------
 * data/ai/config.json  —— 接口地址与模型名（**可以**跟着全量导出走）
 * data/ai/secret.json  —— 只有 API Key（**绝不**能被导出：AppStore 不管这个目录） */
const AI_DIR: &str = "ai";
const CFG_FILE: &str = "config.json";
const SECRET_FILE: &str = "secret.json";
const TIMEOUT_SECS: u64 = 60;

fn ai_dir() -> Result<PathBuf, String> {
    let dir = PathBuf::from(crate::DATA_DIR).join(AI_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 AI 配置目录失败：{e}"))?;
    Ok(dir)
}

/* ---------- 磁盘结构 ---------- */
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct AiConfigFile {
    endpoint: String,
    model: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct AiSecretFile {
    api_key: String,
}

/// 给前端看的配置视图。**故意不含 api_key 字段** —— 让"泄露"这件事在类型层面就不可能。
#[derive(Serialize)]
pub struct AiConfigView {
    endpoint: String,
    model: String,
    has_key: bool,
    /// Key 的后 4 位，仅用于让用户确认"填的是哪一把"，不足以还原
    key_tail: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
pub struct AiReply {
    text: String,
    model: String,
    prompt_tokens: u32,
    completion_tokens: u32,
}

fn read_cfg() -> AiConfigFile {
    let p = match ai_dir() {
        Ok(d) => d.join(CFG_FILE),
        Err(_) => return AiConfigFile::default(),
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<AiConfigFile>(&s).ok())
        .unwrap_or_default()
}

fn read_secret() -> AiSecretFile {
    let p = match ai_dir() {
        Ok(d) => d.join(SECRET_FILE),
        Err(_) => return AiSecretFile::default(),
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<AiSecretFile>(&s).ok())
        .unwrap_or_default()
}

/* ---------- 命令 1：保存配置 ----------
 * api_key 的三态语义（前端负责把"输入框留空"转成 None）：
 *   None          = 不改动现有 Key（用户只改了 endpoint/model）
 *   Some("")      = 清除 Key
 *   Some(非空)    = 覆盖 */
#[tauri::command]
pub fn ai_config_set(
    endpoint: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let dir = ai_dir()?;
    let cfg = AiConfigFile {
        endpoint: endpoint.trim().trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
    };
    let js = serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化配置失败：{e}"))?;
    fs::write(dir.join(CFG_FILE), js).map_err(|e| format!("写入配置失败：{e}"))?;

    if let Some(k) = api_key {
        let k = k.trim().to_string();
        if k.is_empty() {
            /* 清除：直接删文件，而不是写个空字符串 —— 盘上不留痕迹 */
            let p = dir.join(SECRET_FILE);
            if p.exists() {
                fs::remove_file(&p).map_err(|e| format!("清除密钥失败：{e}"))?;
            }
        } else {
            let sec = AiSecretFile { api_key: k };
            let js = serde_json::to_string_pretty(&sec).map_err(|e| format!("序列化密钥失败：{e}"))?;
            fs::write(dir.join(SECRET_FILE), js).map_err(|e| format!("写入密钥失败：{e}"))?;
        }
    }
    Ok(())
}

/* ---------- 命令 2：读取配置（绝不回明文） ---------- */
#[tauri::command]
pub fn ai_config_get() -> Result<AiConfigView, String> {
    let cfg = read_cfg();
    let sec = read_secret();
    let key = sec.api_key.trim();
    let tail = if key.chars().count() >= 4 {
        key.chars().skip(key.chars().count() - 4).collect::<String>()
    } else {
        String::new()
    };
    Ok(AiConfigView {
        endpoint: cfg.endpoint,
        model: cfg.model,
        has_key: !key.is_empty(),
        key_tail: tail,
    })
}

/* ---------- 命令 3：发起一次对话（非流式） ----------
 * 第一档不做流式：流式要处理 SSE 分片解析、[DONE] 终止、断线重连，
 * 而这一档的目标是"验证这个功能有没有用"，不是打磨体验。第二档再加。 */
#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
) -> Result<AiReply, String> {
    let cfg = read_cfg();
    let key = read_secret().api_key.trim().to_string();
    if cfg.endpoint.is_empty() {
        return Err("还没配置接口地址".into());
    }
    if key.is_empty() {
        return Err("还没配置 API Key".into());
    }

    let url = chat_url(&cfg.endpoint);
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.7_f32),
    });

    /* 每次新建 client。对一个"点一下才调一次"的个人工具来说，
     * 连接池的意义不大，而全局单例要么用 OnceLock 要么要 AppHandle，
     * 都会把第一档的复杂度抬上去 —— 第二档真嫌慢再改。 */
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| classify_transport_err(&e, &url))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        /* 🔴 这里的每个分支都**不含请求头与 Key** ——
         * 错误信息会显示在界面上、也可能被截图，绝不能把密钥带出去。 */
        return Err(match status.as_u16() {
            401 => "API Key 无效或已过期（401）".to_string(),
            403 => "没有权限（403）—— 检查这把 Key 是否开通了该模型".to_string(),
            404 => format!("接口不存在（404）—— 检查接口地址是否要带 /v1：{url}"),
            429 => "触发限流（429），稍后再试".to_string(),
            s if s >= 500 => format!("对方服务出错（{s}），稍后再试"),
            s => format!("请求被拒绝（{s}）：{}", api_error_message(&text)),
        });
    }

    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("对方返回的不是合法 JSON：{e}"))?;

    let reply = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if reply.is_empty() {
        return Err("对方返回了空内容（可能被内容策略拦下，或模型名不对）".into());
    }

    Ok(AiReply {
        text: reply,
        model: v["model"].as_str().unwrap_or(&cfg.model).to_string(),
        prompt_tokens: v["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32,
        completion_tokens: v["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32,
    })
}

/* ---------- 小工具 ---------- */

/// 拼 `/chat/completions`。用户很可能把整条 URL 粘进来，所以要先判断。
fn chat_url(endpoint: &str) -> String {
    let e = endpoint.trim().trim_end_matches('/');
    if e.ends_with("/chat/completions") {
        e.to_string()
    } else {
        format!("{e}/chat/completions")
    }
}

/// 传输层错误分类。`reqwest::Error` 的 Display 只含 URL 与原因，**不含请求头**。
fn classify_transport_err(e: &reqwest::Error, url: &str) -> String {
    if e.is_timeout() {
        return format!("请求超时（{TIMEOUT_SECS} 秒）—— 网络慢或对方没响应");
    }
    if e.is_connect() {
        return format!("连不上 {url} —— 检查接口地址与网络（桌面端不联网时也会这样）");
    }
    format!("请求失败：{e}")
}

/// 从错误响应体里抠 `{"error":{"message":"..."}}`，抠不到就截断原文。
fn api_error_message(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v["error"]["message"].as_str() {
            return m.to_string();
        }
        if let Some(m) = v["message"].as_str() {
            return m.to_string();
        }
    }
    let t = body.trim();
    if t.is_empty() {
        "（对方没给错误说明）".to_string()
    } else {
        t.chars().take(200).collect()
    }
}
