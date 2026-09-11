//! 个人工具箱 · Tauri 后端
//!
//! 只做三件事：
//!   1. 把前端 AppStore 的全量 JSON 读写到磁盘（store_read / store_write）
//!   2. 提供原生「另存为」对话框，替代 WebView 里不可控的 <a download>
//!   3. 轮转保留最近几份存档，防止误删或写坏后无法回退
//!
//! 前端侧对应代码：web/index.html 的 AppStore 存储抽象层。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 全量存档文件名。前端所有 toolbox:* 键都存在这一个 JSON 里。
const STORE_FILE: &str = "store.json";

/// 存档轮转保留的份数（.1 / .2 / .3）
const BACKUP_KEEP: usize = 3;

/// 轮转的最小间隔。存档可能在画板拖拽时每 400ms 写一次，
/// 不能每次都复制一遍几 MB 的文件，否则会拖垮界面。
const BACKUP_INTERVAL: Duration = Duration::from_secs(1800);

#[derive(Default)]
struct BackupGate(Mutex<Option<Instant>>);

/// 解析存档路径，顺便保证目录存在。
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法解析应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join(STORE_FILE))
}

/// 把当前存档轮转一份到 .1，原 .1 → .2 → .3，超出份数的丢弃。
/// 受 BACKUP_INTERVAL 节流；任何一步失败都不影响主流程。
fn rotate_backups(path: &std::path::Path, gate: &BackupGate) {
    let now = Instant::now();
    {
        let mut last = match gate.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(t) = *last {
            if now.duration_since(t) < BACKUP_INTERVAL {
                return;
            }
        }
        *last = Some(now);
    }

    for i in (1..BACKUP_KEEP).rev() {
        let from = path.with_extension(format!("json.{i}"));
        let to = path.with_extension(format!("json.{}", i + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("json.1"));
    }
}

/// 启动时一次性读全量存档。文件不存在不算错误，返回空对象即可。
#[tauri::command]
fn store_read(app: AppHandle) -> Result<String, String> {
    let path = store_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("读取存档失败: {e}")),
    }
}

/// 全量写入。先校验 JSON 合法性，再经临时文件原子替换，
/// 保证「写一半断电」不会留下半截损坏的存档。
#[tauri::command]
fn store_write(app: AppHandle, data: String, gate: State<'_, BackupGate>) -> Result<usize, String> {
    // 坏数据绝不落盘 —— 前端如果 stringify 出错，这里会拦住
    serde_json::from_str::<serde_json::Value>(&data)
        .map_err(|e| format!("拒绝写入：内容不是合法 JSON（{e}）"))?;

    let path = store_path(&app)?;

    rotate_backups(&path, &gate);

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes()).map_err(|e| format!("写临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换存档失败: {e}"))?;

    Ok(data.len())
}

/// 原生「另存为」。前端把内容转成 base64 传进来 —— 不用字节数组，
/// 因为字节数组走 JSON IPC 会把每个字节展开成 "255," 的形式，体积爆炸。
///
/// 返回空字符串表示用户取消了对话框。
#[tauri::command]
async fn save_file(
    app: AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("内容解码失败: {e}"))?;

    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    let mut dialog = app.dialog().file().set_file_name(&file_name);
    if let Some(ref e) = ext {
        dialog = dialog.add_filter(e.to_uppercase(), &[e.as_str()]);
    }

    // blocking_* 不能跑在主线程上，所以这条命令必须是 async
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(String::new());
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("目标路径无效: {e}"))?;

    fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册。第二实例启动时立刻回调这里，聚焦已有窗口后自行退出。
        // 不做这件事的话：AppStore 启动时把整个存档读进内存、之后全量写回，
        // 两个实例（例如装好的版本 + 便携版）同时开着会互相覆盖，后写的把另一份改动全抹掉。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(BackupGate::default())
        .invoke_handler(tauri::generate_handler![store_read, store_write, save_file])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
