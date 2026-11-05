#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 希沃屏保配置器 —— Tauri 版后端
//!
//! 设计要点：
//!   · asar 的拆包/打包格式已在 Linux 侧用 @electron/asar 对照验证过
//!     （83 个文件重打包后逐字节一致），此处是它的 Rust 移植。
//!   · 加载器 JS 直接 include_str! 进来，运行时写进 app.asar。
//!   · 不依赖额外插件，减少编译面。

use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LOADER_JS: &str = include_str!("../../tools/payload/aura-screensaver-loader.js");
const KERNEL_MAIN_JS: &str = include_str!("../../tools/electron-app/main.js");
const KERNEL_PKG_JSON: &str = include_str!("../../tools/electron-app/package.json");
const SINGLE_INSTANCE_PORT: u16 = 37651;
const MARKER: &str = "aura-screensaver-loader";
const INJECT_ANCHOR: &str = "n.p=\"\",n(n.s=140)}([";
const INJECT_REPLACE: &str = "n.p=\"\",global.__AURA_REQ__=n,n(n.s=140)}([";
const CONFIG_VERSION: &str = "3.1.1";

// ===================== asar =====================

fn rd_u32(b: &[u8], o: usize) -> u32 {
    if o + 4 > b.len() {
        return 0;
    }
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn wr_u32(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}
fn pad4(n: usize) -> usize {
    (4 - (n % 4)) % 4
}

enum Entry {
    Data(Vec<u8>),
    Link(String),
}

#[derive(Default)]
struct DirNode {
    dirs: BTreeMap<String, DirNode>,
    files: BTreeMap<String, FileNode>,
}
enum FileNode {
    Data { size: usize, offset: usize },
    Link(String),
}

/// 解析 asar 头。实测布局：
///   [0]=4  [4]=headerBufLen  [8]=headerInnerLen  [12]=jsonLen  [16..]=json
///   dataStart = 8 + headerBufLen，头部里的 offset 相对 dataStart
fn parse_asar(buf: &[u8]) -> Result<(Value, usize), String> {
    if buf.len() < 16 {
        return Err("app.asar 太小，格式不对".into());
    }
    let header_buf_len = rd_u32(buf, 4) as usize;
    let json_len = rd_u32(buf, 12) as usize;
    if 16 + json_len > buf.len() {
        return Err("app.asar 头部长度越界".into());
    }
    let v: Value = serde_json::from_slice(&buf[16..16 + json_len])
        .map_err(|e| format!("app.asar 头部 JSON 解析失败: {}", e))?;
    Ok((v, 8 + header_buf_len))
}

fn collect(node: &Value, prefix: &str, out: &mut BTreeMap<String, Entry>, buf: &[u8], data_start: usize) {
    let files = match node.get("files").and_then(|f| f.as_object()) {
        Some(m) => m,
        None => return,
    };
    for (name, child) in files {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };
        if child.get("files").is_some() {
            collect(child, &path, out, buf, data_start);
        } else if let Some(link) = child.get("link").and_then(|l| l.as_str()) {
            out.insert(path, Entry::Link(link.to_string()));
        } else {
            let size = child.get("size").and_then(|s| s.as_u64()).unwrap_or(0) as usize;
            let offset = child
                .get("offset")
                .and_then(|o| o.as_str())
                .and_then(|s| s.parse::<usize>().ok())
                .or_else(|| child.get("offset").and_then(|o| o.as_u64()).map(|v| v as usize))
                .unwrap_or(0);
            let s = data_start + offset;
            let e = s + size;
            if e <= buf.len() {
                out.insert(path, Entry::Data(buf[s..e].to_vec()));
            }
        }
    }
}

fn node_to_json(n: &DirNode) -> Value {
    let mut files = Map::new();
    for (k, v) in &n.dirs {
        files.insert(k.clone(), node_to_json(v));
    }
    for (k, v) in &n.files {
        let obj = match v {
            FileNode::Data { size, offset } => json!({ "size": size, "offset": offset.to_string() }),
            FileNode::Link(l) => json!({ "link": l }),
        };
        files.insert(k.clone(), obj);
    }
    json!({ "files": files })
}

fn pack_asar(map: &BTreeMap<String, Entry>) -> Vec<u8> {
    let mut root = DirNode::default();
    let mut body: Vec<u8> = Vec::new();
    let mut offset: usize = 0;

    for (path, ent) in map {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let mut cur = &mut root;
        for p in &parts[..parts.len() - 1] {
            cur = cur.dirs.entry((*p).to_string()).or_default();
        }
        let name = parts[parts.len() - 1].to_string();
        match ent {
            Entry::Link(l) => {
                cur.files.insert(name, FileNode::Link(l.clone()));
            }
            Entry::Data(d) => {
                cur.files.insert(name, FileNode::Data { size: d.len(), offset });
                body.extend_from_slice(d);
                let p = pad4(d.len());
                if p > 0 {
                    body.extend(std::iter::repeat(0u8).take(p));
                }
                offset += d.len() + p;
            }
        }
    }

    let json_str = serde_json::to_string(&node_to_json(&root))
        .unwrap_or_else(|_| "{\"files\":{}}".to_string());
    let json_bytes = json_str.as_bytes();

    let mut header_inner: Vec<u8> = Vec::new();
    header_inner.extend_from_slice(&wr_u32(json_bytes.len() as u32));
    header_inner.extend_from_slice(json_bytes);
    let p = pad4(json_bytes.len());
    if p > 0 {
        header_inner.extend(std::iter::repeat(0u8).take(p));
    }

    let mut header_buf: Vec<u8> = Vec::new();
    header_buf.extend_from_slice(&wr_u32(header_inner.len() as u32));
    header_buf.extend_from_slice(&header_inner);

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&wr_u32(4));
    out.extend_from_slice(&wr_u32(header_buf.len() as u32));
    out.extend_from_slice(&header_buf);
    out.extend_from_slice(&body);
    out
}

fn unpack_asar(buf: &[u8]) -> Result<BTreeMap<String, Entry>, String> {
    let (json, data_start) = parse_asar(buf)?;
    let mut out = BTreeMap::new();
    collect(&json, "", &mut out, buf, data_start);
    Ok(out)
}

// ===================== 路径 =====================

fn appdata() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| "C:\\".to_string()))
}
fn config_dir() -> PathBuf {
    appdata().join("seewo").join("AuraScreensaver")
}
fn log_dir() -> PathBuf {
    config_dir().join("logs")
}
fn ensure_dir(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| format!("创建目录失败 {}: {}", p.display(), e))
}

/// 找到希沃的 SeewoServiceAssistant 目录（含 resources/app.asar）
fn find_seewo_dir() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for k in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                roots.push(PathBuf::from(v));
            }
        }
    }
    for r in roots {
        let base = r.join("Seewo").join("SeewoService");
        let rd = match fs::read_dir(&base) {
            Ok(x) => x,
            Err(_) => continue,
        };
        let mut cands: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("SeewoService_"))
                    .unwrap_or(false)
            })
            .collect();
        cands.sort();
        for c in cands.into_iter().rev() {
            let a = c.join("SeewoServiceAssistant");
            if a.join("resources").join("app.asar").exists() {
                return Some(a);
            }
        }
    }
    None
}

