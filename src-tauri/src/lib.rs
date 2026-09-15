//! 个人工具箱 · Tauri 后端
//!
//! 只做四件事：
//!   1. 把前端 AppStore 的数据读写到磁盘
//!      - 分键存储（store_read_key / store_write_key / store_del_key）：每键一个文件，
//!        改画板不再重写整个题库
//!      - 全量读写（store_read / store_write）：仅用于导入导出与迁移
//!   2. 提供原生「另存为」对话框，替代 WebView 里不可控的 <a download>
//!   3. 管理画板图片资产（asset_put / asset_get / asset_del），
//!      图片落盘为 data/assets/<sha1>.<ext>，避免 base64 撑爆存档
//!   4. 只读地汇报系统状态（sysinfo / dir_usage / store_stats）
//!
//! 前端侧对应代码：web/index.html 的 AppStore 存储抽象层 + 系统状态模态框。
//!
//! 存储布局（DATA_DIR 下）：
//! ```text
//! data/
//!   keys/                 每键一个 JSON：<key 的 sha1>.json
//!   assets/               画板图片：<sha1>.<ext>
//!   store.json            旧版全量存档（迁移后改名为 store.json.migrated-bak）
//!   store.json.1/.2/.3    轮转备份
//! ```

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
#[cfg(windows)]
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, GetPerformanceInfo,
    PERFORMANCE_INFORMATION, PROCESS_MEMORY_COUNTERS_EX};
#[cfg(windows)]
use windows_sys::Win32::System::SystemInformation::{
    GetNativeSystemInfo, GetPhysicallyInstalledSystemMemory, GetTickCount64, GlobalMemoryStatusEx,
    MEMORYSTATUSEX, SYSTEM_INFO,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetSystemTimes};

/// 全量存档文件名（旧格式，迁移后仅作备份保留）。
const STORE_FILE: &str = "store.json";

/// 迁移完成后旧全量存档改成这个名字，作为回滚点。
const STORE_MIGRATED: &str = "store.json.migrated-bak";

/// 分键存储目录：每键一个小 JSON，避免「改一个键重写整个存档」。
const KEYS_DIR: &str = "keys";

/// 画板图片资产目录。
const ASSETS_DIR: &str = "assets";

/// 存档轮转保留的份数（.1 / .2 / .3）
const BACKUP_KEEP: usize = 3;

/// 轮转的最小间隔。存档可能在画板拖拽时每 400ms 写一次，
/// 不能每次都复制一遍几 MB 的文件，否则会拖垮界面。
const BACKUP_INTERVAL: Duration = Duration::from_secs(1800);

#[derive(Default)]
struct BackupGate(Mutex<Option<Instant>>);

/// 用户指定的数据目录（不放系统盘）。放在项目目录下的 data/ 子文件夹，
/// 便于整体备份、不与源码混在一起。
/// 若要改位置，只改这里即可（注意：改后旧数据不会自动出现在新目录，
/// 除非保留下方 migrate_legacy 的迁移逻辑，或手动搬移）。
const DATA_DIR: &str = "D:\\Ai-file\\MyTool\\data";

/// 解析存档路径，顺便保证目录存在。
fn store_path() -> Result<PathBuf, String> {
    let dir = PathBuf::from(DATA_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join(STORE_FILE))
}

