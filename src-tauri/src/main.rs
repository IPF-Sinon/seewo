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
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LOADER_JS: &str = include_str!("../../tools/payload/aura-screensaver-loader.js");
const KERNEL_PS1: &str = include_str!("kernel_download.ps1");
const KERNEL_MAIN_JS: &str = include_str!("../../tools/electron-app/main.js");
const KERNEL_PKG_JSON: &str = include_str!("../../tools/electron-app/package.json");
const SINGLE_INSTANCE_PORT: u16 = 37651;
const MARKER: &str = "aura-screensaver-loader";
const INJECT_ANCHOR: &str = "n.p=\"\",n(n.s=140)}([";
const INJECT_REPLACE: &str = "n.p=\"\",global.__AURA_REQ__=n,n(n.s=140)}([";
const CONFIG_VERSION: &str = "2.1.0";

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

// ===================== 配置 =====================

fn default_config() -> Value {
    json!({
        "screensaverEnabled": false,
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

#[tauri::command]
fn patch_asar() -> Result<Value, String> {
    let a = asar_path().ok_or("找不到希沃安装目录")?;
    let bak = a.with_extension("asar.bak");
    let buf = fs::read(&a).map_err(|e| format!("读取 app.asar 失败: {}（正常模式下常被希沃驱动拦写）", e))?;

    let mut map = unpack_asar(&buf)?;
    let main = match map.get("main.js") {
        Some(Entry::Data(d)) => d.clone(),
        _ => return Err("app.asar 里没有 main.js".to_string()),
    };
    let mut text = String::from_utf8_lossy(&main).to_string();

    if text.contains("global.__AURA_REQ__") {
        return Ok(json!({ "ok": true, "already": true, "message": "已经是注入状态，无需重复注入" }));
    }
    if !text.contains(INJECT_ANCHOR) {
        return Err("找不到注入锚点，可能是希沃版本不匹配".to_string());
    }
    text = text.replace(INJECT_ANCHOR, INJECT_REPLACE);
    text = text.replace("\n//# sourceMappingURL=", "\n//# sourceMappingURL=");
    text.push_str(&format!("\n;try{{/* {} v{} */\n", MARKER, CONFIG_VERSION));
    text.push_str(LOADER_JS);
    text.push_str("\n}catch(e){}\n");

    if !bak.exists() {
        fs::write(&bak, &buf).map_err(|e| format!("写备份失败: {}", e))?;
    }
    map.insert("main.js".to_string(), Entry::Data(text.into_bytes()));
    let out = pack_asar(&map);
    fs::write(&a, &out).map_err(|e| format!("写入 app.asar 失败: {}（请到安全模式再试）", e))?;

    log_line("INFO", "注入完成");
    Ok(json!({ "ok": true, "already": false, "size": out.len(), "message": "注入成功" }))
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
    let payload = json!({ "cmd": cmd, "at": now_ms() as u64 });
    let p = config_dir().join("command.json");
    fs::write(&p, serde_json::to_string(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写命令文件失败: {}", e))?;
    log_line("INFO", &format!("已下发命令 {}", cmd));
    Ok(json!({ "ok": true, "message": format!("已下发 {}（若希沃未运行则不会生效）", cmd) }))
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
        return Err(format!("目录不存在：{}", target.display()));
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
    PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string()))
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
    ensure_dir(&config_dir())?;
    fs::write(config_dir().join("pending-safe-action.txt"), &action)
        .map_err(|e| format!("写待办标记失败: {}", e))?;
    if !is_admin() {
        return Err("设置安全模式需要管理员权限，请右键以管理员身份运行".to_string());
    }
    run_cmd("bcdedit.exe", &["/set", "{current}", "safeboot", "minimal"])
        .map_err(|e| format!("设置安全模式失败: {}", e))?;
    log_line("INFO", &format!("已设置安全模式，待办动作={}", action));
    Ok(json!({ "ok": true, "ranNow": false, "message": "已安排好。请重启电脑进入安全模式，然后再次打开本程序，它会自动继续。" }))
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

/// 后台下载新内核，通过 kernel-progress / kernel-done 事件回报进度
#[tauri::command]
fn download_kernel(app: tauri::AppHandle) -> Result<Value, String> {
    let dir = write_kernel_app()?;
    let script = dir.join("_download.ps1");
    fs::write(&script, KERNEL_PS1).map_err(|e| format!("写下载脚本失败: {}", e))?;
    let dir_s = dir.to_string_lossy().to_string();

    let app2 = app.clone();
    let dir2 = dir.clone();
    std::thread::spawn(move || {
        let spawned = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg(&dir_s)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let _ = app2.emit("kernel-done", json!({ "ok": false, "message": format!("启动下载失败: {}", e) }));
                return;
            }
        };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let total = fs::read_to_string(dir2.join("download.total"))
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);
            let cur = fs::metadata(dir2.join("download.zip")).map(|m| m.len()).unwrap_or(0);
            let _ = app2.emit("kernel-progress", json!({ "downloaded": cur, "total": total }));
            match child.try_wait() {
                Ok(Some(st)) => {
                    let ver = fs::read_to_string(dir2.join("version.txt")).unwrap_or_default().trim().to_string();
                    let ok = st.success() && dir2.join("electron.exe").exists();
                    let message = if ok {
                        format!("内核 v{} 已就绪", ver)
                    } else {
                        "下载失败：所有源都没成功，请检查网络后重试".to_string()
                    };
                    let _ = app2.emit("kernel-done", json!({ "ok": ok, "message": message, "version": ver }));
                    return;
                }
                Ok(None) => {}
                Err(e) => {
                    let _ = app2.emit("kernel-done", json!({ "ok": false, "message": format!("{}", e) }));
                    return;
                }
            }
        }
    });
    Ok(json!({ "started": true, "message": "已开始下载（约 151MB，后台进行）" }))
}