fn asar_path() -> Option<PathBuf> {
    find_seewo_dir().map(|d| d.join("resources").join("app.asar"))
}
/// 当前 app.asar 是否处于注入状态
fn is_injected_now() -> bool {
    let a = match asar_path() { Some(x) => x, None => return false };
    let buf = match fs::read(&a) { Ok(b) => b, Err(_) => return false };
    match unpack_asar(&buf) {
        Ok(m) => match m.get("main.js") {
            Some(Entry::Data(d)) => String::from_utf8_lossy(d).contains("global.__AURA_REQ__"),
            _ => false,
        },
        Err(_) => false,
    }
}

// ===================== 配置 =====================

fn default_config() -> Value {
    json!({
        "screensaverEnabled": true,
        "lockCascadeOnClose": false,
        "allowManualClose": true,
        "mode": "none",
        "override": Value::Null,
        "localUrlMode": "raw",
        "logLevel": "info",
        "backupCount": 3,
        "web": {
            "enabled": false,
            "url": "",
            "closeOnClick": false,
            "useSystemBrowser": false,
            "useBundledKernel": false,
            "browserPath": ""
        }
    })
}

fn read_config() -> Value {
    let p = config_dir().join("config.json");
    match fs::read_to_string(&p) {
        Ok(t) => serde_json::from_str::<Value>(&t).unwrap_or_else(|_| default_config()),
        Err(_) => default_config(),
    }
}

fn write_config(v: &Value) -> Result<(), String> {
    ensure_dir(&config_dir())?;
    let p = config_dir().join("config.json");
    let t = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::write(&p, t).map_err(|e| format!("保存配置失败: {}", e))
}