/// 分键目录，自动创建。
fn keys_dir() -> Result<PathBuf, String> {
    let dir = PathBuf::from(DATA_DIR).join(KEYS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建分键目录失败: {e}"))?;
    Ok(dir)
}

/// 资产目录，自动创建。
fn assets_dir() -> Result<PathBuf, String> {
    let dir = PathBuf::from(DATA_DIR).join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建资产目录失败: {e}"))?;
    Ok(dir)
}

/// 用 SHA-1 给键名/文件名编个稳定且文件系统安全的短名。
/// 键里含 `:` 和 `<` `>`（如 `toolbox:sketch:shapes`），Windows 文件名不允许。
fn short_hash(s: &str) -> String {
    // 自实现 SHA-1，避免为一个哈希引入新依赖（sha1 crate 未缓存）。
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = s.as_bytes().to_vec();
    let bit_len = (msg.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for i in 0..80 {
            let (f, k) = if i < 20 {
                ((b & c) | ((!b) & d), 0x5A827999u32)
            } else if i < 40 {
                (b ^ c ^ d, 0x6ED9EBA1)
            } else if i < 60 {
                ((b & c) | (b & d) | (c & d), 0x8F1BBCDC)
            } else {
                (b ^ c ^ d, 0xCA62C1D6)
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// 分键文件名。加 `.json` 后缀便于肉眼识别。
fn key_file(key: &str) -> Result<PathBuf, String> {
    Ok(keys_dir()?.join(format!("{}.json", short_hash(key))))
}

/// 把旧的全量 store.json 拆成分键文件。
///
/// 幂等：若旧文件已改名为 migrated-bak，直接返回；
/// 原子性：先把每个键逐个写入并读回校验，全部成功后才改名旧文件。
/// 不删数据：旧文件只改名，`.1/.2/.3` 备份原样保留。
fn migrate_to_keys() -> Result<(), String> {
    let dir = PathBuf::from(DATA_DIR);
    let old = dir.join(STORE_FILE);
    let done = dir.join(STORE_MIGRATED);

    // 已迁过，或本来就没有旧文件 → 无需处理
    if done.exists() || !old.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(&old).map_err(|e| format!("读取旧存档失败: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("旧存档不是合法 JSON，放弃迁移: {e}"))?;

    let map = match value {
        serde_json::Value::Object(m) => m,
        _ => return Err("旧存档顶层不是对象，放弃迁移".to_string()),
    };

    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;

    // 先全部写出来，再逐个读回校验，任何一个失败就中止（此时旧文件还在）
    for (k, v) in &map {
        let path = key_file(k)?;
        let wrapper = serde_json::json!({ "k": k, "v": v.clone() });
        let text = serde_json::to_string(&wrapper).map_err(|e| format!("序列化键 {k} 失败: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入键 {k} 失败: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("落盘键 {k} 失败: {e}"))?;
    }
    for k in map.keys() {
        let path = key_file(k)?;
        let back = fs::read_to_string(&path).map_err(|e| format!("回读键 {k} 失败: {e}"))?;
        let wrapper: serde_json::Value =
            serde_json::from_str(&back).map_err(|e| format!("回读键 {k} 校验失败: {e}"))?;
        // 键名必须能还原，否则读回时这份数据就丢了
        if wrapper.get("k").and_then(|v| v.as_str()) != Some(k.as_str()) {
            return Err(format!("回读键 {k} 的键名不匹配，放弃迁移"));
        }
    }

    // 全部就位后才动旧文件（改名而非删除，留作回滚点）
    fs::rename(&old, &done).map_err(|e| format!("归档旧存档失败: {e}"))?;
    Ok(())
}

/// 首次切到新数据目录时，若目标 store.json 不存在、但旧 %APPDATA% 位置有存档，
/// 整体搬过来（含 .1/.2/.3 轮转备份）。保证切换存储路径不丢历史数据。
/// 只在目标文件缺失时触发一次；之后不再触碰旧目录。
fn migrate_legacy(app: &AppHandle) -> Result<(), String> {
    let dir = PathBuf::from(DATA_DIR);
    let new_path = dir.join(STORE_FILE);
    if new_path.exists() {
        return Ok(());
    }
    let old_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return Ok(()),
    };
    let old_path = old_dir.join(STORE_FILE);
    if !old_path.exists() {
        return Ok(());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    for ext in &["", ".1", ".2", ".3"] {
        let from = old_dir.join(format!("store.json{}", ext));
        let to = dir.join(format!("store.json{}", ext));
        if from.exists() {
            let _ = fs::copy(&from, &to);
        }
    }
    Ok(())
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

/// 启动时读全量存档（仅用于导入导出与兼容）。
/// 顺带把旧的全量存档迁移成分键存储。
#[tauri::command]
fn store_read(app: AppHandle) -> Result<String, String> {
    migrate_legacy(&app)?;
    // 旧格式 → 分键格式。失败不阻断启动：分键读取会各自回落为空，
    // 而旧文件仍在，用户可以手工排查。
    let _ = migrate_to_keys();
    let path = store_path()?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("读取存档失败: {e}")),
    }
}

/// 全量写入。先校验 JSON 合法性，再经临时文件原子替换，
/// 保证「写一半断电」不会留下半截损坏的存档。
///
/// 迁移到分键存储后，这个命令只用于「导入全部数据」这类一次性场景；
/// 日常保存走 store_write_key，避免改一个键重写整个存档。
#[tauri::command]
fn store_write(data: String, gate: State<'_, BackupGate>) -> Result<usize, String> {
    // 坏数据绝不落盘 —— 前端如果 stringify 出错，这里会拦住
    serde_json::from_str::<serde_json::Value>(&data)
        .map_err(|e| format!("拒绝写入：内容不是合法 JSON（{e}）"))?;

    let path = store_path()?;

    rotate_backups(&path, &gate);

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes()).map_err(|e| format!("写临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换存档失败: {e}"))?;

    Ok(data.len())
}

/// 读取单个键。键不存在返回 "null"（与 JSON null 对应，前端据此回落到默认值）。
#[tauri::command]
fn store_read_key(key: String) -> Result<String, String> {
    let path = key_file(&key)?;
    match fs::read_to_string(&path) {
        Ok(s) => {
            // 文件里存的是 {"k":<键名>,"v":<值>} 包装，取出 v 返回
            let wrapper: serde_json::Value =
                serde_json::from_str(&s).map_err(|e| format!("键 {key} 内容损坏: {e}"))?;
            let v = wrapper.get("v").cloned().unwrap_or(serde_json::Value::Null);
            Ok(v.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("null".to_string()),
        Err(e) => Err(format!("读取键 {key} 失败: {e}")),
    }
}

/// 一次读回全部分键，合并成一个对象返回。仅用于启动时建立内存副本 —— 
/// 键名被哈希过，前端无法自己拼文件名逐个读。
///
/// 键名存在文件内容里（格式：`{"k":"toolbox:quiz:questions","v":<原值>}`），
/// 这样即使哈希算法变了也还能还原出原始键名。
#[tauri::command]
fn store_read_all() -> Result<String, String> {
    let dir = keys_dir()?;
    let mut out = serde_json::Map::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&p) else { continue };
            let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let k = wrapper.get("k").and_then(|v| v.as_str()).unwrap_or("");
            if k.is_empty() {
                continue;
            }
            let v = wrapper.get("v").cloned().unwrap_or(serde_json::Value::Null);
            out.insert(k.to_string(), v);
        }
    }
    Ok(serde_json::Value::Object(out).to_string())
}

/// 写入单个键。原子替换，坏 JSON 拒绝落盘。
/// 单键写入不触发全量轮转备份 —— 键文件本身很小，且频繁写会把备份冲掉。
///
/// 落盘格式是 `{"k":<键名>,"v":<值>}` 的包装：键名被哈希成文件名后，
/// 原始键名只能靠文件内容保存，否则 `store_read_all` 无法还原。
#[tauri::command]
fn store_write_key(key: String, data: String) -> Result<usize, String> {
    let value: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("拒绝写入键 {key}：内容不是合法 JSON（{e}）"))?;

    let wrapper = serde_json::json!({ "k": key, "v": value });
    let text = serde_json::to_string(&wrapper)
        .map_err(|e| format!("序列化键 {key} 失败: {e}"))?;

    let path = key_file(&key)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换键 {key} 失败: {e}"))?;

    Ok(text.len())
}

/// 删除单个键。键不存在也算成功（幂等）。
#[tauri::command]
fn store_del_key(key: String) -> Result<bool, String> {
    let path = key_file(&key)?;
    match fs::remove_file(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("删除键 {key} 失败: {e}")),
    }
}

/// 列出所有分键的键名与体积，供系统状态面板展示。
/// 文件名是哈希值，对用户没意义，所以从文件内容里读出原始键名。
#[tauri::command]
fn store_keys() -> Result<String, String> {
    let dir = keys_dir()?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue; // 跳过 .tmp 残留
            }
            let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
            let name = fs::read_to_string(&p)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|w| w.get("k").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| {
                    p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
                });
            items.push(serde_json::json!({ "key": name, "size": size }));
        }
    }
    items.sort_by(|a, b| {
        let sa = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        let sb = b.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        sb.cmp(&sa)
    });
    let total: u64 = items
        .iter()
        .map(|i| i.get("size").and_then(|v| v.as_u64()).unwrap_or(0))
        .sum();
    Ok(serde_json::json!({
        "dir": PathBuf::from(DATA_DIR).join(KEYS_DIR).to_string_lossy(),
        "count": items.len(),
        "total": total,
        "items": items,
    })
    .to_string())
}

