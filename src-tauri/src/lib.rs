use serde::{Deserialize, Serialize};
use tauri::command;
use tauri::ipc::Channel;
use tauri::Manager;

// The hidden duck.ai bridge window is exposed over the Chrome DevTools
// Protocol on this loopback port. The frontend drives the REAL SPA through
// it (minting genuine journey/signals/vqd tokens that duck.ai's bot
// detection now requires). Port 0 would pick a random free port, but a fixed
// value keeps the frontend logic simple.
const DUCAKAI_BRIDGE_DEBUG_PORT: u16 = 9333;
const DUCAKAI_BRIDGE_URL: &str = "https://duck.ai";

const DUCKAI_BASE: &str = "https://duck.ai";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Pinned front-end version observed in the duck.ai SPA. If chat starts failing
// with 400s, refresh this from the live bundle (entry.duckai.*.js).
const FE_VERSION: &str = "serp_20260929_164831_ET-9cf30bed9ed32b02fdfb22cd5234989c3af03e0e";
// duck.ai rejects oversized payloads with 429 ERR_INPUT_LIMIT (~20KB).
const MAX_BODY_BYTES: usize = 18 * 1024;

// Anonymous session cookies the duck.ai SPA sets on warm-up. The reference
// client (p2d-duck) sets these on both .duck.ai and .duckduckgo.com before
// any request; sending them keeps the fingerprint/session consistent.
const WARM_COOKIES: &str = "5=1; ah=wt-wt; dcs=1; dcm=3; isRecentChatOn=1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum StreamEvent {
    Delta { text: String },
    Title { title: String },
    Done,
}

// ---------------------------------------------------------------------------
// Hidden duck.ai bridge window (real SPA) + CDP plumbing
// ---------------------------------------------------------------------------

/// Append `--remote-debugging-port` to WebView2's browser args. Must run
/// BEFORE the first WebView2 instance is created (top of `run`).
///
/// The args live in the PROCESS-WIDE env var, not in per-window
/// `additionalBrowserArgs`: per-window args feed into the WebView2
/// environment's options, and two windows with DIFFERENT options cannot share
/// one browser process on one user-data-dir. That mismatch was verified live —
/// the child webview / second window got registered in Tauri but no HWND
/// ever appeared, no renderer, no CDP target, and the split pane could not
/// show. Identical (absent) per-window args make both windows share one
/// environment built from this string.
fn set_webview_debug_env() {
    let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let flag = format!("--remote-debugging-port={DUCAKAI_BRIDGE_DEBUG_PORT}");
    if !args.split_whitespace().any(|a| a == flag) {
        if !args.trim().is_empty() {
            args.push(' ');
        }
        args.push_str(&flag);
        // `--remote-allow-origins=*` lets the main window's DevTools client
        // attach; loopback-only port keeps exposure local.
        args.push_str(" --remote-allow-origins=*");
        // Keep the browser UA identical to `duckchat_stream`'s: the PoW
        // challenge fingerprints navigator.userAgent, and WebView2's own UA
        // carries an "Edg/..." token duck.ai rejects with 418 ERR_CHALLENGE.
        args.push_str(&format!(" --user-agent=\"{USER_AGENT}\""));
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    }
}

/// Label of the duck.ai bridge — a CHILD webview embedded in the main window
/// (one-window split, like the terminal/output pane).
///
/// History: a runtime-created top-level window never gets an HWND on this
/// machine, and the earlier "child webviews never render" verdict turned out to
/// be the SAME WebView2 environment conflict as the missing HWND — a builder
/// carrying its own `additionalBrowserArgs` cannot join the process-wide
/// environment. With all args in the env var (see `set_webview_debug_env`), a
/// child built with NO per-view args renders duck.ai live, verified over CDP.
/// The pane therefore comes and goes by MOVING this child inside the parent,
/// never by creating or hiding one — `hide()` still kills the renderer.
const BRIDGE_LABEL: &str = "duckai";

/// Parked bounds for the child webview: outside the parent's client area, so
/// Windows clips it from view while the renderer (CDP target, PoW, session)
/// stays alive.
const PARK_X: i32 = -10_000;

/// Get the embedded duck.ai child webview, creating it (parked) on first call.
/// Must NOT run on the main thread: `add_child` round-trips through it.
fn duckai_child(app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    if let Some(wv) = app.get_webview(BRIDGE_LABEL) {
        return Ok(wv);
    }
    use tauri::webview::WebviewBuilder;
    use tauri::WebviewUrl;
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let builder = WebviewBuilder::new(
        BRIDGE_LABEL,
        WebviewUrl::External(DUCAKAI_BRIDGE_URL.parse::<tauri::Url>().map_err(|e| e.to_string())?),
    );
    main.add_child(
        builder,
        tauri::PhysicalPosition::new(PARK_X, PARK_X),
        tauri::PhysicalSize::new(480u32, 640u32),
    )
    .map_err(|e| e.to_string())
}

/// Move the bridge child out of sight without ever hiding it. `hide()` stops
/// WebView2 spinning up its renderer (no CDP target -> PoW never minted, SPA
/// never boots), so it is parked outside the parent's client area instead.
fn park_bridge(app: &tauri::AppHandle) {
    if let Some(wv) = app.get_webview(BRIDGE_LABEL) {
        let _ = wv.set_position(tauri::PhysicalPosition::new(PARK_X, PARK_X));
    }
}

/// Place the embedded duck.ai child at a physical-pixel rect of the main
/// window's client area — the frontend measures its pane column with
/// `getBoundingClientRect()` and multiplies by `devicePixelRatio`. This is the
/// one-window replacement for the old dock-a-second-window command.
#[command]
async fn place_duckai(app: tauri::AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    let child = duckai_child(&app)?;
    child
        .set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(x, y).into(),
            // A zero-sized webview stops painting; keep a 1px floor.
            size: tauri::PhysicalSize::new(w.max(1), h.max(1)).into(),
        })
        .map_err(|e| e.to_string())
}

/// (Re)load the duck.ai bridge page, parked. Used at startup and by
/// Settings → bridge check; the child itself is never closed.
fn create_duckai_bridge_window(app: &tauri::AppHandle) -> Result<(), String> {
    let child = duckai_child(app)?;
    let _ = child.set_position(tauri::PhysicalPosition::new(PARK_X, PARK_X));
    let url = tauri::Url::parse(DUCAKAI_BRIDGE_URL).map_err(|e| e.to_string())?;
    child.navigate(url).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CdpTarget {
    id: String,
    url: String,
    title: String,
    web_socket_debugger_url: String,
}

/// Fixed loopback port the duck.ai bridge exposes CDP on.
#[command]
fn get_bridge_port() -> u16 {
    DUCAKAI_BRIDGE_DEBUG_PORT
}

/// Try an HTTP GET against the CDP loopback server, via both 127.0.0.1 and
/// localhost (WebView2 might bind IPv4 or IPv6 loopback on some machines).
/// Hard 5s timeout: if the debug port is wedged the caller must fail fast
/// instead of hanging the whole chat send forever.
async fn cdp_get(path: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last_err = String::new();
    for host in ["127.0.0.1", "localhost"] {
        let url = format!("http://{host}:{DUCAKAI_BRIDGE_DEBUG_PORT}{path}");
        match client.get(&url).send().await {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = format!("cdp json: {}", e),
            },
            Err(e) => last_err = format!("cdp: {}", e),
        }
    }
    Err(last_err)
}

/// List CDP targets of the duck.ai bridge (from the WebView2 debug server).
/// The frontend picks the duck.ai page and drives it over WebSocket.
#[command]
async fn cdp_targets() -> Result<Vec<CdpTarget>, String> {
    let value = cdp_get("/json/list").await?;
    let arr = value
        .as_array()
        .ok_or_else(|| "cdp: unexpected json shape".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|t| {
            let o = t.as_object()?;
            Some(CdpTarget {
                id: o.get("id")?.as_str()?.to_string(),
                url: o.get("url")?.as_str()?.to_string(),
                title: o.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                web_socket_debugger_url: o.get("webSocketDebuggerUrl")?.as_str()?.to_string(),
            })
        })
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeDiag {
    env_args: String,
    window_exists: bool,
    port_open: bool,
    target_count: usize,
    error: Option<String>,
    /// URL the bridge child webview actually reports. Its own target never
    /// appeared in `/json/list`, so this is the only direct read of what it
    /// navigated to — if it is not duck.ai, the pane has nothing to show.
    bridge_url: Option<String>,
    /// Rust-side cached position/size of the bridge webview, read back after the
    /// dock. Compared against the real HWND: if these say "docked" while the HWND
    /// is still parked, the message never reached wry.
    bridge_pos: Option<(i32, i32)>,
    bridge_size: Option<(u32, u32)>,
    /// Size of the main window, so the two can be checked for a sane layout.
    main_size: Option<(u32, u32)>,
    /// Why each read failed. Three silent `null`s would not have told us which
    /// call broke, so the underlying errors are surfaced verbatim.
    bridge_err: String,
}

/// Float the embedded duck.ai webview over the middle of the main window so
/// the user can solve a bot challenge (image captcha) once; the session cookie
/// then persists. When `show` is false the child is parked outside the parent
/// instead of hidden — a hidden WebView2 never spins up its renderer (no CDP
/// target, SPA never boots). The frontend re-places the pane at its docked
/// rect on the next layout pass.
#[command]
async fn show_bridge_window(app: tauri::AppHandle, show: bool) -> Result<(), String> {
    if !show {
        park_bridge(&app);
        return Ok(());
    }
    let child = duckai_child(&app)?;
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let inner = main.inner_size().map_err(|e| e.to_string())?;
    let scale = main
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let pw = (560.0 * scale).min(inner.width as f64 * 0.9);
    let ph = (780.0 * scale).min(inner.height as f64 * 0.9);
    child
        .set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(
                ((inner.width as f64 - pw) / 2.0).max(0.0).round() as i32,
                ((inner.height as f64 - ph) / 3.0).max(0.0).round() as i32,
            )
            .into(),
            size: tauri::PhysicalSize::new(pw.round() as u32, ph.round() as u32).into(),
        })
        .map_err(|e| e.to_string())
}

/// Snapshot the runtime state of the bridge and main window. Used by both
/// diagnostics, so the fields cannot drift apart between the two code paths.
fn bridge_state(
    app: &tauri::AppHandle,
) -> (
    Option<String>,
    Option<(i32, i32)>,
    Option<(u32, u32)>,
    Option<(u32, u32)>,
    String,
) {
    let wv = app.get_webview(BRIDGE_LABEL);
    let bridge_url = wv.as_ref().and_then(|w| w.url().ok()).map(|u| u.to_string());
    let bridge_pos = wv
        .as_ref()
        .and_then(|w| w.position().ok())
        .map(|p| (p.x, p.y));
    let bridge_size = wv
        .as_ref()
        .and_then(|w| w.size().ok())
        .map(|s| (s.width, s.height));
    let main_size = app
        .get_window("main")
        .and_then(|w| w.outer_size().ok())
        .map(|s| (s.width, s.height));
    let bridge_err = match wv.as_ref() {
        None => "no webview registered".to_string(),
        Some(w) => {
            let u = w.url().err().map(|e| format!("url: {e}")).unwrap_or_else(|| "url ok".into());
            let p = w
                .position()
                .err()
                .map(|e| format!("pos: {e}"))
                .unwrap_or_else(|| "pos ok".into());
            let s = w
                .size()
                .err()
                .map(|e| format!("size: {e}"))
                .unwrap_or_else(|| "size ok".into());
            format!("{u}; {p}; {s}")
        }
    };
    (bridge_url, bridge_pos, bridge_size, main_size, bridge_err)
}