fn log_line(tag: &str, msg: &str) {
    let _ = ensure_dir(&log_dir());
    let p = log_dir().join("aura-gui.log");
    let now = now_ms();
    let line = format!("[{}] [{}] {}\r\n", now, tag, msg);
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ===================== 命令 =====================

#[tauri::command]
fn get_state() -> Result<Value, String> {
    let dir = find_seewo_dir();
    let asar = dir.as_ref().map(|d| d.join("resources").join("app.asar"));
    let bak = asar.as_ref().map(|a| a.with_extension("asar.bak"));

    let mut injected = false;
    let mut injection_note = String::new();
    if let Some(a) = &asar {
        if let Ok(b) = fs::read(a) {
            match unpack_asar(&b) {
                Ok(m) => {
                    if let Some(Entry::Data(d)) = m.get("main.js") {
                        let t = String::from_utf8_lossy(d);
                        injected = t.contains("global.__AURA_REQ__");
                        injection_note = if injected {
                            "已注入".to_string()
                        } else {
                            "未注入".to_string()
                        };
                    }
                }
                Err(e) => injection_note = e,
            }
        } else {
            injection_note = "读不到 app.asar（可能权限不足）".to_string();
        }
    } else {
        injection_note = "没找到希沃安装目录".to_string();
    }

    Ok(json!({
        "config": read_config(),
        "version": CONFIG_VERSION,
        "seewoDir": dir.as_ref().map(|d| d.to_string_lossy().to_string()),
        "asarExists": asar.as_ref().map(|a| a.exists()).unwrap_or(false),
        "bakExists": bak.as_ref().map(|b| b.exists()).unwrap_or(false),
        "injected": injected,
        "installedVersion": installed_loader_version(),
        "injectionNote": injection_note,
        "configDir": config_dir().to_string_lossy().to_string(),
        "logDir": log_dir().to_string_lossy().to_string(),
        "isAdmin": is_admin(),
        "safeMode": is_safe_mode(),
    }))
}

#[tauri::command]
fn save_config(config: Value) -> Result<(), String> {
    write_config(&config)?;
    log_line("INFO", "已保存配置");
    Ok(())
}

/// 从 main.js 文本里读出注入版本标记
fn marker_version(text: &str) -> Option<String> {
    let key = format!("/* {} v", MARKER);
    let i = text.find(&key)?;
    let rest = &text[i + key.len()..];
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

#[tauri::command]
fn patch_asar() -> Result<Value, String> {
    let a = asar_path().ok_or("找不到希沃安装目录")?;
    let bak = a.with_extension("asar.bak");
    let buf = fs::read(&a)
        .map_err(|e| format!("读取 app.asar 失败: {}（正常模式下常被希沃驱动拦写）", e))?;

    let mut map = unpack_asar(&buf)?;
    let main = match map.get("main.js") {
        Some(Entry::Data(d)) => d.clone(),
        _ => return Err("app.asar 里没有 main.js".to_string()),
    };
    let mut text = String::from_utf8_lossy(&main).to_string();

    // ★ 已注入时不是「直接返回」，而是判断版本决定要不要升级。
    //   否则装过旧版的人永远升不上来（这是上一版的真实缺口）。
    let was_injected = text.contains("global.__AURA_REQ__");
    let mut upgraded = false;
    if was_injected {
        let inst = marker_version(&text);
        if inst.as_deref() == Some(CONFIG_VERSION) {
            return Ok(json!({
                "ok": true, "already": true, "upgraded": false,
                "message": format!("已是最新版本 v{}，无需重复注入", CONFIG_VERSION)
            }));
        }
        // 需要升级：必须从**官方备份**重新注入，不能在已注入的版本上叠加
        if !bak.exists() {
            return Err(format!(
                "当前注入的是 {}，但目录里没有官方备份，无法安全升级。请先「卸载还原」或手动恢复官方 app.asar 后再升级。",
                inst.unwrap_or_else(|| "未知版本".to_string())
            ));
        }
        let orig = fs::read(&bak).map_err(|e| format!("读取备份失败: {}", e))?;
        let base = unpack_asar(&orig)?;
        let base_main = match base.get("main.js") {
            Some(Entry::Data(d)) => d.clone(),
            _ => return Err("备份里没有 main.js，可能备份已损坏".to_string()),
        };
        text = String::from_utf8_lossy(&base_main).to_string();
        map = base;
        upgraded = true;
    }

    if !text.contains(INJECT_ANCHOR) {
        return Err("找不到注入锚点，可能是希沃版本不匹配".to_string());
    }
    text = text.replace(INJECT_ANCHOR, INJECT_REPLACE);
    text.push_str(&format!("\n;try{{/* {} v{} */\n", MARKER, CONFIG_VERSION));
    text.push_str(LOADER_JS);
    text.push_str("\n}catch(e){}\n");

    if !bak.exists() {
        fs::write(&bak, &buf).map_err(|e| format!("写备份失败: {}", e))?;
    }
    map.insert("main.js".to_string(), Entry::Data(text.into_bytes()));
    let out = pack_asar(&map);
    fs::write(&a, &out).map_err(|e| format!("写入 app.asar 失败: {}（请到安全模式再试）", e))?;

    let msg = if upgraded {
        format!("已升级到 v{}", CONFIG_VERSION)
    } else {
        "注入成功".to_string()
    };
    log_line("INFO", &msg);
    Ok(json!({ "ok": true, "already": false, "upgraded": upgraded, "size": out.len(), "message": msg }))
}

#[tauri::command]
fn unpatch_asar() -> Result<Value, String> {
    let a = asar_path().ok_or("找不到希沃安装目录")?;
    let bak = a.with_extension("asar.bak");
    if !bak.exists() {
        return Err("没有备份文件，无法还原".to_string());
    }
    let buf = fs::read(&bak).map_err(|e| format!("读备份失败: {}", e))?;
    fs::write(&a, &buf).map_err(|e| format!("还原失败: {}（请到安全模式再试）", e))?;
    log_line("INFO", "已还原官方 app.asar");
    Ok(json!({ "ok": true, "message": "已还原为官方版本" }))
}

/// 通过命令桥让已注入的加载器执行动作
#[tauri::command]
fn send_command(cmd: String) -> Result<Value, String> {
    let allowed = ["preview", "stop", "reloadConfig"];
    if !allowed.contains(&cmd.as_str()) {
        return Err(format!("不支持的命令: {}", cmd));
    }
    ensure_dir(&config_dir())?;

    // ★ 命令桥要求 seq 严格递增（loader: if (seq <= lastSeq) return）。
    //   上一版根本没写 seq -> Number(undefined)=0 -> 0 <= 0 直接 return，
    //   「预览 / 停止」永远静默失效。这是最严重的一个 bug。
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let now = now_ms() as u64;
    let seq = loop {
        let cur = SEQ.load(Ordering::Relaxed);
        let next = if now > cur { now } else { cur + 1 };
        if SEQ
            .compare_exchange(cur, next, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            break next;
        }
    };

    let payload = json!({
        "seq": seq,
        "cmd": cmd,
        "args": {},
        "at": iso_now(),
        "atMs": now,
    });
    let p = config_dir().join("command.json");
    fs::write(&p, serde_json::to_string(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写命令文件失败: {}", e))?;
    log_line("INFO", &format!("已下发命令 {} (seq={})", cmd, seq));
    Ok(json!({ "ok": true, "seq": seq, "message": format!("已下发 {}", cmd) }))
}

/// 把 unix 毫秒转成 "YYYY-MM-DDTHH:MM:SS.mmmZ"（不引入 chrono）
fn iso_now() -> String {
    let ms = now_ms() as i64;
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, h, mi, s, millis
    )
}


// ===================== 文件 / 文件夹选择（Tauri dialog 插件，不经过 PowerShell） =====================

/// 选文件 / 多选 / 选文件夹。
/// 之前用「Rust 调 PowerShell 跑 WinForms 对话框」，有两个毛病：
///   1) 中文路径乱码 —— PowerShell 把结果写到控制台用的是 OEM 码页，
///      Rust 按 UTF-8 读回来就花了；
///   2) 只能单选文件，选不了文件夹。
/// 现在直接用 Tauri 官方 dialog 插件在 Rust 侧弹原生对话框，
/// 返回标准 String，没有编码问题，也支持文件夹与多选。
#[tauri::command]
async fn pick_files(
    app: tauri::AppHandle,
    mode: Option<String>,
    kind: Option<String>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let mode = mode.unwrap_or_else(|| "single".to_string());
    let kind = kind.unwrap_or_else(|| "image".to_string());

    let mut dlg = app.dialog().file().set_title(match mode.as_str() {
        "folder" => "选择文件夹",
        "multi" => "选择文件（可多选）",
        _ => "选择文件",
    });

    dlg = match kind.as_str() {
        "image" => dlg
            .add_filter("图片/动图", &["jpg", "jpeg", "png", "bmp", "gif", "webp", "avif", "apng"])
            .add_filter("所有文件", &["*"]),
        "web" => dlg
            .add_filter("网页或视频", &["html", "htm", "xhtml", "mht", "mhtml", "svg", "mp4", "webm", "ogv", "mov", "m4v"])
            .add_filter("所有文件", &["*"]),
        "exe" => dlg
            .add_filter("可执行文件", &["exe"])
            .add_filter("所有文件", &["*"]),
        _ => dlg.add_filter("所有文件", &["*"]),
    };

    let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();

    match mode.as_str() {
        "folder" => {
            dlg.pick_folder(move |p| {
                let v = p.map(|x| vec![x.to_string()]).unwrap_or_default();
                let _ = tx.send(v);
            });
        }
        "multi" => {
            dlg.pick_files(move |p| {
                let v = p
                    .map(|xs| xs.into_iter().map(|x| x.to_string()).collect::<Vec<String>>())
                    .unwrap_or_default();
                let _ = tx.send(v);
            });
        }
        _ => {
            dlg.pick_file(move |p| {
                let v = p.map(|x| vec![x.to_string()]).unwrap_or_default();
                let _ = tx.send(v);
            });
        }
    }

    let paths = rx.recv().unwrap_or_default();
    log_line("INFO", &format!("选择 {}：{} 项", mode, paths.len()));
    Ok(json!({ "paths": paths, "cancelled": paths.is_empty() }))
}

/// 递归扫描文件夹里的图片（最多 4 层、500 张）
#[tauri::command]
fn scan_image_folder(path: String) -> Result<Value, String> {
    let exts = ["jpg", "jpeg", "png", "bmp", "gif", "webp", "avif", "apng"];
    let mut out: Vec<String> = Vec::new();

    fn walk(dir: &Path, exts: &[&str], out: &mut Vec<String>, depth: u32) {
        if depth > 4 || out.len() >= 500 {
            return;
        }
        let rd = match fs::read_dir(dir) {
            Ok(x) => x,
            Err(_) => return,
        };
        for e in rd.filter_map(|x| x.ok()) {
            let p = e.path();
            if p.is_dir() {
                walk(&p, exts, out, depth + 1);
            } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                if exts.contains(&ext.to_lowercase().as_str()) {
                    out.push(p.to_string_lossy().to_string());
                }
            }
            if out.len() >= 500 {
                return;
            }
        }
    }

    walk(Path::new(&path), &exts, &mut out, 0);
    out.sort();
    let n = out.len();
    log_line("INFO", &format!("扫描文件夹得到 {} 张图片", n));
    Ok(json!({ "files": out, "count": n }))
}

#[tauri::command]
fn image_data_url(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    let md = fs::metadata(&p).map_err(|e| format!("读取信息失败: {}", e))?;
    if !md.is_file() {
        return Err("不是文件".to_string());
    }
    if md.len() > 24 * 1024 * 1024 {
        return Err(format!("图片太大（{}），不预览", human_size(md.len())));
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取失败: {}", e))?;
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    Ok(json!({
        "dataUrl": format!("data:{};base64,{}", mime, b64_encode(&bytes)),
        "size": md.len()
    }))
}

fn human_size(n: u64) -> String {
    if n < 1024 {
        format!("{} B", n)
    } else if n < 1048576 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1048576.0)
    }
}

/// 标准 base64 编码（不引第三方 crate）
fn b64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0usize;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}


#[tauri::command]
fn diagnostics() -> Result<String, String> {
    let mut s = String::new();
    s.push_str(&format!("【本程序】\r\n  版本：{}\r\n  管理员：{}\r\n  安全模式：{}\r\n\r\n", CONFIG_VERSION, is_admin(), is_safe_mode()));
    let dir = find_seewo_dir();
    s.push_str("【安装目录】\r\n");
    match &dir {
        Some(d) => {
            s.push_str(&format!("  {}\r\n", d.display()));
            let a = d.join("resources").join("app.asar");
            s.push_str(&format!("  app.asar：{}\r\n", if a.exists() { "存在" } else { "缺失" }));
            s.push_str(&format!("  备份 .bak：{}\r\n", if a.with_extension("asar.bak").exists() { "存在" } else { "无" }));
        }
        None => s.push_str("  未找到希沃安装目录\r\n"),
    }
    s.push_str("\r\n【路径】\r\n");
    s.push_str(&format!("  配置：{}\r\n", config_dir().display()));
    s.push_str(&format!("  日志：{}\r\n", log_dir().display()));
    s.push_str("\r\n【希沃进程】\r\n");
    for (name, n) in seewo_process_counts() {
        s.push_str(&format!("  {}：{} 个\r\n", name, n));
    }
    Ok(s)
}