/// 保存画板图片资产。前端传 base64（不走字节数组，避免 JSON IPC 体积爆炸），
/// 落盘为 assets/<sha1>.<ext>，返回给前端的是资产 id（即 sha1）。
#[tauri::command]
fn asset_put(data_base64: String, ext: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("资产 base64 解码失败: {e}"))?;

    // 用内容哈希做文件名：同样的图重复插入只存一份，天然去重
    let id = short_hash(&bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());

    // 扩展名只允许字母数字，防止路径穿越
    let clean_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let name = if clean_ext.is_empty() {
        format!("{id}.bin")
    } else {
        format!("{id}.{}", clean_ext.to_ascii_lowercase())
    };

    let path = assets_dir()?.join(&name);
    if !path.exists() {
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &bytes).map_err(|e| format!("写入资产失败: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("落盘资产失败: {e}"))?;
    }
    Ok(name)
}

/// 读取画板图片资产，返回 data URL 供 <img> 直接使用。
#[tauri::command]
fn asset_get(name: String) -> Result<String, String> {
    // 只允许取裸文件名，挡住 ../ 之类的穿越
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法资产名".to_string());
    }
    let path = assets_dir()?.join(&name);
    let bytes = fs::read(&path).map_err(|e| format!("读取资产 {name} 失败: {e}"))?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 删除画板图片资产。不存在也算成功（幂等）。