/// One-stop diagnostic for the hidden bridge window: whether WebView2's debug
/// port logic is in place and the CDP server is answering.
#[command]
async fn bridge_diag(app: tauri::AppHandle) -> BridgeDiag {
    let env_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let window_exists = app.get_webview(BRIDGE_LABEL).is_some();
    let (bridge_url, bridge_pos, bridge_size, main_size, bridge_err) = bridge_state(&app);
    match cdp_get("/json/list").await {
        Ok(v) => BridgeDiag {
            env_args,
            window_exists,
            port_open: true,
            target_count: v.as_array().map(|a| a.len()).unwrap_or(0),
            error: None,
            bridge_url,
            bridge_pos,
            bridge_size,
            main_size,
            bridge_err,
        },
        Err(e) => BridgeDiag {
            env_args,
            window_exists,
            port_open: false,
            target_count: 0,
            error: Some(e),
            bridge_url,
            bridge_pos,
            bridge_size,
            main_size,
            bridge_err,
        },
    }
}

/// Recreate the hidden duck.ai bridge window on demand (Settings → bridge
/// check). Reports what happened so the UI can show a real error.
#[command]
async fn recreate_bridge(app: tauri::AppHandle) -> Result<BridgeDiag, String> {
    // The child webview is never closed (that would destroy the session), so
    // a "recreate" is a fresh navigation of the existing view, not a rebuild.
    create_duckai_bridge_window(&app)?;
    // Give WebView2 a moment to register the new page, then report state.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let env_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let window_exists = app.get_webview(BRIDGE_LABEL).is_some();
    let (bridge_url, bridge_pos, bridge_size, main_size, bridge_err) = bridge_state(&app);
    match cdp_get("/json/list").await {
        Ok(v) => Ok(BridgeDiag {
            env_args,
            window_exists,
            port_open: true,
            target_count: v.as_array().map(|a| a.len()).unwrap_or(0),
            error: None,
            bridge_url,
            bridge_pos,
            bridge_size,
            main_size,
            bridge_err,
        }),
        Err(e) => Ok(BridgeDiag {
            env_args,
            window_exists,
            port_open: false,
            target_count: 0,
            error: Some(e),
            bridge_url,
            bridge_pos,
            bridge_size,
            main_size,
            bridge_err,
        }),
    }
}

// ---------------------------------------------------------------------------
// Duck.ai PoW challenge + streaming chat
// ---------------------------------------------------------------------------

/// The User-Agent used for HTTP requests to duck.ai.
///
/// The PoW challenge fingerprints `navigator.userAgent`, so the frontend MUST
/// run the challenge with the SAME UA that `duckchat_stream` sends over the
/// wire (WebView2's real navigator UA carries an "Edg/..." token the server
/// does not expect -> 418 ERR_CHALLENGE).
#[command]
fn get_user_agent() -> String {
    USER_AGENT.to_string()
}

/// GET /duckchat/v1/status -> returns the base64 PoW challenge from the
/// `x-vqd-hash-1` response header. The frontend executes it (real WebView DOM)
/// and turns the result into the X-Vqd-Hash-1 value for chat requests.
#[command]
async fn get_challenge() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    // Warm-up: the SPA mints its session cookies on the landing page. Mirrors
    // p2d's warm(): GET / then /duckchat/v1/status with x-vqd-accept.
    let _ = client
        .get(format!("{}/", DUCKAI_BASE))
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Cookie", WARM_COOKIES)
        .header("Referer", DUCKAI_BASE)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    let resp = client
        .get(format!("{}/duckchat/v1/status", DUCKAI_BASE))
        .header("Accept", "*/*")
        .header("x-vqd-accept", "1")
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache")
        .header("Cookie", WARM_COOKIES)
        .header("Referer", format!("{}/", DUCKAI_BASE))
        .header("Origin", DUCKAI_BASE)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.headers()
        .get("x-vqd-hash-1")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| "No x-vqd-hash-1 header in status response".to_string())
}