#[tauri::command]
fn open_path(which: String) -> Result<(), String> {
    let target: PathBuf = match which.as_str() {
        "logs" => log_dir(),
        "config" => {
            let _ = ensure_dir(&config_dir());
            config_dir()
        }
        "seewo" => find_seewo_dir().ok_or("找不到希沃安装目录")?,
        "defaultImages" => default_image_dir().ok_or("还没有默认图片目录")?,
        "kernel" => kernel_dir(),
        _ => return Err(format!("未知路径: {}", which)),
    };
    if !target.exists() {
        // logs/config/kernel 是我们要用的目录，顺手建出来再打开
        if which == "logs" || which == "config" || which == "kernel" {
            let _ = fs::create_dir_all(&target);
        }
        if !target.exists() {
            return Err(format!("目录不存在：{}", target.display()));
        }
    }
    Command::new("explorer.exe")
        .arg(target.as_os_str())
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    Ok(())
}

fn default_image_dir() -> Option<PathBuf> {
    let p = appdata().join("seewo").join("SeewoAbility").join("screen_saver");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

#[tauri::command]
fn list_default_images() -> Result<Value, String> {
    let d = match default_image_dir() {
        Some(d) => d,
        None => return Ok(json!({ "dir": Value::Null, "files": [] })),
    };
    let rd = fs::read_dir(&d).map_err(|e| e.to_string())?;
    let mut files: Vec<Value> = Vec::new();
    for e in rd.filter_map(|x| x.ok()) {
        let p = e.path();
        if let Ok(md) = e.metadata() {
            if md.is_file() && md.len() > 0 {
                files.push(json!({
                    "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    "path": p.to_string_lossy().to_string(),
                    "size": md.len(),
                }));
            }
        }
    }
    files.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(json!({ "dir": d.to_string_lossy().to_string(), "files": files }))
}

fn kernel_dir() -> PathBuf {
    // 用 LOCALAPPDATA：普通用户可写。ProgramData 需要管理员，会导致下载第一步就失败。
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .unwrap_or_else(|_| "C:\\".to_string());
    PathBuf::from(base)
        .join("seewo")
        .join("AuraScreensaver")
        .join("kernel")
}

#[tauri::command]
fn detect_browsers() -> Result<Value, String> {
    let mut found: Vec<Value> = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    for k in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                roots.push(PathBuf::from(v));
            }
        }
    }
    let rels = [
        "Microsoft/Edge/Application/msedge.exe",
        "Google/Chrome/Application/chrome.exe",
    ];
    for r in &roots {
        for rel in &rels {
            let p = r.join(rel);
            if p.exists() {
                found.push(json!({ "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), "path": p.to_string_lossy().to_string() }));
            }
        }
    }
    let k = kernel_dir().join("electron.exe");
    let kernel_ready = k.exists();
    Ok(json!({ "browsers": found, "kernelReady": kernel_ready, "kernelDir": kernel_dir().to_string_lossy().to_string() }))
}

#[tauri::command]
fn enter_safe_mode(action: String) -> Result<Value, String> {
    if action != "install" && action != "uninstall" {
        return Err("动作只能是 install 或 uninstall".to_string());
    }
    // 已经在安全模式里了 -> 直接干活，不要再设 bcdedit
    if is_safe_mode() {
        log_line("INFO", &format!("已在安全模式，直接执行 {}", action));
        let r = if action == "uninstall" { unpatch_asar() } else { patch_asar() };
        let _ = fs::remove_file(config_dir().join("pending-safe-action.txt"));
        let _ = run_cmd("bcdedit.exe", &["/deletevalue", "{current}", "safeboot"]);
        return match r {
            Ok(v) => Ok(json!({ "ok": true, "ranNow": true, "result": v, "message": "已完成（本次已在安全模式，无需重启）" })),
            Err(e) => Err(e),
        };
    }
    if !is_admin() {
        return Err("设置安全模式需要管理员权限，请右键以管理员身份运行".to_string());
    }
    ensure_dir(&config_dir())?;
    fs::write(config_dir().join("pending-safe-action.txt"), &action)
        .map_err(|e| format!("写待办标记失败: {}", e))?;
    // ★ 先把纯 PowerShell 版脚本和桌面批处理准备好，再重启。
    //   因为安全模式下 WebView2 常常起不来，GUI 很可能打不开。
    let safe = write_safe_scripts().unwrap_or_else(|_| json!({}));
    run_cmd("bcdedit.exe", &["/set", "{current}", "safeboot", "minimal"])
        .map_err(|e| format!("设置安全模式失败: {}", e))?;
    log_line("INFO", &format!("已设置安全模式，待办动作={}", action));
    Ok(json!({ "ok": true, "ranNow": false, "safe": safe, "message": "已安排好。重启进入安全模式后，双击桌面「安全模式-点我.bat」并选 1 即可完成。" }))
}
#[tauri::command]
fn is_pending_safe_action() -> Result<Value, String> {
    let p = config_dir().join("pending-safe-action.txt");
    match fs::read_to_string(&p) {
        Ok(t) => Ok(json!({ "pending": true, "action": t.trim() })),
        Err(_) => Ok(json!({ "pending": false, "action": "" })),
    }
}

#[tauri::command]
fn run_pending_safe_action() -> Result<Value, String> {
    let p = config_dir().join("pending-safe-action.txt");
    let t = fs::read_to_string(&p).map_err(|_| "没有待办动作".to_string())?;
    let action = t.trim().to_string();
    let r = if action == "uninstall" {
        unpatch_asar()
    } else {
        patch_asar()
    };
    // 无论成败都清掉安全模式，避免用户卡在里面
    let _ = run_cmd("bcdedit.exe", &["/deletevalue", "{current}", "safeboot"]);
    let _ = fs::remove_file(&p);
    match r {
        Ok(v) => Ok(json!({ "ok": true, "result": v })),
        Err(e) => Err(e),
    }
}

// ===================== 新内核 =====================

/// 把内核目录下的包装程序写好（main.js / package.json）
fn write_kernel_app() -> Result<PathBuf, String> {
    let dir = kernel_dir();
    let app = dir.join("resources").join("app");
    ensure_dir(&app)?;
    fs::write(app.join("main.js"), KERNEL_MAIN_JS).map_err(|e| format!("写 main.js 失败: {}", e))?;
    fs::write(app.join("package.json"), KERNEL_PKG_JSON).map_err(|e| format!("写 package.json 失败: {}", e))?;
    Ok(dir)
}

#[tauri::command]
fn kernel_info() -> Result<Value, String> {
    let dir = kernel_dir();
    let exe = dir.join("electron.exe");
    let main = dir.join("resources").join("app").join("main.js");
    let ver = fs::read_to_string(dir.join("version.txt")).unwrap_or_default().trim().to_string();
    let ready = exe.exists() && main.exists();
    let mut size_mb = 0f64;
    if dir.exists() {
        let mut total = 0u64;
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.filter_map(|x| x.ok()) {
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        total += m.len();
                    } else {
                        total += dir_size(&e.path());
                    }
                }
            }
        }
        size_mb = (total as f64) / 1048576.0;
    }
    Ok(json!({ "ready": ready, "version": ver, "dir": dir.to_string_lossy().to_string(), "sizeMB": (size_mb * 10.0).round() / 10.0 }))
}

fn dir_size(p: &Path) -> u64 {
    let mut n = 0u64;
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.filter_map(|x| x.ok()) {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    n += m.len();
                } else {
                    n += dir_size(&e.path());
                }
            }
        }
    }
    n
}