#[tauri::command]
fn asset_del(name: String) -> Result<bool, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法资产名".to_string());
    }
    let path = assets_dir()?.join(&name);
    match fs::remove_file(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("删除资产 {name} 失败: {e}")),
    }
}

/// 统计资产目录：文件数与总体积，供系统状态面板展示。
#[tauri::command]
fn asset_stats() -> Result<String, String> {
    let dir = assets_dir()?;
    let mut count: u64 = 0;
    let mut total: u64 = 0;
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|s| s.to_str()) == Some("tmp") {
                continue;
            }
            if p.is_file() {
                count += 1;
                total += ent.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "count": count,
        "total": total,
    })
    .to_string())
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

// ---------------------------------------------------------------------------
// 系统状态（只读）
//
// 设计前提：这是一个「诊断面板」，不是任务管理器。所有函数都不写入任何系统状态、
// 不结束任何进程、不改任何设置 —— 拿不准要不要加的功能，就不加。
//
// 关于 CPU：GetSystemTimes 返回的是**开机以来的累计 tick**，单次调用拿不到"占用率"，
// 必须两次采样做差。因此这里用一个 State 保存上一次的采样值，第一次调用返回 -1
// 表示"测量中"，前端据此显示占位符而不是画一个假的 0%。
// ---------------------------------------------------------------------------

/// 上一次的 (idle, kernel, user) 累计 tick。仅用于 CPU 做差。
#[derive(Default)]
struct CpuSample(Mutex<Option<(u64, u64, u64)>>);