/// POST /duckchat/v1/chat with streaming SSE deltas pushed through `on_event`.
///
/// Notes (reverse-engineered from the duck.ai SPA + duckai-bridge):
/// - `role="system"` is rejected with 400 -> system content is merged into the
///   first user message before sending.
/// - Body must stay under ~20KB or the upstream returns 429 ERR_INPUT_LIMIT.
/// - `durable_stream` is the RSA-OAEP-256 public JWK generated client-side;
///   the upstream sends plain JSON SSE in practice.
#[command]
async fn duckchat_stream(
    model: String,
    messages: Vec<ChatMessage>,
    vqd_hash: String,
    durable_stream: serde_json::Value,
    journey_id: String,
    fe_signals: String,
    cookies: Option<String>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    // 1. Fold system/developer messages into the first user message.
    let mut msgs: Vec<ChatMessage> = Vec::new();
    let mut sys_parts: Vec<String> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" | "developer" => sys_parts.push(m.content),
            "tool" => msgs.push(ChatMessage {
                role: "user".into(),
                content: format!("[tool_result] {}", m.content),
            }),
            _ => msgs.push(m),
        }
    }
    if !sys_parts.is_empty() {
        let sys = sys_parts.join("\n\n");
        if let Some(first_user) = msgs.iter_mut().find(|m| m.role == "user") {
            first_user.content = format!("{}\n\n{}", sys, first_user.content);
        } else {
            msgs.insert(0, ChatMessage { role: "user".into(), content: sys });
        }
    }
    if msgs.is_empty() {
        return Err("No messages to send".into());
    }

    // 2. Build body, truncating the first (context-heavy) message if needed.
    //
    // Field set mirrored from a live duck.ai capture (2026-09-30): message
    // `content` is an ARRAY of `{type:"text"}` parts, `reasoningEffort` and
    // `canShowGreeting` are required, and `metadata.toolChoice` no longer
    // exists. Sending the old shape is what surfaces as the opaque
    // 400 ERR_BAD_REQUEST / 418 ERR_CHALLENGE.
    let mut body = serde_json::json!({
        "model": model,
        "messages": msgs
            .iter()
            .map(|m| {
                serde_json::json!({
                    "role": m.role,
                    "content": [{ "type": "text", "text": m.content }],
                })
            })
            .collect::<Vec<serde_json::Value>>(),
        "canUseTools": false,
        "reasoningEffort": "none",
        "canUseApproxLocation": null,
        "canDelegateImageGeneration": null,
        "canShowGreeting": false,
        "durableStream": durable_stream,
    });
    let mut body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    if body_str.len() > MAX_BODY_BYTES {
        let overflow = body_str.len() - MAX_BODY_BYTES;
        if let Some(first) = body["messages"][0]["content"][0].get_mut("text") {
            if let Some(s) = first.as_str() {
                let cut = overflow + 200;
                let new_content = if s.len() > cut + 2000 {
                    let keep_end = 2000.min(s.len());
                    let head_end = floor_boundary(s, s.len() - cut - keep_end);
                    let tail_start = floor_boundary(s, s.len() - keep_end);
                    format!(
                        "{}[...truncated to fit duck.ai input limit...]{}",
                        &s[..head_end],
                        &s[tail_start..]
                    )
                } else {
                    let half = floor_boundary(s, (MAX_BODY_BYTES / 2).min(s.len()));
                    format!("{}...(truncated)", &s[..half])
                };
                *first = serde_json::Value::String(new_content);
            }
        }
        body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    }

    // 3. POST with the full SPA header set.
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let fe_signals = if fe_signals.trim().is_empty() {
        base64_encode("{}")
    } else {
        fe_signals
    };
    // Prefer real-browser cookies (captured by the user) so the WAF sees an
    // established session; otherwise fall back to the minimal warm cookies.
    let cookie_header = cookies
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or(WARM_COOKIES);
    let mut resp = client
        .post(format!("{}/duckchat/v1/chat", DUCKAI_BASE))
        .header("Accept", "text/event-stream")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "gzip, deflate, br")
        .header("Content-Type", "application/json")
        .header("Origin", "https://duck.ai")
        .header("Referer", "https://duck.ai/")
        .header("Cookie", cookie_header)
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("Sec-Ch-Ua", "\"Not.A/Brand\";v=\"99\", \"Chromium\";v=\"131\"")
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"Windows\"")
        .header("x-fe-version", FE_VERSION)
        .header("x-fe-signals", fe_signals)
        .header("X-Vqd-Hash-1", &vqd_hash)
        .header("x-ddg-journey-id", &journey_id)
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    // 4. Stream SSE chunks. Lines look like:
    //    data: {"role":"assistant","message":"..."}
    //    data: [DONE] | data: [PING] | data: [CHAT_TITLE:...]
    let mut buf = String::new();
    loop {
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    let line = line.trim();
                    if line.is_empty() || !line.starts_with("data:") {
                        continue;
                    }
                    let payload = line["data:".len()..].trim();
                    if payload == "[DONE]" {
                        let _ = on_event.send(StreamEvent::Done);
                        return Ok(());
                    }
                    if payload == "[PING]" || payload.is_empty() {
                        continue;
                    }
                    if let Some(title) = payload
                        .strip_prefix("[CHAT_TITLE:")
                        .and_then(|t| t.strip_suffix(']'))
                    {
                        let _ = on_event.send(StreamEvent::Title {
                            title: title.to_string(),
                        });
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                        let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
                        if role == "assistant" {
                            if let Some(text) =
                                v.get("message").and_then(|m| m.as_str())
                            {
                                if !text.is_empty() {
                                    let _ = on_event.send(StreamEvent::Delta {
                                        text: text.to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("stream error: {}", e)),
        }
    }

    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}

fn floor_boundary(s: &str, n: usize) -> usize {
    if n >= s.len() {
        return s.len();
    }
    let mut i = n;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn base64_encode(s: &str) -> String {
    base64_encode_bytes(s.as_bytes())
}

fn base64_encode_bytes(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if i + 1 < bytes.len() {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if i + 2 < bytes.len() {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
        i += 3;
    }
    out
}

// ---------------------------------------------------------------------------
// Project filesystem
// ---------------------------------------------------------------------------

#[command]
async fn read_project_tree(path: String) -> Result<Vec<FileNode>, String> {
    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&path).await.map_err(|e| e.to_string())?;

    let ignore_folders = [
        "node_modules", ".git", "dist", "build", "target",
        "__pycache__", ".next", ".nuxt", "coverage", ".cache",
    ];
    let ignore_files = [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
        ".DS_Store", "Thumbs.db",
    ];

    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if ignore_folders.contains(&file_name.as_str())
            || ignore_files.contains(&file_name.as_str())
        {
            continue;
        }
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        let is_dir = metadata.is_dir();
        let full_path = entry.path().to_string_lossy().to_string();
        let children = if is_dir {
            Some(Box::pin(read_project_tree(full_path.clone())).await?)
        } else {
            None
        };
        entries.push(FileNode {
            name: file_name,
            path: full_path,
            is_dir,
            children,
            size: if is_dir { None } else { Some(metadata.len()) },
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(entries)
}

#[command]
async fn read_file_content(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())
}

/// Base64 bytes for the composer's hover previews.
///
/// Bounded on purpose: a picture bigger than `max_bytes` returns `None` instead
/// of a payload that would stall the webview, and the caller never learns a
/// truncated half-image.
#[command]
async fn read_file_preview(path: String, max_bytes: Option<usize>) -> Result<Option<String>, String> {
    let limit = max_bytes.unwrap_or(3_000_000).clamp(1024, 8_000_000);
    let meta = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() as usize > limit {
        return Ok(None);
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    Ok(Some(base64_encode_bytes(&bytes)))
}

#[command]
async fn read_file_chunk(path: String, max_chars: usize) -> Result<String, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|&b| b == 0) && !looks_like_text(&bytes) {
        return Err("Binary file (skipped)".into());
    }
    let s = String::from_utf8_lossy(&bytes);
    let s = s.lines().take(max_chars.max(100).min(20000)).collect::<Vec<_>>().join("\n");
    let mut out = s;
    if out.len() > max_chars {
        let cut = floor_boundary(&out, max_chars);
        out = out[..cut].to_string();
        out.push_str("\n... (truncated)");
    }
    Ok(out)
}

fn looks_like_text(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(4096)];
    let printable = sample
        .iter()
        .filter(|&&b| b == 9 || b == 10 || b == 13 || (32..=126).contains(&b))
        .count();
    printable * 10 >= sample.len() * 9
}

#[derive(Debug, Serialize)]
struct GrepMatch {
    path: String,
    line_number: usize,
    line: String,
}

const IGNORE_FOLDERS: [&str; 11] = [
    "node_modules", ".git", "dist", "build", "target",
    "__pycache__", ".next", ".nuxt", "coverage", ".cache", ".venv",
];
const IGNORE_FILES: [&str; 7] = [
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    ".DS_Store", "Thumbs.db", "Cargo.lock", "bun.lock",
];

/// Lightweight content search across a project. Safe, bounded walk:
/// max 1500 files scanned, files > 512KB skipped, binary skipped.
#[command]
async fn grep_project(root: String, query: String) -> Result<Vec<GrepMatch>, String> {
    let mut out = Vec::new();
    let mut visited = 0usize;
    let mut walk = std::collections::VecDeque::from([root]);
    let lower = query.to_lowercase();

    while let Some(dir) = walk.pop_front() {
        if visited > 1500 {
            break;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            if out.len() >= 200 {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if IGNORE_FOLDERS.contains(&name.as_str()) || IGNORE_FILES.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata().await else { continue };
            if meta.is_dir() {
                walk.push_back(path.to_string_lossy().to_string());
            } else {
                visited += 1;
                if meta.len() > 512 * 1024 || meta.len() == 0 {
                    continue;
                }
                let Ok(bytes) = tokio::fs::read(&path).await else { continue };
                if !looks_like_text(&bytes) {
                    continue;
                }
                let Ok(content) = String::from_utf8(bytes) else { continue };
                for (i, ln) in content.lines().enumerate() {
                    if ln.to_lowercase().contains(&lower) {
                        out.push(GrepMatch {
                            path: path.to_string_lossy().to_string(),
                            line_number: i + 1,
                            line: ln.trim().chars().take(220).collect(),
                        });
                        if out.len() >= 200 {
                            break;
                        }
                    }
                }
            }
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line_number.cmp(&b.line_number)));
    out.truncate(200);
    Ok(out)
}

/// Flat list of file paths in a project (ignoring build dirs). Bounded to 800.
#[command]
async fn list_project_files(root: String) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut walk = std::collections::VecDeque::from([std::path::PathBuf::from(root)]);
    while let Some(dir) = walk.pop_front() {
        if out.len() >= 800 {
            break;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            if out.len() >= 800 {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if IGNORE_FOLDERS.contains(&name.as_str()) || IGNORE_FILES.contains(&name.as_str()) {
                continue;
            }
            if entry.metadata().await.map(|m| m.is_dir()).unwrap_or(false) {
                walk.push_back(entry.path());
            } else {
                out.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[command]
async fn get_project_info(path: String) -> Result<serde_json::Value, String> {
    let mut info = serde_json::Map::new();
    info.insert("path".into(), serde_json::Value::String(path.clone()));
    let read_dir = tokio::fs::read_dir(&path).await.map_err(|e| e.to_string())?;
    let mut file_count = 0u64;
    let mut dir_count = 0u64;
    let mut entries = read_dir;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        if meta.is_dir() {
            dir_count += 1;
        } else {
            file_count += 1;
        }
    }
    info.insert("files".into(), serde_json::json!(file_count));
    info.insert("dirs".into(), serde_json::json!(dir_count));
    let detection_files = [
        "package.json",
        "Cargo.toml",
        "go.mod",
        "requirements.txt",
        "pyproject.toml",
        "tsconfig.json",
    ];
    for f in detection_files {
        let check_path = format!("{}/{}", path, f);
        if tokio::fs::metadata(&check_path).await.is_ok() {
            info.insert(
                "type".into(),
                serde_json::Value::String(f.replace(".json", "").replace(".toml", "")),
            );
            break;
        }
    }
    Ok(serde_json::Value::Object(info))
}

/// Open a filesystem folder in Windows File Explorer. Used by the project
/// card's context menu (shell plugin scopes don't cover filesystem paths).
#[command]
async fn open_in_explorer(path: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        Err("open_in_explorer is Windows-only".into())
    }
}

/// Lexically resolve `.` and `..` without touching the filesystem.
///
/// `canonicalize` cannot be used for this: it requires every component to exist,
/// so it is useless for a target whose parent directory has not been created yet
/// — which is exactly the case a write guard has to reason about.
fn lexical_normalize(p: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` at a root is a no-op (there is nothing above `D:\`), so
                // failing to pop is expected there and must not become an error.
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve symlinks in the longest **existing** prefix of `path`, then re-append
/// the not-yet-existing remainder. Returns `None` if nothing on the chain
/// resolves, which callers must treat as "refuse".
///
/// This is what makes the check work for paths that do not exist yet while still
/// catching a symlink inside the project that points outside it.
fn resolve_existing_prefix(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut probe = path;
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(probe) {
            let mut full = canonical;
            for part in rest.iter().rev() {
                full.push(part);
            }
            return Some(full);
        }
        match (probe.file_name(), probe.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                probe = parent;
            }
            _ => return None,
        }
    }
}

/// Resolve `target` and prove it lives inside `root`, returning the resolved
/// path so the caller operates on exactly what was validated. `what` names the
/// operation for the error message ("write", "read").
///
/// **Fails closed.** The previous implementation canonicalised the target's
/// parent and treated a failure as permission to proceed:
///
/// ```ignore
/// if let Ok(parent_c) = std::fs::canonicalize(parent) {   // <-- no else
///     if !parent_c.starts_with(&root_c) { return Err(..); }
/// }
/// ```
///
/// `canonicalize` fails whenever the parent does not exist, so the containment
/// check was skipped for precisely the paths that needed it most. `create_dir_all`
/// then built the missing directory and the file landed outside the project —
/// silently, with the tool reporting a successful write. A path is only allowed
/// if it can be *positively* shown to be inside the root.
fn resolve_inside_root(
    target: &std::path::Path,
    root: &str,
    what: &str,
) -> Result<std::path::PathBuf, String> {
    let outside = format!("Refusing to {what} outside the project root");
    let root_c =
        std::fs::canonicalize(root).map_err(|_| "Project root does not exist".to_string())?;
    let abs = std::path::absolute(target).map_err(|e| e.to_string())?;
    let normalized = lexical_normalize(&abs);
    let resolved = resolve_existing_prefix(&normalized).ok_or_else(|| outside.clone())?;
    if !resolved.starts_with(&root_c) {
        return Err(outside);
    }
    Ok(resolved)
}

/// Write UTF-8 text to a file. The resolved target must live under `root`
/// (the current project) when a root is given; without a root, relative
/// paths are rejected because there is no working-directory context.
#[command]
async fn write_file(path: String, content: String, root: Option<String>) -> Result<usize, String> {
    if content.len() > 200 * 1024 {
        return Err("Content too large (max 200KB)".into());
    }
    let raw = std::path::PathBuf::from(&path);
    let target = if raw.is_absolute() {
        raw
    } else {
        match &root {
            Some(r) => std::path::PathBuf::from(r).join(&raw),
            None => return Err("No project is open; use an absolute path".into()),
        }
    };
    let target = match &root {
        Some(r) => resolve_inside_root(&target, r, "write")?,
        None => target,
    };
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&target, content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(content.len())
}

/// Delete a file (undo support for files created by write_file). The target
/// must exist and stay inside the project root when a root is given.
#[command]
async fn delete_file(path: String, root: Option<String>) -> Result<(), String> {
    let raw = std::path::PathBuf::from(&path);
    let target = if raw.is_absolute() {
        raw
    } else {
        match &root {
            Some(r) => std::path::PathBuf::from(r).join(&raw),
            None => return Err("No project is open; use an absolute path".into()),
        }
    };
    if let Some(r) = &root {
        let Ok(root_c) = std::fs::canonicalize(r) else {
            return Err("Project root does not exist".into());
        };
        if let Ok(target_c) = std::fs::canonicalize(&target) {
            if !target_c.starts_with(&root_c) {
                return Err("Refusing to delete outside the project root".into());
            }
        } else {
            return Err("File does not exist".into());
        }
    }
    if !target.is_file() {
        return Err("Not a file (directories are not deleted)".into());
    }
    tokio::fs::remove_file(&target)
        .await
        .map_err(|e| e.to_string())
}

/// Read the on-disk Git diff of one project file (opencode-style review).
/// Returns an empty string when the path is unchanged. Untracked new files
/// are diffed against /dev/null. Parse-friendly output: --no-color, -U3.
#[command]
async fn git_diff(path: String, root: String) -> Result<String, String> {
    let rel = path.replace('\\', "/");
    let tracked = tokio::process::Command::new("git")
        .args(["diff", "HEAD", "--no-color", "-U3", "--", &rel])
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git diff failed: {e}"))?;
    let text = String::from_utf8_lossy(&tracked.stdout).to_string();
    if !text.trim().is_empty() {
        return Ok(text);
    }
    // Empty diff: either unchanged, or a brand-new file Git has not seen.
    let status = tokio::process::Command::new("git")
        .args(["status", "--porcelain", "--", &rel])
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git status failed: {e}"))?;
    let st = String::from_utf8_lossy(&status.stdout);
    if !st.starts_with("??") {
        return Ok(String::new()); // tracked and unchanged
    }
    // Untracked: diff the new file against the empty device.
    let untracked = tokio::process::Command::new("git")
        .args([
            "diff",
            "--no-color",
            "-U3",
            "--no-index",
            "--",
            "/dev/null",
            &rel,
        ])
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git diff --no-index failed: {e}"))?;
    // git exits 1 when differences exist; Command::output ignores exit codes.
    Ok(String::from_utf8_lossy(&untracked.stdout).to_string())
}

/// One entry of `git status --porcelain` for the review panel's stage list.
#[derive(Debug, Serialize)]
struct GitStatusFile {
    path: String,
    /// Index (staged) status letter: ' ' when nothing staged, 'A', 'M', 'D'...
    index_status: String,
    /// Worktree status letter: ' ' when the worktree matches the index.
    worktree_status: String,
    untracked: bool,
}

fn parse_porcelain(text: &str) -> Vec<GitStatusFile> {
    let mut files = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        // Skip the "XY " prefix; the rest is the path (spaces included).
        let path = line[3..].trim().trim_matches('"').to_string();
        if path.is_empty() {
            continue;
        }
        files.push(GitStatusFile {
            path,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            untracked: x == '?' && y == '?',
        });
    }
    files
}

/// List changed files (staged + unstaged) of the project, porcelain v1.
#[command]
async fn git_status(root: String) -> Result<Vec<GitStatusFile>, String> {
    let out = tokio::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git status failed: {e}"))?;
    Ok(parse_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

/// Stage files (git add --).
#[command]
async fn git_stage(paths: Vec<String>, root: String) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("add").arg("--");
    for p in &paths {
        cmd.arg(p);
    }
    let out = cmd
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git add failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Unstage files back to HEAD (git reset -q HEAD -- <paths>).
#[command]
async fn git_unstage(paths: Vec<String>, root: String) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("reset").arg("-q").arg("HEAD").arg("--");
    for p in &paths {
        cmd.arg(p);
    }
    let out = cmd
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git reset failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Rename a folder on disk (used by "New Space" / "Rename" in the sidebar).
/// Refuses to overwrite an existing destination.
#[command]
async fn rename_folder(from: String, to: String) -> Result<(), String> {
    let src = std::path::PathBuf::from(&from);
    let dst = std::path::PathBuf::from(&to);
    if !src.is_dir() {
        return Err(format!("Thư mục nguồn không tồn tại: {from}"));
    }
    if dst.exists() {
        return Err(format!("Đã tồn tại: {to}"));
    }
    tokio::fs::rename(&src, &dst)
        .await
        .map_err(|e| format!("Đổi tên thất bại: {e}"))
}

/// Commit the staged changes with the given message; returns git's summary.
#[command]
async fn git_commit(message: String, root: String) -> Result<String, String> {
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("Commit message trống".into());
    }
    let out = tokio::process::Command::new("git")
        .args(["commit", "-m", &msg])
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git commit failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn parse_porcelain_name_status(text: &str) -> Vec<(char, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(2, '\t');
        let (Some(st), Some(path)) = (parts.next(), parts.next()) else {
            continue;
        };
        let c = st.chars().next().unwrap_or('M');
        out.push((c, path.trim().trim_matches('"').to_string()));
    }
    out
}

/// Conventional-style message from change entries: `Add a.ts`,
/// `Update 3 files (a.ts, b.ts +1 more)`, ...
fn build_commit_message(entries: &[(char, String)]) -> String {
    let n = entries.len();
    let names: Vec<String> = entries
        .iter()
        .map(|(_, p)| p.rsplit(['/', '\\']).next().unwrap_or(p).to_string())
        .collect();
    let all_added = entries.iter().all(|(c, _)| *c == 'A');
    let all_deleted = entries.iter().all(|(c, _)| *c == 'D');
    let verb = if all_deleted {
        "Remove"
    } else if all_added {
        "Add"
    } else {
        "Update"
    };
    if n <= 3 {
        format!("{} {}", verb, names.join(", "))
    } else {
        format!(
            "{} {} files ({}, {} +{} more)",
            verb,
            n,
            names[0],
            names[1],
            n - 2
        )
    }
}

/// Heuristic commit message from the staged changes ("agent-suggested"
/// draft prefilled in the review panel's commit box). Falls back to every
/// visible change when nothing is staged yet.
#[command]
async fn git_suggest_commit_message(root: String) -> Result<String, String> {
    let staged = tokio::process::Command::new("git")
        .args(["diff", "--staged", "--name-status"])
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("git diff failed: {e}"))?;
    let mut entries = parse_porcelain_name_status(&String::from_utf8_lossy(&staged.stdout));
    if entries.is_empty() {
        let status = tokio::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&root)
            .output()
            .await
            .map_err(|e| format!("git status failed: {e}"))?;
        entries = parse_porcelain(&String::from_utf8_lossy(&status.stdout))
            .into_iter()
            .map(|f| {
                let st = if f.untracked {
                    'A'
                } else if f.index_status != " " {
                    f.index_status.chars().next().unwrap_or('M')
                } else {
                    f.worktree_status.chars().next().unwrap_or('M')
                };
                (st, f.path)
            })
            .collect();
    }
    if entries.is_empty() {
        return Err("Không có thay đổi nào để gợi ý message".into());
    }
    Ok(build_commit_message(&entries))
}

#[derive(Debug, Serialize)]
struct RunCommandResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn cap_command_output(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    const MAX: usize = 20_000;
    let out: String = s.chars().take(MAX).collect();
    if s.chars().count() > MAX {
        format!("{out}\n... (output truncated)\n")
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// PATH for agent commands
//
// The shell DuckChat spawns inherits the environment of whatever launched the
// app, so a program installed *after* the app started — or one whose folder only
// exists in the registry — comes back as "is not recognized as a name of a
// cmdlet", and the agent tells the user the toolchain is missing. Rebuilding
// PATH from the registry on every command, with the folders pinned in Settings
// in front, makes freshly installed programs visible without a restart.
// ---------------------------------------------------------------------------

/// Registry scopes whose `Path` value contributes, user scope first so a
/// per-user install can override the machine-wide one.
const PATH_REGISTRY_SCOPES: [&str; 2] = [
    r"HKCU\Environment",
    r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
];

/// Expand `%SystemRoot%`-style references in a REG_EXPAND_SZ value. Unknown
/// names are left as-is rather than dropped, so a bad entry stays visible.
fn expand_env(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        match rest[start + 1..].find('%') {
            Some(rel) => {
                let name = &rest[start + 1..start + 1 + rel];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&rest[start..start + rel + 2]),
                }
                rest = &rest[start + rel + 2..];
            }
            None => {
                out.push('%');
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Parse one `reg query` output into the `Path` value's directories.
fn parse_reg_path(output: &str) -> Vec<String> {
    for line in output.lines() {
        let trimmed = line.trim_start();
        let Some((name, after)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        if !name.eq_ignore_ascii_case("path") {
            continue;
        }
        // `after` still starts with the type token: "REG_EXPAND_SZ   C:\…".
        let Some((_, value)) = after.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        return split_path(&expand_env(value.trim()));
    }
    Vec::new()
}

fn split_path(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(normalize_dir)
        .filter(|s| !s.is_empty())
        .collect()
}

/// Trim surrounding space and a trailing separator, keeping a bare drive root
/// usable: "C:\" must stay "C:\", since "C:" alone means the process's current
/// directory on that drive.
fn normalize_dir(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    if trimmed.len() == 2 && trimmed.as_bytes().get(1) == Some(&b':') {
        return format!("{trimmed}\\");
    }
    trimmed.to_string()
}

/// The key Windows actually stores PATH under (`Path`, `PATH`, …). Writing a
/// different casing would leave two entries in the child's environment block.
fn path_env_key() -> String {
    std::env::vars()
        .find(|(k, _)| k.eq_ignore_ascii_case("path"))
        .map(|(k, _)| k)
        .unwrap_or_else(|| "PATH".to_string())
}

/// Read a registry `Path` with `reg.exe` — no extra crate, and it works on any
/// Windows install.
fn registry_path_dirs(scope: &str) -> Vec<String> {
    let Ok(out) = std::process::Command::new("reg")
        .args(["query", scope, "/v", "Path"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_reg_path(&String::from_utf8_lossy(&out.stdout))
}

/// Registry PATH, cached: reading it costs two process spawns, and the value
/// only changes when the user edits system settings. A short TTL is what lets a
/// freshly installed tool appear mid-session.
fn registry_path_dirs_cached() -> Vec<String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<String>)>> =
        std::sync::Mutex::new(None);
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, dirs)) = guard.as_ref() {
        if at.elapsed() < TTL {
            return dirs.clone();
        }
    }
    let dirs: Vec<String> = PATH_REGISTRY_SCOPES
        .iter()
        .flat_map(|scope| registry_path_dirs(scope))
        .collect();
    *guard = Some((std::time::Instant::now(), dirs.clone()));
    dirs
}

/// Order the three sources, dropping duplicates case-insensitively (Windows
/// paths) while keeping the first spelling seen.
fn merge_path_dirs(extra: &[String], process: &str, registry: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let candidates = extra
        .iter()
        .cloned()
        .chain(split_path(process))
        .chain(registry.iter().cloned());
    for dir in candidates {
        let dir = normalize_dir(&dir);
        let key = dir.to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(dir);
    }
    out
}

/// The PATH string handed to a child shell. Directories that no longer exist
/// are dropped: they are dead weight, and duck.ai's environment block is not
/// unlimited.
fn build_command_path(extra: &[String]) -> String {
    let process = std::env::var("PATH").unwrap_or_default();
    merge_path_dirs(extra, &process, &registry_path_dirs_cached())
        .into_iter()
        .filter(|d| std::path::Path::new(d).is_dir())
        .collect::<Vec<_>>()
        .join(";")
}

/// What Settings shows after the user pins a folder: how many directories the
/// agent actually searches, and which pinned folders are not (yet) real.
#[derive(Debug, Serialize)]
struct PathReport {
    searched: usize,
    invalid: Vec<String>,
}

#[command]
async fn path_report(extra: Option<Vec<String>>) -> PathReport {
    let extra = extra.unwrap_or_default();
    tokio::task::spawn_blocking(move || PathReport {
        searched: build_command_path(&extra).split(';').filter(|s| !s.is_empty()).count(),
        invalid: extra
            .iter()
            .filter(|d| !std::path::Path::new(d).is_dir())
            .cloned()
            .collect(),
    })
    .await
    .unwrap_or(PathReport {
        searched: 0,
        invalid: Vec::new(),
    })
}

/// Run a shell command inside the project, capturing output. Bounded by a
/// 120s timeout. The `shell` string is one of powershell (default), cmd, or
/// bash; `cwd` is resolved against `root` unless it is absolute.
///
/// `extra_path` holds folders pinned in Settings; they are searched FIRST, so a
/// toolchain that lives outside the system PATH still resolves.
#[command]
async fn run_command(
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    root: Option<String>,
    extra_path: Option<Vec<String>>,
) -> Result<RunCommandResult, String> {
    let dir = match (&cwd, &root) {
        (Some(d), _) if !d.is_empty() && d != "." => {
            let base = std::path::PathBuf::from(d);
            if base.is_absolute() {
                base
            } else if let Some(r) = root {
                std::path::PathBuf::from(r).join(base)
            } else {
                base
            }
        }
        (_, Some(r)) => std::path::PathBuf::from(r),
        _ => std::env::current_dir().map_err(|e| e.to_string())?,
    };

    let (prog, args): (String, Vec<String>) = match shell.unwrap_or_else(|| "powershell".into()).to_lowercase().as_str() {
        "cmd" | "cmd.exe" => ("cmd".into(), vec!["/C".into(), command.clone()]),
        "bash" | "sh" => ("bash".into(), vec!["-lc".into(), command.clone()]),
        "pwsh" | "pwsh.exe" => (
            "pwsh".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.clone(),
            ],
        ),
        _ => (
            "powershell".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.clone(),
            ],
        ),
    };

    // Built off the async thread: the first call in a 60s window spawns `reg`.
    let extra = extra_path.unwrap_or_default();
    let mut path_value = tokio::task::spawn_blocking(move || build_command_path(&extra))
        .await
        .unwrap_or_default();
    if path_value.is_empty() {
        path_value = std::env::var("PATH").unwrap_or_default();
    }

    let mut child = tokio::process::Command::new(&prog)
        .args(&args)
        .current_dir(&dir)
        .env(path_env_key(), &path_value)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start shell '{prog}': {e}"))?;

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    // Drain stdout/stderr concurrently while waiting: a child that fills the
    // OS pipe buffer (>64KB on Windows) would otherwise block on write while
    // we block on wait() — a classic deadlock.
    use tokio::io::AsyncReadExt;
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait(),
    )
    .await
    {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            out_task.abort();
            err_task.abort();
            return Err(e.to_string());
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            out_task.abort();
            err_task.abort();
            return Ok(RunCommandResult {
                exit_code: None,
                stdout: String::new(),
                stderr: "Command timed out after 120 seconds.\n".into(),
                timed_out: true,
            });
        }
    };

    let out_bytes = out_task.await.unwrap_or_default();
    let err_bytes = err_task.await.unwrap_or_default();

    Ok(RunCommandResult {
        exit_code: status.code(),
        stdout: cap_command_output(&out_bytes),
        stderr: cap_command_output(&err_bytes),
        timed_out: false,
    })
}

/// A numbered slice of a text file for the agent loop.
#[derive(Debug, Serialize)]
struct ReadChunk {
    content: String,
    total_lines: usize,
    start_line: usize,
    end_line: usize,
    truncated: bool,
}

/// Read lines [start_line, start_line+max_lines) of a text file.
/// start_line is 0-based; the frontend renders 1-based numbers from it.
///
/// When `root` is given (the agent's read tool always passes it) the path must
/// resolve inside the project, so the agent cannot read arbitrary files off the
/// machine — `~/.ssh/id_rsa` and friends included.
#[command]
async fn read_file_lines(
    path: String,
    start_line: Option<usize>,
    max_lines: Option<usize>,
    root: Option<String>,
) -> Result<ReadChunk, String> {
    let path = match &root {
        Some(r) => resolve_inside_root(std::path::Path::new(&path), r, "read")?,
        None => std::path::PathBuf::from(&path),
    };
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|&b| b == 0) && !looks_like_text(&bytes) {
        return Err("Binary file (skipped)".into());
    }
    let s = String::from_utf8_lossy(&bytes);
    let total = s.lines().count();
    let start = start_line.unwrap_or(0).min(total);
    let max_l = max_lines.unwrap_or(400).clamp(50, 2000);
    let end = (start + max_l).min(total);
    let mut content: String = s.lines().skip(start).take(max_l).collect::<Vec<_>>().join("\n");
    let mut char_cut = false;
    if content.len() > 30_000 {
        let cut = floor_boundary(&content, 30_000);
        content = content[..cut].to_string();
        content.push_str("\n... (char-truncated)");
        char_cut = true;
    }
    Ok(ReadChunk {
        content,
        total_lines: total,
        start_line: start,
        end_line: end,
        truncated: end < total || char_cut,
    })
}

// ---------------------------------------------------------------------------
// tiny glob matcher: `**` crosses directories, `*`/`?` stay in one segment
// ---------------------------------------------------------------------------

fn seg_match(pat: &[u8], text: &[u8]) -> bool {
    let (mut px, mut sx) = (0usize, 0usize);
    let (mut star, mut ss) = (None::<usize>, 0usize);
    while sx < text.len() {
        if px < pat.len() && (pat[px] == b'?' || pat[px] == text[sx]) {
            px += 1;
            sx += 1;
        } else if px < pat.len() && pat[px] == b'*' {
            star = Some(px);
            px += 1;
            ss = sx;
        } else if let Some(sp) = star {
            px = sp + 1;
            ss += 1;
            sx = ss;
        } else {
            return false;
        }
    }
    while px < pat.len() && pat[px] == b'*' {
        px += 1;
    }
    px == pat.len()
}

fn segs_match(pat: &[&str], path: &[&str]) -> bool {
    if pat.is_empty() {
        return path.is_empty();
    }
    if pat[0] == "**" {
        let mut i = 0;
        while i <= path.len() {
            if segs_match(&pat[1..], &path[i..]) {
                return true;
            }
            i += 1;
        }
        return false;
    }
    if path.is_empty() {
        return false;
    }
    if !seg_match(pat[0].as_bytes(), path[0].as_bytes()) {
        return false;
    }
    segs_match(&pat[1..], &path[1..])
}

fn glob_match(pattern: &str, rel: &str) -> bool {
    let mut pat = pattern.replace('\\', "/");
    while let Some(stripped) = pat.strip_prefix("./") {
        pat = stripped.to_string();
    }
    pat = pat.trim_start_matches('/').to_string();
    if !pat.contains('/') {
        pat = format!("**/{pat}");
    }
    let p: Vec<&str> = pat.split('/').filter(|s| !s.is_empty()).collect();
    let s: Vec<&str> = rel.split('/').filter(|x| !x.is_empty()).collect();
    segs_match(&p, &s)
}

/// Find files under root matching a glob (e.g. `src/**/*.ts`). Returns paths
/// relative to root with forward slashes, bounded to 200 results.
#[command]
async fn glob_files(root: String, pattern: String) -> Result<Vec<String>, String> {
    if pattern.trim().is_empty() {
        return Err("pattern is empty".into());
    }
    let root_path = std::path::PathBuf::from(&root);
    let mut out: Vec<String> = Vec::new();
    let mut walk = std::collections::VecDeque::from([root_path.clone()]);
    while let Some(dir) = walk.pop_front() {
        if out.len() >= 200 {
            break;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            if out.len() >= 200 {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if IGNORE_FOLDERS.contains(&name.as_str()) || IGNORE_FILES.contains(&name.as_str()) {
                continue;
            }
            let p = entry.path();
            if entry.metadata().await.map(|m| m.is_dir()).unwrap_or(false) {
                walk.push_back(p);
            } else if let Ok(rel) = p.strip_prefix(&root_path) {
                let rel_s = rel.to_string_lossy().replace('\\', "/");
                if glob_match(&pattern, &rel_s) {
                    out.push(rel_s);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// project overview: the "codebase map" the agent reads before coding
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct OverviewFile {
    path: String,
    lines: usize,
    size: u64,
}

#[derive(Debug, Serialize)]
struct OverviewLang {
    ext: String,
    files: usize,
    lines: usize,
}

#[derive(Debug, Serialize)]
struct OverviewConfig {
    path: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ProjectOverview {
    files: Vec<OverviewFile>,
    total_files: usize,
    total_lines: usize,
    langs: Vec<OverviewLang>,
    configs: Vec<OverviewConfig>,
    hints: Vec<String>,
}

const CONFIG_NAMES: [&str; 10] = [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "pyproject.toml",
    "tsconfig.json",
    "README.md",
    "Makefile",
    "vite.config.ts",
    "tauri.conf.json",
];

/// Compact codebase map: per-file line counts, language breakdown, key config
/// contents, and how to build/test/verify. Bounded: max 800 files, files
/// >512KB and binaries only contribute their size, configs capped at 6x1200
/// chars. The frontend caches this per project and refreshes it after writes.
#[command]
async fn project_overview(root: String) -> Result<ProjectOverview, String> {
    let root_path = std::path::PathBuf::from(&root);
    let mut files: Vec<OverviewFile> = Vec::new();
    let mut langs: std::collections::HashMap<String, (usize, usize)> =
        std::collections::HashMap::new();
    let mut total_lines = 0usize;
    let mut walk = std::collections::VecDeque::from([root_path.clone()]);
    while let Some(dir) = walk.pop_front() {
        if files.len() >= 800 {
            break;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            if files.len() >= 800 {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if IGNORE_FOLDERS.contains(&name.as_str()) || IGNORE_FILES.contains(&name.as_str()) {
                continue;
            }
            let p = entry.path();
            let Ok(meta) = entry.metadata().await else { continue };
            if meta.is_dir() {
                walk.push_back(p);
                continue;
            }
            let size = meta.len();
            let rel = p
                .strip_prefix(&root_path)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            let mut lines = 0usize;
            if size > 0 && size <= 512 * 1024 {
                if let Ok(bytes) = tokio::fs::read(&p).await {
                    if looks_like_text(&bytes) {
                        lines = bytes.iter().filter(|&&b| b == b'\n').count();
                        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
                            lines += 1;
                        }
                    }
                }
            }
            let ext = rel
                .rsplit('.')
                .next()
                .filter(|_| rel.contains('.'))
                .unwrap_or("noext")
                .to_lowercase();
            let e = langs.entry(ext).or_insert((0, 0));
            e.0 += 1;
            e.1 += lines;
            total_lines += lines;
            files.push(OverviewFile { path: rel, lines, size });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let total_files = files.len();

    let mut langs_v: Vec<OverviewLang> = langs
        .into_iter()
        .map(|(ext, (f, l))| OverviewLang { ext, files: f, lines: l })
        .collect();
    langs_v.sort_by(|a, b| b.lines.cmp(&a.lines).then(b.files.cmp(&a.files)));
    langs_v.truncate(8);

    // Key configs: first match per name, content capped.
    let mut configs: Vec<OverviewConfig> = Vec::new();
    for cfg in CONFIG_NAMES {
        if configs.len() >= 6 {
            break;
        }
        if let Some(f) = files.iter().find(|f| {
            f.path == cfg || f.path.ends_with(&format!("/{cfg}"))
        }) {
            if f.size > 0 && f.size <= 64 * 1024 {
                if let Ok(bytes) = tokio::fs::read(root_path.join(&f.path)).await {
                    if looks_like_text(&bytes) {
                        let mut content = String::from_utf8_lossy(&bytes).into_owned();
                        if content.len() > 1200 {
                            let cut = floor_boundary(&content, 1200);
                            content = content[..cut].to_string();
                            content.push_str("\n... (truncated)");
                        }
                        configs.push(OverviewConfig { path: f.path.clone(), content });
                    }
                }
            }
        }
    }

    // Verify hints: scripts from package.json, or per-ecosystem defaults.
    let mut hints: Vec<String> = Vec::new();
    let has = |n: &str| files.iter().any(|f| f.path == n || f.path.ends_with(&format!("/{n}")));
    if let Some(pkg) = configs.iter().find(|c| c.path.ends_with("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pkg.content) {
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                for key in scripts.keys().take(6) {
                    hints.push(format!("npm run {key}"));
                }
            }
        }
        if hints.is_empty() {
            hints.push("npm run build".into());
        }
    }
    if has("Cargo.toml") {
        hints.push("cargo build".into());
        hints.push("cargo test".into());
    } else if has("go.mod") {
        hints.push("go build ./...".into());
        hints.push("go test ./...".into());
    } else if has("requirements.txt") || has("pyproject.toml") {
        hints.push("python -m pytest".into());
    } else if files.iter().any(|f| f.path.ends_with(".csproj") || f.path.ends_with(".sln")) {
        hints.push("dotnet build".into());
        hints.push("dotnet test".into());
    }
    hints.truncate(6);

    Ok(ProjectOverview {
        files,
        total_files,
        total_lines,
        langs: langs_v,
        configs,
        hints,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reg_path_output_parses_into_dirs() {
        let raw = "\r\n\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    D:\\Program\\Python\\;C:\\Tools\\\r\n\r\n";
        assert_eq!(
            parse_reg_path(raw),
            vec!["D:\\Program\\Python".to_string(), "C:\\Tools".to_string()]
        );
        // A key without a Path value (or a failed query) yields nothing.
        assert!(parse_reg_path("ERROR: The system was unable to find the specified registry key or value.").is_empty());
    }

    #[test]
    fn env_placeholders_expand_and_unknown_ones_survive() {
        std::env::set_var("DUCKCHAT_TEST_DIR", "C:\\Windows\\System32");
        assert_eq!(
            expand_env(r"%DUCKCHAT_TEST_DIR%\..;C:\x"),
            r"C:\Windows\System32\..;C:\x"
        );
        // Unknown names stay literal so a broken entry is still visible.
        assert_eq!(expand_env(r"%DUCKCHAT_MISSING_X%\bin"), r"%DUCKCHAT_MISSING_X%\bin");
    }

    #[test]
    fn pinned_folders_win_and_duplicates_collapse() {
        let merged = merge_path_dirs(
            &["D:\\lua".to_string()],
            r"C:\Windows;C:\Tools",
            &[r"C:\tools\".to_string(), "D:\\mre".to_string()],
        );
        // Pinned first, then the process PATH, then the registry — and `C:\Tools`
        // appears once despite the differing casing and trailing separator.
        assert_eq!(
            merged,
            vec![
                "D:\\lua".to_string(),
                "C:\\Windows".to_string(),
                "C:\\Tools".to_string(),
                "D:\\mre".to_string()
            ]
        );
    }

    #[test]
    fn bare_drive_root_stays_usable() {
        assert_eq!(normalize_dir("C:\\"), "C:\\");
        assert_eq!(normalize_dir("  D:\\Program\\  "), "D:\\Program");
    }

    #[test]
    fn web_url_guard_allows_pages_but_not_credentials_or_schemes() {
        assert!(is_fetchable_http_url("https://example.com/a/b?q=1"));
        assert!(is_fetchable_http_url("http://localhost:3000/docs"));
        assert!(!is_fetchable_http_url("ftp://example.com/x"));
        assert!(!is_fetchable_http_url("file:///etc/passwd"));
        assert!(!is_fetchable_http_url("https://user:pass@example.com/"));
        assert!(!is_fetchable_http_url("not a url"));
        assert!(!is_fetchable_http_url(""));
    }

    #[test]
    fn html_to_text_drops_head_content_and_keeps_blocks_readable() {
        let html = r#"<!DOCTYPE html><html><head><title>T</title><style>.a{color:red}</style>
            <script>var x = "<div>not text</div>";</script></head>
            <body><!-- a comment --><h1>Hello &amp; welcome</h1>
            <p>First&nbsp;para with <a href="https://e.com/?a=1&gt;2">a &lt;link&gt;</a>.</p>
            <p>Second para&#33;</p></body></html>"#;
        let text = html_to_text(html);
        assert!(!text.contains("color:red"), "style leaked: {text}");
        assert!(!text.contains("not text"), "script leaked: {text}");
        assert!(!text.contains("a comment"), "comment leaked: {text}");
        assert!(text.contains("Hello & welcome"), "entity not decoded: {text}");
        assert!(text.contains("First para with a <link>."), "link text wrong: {text}");
        assert!(text.contains("Second para!"), "numeric entity wrong: {text}");
    }

    #[test]
    fn html_entities_decode_named_and_numeric_but_keep_unknown() {
        assert_eq!(decode_html_entities("a &lt; b &amp; c"), "a < b & c");
        assert_eq!(decode_html_entities("&#233; &#xE9;"), "é é");
        assert_eq!(decode_html_entities("&notarealentity;"), "&notarealentity;");
        // A `;` far away ends another sentence, not an entity.
        assert_eq!(
            decode_html_entities("fish & chips; tasty"),
            "fish & chips; tasty"
        );
    }

    #[test]
    fn ddg_redirect_targets_unwrap_to_the_real_destination() {
        assert_eq!(
            extract_ddg_target("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc&rut=abc"),
            "https://example.com/a?b=c"
        );
        assert_eq!(
            extract_ddg_target("https://direct.example/x"),
            "https://direct.example/x"
        );
        assert_eq!(
            extract_ddg_target("//example.com/proto-relative"),
            "https://example.com/proto-relative"
        );
    }

    #[test]
    fn ddg_results_parse_titles_urls_and_snippets() {
        let html = r#"<div class="result"><h2 class="result__title">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=x">One &amp; Only</a></h2>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">first <b>hit</b> here</a></div>
            <div class="result"><h2 class="result__title">
            <a class="result__a" href="https://direct.example/two">Two</a></h2></div>"#;
        let res = parse_ddg_results(html, 5);
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].title, "One & Only");
        assert_eq!(res[0].url, "https://example.com/one");
        assert_eq!(res[0].snippet, "first hit here");
        assert_eq!(res[1].url, "https://direct.example/two");
        assert!(res[1].snippet.is_empty());
    }

    #[tokio::test]
    async fn web_tools_reject_bad_input_without_touching_the_network() {
        assert!(fetch_web("ftp://example.com/x".into(), None).await.is_err());
        assert!(fetch_web("".into(), None).await.is_err());
        assert!(web_search("   ".into(), None).await.is_err());
    }

    #[test]
    fn glob_match_cases() {
        assert!(glob_match("src/**/*.ts", "src/lib/a.ts"));
        assert!(glob_match("src/**/*.ts", "src/a.ts"));
        assert!(!glob_match("src/**/*.ts", "src/a.js"));
        assert!(glob_match("*.json", "package.json"));
        assert!(glob_match("*.json", "src/package.json"));
        assert!(!glob_match("src/*.ts", "src/lib/a.ts"));
        assert!(glob_match("src/**", "src/lib/a.ts"));
        assert!(glob_match("src/**", "src"));
        assert!(glob_match("**/test_*.py", "a/b/test_x.py"));
        assert!(glob_match("README.md", "docs/README.md"));
        assert!(!glob_match("a?c", "ac"));
        assert!(glob_match("a?c", "abc"));
    }

    #[test]
    fn porcelain_parse_and_commit_message() {
        let files = parse_porcelain(" M a.ts\n?? new dir/b c.md\nA  d.rs\n");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "a.ts");
        assert!(!files[0].untracked);
        assert_eq!(files[1].path, "new dir/b c.md");
        assert!(files[1].untracked);
        assert_eq!(files[2].index_status, "A");

        let msg = build_commit_message(&[
            ('A', "src/new.ts".into()),
            ('M', "src/old.ts".into()),
        ]);
        assert_eq!(msg, "Update new.ts, old.ts");
        let add = build_commit_message(&[('A', "x/y.ts".into())]);
        assert_eq!(add, "Add y.ts");
        let many = build_commit_message(&[
            ('A', "a.ts".into()),
            ('A', "b.ts".into()),
            ('A', "c.ts".into()),
            ('A', "d.ts".into()),
        ]);
        assert_eq!(many, "Add 4 files (a.ts, b.ts +2 more)");
        let del = build_commit_message(&[('D', "gone.ts".into())]);
        assert_eq!(del, "Remove gone.ts");
    }

    /// A unique scratch directory per test, cleaned up by the caller.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("duckchat_wf_{tag}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The core promise: what the agent writes lands *inside* the project, and
    /// it does so for the project-relative paths the tool prompt tells it to use.
    #[tokio::test]
    async fn write_file_lands_inside_the_project() {
        let base = scratch("inside");
        let root = base.join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let root_s = root.to_string_lossy().to_string();

        let written = write_file(
            "src/new_mod.ts".into(),
            "export const x = 1;\n".into(),
            Some(root_s.clone()),
        )
        .await
        .expect("write_file should accept a project-relative path");

        assert!(written > 0);
        let landed = root.join("src").join("new_mod.ts");
        assert!(landed.is_file(), "file did not land under the project root");
        assert_eq!(
            std::fs::read_to_string(&landed).unwrap(),
            "export const x = 1;\n"
        );

        // …and it creates missing parent directories inside the project.
        write_file(
            "deep/nested/dir/leaf.ts".into(),
            "leaf\n".into(),
            Some(root_s),
        )
        .await
        .expect("write_file should create missing parents inside the project");
        assert!(root.join("deep/nested/dir/leaf.ts").is_file());

        std::fs::remove_dir_all(&base).ok();
    }

    /// An absolute path outside the project is refused when its parent exists.
    #[tokio::test]
    async fn write_file_refuses_absolute_path_outside_root() {
        let base = scratch("abs_existing");
        let root = base.join("proj");
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let res = write_file(
            outside.join("pwned.txt").to_string_lossy().to_string(),
            "nope\n".into(),
            Some(root.to_string_lossy().to_string()),
        )
        .await;

        assert!(res.is_err(), "expected refusal, got {:?}", res);
        assert!(!outside.join("pwned.txt").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    /// The escape: an absolute path outside the project whose parent directory
    /// does not exist yet. `canonicalize` fails on a missing parent, so a guard
    /// written as `if let Ok(parent_c) = canonicalize(parent)` silently skips
    /// the check — and `create_dir_all` then builds the directory and the file
    /// lands outside the project.
    #[tokio::test]
    async fn write_file_refuses_absolute_path_through_missing_parent() {
        let base = scratch("abs_missing");
        let root = base.join("proj");
        let outside = base.join("brand_new_dir"); // deliberately NOT created
        std::fs::create_dir_all(&root).unwrap();

        let res = write_file(
            outside.join("pwned.txt").to_string_lossy().to_string(),
            "nope\n".into(),
            Some(root.to_string_lossy().to_string()),
        )
        .await;

        assert!(
            res.is_err(),
            "wrote outside the project root through a missing parent: {:?}",
            res
        );
        assert!(
            !outside.join("pwned.txt").exists(),
            "file escaped the project root into {}",
            outside.display()
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// `..` traversal out of the root must be refused even when the intermediate
    /// directory does not exist.
    #[tokio::test]
    async fn write_file_refuses_dotdot_traversal() {
        let base = scratch("dotdot");
        let root = base.join("proj");
        std::fs::create_dir_all(&root).unwrap();

        let escape = root.join("ghost").join("..").join("..").join("escaped.txt");
        let res = write_file(
            escape.to_string_lossy().to_string(),
            "nope\n".into(),
            Some(root.to_string_lossy().to_string()),
        )
        .await;

        assert!(res.is_err(), "expected refusal, got {:?}", res);
        assert!(
            !base.join("escaped.txt").exists(),
            "file escaped the project root via .."
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// The agent's read tool is contained as well: it must not be able to reach
    /// arbitrary files off the machine (`~/.ssh/id_rsa` and friends).
    #[tokio::test]
    async fn read_file_lines_refuses_paths_outside_root() {
        let base = scratch("read_guard");
        let root = base.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let secret = base.join("secret.txt");
        std::fs::write(&secret, "TOP SECRET\n").unwrap();
        let root_s = Some(root.to_string_lossy().to_string());

        let res = read_file_lines(
            secret.to_string_lossy().to_string(),
            None,
            None,
            root_s.clone(),
        )
        .await;
        assert!(
            res.is_err(),
            "agent read a file outside the project: {:?}",
            res
        );

        // …while a file that IS inside the project still reads normally.
        std::fs::write(root.join("inside.txt"), "hello\n").unwrap();
        let ok = read_file_lines(
            root.join("inside.txt").to_string_lossy().to_string(),
            None,
            None,
            root_s,
        )
        .await
        .expect("reading an in-project file should succeed");
        assert!(ok.content.contains("hello"));

        std::fs::remove_dir_all(&base).ok();
    }

    /// The plugin fetcher is the one place the app reaches out to a third-party
    /// host, so its allowlist is matched exactly: no scheme downgrade, no
    /// credentials, no port trick, no suffix that would admit a lookalike host.
    #[test]
    fn plugin_url_allowlist_is_exact() {
        assert!(is_trusted_plugin_url(
            "https://raw.githubusercontent.com/zai-org/zcode-plugins/main/marketplace.json"
        ));
        assert!(is_trusted_plugin_url(
            "https://api.github.com/repos/zai-org/zcode-plugins/git/trees/main?recursive=1"
        ));

        assert!(!is_trusted_plugin_url("http://raw.githubusercontent.com/a/b"));
        assert!(!is_trusted_plugin_url("https://raw.githubusercontent.com.evil/x/y"));
        assert!(!is_trusted_plugin_url("https://evil.com/#https://raw.githubusercontent.com"));
        // Credentials and an explicit port both redirect the same hostname.
        assert!(!is_trusted_plugin_url(
            "https://user:pass@raw.githubusercontent.com/a/b"
        ));
        assert!(!is_trusted_plugin_url("https://raw.githubusercontent.com@evil.com/a/b"));
        assert!(!is_trusted_plugin_url("https://raw.githubusercontent.com:8080/a/b"));
        // Subdomains of the allowlisted hosts are not themselves allowlisted.
        assert!(!is_trusted_plugin_url("https://x.codeload.github.com/a/b"));
        // The GitHub media/camo hosts proxy arbitrary URLs; they are not sources.
        assert!(!is_trusted_plugin_url("https://camo.githubusercontent.com/a/b"));
        assert!(!is_trusted_plugin_url("not a url"));
        assert!(!is_trusted_plugin_url(""));
    }
}

// ---------------------------------------------------------------------------
// Plugin marketplace (ZCode-compatible plugins): transport + install root
// ---------------------------------------------------------------------------

/// The only hosts a plugin download may come from. lvaigent installs text files
/// that become instructions the agent follows, so the source is allowlisted
/// rather than "any HTTPS URL the frontend happens to ask for".
const PLUGIN_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "api.github.com",
    "codeload.github.com",
    "cdn-zcode.z.ai",
];

fn is_trusted_plugin_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" || parsed.username() != "" || parsed.password().is_some() {
        return false;
    }
    // An explicit port would point the same hostname at another machine.
    if parsed.port_or_known_default() != Some(443) {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    // Exact hosts only. A suffix match would silently admit whatever is
    // registered under the domain — `camo.githubusercontent.com` proxies
    // arbitrary signed URLs, which is not a plugin source.
    PLUGIN_HOSTS.contains(&host)
}

/// GET a marketplace file (JSON manifest or markdown) as UTF-8 text.
///
/// Fetching goes through Rust rather than the webview's `fetch` because the app
/// origin is `http://tauri.localhost`: a cross-scheme request from it is exactly
/// the kind WebView2 blocks, and the app already routes every network call here.
#[command]
async fn http_get_text(url: String, max_bytes: Option<usize>) -> Result<String, String> {
    if !is_trusted_plugin_url(&url) {
        return Err(format!("URL is not on the plugin source allowlist: {url}"));
    }
    let cap = max_bytes.unwrap_or(2_000_000).clamp(1, 8_000_000);
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    // A redirect can leave the allowlist (GitHub answers some API paths with a
    // 301 to another host), so the *final* URL is checked too.
    if !is_trusted_plugin_url(resp.url().as_str()) {
        return Err(format!(
            "redirect left the plugin source allowlist: {}",
            resp.url()
        ));
    }
    let status = resp.status();
    if !status.is_success() {
        // 403 from api.github.com means the unauthenticated rate limit (60
        // req/hour) is spent — a different problem than a missing plugin, and
        // the UI says so differently.
        let code = status.as_u16();
        let hint = if code == 403 { " (rate limit?)" } else { "" };
        return Err(format!("HTTP {code}{hint} for {url}"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > cap {
        return Err(format!("response too large: {} bytes", bytes.len()));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "response is not UTF-8 text".to_string())
}

// ---------------------------------------------------------------------------
// Internet capability (Agent-Reach integration, native port)
//
// Agent-Reach is a capability layer: it selects, installs, health-checks and
// routes upstream internet tools (Jina Reader for web pages, Exa/MCP for
// search, yt-dlp/gh/bili-cli/... per platform) rather than reading itself.
// lvaigent ships a single Windows .exe with no Python sidecar, so the two
// zero-config channels every agent needs — "read any URL" and "search the
// whole web" — are ported here natively:
//
//   - fetch_web mirrors Agent-Reach's web channel (Jina Reader first, direct
//     fetch + HTML-to-text fallback), so `web_read` works with no API key.
//   - web_search mirrors its search channel over DuckDuckGo HTML (also keyless)
//     instead of the Exa/MCP route, which needs Node + mcporter on the host.
//
// Authenticated/social channels (Twitter, Reddit, XHS, Facebook, Instagram,
// Bilibili subtitles, LinkedIn, ...) stay on the Agent-Reach CLI + `run_command`
// path: `agent-reach doctor` picks the backend, the agent calls it directly.
// ---------------------------------------------------------------------------

/// One web-search hit: title + URL + excerpt, as the model sees it.
#[derive(Debug, Serialize, Clone)]
struct WebSearchResult {
    title: String,
    url: String,
    snippet: String,
}

/// True for URLs the internet tools may fetch: http(s), a host, no embedded
/// credentials. Any host is allowed — this is a user-requested read, not a
/// plugin install (contrast `is_trusted_plugin_url`'s allowlist).
fn is_fetchable_http_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return false;
    }
    parsed.host_str().is_some_and(|h| !h.is_empty())
}

fn ascii_lower(s: &str) -> String {
    s.bytes()
        .map(|b| (if b.is_ascii_uppercase() { b + 32 } else { b }) as char)
        .collect()
}

/// Remove `<!-- ... -->` comments so commented-out markup never leaks as text.
fn strip_html_comments(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Remove whole `<tag ...>...</tag>` blocks (scripts, styles, ...).
/// Case-insensitive on ASCII tag names; a missing close tag drops to the end.
fn strip_tag_blocks(html: &str, tag: &str) -> String {
    let lower = ascii_lower(html);
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;
    while pos < html.len() {
        let Some(rel) = lower[pos..].find(&open_pat) else {
            out.push_str(&html[pos..]);
            break;
        };
        let abs = pos + rel;
        // `<tagsomething` is not `<tag`: the char after the name must end it.
        let after = lower.as_bytes().get(abs + open_pat.len()).copied().unwrap_or(b'>');
        if !matches!(after, b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r') {
            out.push_str(&html[pos..abs + open_pat.len()]);
            pos = abs + open_pat.len();
            continue;
        }
        out.push_str(&html[pos..abs]);
        match lower[abs..].find(&close_pat) {
            Some(end) => pos = abs + end + close_pat.len(),
            None => break,
        }
    }
    out
}

/// Replace an opening tag (any attributes, any case) with `replacement`.
/// Used for `<br ...>` line breaks before the generic tag stripper runs.
fn replace_open_tag_with(html: &str, tag: &str, replacement: &str) -> String {
    let lower = ascii_lower(html);
    let pat = format!("<{tag}");
    let mut out = String::with_capacity(html.len() + 16);
    let mut pos = 0;
    while pos < html.len() {
        let Some(rel) = lower[pos..].find(&pat) else {
            out.push_str(&html[pos..]);
            break;
        };
        let abs = pos + rel;
        let after = lower.as_bytes().get(abs + pat.len()).copied().unwrap_or(b'>');
        if !matches!(after, b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r') {
            out.push_str(&html[pos..abs + pat.len()]);
            pos = abs + pat.len();
            continue;
        }
        // The tag ends at the first `>` that is not inside quotes
        // (`<div title="a>b">` is one tag, not two).
        let bytes = html.as_bytes();
        let mut i = abs;
        let mut quote = None::<u8>;
        while i < html.len() {
            let b = bytes[i];
            if let Some(q) = quote {
                if b == q {
                    quote = None;
                }
            } else if b == b'"' || b == b'\'' {
                quote = Some(b);
            } else if b == b'>' {
                break;
            }
            i += 1;
        }
        out.push_str(&html[pos..abs]);
        out.push_str(replacement);
        pos = (i + 1).min(html.len());
    }
    out
}

/// Drop every remaining `<...>` tag (quote-aware, like above).
fn strip_all_tags(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        let b = bytes[i];
        if b == b'<' {
            let mut j = i + 1;
            let mut quote = None::<u8>;
            while j < html.len() {
                let c = bytes[j];
                if let Some(q) = quote {
                    if c == q {
                        quote = None;
                    }
                } else if c == b'"' || c == b'\'' {
                    quote = Some(c);
                } else if c == b'>' {
                    break;
                }
                j += 1;
            }
            i = (j + 1).min(html.len());
        } else {
            // Push the full char, not the byte: slicing mid-char panics.
            let ch = html[i..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn decode_numeric_entity(num: &str, hex: bool) -> Option<char> {
    let n = if hex {
        u32::from_str_radix(num, 16).ok()?
    } else {
        num.parse::<u32>().ok()?
    };
    if n == 0 {
        return None;
    }
    char::from_u32(n)
}

/// Decode the entities HTML text actually contains. Named coverage is the
/// handful pages emit; numeric (`&#233;`, `&#xE9;`) covers the rest. Unknown
/// `&...;` sequences survive verbatim instead of being eaten.
fn decode_html_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let Some(semi) = tail.find(';') else {
            out.push_str(tail);
            break;
        };
        // A "real" entity is short; a `;` 40 chars away ends another sentence.
        if semi > 12 {
            out.push('&');
            rest = &rest[amp + 1..];
            continue;
        }
        let entity = &tail[1..semi];
        let decoded = if entity.eq_ignore_ascii_case("amp") {
            Some('&')
        } else if entity.eq_ignore_ascii_case("lt") {
            Some('<')
        } else if entity.eq_ignore_ascii_case("gt") {
            Some('>')
        } else if entity.eq_ignore_ascii_case("quot") {
            Some('"')
        } else if entity.eq_ignore_ascii_case("apos") || entity == "#39" {
            Some('\'')
        } else if entity.eq_ignore_ascii_case("nbsp") {
            Some(' ')
        } else if let Some(num) = entity.strip_prefix('#') {
            let (hex, digits) = match num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                Some(h) => (true, h),
                None => (false, num),
            };
            if !digits.is_empty()
                && digits.len() <= 7
                && digits
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (hex && b.is_ascii_hexdigit()))
            {
                decode_numeric_entity(digits, hex)
            } else {
                None
            }
        } else {
            None
        };
        match decoded {
            Some(ch) => out.push(ch),
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Heuristic: does this body look like HTML rather than plain text / JSON?
fn looks_like_html(body: &str) -> bool {
    let lower = ascii_lower(body.trim_start().get(..512).unwrap_or(body));
    lower.starts_with('<')
        || ["<html", "<body", "<div", "<article", "<main", "</p>", "</div>"].iter().any(|t| lower.contains(t))
}

/// Turn HTML into model-readable text: drop head content, break blocks into
/// lines, strip tags, decode entities, collapse whitespace. Pure function, so
/// the formatting is unit-testable without touching the network.
fn html_to_text(html: &str) -> String {
    let mut s = strip_html_comments(html);
    for tag in ["script", "style", "noscript", "template"] {
        s = strip_tag_blocks(&s, tag);
    }
    // Block closers/openers become line breaks BEFORE tags are stripped.
    for tag in [
        "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "article",
        "section", "header", "footer", "blockquote", "pre", "hr",
    ] {
        s = replace_open_tag_with(&s, &format!("/{tag}"), "\n");
        s = replace_open_tag_with(&s, tag, "\n");
    }
    s = replace_open_tag_with(&s, "br", "\n");
    let stripped = strip_all_tags(&s);
    let decoded = decode_html_entities(&stripped);
    let mut out = String::new();
    let mut blank = false;
    for line in decoded.lines() {
        let t = collapse_spaces(line);
        let t = t.trim();
        if t.is_empty() {
            if !blank && !out.is_empty() {
                out.push('\n');
                blank = true;
            }
            continue;
        }
        // `out` never ends with a blank line here (see above), so one more
        // newline separates paragraphs without stacking empties.
        if !out.is_empty() && !blank {
            out.push('\n');
        }
        out.push_str(t);
        blank = false;
    }
    out
}

/// Cut `text` to `cap` characters on a char boundary, labelling the cut so
/// the model cannot mistake the excerpt for the whole page.
fn truncate_chars(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let mut end = 0;
    for (i, _) in text.char_indices() {
        if text[..i].chars().count() >= cap {
            break;
        }
        end = i;
    }
    // `end` is the start of the last kept char; extend past it.
    let end = text[end..].chars().next().map(|c| end + c.len_utf8()).unwrap_or(end);
    format!("{}\n... (truncated)", text[..end].trim_end())
}

/// Percent-encode a search query: unreserved marks survive, space becomes `+`.
fn percent_encode_query(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else if *b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        // `+` only means space inside query strings — which is exactly where
        // DuckDuckGo redirect targets carry their encoding.
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// DuckDuckGo HTML wraps result links as `//duckduckgo.com/l/?uddg=<target>`.
/// Unwrap to the real destination; pass direct links through untouched.
fn extract_ddg_target(href: &str) -> String {
    let Some(q) = href.find("uddg=") else {
        if href.starts_with("//") {
            return format!("https:{href}");
        }
        return href.to_string();
    };
    let enc = &href[q + 5..];
    let end = enc.find('&').unwrap_or(enc.len());
    percent_decode(&enc[..end])
}

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=");
    let mut search = tag;
    let mut offset = 0;
    loop {
        let rel = ascii_lower(search).find(&pat)?;
        let abs = offset + rel;
        let after = tag[abs + pat.len()..].chars().next()?;
        if after != '"' && after != '\'' {
            search = &tag[abs + pat.len()..];
            offset = abs + pat.len();
            continue;
        }
        let quote = after;
        let start = abs + pat.len() + 1;
        let rest = &tag[start..];
        let end = rest.find(quote)?;
        return Some(rest[..end].to_string());
    }
}

/// Parse DuckDuckGo HTML results (`result__a` title links + `result__snippet`
/// excerpts). String scanning instead of an HTML parser crate: the one-file
/// `.exe` gains no new dependency, and DDG's markup only needs three anchors.
fn parse_ddg_results(html: &str, limit: usize) -> Vec<WebSearchResult> {
    let mut out = Vec::new();
    let mut pos = 0;
    let mut guard = 0;
    while out.len() < limit && guard < 400 {
        guard += 1;
        let Some(idx) = html[pos..].find("result__a") else {
            break;
        };
        let abs = pos + idx;
        let Some(tag_start) = html[..abs].rfind('<') else {
            pos = abs + 10;
            continue;
        };
        let Some(tag_rel) = html[abs..].find('>') else {
            break;
        };
        let tag_end = abs + tag_rel;
        let tag = &html[tag_start..=tag_end];
        let href = extract_attr(tag, "href").unwrap_or_default();
        let title_start = tag_end + 1;
        let Some(title_rel) = html[title_start..].find("</a>") else {
            pos = tag_end + 1;
            continue;
        };
        let title_end = title_start + title_rel;
        let title = collapse_spaces(&decode_html_entities(&strip_all_tags(&html[title_start..title_end])));
        let title = title.trim().to_string();
        pos = title_end + 4;
        if title.is_empty() {
            continue;
        }
        // The snippet anchor (if any) sits between this title and the next one.
        let next_title = html[pos..].find("result__a").map(|r| pos + r).unwrap_or(html.len());
        let mut snippet = String::new();
        if let Some(s_idx) = html[pos..next_title].find("result__snippet") {
            let s_abs = pos + s_idx;
            if let Some(s_tag) = html[s_abs..].find('>') {
                let s_start = s_abs + s_tag + 1;
                if let Some(s_rel) = html[s_start..next_title].find("</a>") {
                    let raw = &html[s_start..s_start + s_rel];
                    snippet = collapse_spaces(&decode_html_entities(&strip_all_tags(raw)));
                    snippet = snippet.trim().to_string();
                }
            }
        }
        let url = extract_ddg_target(&href);
        if url.is_empty() {
            continue;
        }
        out.push(WebSearchResult { title, url, snippet });
    }
    out
}

/// Read any web page as text (Agent-Reach `web` channel, native).
///
/// Tries Jina Reader first — free, keyless, already-clean text — then falls
/// back to a direct fetch with HTML-to-text conversion.
#[command]
async fn fetch_web(url: String, max_chars: Option<usize>) -> Result<String, String> {
    let target = url.trim().to_string();
    if !is_fetchable_http_url(&target) {
        return Err("URL must start with http:// or https://".into());
    }
    let cap = max_chars.unwrap_or(20_000).clamp(1_000, 60_000);
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    // 1. Jina Reader (Agent-Reach's default web backend).
    let jina_url = format!("https://r.jina.ai/{target}");
    if let Ok(resp) = client.get(&jina_url).send().await {
        if resp.status().is_success() {
            if let Ok(bytes) = resp.bytes().await {
                if !bytes.is_empty() && bytes.len() <= 1_500_000 {
                    let text = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !text.is_empty() {
                        return Ok(truncate_chars(&text, cap));
                    }
                }
            }
        }
    }
    // 2. Direct fetch + HTML-to-text.
    let resp = client
        .get(&target)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {} for {target}", status.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 1_500_000 {
        return Err(format!("response too large: {} bytes", bytes.len()));
    }
    let body = String::from_utf8_lossy(&bytes);
    let text = if looks_like_html(&body) {
        html_to_text(&body)
    } else {
        body.trim().to_string()
    };
    if text.is_empty() {
        return Err("page contained no readable text".into());
    }
    Ok(truncate_chars(&text, cap))
}

/// Search the web without an API key (native stand-in for Agent-Reach's
/// Exa/MCP search route, which needs Node + mcporter on the host).
#[command]
async fn web_search(query: String, count: Option<usize>) -> Result<Vec<WebSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query is empty".into());
    }
    let n = count.unwrap_or(5).clamp(1, 10);
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://html.duckduckgo.com/html/?q={}", percent_encode_query(q));
    let resp = client
        .get(&url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("search HTTP {}", resp.status().as_u16()));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_ddg_results(&html, n))
}

/// Folder installed plugins live in: `<app data>/plugins`, created on demand.
///
/// Deliberately outside any project: a plugin is a user-level capability, and
/// writing it into the open project would put third-party instructions in the
/// user's repository.
#[command]
fn plugins_dir(app: tauri::AppHandle) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().to_string())
}

/// Names of the installed plugin folders (immediate children only).
#[command]
async fn list_plugin_dirs(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let root = plugins_dir(app)?;
    let mut out = Vec::new();
    let mut entries = tokio::fs::read_dir(&root).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        if entry.metadata().await.map(|m| m.is_dir()).unwrap_or(false) {
            out.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// Delete one installed plugin folder. The path must resolve to a direct child
/// of the plugins root, so this can never become "delete anything".
#[command]
async fn remove_plugin_dir(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let root = plugins_dir(app)?;
    let root_c = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Not a plugin folder name".into());
    }
    let target = std::path::absolute(root_c.join(&name)).map_err(|e| e.to_string())?;
    let resolved = resolve_existing_prefix(&lexical_normalize(&target))
        .filter(|p| p != &root_c && p.starts_with(&root_c))
        .ok_or_else(|| "Refusing to remove outside the plugins folder".to_string())?;
    if !resolved.is_dir() {
        return Err("Plugin folder does not exist".into());
    }
    tokio::fs::remove_dir_all(&resolved)
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    set_webview_debug_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // The embedded duck.ai child webview is created up front, parked
            // outside the parent's client area, so the bridge (CDP target,
            // PoW, session) is alive even with the split closed. It MUST be
            // built off the main thread: `add_child` round-trips through the
            // event loop, and `setup` runs on that loop — calling it here
            // would wait on itself.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                if let Err(e) = create_duckai_bridge_window(&handle) {
                    eprintln!("[bridge] startup create failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_user_agent,
            get_challenge,
            duckchat_stream,
            get_bridge_port,
            cdp_targets,
            bridge_diag,
            recreate_bridge,
            show_bridge_window,
            place_duckai,
            open_in_explorer,
            http_get_text,
            fetch_web,
            web_search,
            plugins_dir,
            list_plugin_dirs,
            remove_plugin_dir,
            read_project_tree,
            read_file_content,
            read_file_preview,
            read_file_chunk,
            grep_project,
            list_project_files,
            get_project_info,
            write_file,
            delete_file,
            git_diff,
            git_status,
            git_stage,
            git_unstage,
            git_commit,
            git_suggest_commit_message,
            rename_folder,
            run_command,
            path_report,
            read_file_lines,
            glob_files,
            project_overview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