/// 下载新内核 —— **纯 Rust 实现**，不调用 PowerShell。
///
/// 之前是写个 .ps1 让 PowerShell 下载 + Expand-Archive，问题：
///   1) 多一个进程和一层错误传递，失败时只知道「所有源都失败了」；
///   2) 进度要从文件大小反推，不精确；
///   3) PowerShell 在受限环境可能被拦。
/// 现在用 ureq 流式下载（边下边发进度事件），zip 直接解压。
/// 对三个下载源做一次小范围测速（各拉 256KB），返回按速度排序的结果。
/// 让用户在下载 150MB 之前就知道该选哪个源。
#[tauri::command]
fn speedtest_mirrors(version: Option<String>) -> Result<Value, String> {
    let ver = match version {
        Some(v) if !v.is_empty() => v,
        _ => resolve_kernel_version(),
    };
    let name = format!("electron-v{}-win32-x64.zip", ver);
    let direct = format!(
        "https://github.com/electron/electron/releases/download/v{}/{}",
        ver, name
    );
    let mirrors: Vec<(&str, String)> = vec![
        ("直连 GitHub", direct.clone()),
        ("gh-proxy.com", format!("https://gh-proxy.com/{}", direct)),
        ("gh-proxy.org", format!("https://gh-proxy.org/{}", direct)),
    ];

    const PROBE: u64 = 256 * 1024;
    let mut results: Vec<Value> = Vec::new();
    for (label, url) in mirrors {
        let t0 = std::time::Instant::now();
        let mut bytes: u64 = 0;
        let resp = ureq::get(&url)
            .set("User-Agent", "AuraScreensaver")
            .set("Range", "bytes=0-262143")
            .timeout(std::time::Duration::from_secs(12))
            .call();
        if let Ok(r) = resp {
            let mut reader = r.into_reader();
            let mut buf = vec![0u8; 32 * 1024];
            while bytes < PROBE {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => bytes += n as u64,
                    Err(_) => break,
                }
            }
        }
        let ms = t0.elapsed().as_millis() as u64;
        let kbps = if ms > 0 {
            (bytes as f64 / 1024.0) / (ms as f64 / 1000.0)
        } else {
            0.0
        };
        results.push(json!({
            "label": label,
            "url": url,
            "ok": bytes > 0,
            "ms": ms,
            "bytes": bytes,
            "kbps": (kbps * 10.0).round() / 10.0,
        }));
    }
    // 可用的排前面，再按速度降序
    results.sort_by(|a, b| {
        let ao = a["ok"].as_bool().unwrap_or(false);
        let bo = b["ok"].as_bool().unwrap_or(false);
        if ao != bo {
            return bo.cmp(&ao);
        }
        let ak = a["kbps"].as_f64().unwrap_or(0.0);
        let bk = b["kbps"].as_f64().unwrap_or(0.0);
        bk.partial_cmp(&ak).unwrap_or(std::cmp::Ordering::Equal)
    });
    log_line("INFO", &format!("镜像测速完成，版本 v{}", ver));
    Ok(json!({ "version": ver, "results": results }))
}

/// 解析最新 Electron 版本（三级回退）
fn resolve_kernel_version() -> String {
    let api = "https://api.github.com/repos/electron/electron/releases/latest";
    for u in mirror_urls(api) {
        if let Ok(r) = ureq::get(&u)
            .set("User-Agent", "AuraScreensaver")
            .timeout(std::time::Duration::from_secs(15))
            .call()
        {
            if let Ok(v) = r.into_json::<serde_json::Value>() {
                if let Some(t) = v.get("tag_name").and_then(|x| x.as_str()) {
                    return t.trim_start_matches('v').to_string();
                }
            }
        }
    }
    "45.1.0".to_string()
}

#[tauri::command]
fn download_kernel(app: tauri::AppHandle, prefer: Option<String>) -> Result<Value, String> {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("已有下载任务在进行中，请等它结束".to_string());
    }
    let dir = match write_kernel_app() {
        Ok(d) => d,
        Err(e) => {
            RUNNING.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let app2 = app.clone();
    let pref = prefer.unwrap_or_default();
    std::thread::spawn(move || {
        let r = do_download_kernel(&dir, &app2, &pref);
        RUNNING.store(false, Ordering::SeqCst);
        match r {
            Ok(ver) => {
                let _ = app2.emit(
                    "kernel-done",
                    json!({ "ok": true, "message": format!("内核 v{} 已就绪", ver), "version": ver }),
                );
            }
            Err(e) => {
                let _ = app2.emit("kernel-done", json!({ "ok": false, "message": e }));
            }
        }
    });
    Ok(json!({ "started": true, "message": "已开始下载（约 151MB，后台进行）" }))
}

fn mirror_urls(url: &str) -> Vec<String> {
    vec![
        url.to_string(),
        format!("https://gh-proxy.com/{}", url),
        format!("https://gh-proxy.org/{}", url),
    ]
}

fn do_download_kernel(dir: &Path, app: &tauri::AppHandle, prefer: &str) -> Result<String, String> {
    // 1) 取最新版本号（三级回退）
    let api = "https://api.github.com/repos/electron/electron/releases/latest";
    let mut version = String::from("45.1.0");
    for u in mirror_urls(api) {
        let resp = ureq::get(&u)
            .set("User-Agent", "AuraScreensaver")
            .timeout(std::time::Duration::from_secs(20))
            .call();
        if let Ok(r) = resp {
            if let Ok(v) = r.into_json::<serde_json::Value>() {
                if let Some(t) = v.get("tag_name").and_then(|x| x.as_str()) {
                    version = t.trim_start_matches('v').to_string();
                    break;
                }
            }
        }
    }
    log_line("INFO", &format!("内核目标版本 v{}", version));

    let name = format!("electron-v{}-win32-x64.zip", version);
    let direct = format!(
        "https://github.com/electron/electron/releases/download/v{}/{}",
        version, name
    );

    let zip_path = dir.join("download.zip");
    let _ = fs::remove_file(&zip_path);

    let mut urls = mirror_urls(&direct);
    if !prefer.is_empty() {
        urls.sort_by_key(|u| if u == prefer { 0 } else { 1 });
    }
    let mut last_err = String::new();
    let mut ok = false;
    for u in urls {
        log_line("INFO", &format!("尝试下载源 {}", u));
        match fetch_to_file(&u, &zip_path, app) {
            Ok(_) => {
                ok = true;
                break;
            }
            Err(e) => {
                last_err = e;
                let _ = fs::remove_file(&zip_path);
            }
        }
    }
    if !ok {
        return Err(format!("所有下载源都失败：{}", last_err));
    }

    let len = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    if len < 50 * 1024 * 1024 {
        let _ = fs::remove_file(&zip_path);
        return Err(format!(
            "下载文件过小（{:.1} MB），可能是失败页",
            len as f64 / 1048576.0
        ));
    }

    // 2) 解压
    let f = fs::File::open(&zip_path).map_err(|e| format!("打开压缩包失败: {}", e))?;
    let mut ar = zip::ZipArchive::new(std::io::BufReader::new(f))
        .map_err(|e| format!("解析压缩包失败: {}", e))?;
    let total = ar.len();
    for i in 0..total {
        let mut entry = match ar.by_index(i) {
            Ok(x) => x,
            Err(e) => return Err(format!("读取压缩项失败: {}", e)),
        };
        let out = match entry.enclosed_name() {
            Some(p) => dir.join(p),
            None => continue, // 防目录穿越
        };
        if entry.is_dir() {
            let _ = fs::create_dir_all(&out);
            continue;
        }
        if let Some(par) = out.parent() {
            let _ = fs::create_dir_all(par);
        }
        let mut w = fs::File::create(&out)
            .map_err(|e| format!("写入失败 {}: {}", out.display(), e))?;
        std::io::copy(&mut entry, &mut w).map_err(|e| format!("解压失败: {}", e))?;
    }
    let _ = fs::remove_file(&zip_path);
    let _ = fs::write(dir.join("version.txt"), &version);
    log_line("INFO", &format!("内核 v{} 解压完成（{} 项）", version, total));
    Ok(version)
}

/// 流式下载到文件，边下边发进度事件
fn fetch_to_file(url: &str, dest: &Path, app: &tauri::AppHandle) -> Result<(), String> {
    let resp = ureq::get(url)
        .set("User-Agent", "AuraScreensaver")
        .timeout(std::time::Duration::from_secs(3600))
        .call()
        .map_err(|e| format!("请求失败: {}", e))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = fs::File::create(dest).map_err(|e| format!("创建文件失败: {}", e))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| format!("读取失败: {}", e))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("写入失败: {}", e))?;
        done += n as u64;
        if done - last_emit >= 512 * 1024 {
            last_emit = done;
            let _ = app.emit("kernel-progress", json!({ "downloaded": done, "total": total }));
        }
    }
    let _ = app.emit("kernel-progress", json!({ "downloaded": done, "total": total }));
    Ok(())
}