#[cfg(windows)]
fn filetime_to_u64(ft: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

/// 系统 CPU 占用率（0~100）。
///
/// 首次调用没有基准，返回 None —— 前端显示"测量中"。
/// 注意：Windows 的 kernel time **已经包含** idle time，
/// 所以总时间 = (kernel - prev_kernel) + (user - prev_user)，**不要再单独加一次 idle**。
#[cfg(windows)]
fn cpu_percent(state: &CpuSample) -> Option<f64> {
    unsafe {
        let (mut idle, mut kern, mut user) = std::mem::zeroed();
        if GetSystemTimes(&mut idle, &mut kern, &mut user) == 0 {
            return None;
        }
        let cur = (
            filetime_to_u64(&idle),
            filetime_to_u64(&kern),
            filetime_to_u64(&user),
        );

        let mut guard = match state.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let prev = guard.replace(cur);

        let (pi, pk, pu) = prev?;
        let d_idle = cur.0.saturating_sub(pi);
        let d_total = cur.1.saturating_sub(pk) + cur.2.saturating_sub(pu);
        if d_total == 0 {
            return None;
        }
        let busy = 1.0 - (d_idle as f64 / d_total as f64);
        Some((busy * 100.0).clamp(0.0, 100.0))
    }
}

/// 读注册表拿 CPU 型号名，例如 "12th Gen Intel(R) Core(TM) i5-12500H"。
/// 这是唯一不引入 WMI/COM 就能拿到型号的轻量途径。
/// 读不到就返回空串，前端不显示这一行。
///
/// 为什么不直接用 `windows-sys` 的 `Win32_System_Registry` feature：
/// 那要为一个函数多编一整个 feature，这里手工声明两个符号就够。
#[cfg(windows)]
fn cpu_brand() -> String {
    // RegOpenKeyExW 在 64 位下要 key = HKEY_LOCAL_MACHINE（预定义值），
    // 声明成 isize 而非 *mut c_void 是为了凑够指针宽度 —— 值本身是 0x80000002。
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
    const KEY_READ: u32 = 0x2_0019;      // STANDARD_RIGHTS_READ | KEY_QUERY_VALUE | ...
    const KEY_WOW64_64KEY: u32 = 0x0100;

    // 返回类型用 i32（LSTATUS / LONG），不用 windows_sys 的 BOOL —— 免得为它引 Win32_Foundation。
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            hkey: isize,
            sub_key: *const u16,
            options: u32,
            desired: u32,
            result: *mut isize,
        ) -> i32;
        fn RegQueryValueExW(
            hkey: isize,
            value_name: *const u16,
            reserved: *mut u32,
            ty: *mut u32,
            data: *mut u8,
            cb_data: *mut u32,
        ) -> i32;
        fn RegCloseKey(hkey: isize) -> i32;
    }

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };

    let sub = wide("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0");
    let name = wide("ProcessorNameString");
    let mut hkey: isize = 0;

    unsafe {
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            sub.as_ptr(),
            0,
            KEY_READ | KEY_WOW64_64KEY,
            &mut hkey,
        ) != 0
        {
            return String::new();
        }

        // 缓冲区按 u16 开，避免后面再 cast 一次、也保证 2 字节对齐。
        // 给足 512 字节：ProcessorNameString 实际不超过 64 字符，留足冗余。
        let mut buf = [0u16; 256];
        let mut cb: u32 = (buf.len() * 2) as u32;
        let mut ty: u32 = 0;

        let rc = RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buf.as_mut_ptr() as *mut u8,
            &mut cb,
        );
        RegCloseKey(hkey);   // 无论成功失败都要关，别泄漏句柄

        if rc != 0 || cb == 0 {
            return String::new();
        }

        // REG_SZ 末尾一定带 NUL；cb 是字节数，按 u16 数截断。
        // 加一层 cb 合理性检查，防止极端情况下 ushorts 越界。
        let count = ((cb as usize) / 2).min(buf.len());
        let u16s = &buf[..count];
        let end = u16s.iter().position(|&c| c == 0).unwrap_or(u16s.len());
        String::from_utf16_lossy(&u16s[..end]).trim().to_string()
    }
}

#[cfg(not(windows))]
fn cpu_brand() -> String {
    String::new()
}