// ===================== 升级检测 / 清理 =====================

/// 从已注入的 main.js 里读出注入版本标记
fn installed_loader_version() -> Option<String> {
    let a = asar_path()?;
    let buf = fs::read(a).ok()?;
    let map = unpack_asar(&buf).ok()?;
    if let Some(Entry::Data(d)) = map.get("main.js") {
        let t = String::from_utf8_lossy(d).to_string();
        let key = format!("/* {} v", MARKER);
        let i = t.find(&key)?;
        let rest = &t[i + key.len()..];
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        return Some(rest[..end].to_string());
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

#[tauri::command]
fn cleanup_candidates() -> Result<Value, String> {
    let mut items: Vec<Value> = Vec::new();
    let logs = log_dir();
    if logs.exists() {
        if let Ok(rd) = fs::read_dir(&logs) {
            for e in rd.filter_map(|x| x.ok()) {
                let p = e.path();
                if p.is_file() {
                    let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
                    items.push(json!({ "key": format!("log:{}", p.file_name().unwrap_or_default().to_string_lossy()), "path": p.to_string_lossy().to_string(), "label": format!("日志 {}", p.file_name().unwrap_or_default().to_string_lossy()), "size": sz }));
                }
            }
        }
    }
    let kd = kernel_dir();
    for n in ["download.zip", "download.total", "download.version", "_download.ps1"] {
        let p = kd.join(n);
        if p.exists() {
            let sz = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            items.push(json!({ "key": format!("kernel:{}", n), "path": p.to_string_lossy().to_string(), "label": format!("内核临时文件 {}", n), "size": sz }));
        }
    }
    let p = config_dir().join("exit-btn.html");
    if p.exists() {
        items.push(json!({ "key": "ui:exit-btn", "path": p.to_string_lossy().to_string(), "label": "网页屏保退出按钮页面", "size": fs::metadata(&p).map(|m| m.len()).unwrap_or(0) }));
    }
    Ok(json!({ "items": items }))
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


// ===================== 小工具 =====================

fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn is_admin() -> bool {
    // 用 net session 探测（需要管理员权限才能成功）
    Command::new("net")
        .arg("session")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_safe_mode() -> bool {
    let out = Command::new("bcdedit.exe").arg("/enum").arg("{current}").output();
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
    let out = Command::new("tasklist.exe")
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
            check_upgrade,
            cleanup_candidates,
            do_cleanup,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