// ===================== 升级检测 / 清理 =====================

/// 从已注入的 main.js 里读出注入版本标记
fn installed_loader_version() -> Option<String> {
    let a = asar_path()?;
    let buf = fs::read(a).ok()?;
    let map = unpack_asar(&buf).ok()?;
    if let Some(Entry::Data(d)) = map.get("main.js") {
        return marker_version(&String::from_utf8_lossy(d));
    }
    None
}

#[tauri::command]
fn check_upgrade() -> Result<Value, String> {
    let inst = installed_loader_version();
    let cur = CONFIG_VERSION.to_string();
    let need = match &inst {
        None => false,                    // 还没注入，谈不上升级
        Some(v) => v != &cur,
    };
    Ok(json!({ "installed": inst, "current": cur, "needUpgrade": need }))
}

/// 列出本程序制造的所有可清理文件，并说明用途。
/// 只列「删了不影响功能」的东西；配置文件本身不列（那是用户的设置）。
#[tauri::command]
fn cleanup_candidates() -> Result<Value, String> {
    let mut items: Vec<Value> = Vec::new();

    let mut push = |path: PathBuf, group: &str, label: &str, purpose: &str| {
        if path.exists() {
            let size = if path.is_dir() { dir_size(&path) } else { fs::metadata(&path).map(|m| m.len()).unwrap_or(0) };
            items.push(json!({
                "path": path.to_string_lossy().to_string(),
                "group": group,
                "label": label,
                "purpose": purpose,
                "size": size,
                "isDir": path.is_dir(),
            }));
        }
    };

    let cd = config_dir();
    let ld = log_dir();

    // ---- 日志 ----
    if ld.exists() {
        if let Ok(rd) = fs::read_dir(&ld) {
            for e in rd.filter_map(|x| x.ok()) {
                let p = e.path();
                if p.is_file() {
                    push(p, "日志", "日志文件", "排查问题用，删掉不影响功能");
                }
            }
        }
    }
    push(cd.join("aura-gui.log"), "日志", "旧位置日志", "早期版本的界面日志");
    push(cd.join("safe-action.log"), "日志", "安全模式动作日志", "命令行模式执行时写的结果");
    push(cd.join("ui-error.log"), "日志", "界面异常日志", "界面上未处理异常的记录");

    // ---- 临时/运行时文件 ----
    push(cd.join("command.json"), "运行时", "命令桥命令文件", "临时的预览/停止指令，正常情况下用完即删");
    push(cd.join("command-result.json"), "运行时", "命令桥结果文件", "加载器回写的执行结果");
    push(cd.join("web-browser.pid"), "运行时", "网页屏保进程号", "用来关闭系统浏览器；网页屏保没在跑时是残留");
    push(cd.join("exit-btn.html"), "运行时", "悬浮退出按钮页面", "系统浏览器模式下那个置顶小按钮的页面");
    push(cd.join("video.html"), "运行时", "视频包装页面", "把视频文件包成全屏循环播放的页面");
    push(cd.join("kill-browser.ps1"), "运行时", "浏览器清理脚本", "三层兜底关闭时生成的临时脚本");
    push(cd.join("pending-safe-action.txt"), "运行时", "安全模式待办标记", "记录还要不要注入/卸载；已经完成后可删");

    // ---- 浏览器独立配置目录（可能很大）----
    if cd.exists() {
        if let Ok(rd) = fs::read_dir(&cd) {
            let mut profiles: Vec<PathBuf> = rd
                .filter_map(|x| x.ok())
                .map(|x| x.path())
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .map(|n| n.to_string_lossy().starts_with("browser-profile"))
                            .unwrap_or(false)
                })
                .collect();
            profiles.sort();
            for p in profiles {
                push(p, "浏览器配置", "浏览器独立配置目录", "给系统浏览器用的独立 profile，不碰你自己的浏览记录；关掉屏保后可删");
            }
        }
    }

    // ---- 安全模式入口 ----
    let sd = safe_dir();
    push(sd.join("AuraSafe.exe"), "安全模式", "安全模式用的程序副本", "约 3.5MB。桌面批处理调用它；下次点安装会重新生成");
    push(sd.join("安全模式-点我.bat"), "安全模式", "安全模式批处理（副本）", "配置目录里的那份，桌面还有一份");
    if let Some(dt) = desktop_dir() {
        push(dt.join("安全模式-点我.bat"), "安全模式", "桌面安全模式批处理", "重启进安全模式后双击它完成安装；装完可删");
    }

    // ---- 新内核 ----
    let kd = kernel_dir();
    push(kd.join("download.zip"), "新内核", "内核下载临时包", "约 150MB，下载过程中才有；中断会残留");
    push(kd.join("electron.exe"), "新内核", "新内核主体（整个目录）", "约 250MB。删掉后网页屏保会回退到系统浏览器");
    push(kd.join("version.txt"), "新内核", "内核版本记录", "记录下载的是哪个 Electron 版本");

    // 目录型条目去重（内核目录只报一次）
    if kd.exists() {
        let has_zip = kd.join("download.zip").exists();
        let has_exe = kd.join("electron.exe").exists();
        if has_exe {
            items.retain(|i| i["path"].as_str() != Some(kd.join("electron.exe").to_string_lossy().as_ref()));
            let size = dir_size(&kd);
            items.push(json!({
                "path": kd.to_string_lossy().to_string(),
                "group": "新内核",
                "label": "新内核目录（整个删掉）",
                "purpose": "约 250MB。删掉后网页屏保回退到系统浏览器；下次用可重新下载",
                "size": size,
                "isDir": true,
            }));
        }
        let _ = has_zip;
    }

    // 删除顺序：先小文件后目录，方便阅读
    items.sort_by(|a, b| {
        let ga = a["group"].as_str().unwrap_or("");
        let gb = b["group"].as_str().unwrap_or("");
        ga.cmp(gb)
    });

    let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
    Ok(json!({ "items": items, "totalSize": total }))
}