/// 一次性返回全部系统指标（JSON 字符串）。
///
/// 磁盘信息针对 `data_dir` 所在盘（本项目固定 D 盘）。`data_dir` 由前端传，
/// 免得前后端各写一份路径常量。
#[tauri::command]
fn sysinfo(cpu_state: State<'_, CpuSample>, data_dir: String) -> Result<String, String> {
    let mut out = serde_json::Map::new();

    // ---- 本进程信息 ----
    out.insert("pid".into(), std::process::id().into());
    out.insert("version".into(), env!("CARGO_PKG_VERSION").into());

    #[cfg(windows)]
    unsafe {
        // 本进程内存：WorkingSetSize = 任务管理器「内存」，PrivateUsage = 「提交大小」里的私有部分
        let mut pmc: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        if GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut pmc as *mut _ as *mut _,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ) != 0
        {
            out.insert("proc_working".into(), (pmc.WorkingSetSize as u64).into());
            out.insert("proc_private".into(), (pmc.PrivateUsage as u64).into());
            out.insert("proc_peak".into(), (pmc.PeakWorkingSetSize as u64).into());
        }

        // 系统内存 + 页文件 + 内核内存 + 进程/线程数（GetPerformanceInfo 一次全给）
        let mut pi: PERFORMANCE_INFORMATION = std::mem::zeroed();
        if GetPerformanceInfo(&mut pi, std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32) != 0 {
            let page = pi.PageSize as u64;
            out.insert("mem_total".into(), ((pi.PhysicalTotal as u64) * page).into());
            out.insert(
                "mem_avail".into(),
                ((pi.PhysicalAvailable as u64) * page).into(),
            );
            out.insert("mem_commit".into(), ((pi.CommitTotal as u64) * page).into());
            out.insert("mem_commit_limit".into(), ((pi.CommitLimit as u64) * page).into());
            out.insert("mem_commit_peak".into(), ((pi.CommitPeak as u64) * page).into());
            out.insert("mem_cache".into(), ((pi.SystemCache as u64) * page).into());
            out.insert("mem_kernel_total".into(), ((pi.KernelTotal as u64) * page).into());
            out.insert("mem_kernel_paged".into(), ((pi.KernelPaged as u64) * page).into());
            out.insert(
                "mem_kernel_nonpaged".into(),
                ((pi.KernelNonpaged as u64) * page).into(),
            );
            out.insert("proc_count".into(), (pi.ProcessCount as u64).into());
            out.insert("thread_count".into(), (pi.ThreadCount as u64).into());
            out.insert("handle_count".into(), (pi.HandleCount as u64).into());
        }

        // GlobalMemoryStatusEx 补充「内存负载百分比」，PerfInfo 里没有这个字段
        let mut ms: MEMORYSTATUSEX = std::mem::zeroed();
        ms.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut ms) != 0 {
            out.insert("mem_percent".into(), (ms.dwMemoryLoad as u64).into());
        }

        // 物理内存条实际容量（KB）—— 与 mem_total 一比就知道硬件保留了多少（集显等）
        let mut kb: u64 = 0;
        if GetPhysicallyInstalledSystemMemory(&mut kb) != 0 {
            out.insert("mem_installed".into(), (kb * 1024).into());
        }

        // CPU：核数 + 架构 + 占用率
        let mut si: SYSTEM_INFO = std::mem::zeroed();
        GetNativeSystemInfo(&mut si);
        out.insert("cpu_cores".into(), (si.dwNumberOfProcessors as u64).into());
        // SYSTEM_INFO 的第一个字段是匿名 union，取架构要下钻两层
        // （外层 union 是 dwOemId / Anonymous，内层才是架构 + 保留位）
        let arch = si.Anonymous.Anonymous.wProcessorArchitecture;
        out.insert("cpu_arch".into(), (arch as u64).into());
        out.insert("cpu_brand".into(), cpu_brand().into());

        // 首次采样没有基准，返回 -1 表示「测量中」，前端据此显示占位而不是假的 0%
        let pct = cpu_percent(&cpu_state).unwrap_or(-1.0);
        out.insert("cpu_percent".into(), serde_json::json!(pct));

        // 开机时长
        out.insert("uptime_ms".into(), GetTickCount64().into());

        // ---- 磁盘（data_dir 所在盘，取盘符根）----
        let root: String = data_dir
            .chars()
            .take_while(|c| *c != '\\' && *c != '/')
            .collect::<String>()
            + "\\";
        let root_wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
        if GetDiskFreeSpaceExW(root_wide.as_ptr(), &mut free, &mut total, &mut total_free) != 0 {
            out.insert("disk_total".into(), total.into());
            out.insert("disk_free".into(), free.into());
            out.insert("disk_root".into(), root.into());
        }
    }

    Ok(serde_json::Value::Object(out).to_string())
}