#[tauri::command]
fn do_cleanup(paths: Vec<String>) -> Result<Value, String> {
    let mut done = 0u32;
    let mut failed: Vec<String> = Vec::new();
    for p in &paths {
        let pb = PathBuf::from(p);
        // 只允许删我们自己目录下的东西
        let ok_dir = pb.starts_with(log_dir()) || pb.starts_with(kernel_dir()) || pb.starts_with(config_dir());
        if !ok_dir {
            failed.push(format!("{}（不在允许的目录内，已跳过）", p));
            continue;
        }
        match fs::remove_file(&pb) {
            Ok(_) => done += 1,
            Err(e) => failed.push(format!("{}: {}", p, e)),
        }
    }
    log_line("INFO", &format!("清理完成 {} 项", done));
    Ok(json!({ "removed": done, "failed": failed }))
}


#[tauri::command]
fn reboot() -> Result<Value, String> {
    // 5 秒后重启，给用户留出保存其它工作的余地
    run_cmd("shutdown.exe", &["/r", "/t", "5", "/c", "AuraScreensaver: 重启进入安全模式"]).map_err(|e| format!("发起重启失败: {}", e))?;
    Ok(json!({ "ok": true, "message": "电脑将在 5 秒后重启" }))
}

// ===================== 安全模式落地（不依赖 WebView2） =====================

fn safe_dir() -> PathBuf {
    config_dir().join("safe")
}

fn desktop_dir() -> Option<PathBuf> {
    let up = std::env::var("USERPROFILE").ok()?;
    for name in ["Desktop", "桌面"] {
        let d = PathBuf::from(&up).join(name);
        if d.exists() {
            return Some(d);
        }
    }
    if let Ok(od) = std::env::var("OneDrive") {
        let d = PathBuf::from(od).join("Desktop");
        if d.exists() {
            return Some(d);
        }
    }
    None
}

/// 生成安全模式用的**单个**批处理，并把本 exe 复制过去。
///
/// ★ 为什么不再用 PowerShell 脚本：
///   1) 原来的 bat 用 Start-Process -Verb RunAs 提权，而该方式依赖
///      Secondary Logon(seclogon) 服务 —— 安全模式下不启动，所以
///      PowerShell 窗口一闪就报红退出（用户实测）。
///   2) exe 自己的命令行模式最省事：纯 Rust 文件操作，零 GUI、零 WebView2、
///      零 PowerShell 依赖。
fn write_safe_scripts() -> Result<Value, String> {
    let dir = safe_dir();
    ensure_dir(&dir)?;

    let safe_exe = dir.join("AuraSafe.exe");
    let mut copied = false;
    if let Ok(cur) = std::env::current_exe() {
        let same = cur.to_string_lossy().to_lowercase() == safe_exe.to_string_lossy().to_lowercase();
        if !same {
            match fs::copy(&cur, &safe_exe) {
                Ok(_) => copied = true,
                Err(e) => log_line("WARN", &format!("复制 AuraSafe.exe 失败: {}", e)),
            }
        }
    }

    let bat = build_safe_bat(&safe_exe);
    let mut made: Vec<String> = vec![safe_exe.to_string_lossy().to_string()];
    if let Some(dt) = desktop_dir() {
        let f = dt.join("安全模式-点我.bat");
        if fs::write(&f, bat.as_bytes()).is_ok() {
            made.push(f.to_string_lossy().to_string());
        }
    }
    let f2 = dir.join("安全模式-点我.bat");
    let _ = fs::write(&f2, bat.as_bytes());
    made.push(f2.to_string_lossy().to_string());

    // 清掉上一版留下的、会在安全模式下报错的旧脚本
    for old in [
        "安全模式-完成安装.bat",
        "退出安全模式.bat",
        "safe-action.ps1",
        "exit-safe-mode.ps1",
        "Patch-Asar.ps1",
        "loader.js",
    ] {
        let _ = fs::remove_file(dir.join(old));
        if let Some(dt) = desktop_dir() {
            let _ = fs::remove_file(dt.join(old));
        }
    }

    log_line("INFO", &format!("已生成安全模式入口 (copied={})", copied));
    Ok(json!({ "ok": true, "dir": dir.to_string_lossy().to_string(), "files": made, "exe": safe_exe.to_string_lossy().to_string() }))
}

fn build_safe_bat(exe: &Path) -> String {
    let e = exe.display().to_string();
    let body = [
        "@echo off",
        "chcp 65001 >nul 2>nul",
        "title 希沃屏保配置 - 安全模式操作",
        "",
        "whoami /groups 2>nul | findstr /C:\"S-1-16-12288\" >nul 2>&1",
        "if errorlevel 1 (",
        "    echo.",
        "    echo   需要管理员权限才能写入希沃程序目录。",
        "    echo   请关掉本窗口，右键这个文件，选「以管理员身份运行」。",
        "    echo.",
        "    echo   按任意键仍要继续尝试 ^(可能失败^)...",
        "    pause >nul",
        ")",
        "",
        ":menu",
        "cls",
        "echo.",
        "echo   ==========================================",
        "echo     希沃屏保配置 . 安全模式操作",
        "echo   ==========================================",
        "echo.",
        "echo     [1] 完成安装 / 升级注入   ^(完成后退出安全模式并重启^)",
        "echo     [2] 卸载还原             ^(完成后退出安全模式并重启^)",
        "echo     [3] 仅退出安全模式并重启",
        "echo     [4] 关闭本窗口",
        "echo.",
        "set /p CH=  请输入 1/2/3/4 再回车: ",
        "if \"%CH%\"==\"1\" goto do_install",
        "if \"%CH%\"==\"2\" goto do_uninstall",
        "if \"%CH%\"==\"3\" goto do_exit",
        "if \"%CH%\"==\"4\" exit /b",
        "goto menu",
    ];
    let mut s = body.join("\r\n");
    s.push_str("\r\n");
    s.push_str("\r\n\r\n:do_install\r\n");
    s.push_str(&format!("\"{}\" --safe-install", e));
    s.push_str("\r\nexit /b\r\n");
    s.push_str("\r\n:do_uninstall\r\n");
    s.push_str(&format!("\"{}\" --safe-uninstall", e));
    s.push_str("\r\nexit /b\r\n");
    s.push_str("\r\n:do_exit\r\n");
    s.push_str(&format!("\"{}\" --exit-safe-mode", e));
    s.push_str("\r\nexit /b\r\n");
    s
}


#[tauri::command]
fn prepare_safe_mode() -> Result<Value, String> {
    write_safe_scripts()
}

#[tauri::command]
fn open_safe_dir() -> Result<(), String> {
    write_safe_scripts()?;
    let d = safe_dir();
    Command::new("explorer.exe")
        .arg(d.as_os_str())
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    Ok(())
}


// ===================== 小工具 =====================

/// 在 Windows 上让子进程不弹控制台窗口。
/// 用户反馈「一打开软件总闪过几个命令行窗口」——
/// 原因就是 whoami / bcdedit / tasklist 这些命令各自弹了个控制台。
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(program);
    c.args(args);
    no_window(&mut c);
    let out = c.output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn is_admin() -> bool {
    // 用令牌完整性级别判断（High=S-1-16-12288 / System=S-1-16-16384）。
    // 原来的 net session 依赖 Server 服务，而安全模式下该服务不启动，
    // 会把管理员误判成「不是管理员」。
    let mut c = Command::new("whoami.exe");
    c.arg("/groups");
    no_window(&mut c);
    match c.output() {
        Ok(o) => {
            let t = String::from_utf8_lossy(&o.stdout);
            t.contains("S-1-16-12288") || t.contains("S-1-16-16384")
        }
        Err(_) => false,
    }
}

fn is_safe_mode() -> bool {
    let mut c = Command::new("bcdedit.exe");
    c.arg("/enum").arg("{current}");
    no_window(&mut c);
    let out = c.output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_lowercase().contains("safeboot"),
        Err(_) => false,
    }
}

fn seewo_process_counts() -> Vec<(String, usize)> {
    let names = [
        "SeewoServiceAssistant",
        "SeewoCore",
        "SeewoAbility",
        "ResidentSideBar",
    ];
    let mut c = Command::new("tasklist.exe");
    no_window(&mut c);
    let out = c
        .arg("/fo")
        .arg("csv")
        .arg("/nh")
        .output();
    let text = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return names.iter().map(|n| (n.to_string(), 0)).collect(),
    };
    names
        .iter()
        .map(|n| {
            let c = text
                .lines()
                .filter(|l| l.to_lowercase().contains(&format!("\"{}.exe\"", n.to_lowercase())))
                .count();
            (n.to_string(), c)
        })
        .collect()
}

fn main() {
    // =====================================================================
    // ★ 命令行模式：完全不走 Tauri / WebView2，因此**在安全模式下也能跑**。
    //   Tauri 依赖 WebView2 渲染界面，而安全模式下 WebView2 常常起不来
    //   （用户实测：点安装进安全模式后程序打不开、没反应）。
    //   这里在创建任何窗口之前就分流，纯 Rust 文件操作，零 GUI 依赖。
    //
    //   注意：本程序是 windows_subsystem="windows"，没有控制台，
    //   所以结果写进日志文件并用记事本展示，而不是 println!。
    // =====================================================================
    let argv: Vec<String> = std::env::args().collect();
    let has = |k: &str| argv.iter().any(|a| a == k);

    if has("--prepare-safe")
        || has("--safe-action")
        || has("--safe-install")
        || has("--safe-uninstall")
        || has("--exit-safe-mode")
    {
        let _ = ensure_dir(&config_dir());
        let mut out = String::new();
        let mut reboot_after: u32 = 0;

        out.push_str("希沃屏保配置 · 命令行模式（不依赖 WebView2，安全模式下可用）\r\n");
        out.push_str(&format!("版本 {}   管理员: {}\r\n\r\n", CONFIG_VERSION, is_admin()));

        if has("--prepare-safe") {
            match write_safe_scripts() {
                Ok(v) => {
                    out.push_str("已生成安全模式脚本：\r\n");
                    if let Some(arr) = v["files"].as_array() {
                        for f in arr {
                            out.push_str(&format!("  {}\r\n", f.as_str().unwrap_or("")));
                        }
                    }
                }
                Err(e) => out.push_str(&format!("[!!] 生成失败: {}\r\n", e)),
            }
        } else if has("--exit-safe-mode") {
            out.push_str("正在关闭安全模式…\r\n");
            match run_cmd("bcdedit.exe", &["/deletevalue", "{current}", "safeboot"]) {
                Ok(_) => out.push_str("  [OK] 安全模式已关闭\r\n"),
                Err(e) => out.push_str(&format!("  [!!] 失败: {}（需要管理员权限）\r\n", e)),
            }
            let _ = fs::remove_file(config_dir().join("pending-safe-action.txt"));
            out.push_str("\r\n电脑将在 15 秒后重启。\r\n想取消：在本窗口执行 shutdown /a\r\n");
            reboot_after = 15;
        } else {
            // 命令行开关优先（bat 菜单选 1/2 时直接指定），否则读 pending 文件
            let pending = config_dir().join("pending-safe-action.txt");
            let action = if has("--safe-uninstall") {
                "uninstall".to_string()
            } else if has("--safe-install") {
                "install".to_string()
            } else {
                let t = fs::read_to_string(&pending)
                    .map(|v| v.trim().to_string())
                    .unwrap_or_else(|_| "install".to_string());
                if t == "uninstall" { "uninstall".to_string() } else { "install".to_string() }
            };
            out.push_str(&format!("待办动作: {}\r\n\r\n", action));

            if let Some(d) = find_seewo_dir() {
                out.push_str(&format!("希沃目录: {}\r\n", d.display()));
            } else {
                out.push_str("[!!] 没找到希沃安装目录\r\n");
            }
            out.push_str("\r\n");

            // 防御：未注入时不做还原，否则可能把刚注入的覆盖掉
            let was_injected = is_injected_now();
            out.push_str(&format!("注入前状态: {}\r\n\r\n", if was_injected { "已注入" } else { "未注入" }));
            let r = if action == "uninstall" {
                if !was_injected {
                    Ok(json!({ "message": "当前本来就没注入，无需还原" }))
                } else {
                    unpatch_asar()
                }
            } else {
                patch_asar()
            };
            match &r {
                Ok(v) => out.push_str(&format!("[OK] {}\r\n", v["message"].as_str().unwrap_or("完成"))),
                Err(e) => out.push_str(&format!("[!!] {}\r\n", e)),
            }
            out.push_str(&format!("\r\n注入后状态: {}\r\n", if is_injected_now() { "已注入" } else { "未注入" }));

            let _ = fs::remove_file(&pending);
            out.push_str("\r\n正在关闭安全模式…\r\n");
            match run_cmd("bcdedit.exe", &["/deletevalue", "{current}", "safeboot"]) {
                Ok(_) => out.push_str("  [OK] 安全模式已关闭\r\n"),
                Err(e) => out.push_str(&format!("  [!!] 失败: {} —— 请双击桌面「安全模式-点我.bat」并选 3\r\n", e)),
            }
            out.push_str("\r\n电脑将在 15 秒后重启回正常模式。\r\n想取消：在本窗口执行 shutdown /a\r\n");
            reboot_after = 15;
        }

        // 写日志并用记事本打开（没有控制台，只能这样展示）
        let logf = config_dir().join("safe-action.log");
        let _ = fs::write(&logf, &out);
        log_line("INFO", "命令行模式完成");
        let _ = Command::new("notepad.exe").arg(logf.as_os_str()).spawn();

        if reboot_after > 0 {
            let t = reboot_after.to_string();
            let _ = run_cmd("shutdown.exe", &["/r", "/t", &t, "/c", "AuraScreensaver: 重启回正常模式"]);
        }
        return;
    }
    // ---- 单实例：用一个本地端口当锁 ----
    // 第二个实例连得上就说明已有实例，请它把窗口带到前台后自己退出。
    let listener = std::net::TcpListener::bind(("127.0.0.1", SINGLE_INSTANCE_PORT)).ok();
    if listener.is_none() {
        use std::io::Write;
        if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
            let _ = s.write_all(b"SHOW");
        }
        return;
    }
    let listener = listener.expect("listener");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // 已有实例被再次启动时，把窗口拉到前台
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use std::io::Read;
                for stream in listener.incoming() {
                    if let Ok(mut s) = stream {
                        let mut buf = [0u8; 8];
                        let _ = s.read(&mut buf);
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_config,
            patch_asar,
            unpatch_asar,
            send_command,
            diagnostics,
            open_path,
            list_default_images,
            detect_browsers,
            enter_safe_mode,
            is_pending_safe_action,
            run_pending_safe_action,
            kernel_info,
            download_kernel,
            speedtest_mirrors,
            check_upgrade,
            cleanup_candidates,
            do_cleanup,
            reboot,
            pick_files,
            scan_image_folder,
            image_data_url,
            prepare_safe_mode,
            open_safe_dir,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