/// 递归统计一个目录的字节数与文件数。
///
/// 单独一条命令（不并进 sysinfo）：`src-tauri/target` 这类目录有几万个文件，
/// 扫一遍要几百毫秒到几秒，塞进每 3 秒轮询的主面板里会明显卡顿。
/// 前端只在打开面板时调一次，之后手动刷新才重扫。
#[tauri::command]
async fn dir_usage(path: String) -> Result<String, String> {
    let mut bytes: u64 = 0;
    let mut files: u64 = 0;

    let root = PathBuf::from(&path);
    if !root.exists() {
        // 路径不存在不算错误 —— 例如 debug 缓存已被清理，前端展示 0 即可
        return Ok(serde_json::json!({ "bytes": 0, "files": 0, "exists": false }).to_string());
    }

    // 显式栈迭代，避免深目录把递归调用栈顶爆
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue; // 无权限的子目录直接跳过，不影响整体统计
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                bytes = bytes.saturating_add(meta.len());
                files += 1;
            }
        }
    }

    Ok(serde_json::json!({
        "bytes": bytes,
        "files": files,
        "exists": true,
    })
    .to_string())
}

/// 当前存档的统计：分键目录 + 资产目录 + 旧全量存档与轮转备份。
/// 比在 JS 里算更准 —— `AppStore.exportAll()` 只返回内存里的键，
/// 磁盘上的备份与资产前端完全看不到，而那是只增不减的隐性开销。
#[tauri::command]
fn store_stats() -> Result<String, String> {
    let path = PathBuf::from(DATA_DIR).join(STORE_FILE);
    let mut items = Vec::new();
    let mut total: u64 = 0;

    // 分键目录：现在数据的主体
    let kdir = PathBuf::from(DATA_DIR).join(KEYS_DIR);
    let mut keys_bytes: u64 = 0;
    let mut keys_count: u64 = 0;
    if let Ok(rd) = fs::read_dir(&kdir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            keys_count += 1;
            keys_bytes = keys_bytes.saturating_add(ent.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }

    // 资产目录：画板图片
    let adir = PathBuf::from(DATA_DIR).join(ASSETS_DIR);
    let mut assets_bytes: u64 = 0;
    let mut assets_count: u64 = 0;
    if let Ok(rd) = fs::read_dir(&adir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|s| s.to_str()) == Some("tmp") || !p.is_file() {
                continue;
            }
            assets_count += 1;
            assets_bytes = assets_bytes.saturating_add(ent.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }

    for ext in &["", ".1", ".2", ".3"] {
        let p = PathBuf::from(format!("{}{}", path.to_string_lossy(), ext));
        let exists = p.exists();
        // 只在文件存在时才取大小；不存在记 0，前端据此不渲染这一行
        let size = if exists {
            fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };
        total = total.saturating_add(size);
        items.push(serde_json::json!({
            "name": format!("{}{}", STORE_FILE, ext),
            "bytes": size,
            "exists": exists,
        }));
    }

    // 旧文件迁移后改名为 migrated-bak，单独列出以便用户确认可以删
    let migrated = PathBuf::from(DATA_DIR).join(STORE_MIGRATED);
    let migrated_bytes = if migrated.exists() {
        fs::metadata(&migrated).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    total = total.saturating_add(migrated_bytes);

    Ok(serde_json::json!({
        "items": items,
        "total": total,
        "dir": DATA_DIR,
        "keys": { "count": keys_count, "bytes": keys_bytes },
        "assets": { "count": assets_count, "bytes": assets_bytes },
        "migrated": { "bytes": migrated_bytes, "exists": migrated.exists() },
    })
    .to_string())
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
        .manage(CpuSample::default())
        .invoke_handler(tauri::generate_handler![
            store_read,
            store_write,
            store_read_key,
            store_write_key,
            store_del_key,
            store_read_all,
            store_keys,
            asset_put,
            asset_get,
            asset_del,
            asset_stats,
            save_file,
            sysinfo,
            dir_usage,
            store_stats
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
