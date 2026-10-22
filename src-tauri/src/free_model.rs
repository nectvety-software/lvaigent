//! The keyless free model lane (OpenCode Zen gateway).
//!
//! Ported from the `dsh-our-free-model` project (Ebony-Vinyl), which mounts
//! the same lane into the DeepSeek Harness as a plugin. The lane needs no
//! account, no API key and no local service: the gateway accepts a pooled
//! `public` credential — but only from a client that presents the official v2
//! fingerprint.
//!
//! Four facts are each a 403 on their own, so they are reproduced verbatim
//! rather than approximated:
//!
//!   - the User-Agent must be sent **alone** (`opencode/latest/2.0.26/cli`).
//!     Any prefix or suffix — including an attribution UA — stops the string
//!     from being "a v2 client", and the gateway answers 403 FreeTierError;
//!   - the session id's *encoding* is checked, not just its `ses_` shape: the
//!     twelve hex digits must be the descending `~(value << 12 | counter)`
//!     layout with the counter inside the accepted 1..=63 window;
//!   - the `read` / `shell` tool definitions must match the official client's
//!     byte for byte — a rewritten description or a slimmed schema is refused;
//!   - `tool_choice: "none"` must never be sent; v2 answers 403 for it.
//!
//! The tool declarations exist only to pass that gate. They are real tools
//! upstream, so the model may call them, and lvaigent's own tools are text
//! blocks rather than function calls — a note in the system prompt says so,
//! exactly as the upstream project does for its own hosts.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::command;
use tauri::ipc::Channel;

/// The v2 client fingerprint. Sent as the whole User-Agent string.
pub const CLIENT_UA: &str = "opencode/latest/2.0.26/cli";

const UPSTREAM_BASE: &str = "https://opencode.ai";
const API_PATH: &str = "/inference/v1";

/// The pooled credential. There is no per-user secret on this lane.
const POOL_CREDENTIAL: &str = "Bearer public";

/// Default output budget, in tokens. The free models spend a lot of them on
/// thinking, so the answer itself needs room.
const DEFAULT_MAX_TOKENS: usize = 32_768;

/// The two tools the free-tier gate requires, verbatim from the official
/// client. The gateway compares the description and the parameter schema, so
/// these strings must not be reworded, reordered or "cleaned up".
///
/// The description and the schema are kept apart from the wrapper because
/// the three wires wrap the same tool differently: the Chat wire nests it
/// under `function`, the Responses wire declares it flat, and the
/// Anthropic-shaped wire calls the schema `input_schema`.
const READ_DESCRIPTION: &str = "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.";

const READ_PARAMETERS: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"File or directory to read"},"offset":{"type":"integer","minimum":0,"description":"The line or directory entry to start reading from (1-based)"},"limit":{"type":"integer","minimum":0,"description":"The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}},"required":["path"],"additionalProperties":false}"#;

const SHELL_DESCRIPTION: &str = "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.";

const SHELL_PARAMETERS: &str = r#"{"type":"object","properties":{"command":{"type":"string","description":"Shell command string to execute"},"workdir":{"type":"string","description":"The working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},"timeout":{"type":"integer","minimum":0,"description":"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},"background":{"type":"boolean","description":"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."}},"required":["command"],"additionalProperties":false}"#;

/// An incremental UTF-8 decoder for a byte stream that arrives in chunks.
///
/// A multi-byte character can straddle two chunks, and decoding each chunk
/// on its own turns the halves into U+FFFD: the model's own Vietnamese text
/// came out as "kh??ng". The bytes that do not yet form a character wait for
/// the next chunk.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    /// Add bytes and return the text they complete.
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                let out = text.to_string();
                self.pending.clear();
                out
            }
            Err(err) => {
                let valid = err.valid_up_to();
                let out = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                self.pending.drain(..valid);
                out
            }
        }
    }
}

/// Whether the protocol trace is on.
///
/// One read per turn, not one per frame: the flag is read on every delta
/// otherwise, and the trace is a debugging aid, not a hot path.
fn trace_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("FREE_DEBUG").is_ok())
}

/// The note that explains how the two gate tools relate to lvaigent's own.
///
/// Two things have to be said, and the second one matters more than it
/// looks: the model reads lvaigent's tool list in the prompt and takes it
/// for a list of *functions*, so it calls `run_command` as a function — with
/// no arguments, because the gateway only ever declared a schema for `read`
/// and `shell`. Without the rule it keeps calling it that way, and every
/// such call lands as a tool with no arguments.
const PLACEHOLDER_NOTE: &str = "The only tools this gateway exposes as functions are `read` (lvaigent's read_file) and `shell` (lvaigent's run_command) — you may call those two directly, and they reach the same tools. Every other lvaigent tool must be emitted as a `<tool … />` text block, exactly as the instructions above show — never as a function call.";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// Which upstream path serves a model, and how its frames are shaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreeWire {
    Chat,
    Responses,
    Messages,
}

/// Models the gateway serves on the Responses path.
fn is_responses_model(base: &str) -> bool {
    base == "muse-spark-1.2-contributor-free" || base == "muse-spark-1.3-contributor-free"
        || {
            let lower = base.to_ascii_lowercase();
            let stem = lower.split('/').next_back().unwrap_or(&lower);
            stem.starts_with("muse-spark") || stem.starts_with("muse_spark")
        }
}

/// Models the gateway serves on the Anthropic-shaped path.
fn is_messages_model(base: &str) -> bool {
    base == "union-alpha"
}

/// The model id without a trailing "(level)" thinking suffix.
pub fn base_model_id(model: &str) -> &str {
    let trimmed = model.trim();
    match trimmed.rfind('(') {
        Some(open) if trimmed.ends_with(')') && !trimmed[open..].contains("()") => trimmed[..open].trim(),
        _ => trimmed,
    }
}

/// Which path serves this model, and which wire it speaks.
pub fn wire_for(model: &str) -> (FreeWire, &'static str) {
    let base = base_model_id(model);
    if is_responses_model(base) {
        return (FreeWire::Responses, "/inference/v1/responses");
    }
    if is_messages_model(base) {
        return (FreeWire::Messages, "/inference/v1/messages");
    }
    (FreeWire::Chat, "/inference/v1/chat/completions")
}

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Render `bytes` as exactly `width` base62 characters, big-endian.
///
/// The width is kept even when the number is short: the gateway matches the
/// session id against a fixed shape, so a leading zero must be a character
/// and not a hole.
fn base62_fixed(bytes: &[u8], width: usize) -> String {
    let mut n: u128 = 0;
    for b in bytes {
        n = (n << 8) | u128::from(*b);
    }
    let mut out = vec![b'0'; width];
    for i in (0..width).rev() {
        out[i] = BASE62[(n % 62) as usize];
        n /= 62;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The session id for one conversation.
///
/// The gateway accounts the free quota per session, so a conversation must
/// keep ONE id for its whole life, and it checks the id's *encoding*: the
/// twelve hex digits must be the descending `~(value << 12 | counter)` layout,
/// with the counter inside the accepted 1..=63 window (the low 12 bits land
/// on `0xfc0..=0xfff`). An ascending `ts << 12` value or a plain digest is
/// refused with 403 FreeTierError even though the shape is right.
///
/// The value is derived from a digest of the conversation seed, so the same
/// conversation always maps to the same upstream session: nothing to store,
/// and the same id after a restart.
pub fn canonical_session(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ses\0");
    hasher.update(seed.as_bytes());
    let digest = hasher.finalize();
    // 40 bits of the digest, shifted up, with the counter in the low 12 bits.
    let current = (u64::from(digest[0]) << 28
        | u64::from(digest[1]) << 20
        | u64::from(digest[2]) << 12
        | u64::from(digest[3]) << 4
        | u64::from(digest[4]) >> 4)
        << 12
        | 1;
    let inverted = !current & 0xffff_ffff_ffff;
    let time_hex = format!("{inverted:012x}");
    format!("ses_{time_hex}{}", base62_fixed(&digest[6..16], 14))
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// One message of the turn, as the frontend holds it.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// A JSON string literal, for splicing into a body without reordering keys.
fn json_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// The tool array for one wire.
///
/// Raw JSON, not `json!`: the gateway compares the tool definitions against
/// the official client's, and `serde_json`'s map sorts its keys while the
/// reference sends them in declaration order. The strings are spliced
/// verbatim, so the order is the one the official client sends.
fn tools_json(wire: FreeWire) -> String {
    let (read, shell) = match wire {
        FreeWire::Chat => (
            format!(
                r#"{{"type":"function","function":{{"name":"read","description":{},"parameters":{READ_PARAMETERS}}}}}"#,
                json_str(READ_DESCRIPTION)
            ),
            format!(
                r#"{{"type":"function","function":{{"name":"shell","description":{},"parameters":{SHELL_PARAMETERS}}}}}"#,
                json_str(SHELL_DESCRIPTION)
            ),
        ),
        FreeWire::Responses => (
            format!(
                r#"{{"type":"function","name":"read","description":{},"parameters":{READ_PARAMETERS}}}"#,
                json_str(READ_DESCRIPTION)
            ),
            format!(
                r#"{{"type":"function","name":"shell","description":{},"parameters":{SHELL_PARAMETERS}}}"#,
                json_str(SHELL_DESCRIPTION)
            ),
        ),
        FreeWire::Messages => (
            format!(
                r#"{{"name":"read","description":{},"input_schema":{READ_PARAMETERS}}}"#,
                json_str(READ_DESCRIPTION)
            ),
            format!(
                r#"{{"name":"shell","description":{},"input_schema":{SHELL_PARAMETERS}}}"#,
                json_str(SHELL_DESCRIPTION)
            ),
        ),
    };
    format!("[{read},{shell}]")
}

/// The body of one request, as raw JSON.
///
/// Built as text rather than through `json!` for the same reason as the tool
/// array: the gate compares the tool definitions byte for byte.
pub fn build_body(
    wire: FreeWire,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: usize,
) -> String {
    let mut system = String::new();
    let mut turns: Vec<(String, String)> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" | "developer" => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&m.content);
            }
            // The agent's tool feedback is plain text, so it cannot carry the
            // tool_call_id the strict `tool` role demands. The other
            // transports map it to a user message too.
            "tool" => turns.push((
                "user".to_string(),
                format!("[tool_result] {}", m.content),
            )),
            other => turns.push((other.to_string(), m.content.clone())),
        }
    }
    // The note rides with the system prompt; without one it is a turn of its
    // own, so the model always sees it.
    if system.is_empty() {
        system = PLACEHOLDER_NOTE.to_string();
    } else {
        system = format!("{system}\n\n{PLACEHOLDER_NOTE}");
    }

    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("\"model\":{}", json_str(model)));
    parts.push("\"stream\":true".to_string());

    match wire {
        FreeWire::Chat => {
            // The system turn is a message of its own on this wire, and it
            // carries the placeholder note.
            let mut msgs: Vec<String> = vec![format!(
                "{{\"role\":\"system\",\"content\":{}}}",
                json_str(&system)
            )];
            msgs.extend(turns.iter().map(|(role, content)| {
                format!(
                    "{{\"role\":{},\"content\":{}}}",
                    json_str(role),
                    json_str(content)
                )
            }));
            parts.push(format!("\"messages\":[{}]", msgs.join(",")));
            parts.push(format!("\"max_tokens\":{max_tokens}"));
        }
        FreeWire::Responses => {
            parts.push(format!("\"instructions\":{}", json_str(&system)));
            let items: Vec<String> = turns
                .iter()
                .map(|(role, content)| {
                    let kind = if role == "assistant" {
                        "output_text"
                    } else {
                        "input_text"
                    };
                    format!(
                        "{{\"role\":{},\"content\":[{{\"type\":\"{kind}\",\"text\":{}}}]}}",
                        json_str(role),
                        json_str(content)
                    )
                })
                .collect();
            parts.push(format!("\"input\":[{}]", items.join(",")));
            parts.push(format!("\"max_output_tokens\":{max_tokens}"));
        }
        FreeWire::Messages => {
            parts.push(format!("\"system\":{}", json_str(&system)));
            let msgs: Vec<String> = turns
                .iter()
                .map(|(role, content)| {
                    let role = if role == "assistant" { "assistant" } else { "user" };
                    format!(
                        "{{\"role\":\"{role}\",\"content\":{}}}",
                        json_str(content)
                    )
                })
                .collect();
            parts.push(format!("\"messages\":[{}]", msgs.join(",")));
            parts.push(format!("\"max_tokens\":{max_tokens}"));
        }
    }

    parts.push(format!("\"tools\":{}", tools_json(wire)));
    format!("{{{}}}", parts.join(","))
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/// One streamed event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum FreeEvent {
    Delta { text: String },
    Done,
}

/// Classify a body by shape, not by its Content-Type.
///
/// The gateway is observed answering 200 with a JSON content type over a body
/// that is a perfectly normal SSE frame stream. Believing the header cost the
/// whole turn there, so the first bytes decide and the bytes spent looking are
/// replayed into the reader.
fn sniff_body(head: &str) -> &'static str {
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if head.is_empty() {
        return "empty";
    }
    if head.starts_with('{') || head.starts_with('[') {
        return "json";
    }
    if head.starts_with(':') {
        return "sse";
    }
    let first = head.lines().next().unwrap_or("");
    for field in ["data:", "event:", "id:", "retry:"] {
        if first.starts_with(field) {
            return "sse";
        }
    }
    "unknown"
}

/// The text carried by one frame, per wire.
fn delta_text(wire: FreeWire, payload: &Value) -> Option<String> {
    match wire {
        FreeWire::Chat => payload
            .get("choices")?
            .get(0)?
            .get("delta")?
            .get("content")?
            .as_str()
            .map(|s| s.to_string()),
        FreeWire::Responses => {
            if payload.get("type").and_then(|t| t.as_str()) != Some("response.output_text.delta") {
                return None;
            }
            payload.get("delta")?.as_str().map(|s| s.to_string())
        }
        FreeWire::Messages => {
            if payload.get("type").and_then(|t| t.as_str()) != Some("content_block_delta") {
                return None;
            }
            payload
                .get("delta")?
                .get("text")?
                .as_str()
                .map(|s| s.to_string())
        }
    }
}

/// The thinking carried by one frame, per wire.
///
/// These models think before they answer, and a turn that spends its whole
/// budget thinking produces no answer at all. Knowing that the thinking
/// happened is what turns "the model said nothing" into a legible reason.
fn delta_reasoning(wire: FreeWire, payload: &Value) -> Option<String> {
    match wire {
        FreeWire::Chat => payload
            .get("choices")?
            .get(0)?
            .get("delta")?
            .get("reasoning_content")?
            .as_str()
            .map(|s| s.to_string()),
        FreeWire::Responses => {
            if payload.get("type").and_then(|t| t.as_str())
                != Some("response.reasoning_summary_text.delta")
            {
                return None;
            }
            payload.get("delta")?.as_str().map(|s| s.to_string())
        }
        FreeWire::Messages => {
            if payload.get("type").and_then(|t| t.as_str()) != Some("content_block_delta") {
                return None;
            }
            payload
                .get("delta")?
                .get("thinking")?
                .as_str()
                .map(|s| s.to_string())
        }
    }
}

/// The text of a whole (non-streaming) answer, per wire.
fn body_text(wire: FreeWire, payload: &Value) -> Option<String> {
    match wire {
        FreeWire::Chat => payload
            .get("choices")?
            .get(0)?
            .get("message")?
            .get("content")?
            .as_str()
            .map(|s| s.to_string()),
        FreeWire::Responses => {
            let output = payload.get("output")?.as_array()?;
            let mut out = String::new();
            for item in output {
                let Some(blocks) = item.get("content").and_then(|c| c.as_array()) else {
                    continue;
                };
                for block in blocks {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        out.push_str(text);
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        FreeWire::Messages => {
            let blocks = payload.get("content")?.as_array()?;
            let mut out = String::new();
            for block in blocks {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    out.push_str(text);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
    }
}

/// The native tool calls of one turn, accumulated from the stream.
///
/// The gateway's gate only lets two native tools through, and they are
/// lvaigent's own under other names — `read` is `read_file`, `shell` is
/// `run_command`. A function-calling model reaches for them, because that is
/// what the declarations are for, and its answer then carries a tool call
/// where lvaigent expects a text block. So the calls are translated into
/// lvaigent's own text blocks: the agent loop parses them, the permission
/// gate runs, and the result comes back as an ordinary tool result.
#[derive(Default)]
struct Turn {
    /// (index, name, arguments accumulated so far) — the Chat and Responses
    /// wires both identify a call by index.
    calls: Vec<(i64, String, String)>,
    /// The turn produced an answer.
    saw_content: bool,
    /// The turn produced thinking.
    saw_reasoning: bool,
    /// The turn produced a tool call (which becomes a text block).
    saw_tool: bool,
}

impl Turn {
    fn push(&mut self, index: i64, name: &str, args: &str) {
        match self.calls.iter_mut().find(|(i, _, _)| *i == index) {
            Some(entry) => {
                if !name.is_empty() {
                    entry.1 = name.to_string();
                }
                entry.2.push_str(args);
            }
            None => self.calls.push((index, name.to_string(), args.to_string())),
        }
    }

    /// Take the accumulated calls and translate them into text blocks.
    fn take_calls(&mut self) -> Vec<String> {
        let calls: Vec<(String, String)> = self
            .calls
            .iter()
            .map(|(_, name, args)| (name.clone(), args.clone()))
            .collect();
        self.calls.clear();
        let blocks: Vec<String> = calls
            .into_iter()
            .filter_map(|(name, args)| native_call_to_block(&name, &args))
            .collect();
        if !blocks.is_empty() {
            self.saw_tool = true;
        }
        blocks
    }
}

/// Quote a value for a tool block's attribute.
///
/// The same rule the app's own tool echo uses: double quotes normally, single
/// quotes when the value carries a double quote of its own — the parser
/// accepts either pair, and a value with both cannot be expressed.
fn quote_attr(value: &str) -> String {
    if value.contains('"') && !value.contains('\'') {
        format!("'{value}'")
    } else {
        format!("\"{value}\"")
    }
}

/// The same value, as a tool block's body instead of an attribute.
///
/// A value with both quote kinds has no attribute form: the parser ends at
/// the first inner quote, and a command cut in half is the wrong command.
/// The body carries it verbatim.
fn body_block(tool: &str, value: &str) -> String {
    format!("<tool name=\"{tool}\"><content>{value}</content></tool>")
}

/// How a native call of one of lvaigent's own tool names maps onto that tool.
///
/// The gate only ever declares a schema for `read` and `shell`, but the model
/// reads lvaigent's tool list in the prompt and sometimes calls one of the
/// other tools as a function. Mapping the names means such a call still
/// reaches the right tool — and the executor's own error ("run_command
/// requires a command attribute") is what tells the model what to do next.
const NATIVE_TOOL_ALIASES: &[(&str, &str, &[(&str, &str)])] = &[
    ("list_files", "list_files", &[]),
    ("glob", "glob", &[("pattern", "pattern")]),
    (
        "read_file",
        "read_file",
        &[("path", "path"), ("start_line", "start_line")],
    ),
    ("grep", "grep", &[("query", "query")]),
    ("web_read", "web_read", &[("url", "url")]),
    ("web_search", "web_search", &[("query", "query"), ("count", "count")]),
    (
        "run_command",
        "run_command",
        &[("command", "command"), ("cwd", "cwd")],
    ),
    (
        "edit_file",
        "edit_file",
        &[
            ("path", "path"),
            ("old_string", "old_string"),
            ("new_string", "new_string"),
            ("replace_all", "replace_all"),
        ],
    ),
    (
        "ask_user",
        "ask_user",
        &[("question", "question"), ("options", "options"), ("multi", "multi")],
    ),
    ("write_file", "write_file", &[("path", "path")]),
    ("todo", "todo", &[]),
];

/// Translate one native tool call into lvaigent's own text tool block.
fn native_call_to_block(name: &str, args_json: &str) -> Option<String> {
    let args: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
    let text = |key: &str| -> String {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    match name {
        "read" => {
            let path = text("path");
            if path.is_empty() {
                return None;
            }
            // The gate's offset is 1-based; lvaigent's start_line is 0-based.
            let offset = args.get("offset").and_then(|v| v.as_i64());
            let start = offset.map(|o| (o - 1).max(0));
            Some(match start {
                Some(start) => format!(
                    "<tool name=\"read_file\" path={} start_line=\"{start}\" />",
                    quote_attr(&path)
                ),
                None => format!("<tool name=\"read_file\" path={} />", quote_attr(&path)),
            })
        }
        "shell" => {
            let command = text("command");
            if command.is_empty() {
                return None;
            }
            // A command with both quote kinds has no attribute form.
            if command.contains('"') && command.contains('\'') {
                return Some(body_block("run_command", &command));
            }
            let workdir = text("workdir");
            Some(if workdir.is_empty() {
                format!(
                    "<tool name=\"run_command\" command={} />",
                    quote_attr(&command)
                )
            } else {
                format!(
                    "<tool name=\"run_command\" command={} cwd={} />",
                    quote_attr(&command),
                    quote_attr(&workdir)
                )
            })
        }
        other => {
            let Some((_, tool, mapping)) = NATIVE_TOOL_ALIASES
                .iter()
                .find(|(alias, _, _)| *alias == other)
            else {
                // Not a tool lvaigent knows: pass it through under its own
                // name. The executor refuses it with "unknown tool", which
                // the model can read and adapt to.
                return Some(format!("<tool name={} />", quote_attr(other)));
            };
            let mut attrs = vec![format!("name={}", quote_attr(tool))];
            for (from, to) in mapping.iter() {
                match args.get(*from) {
                    Some(Value::String(s)) => {
                        // A command with both quote kinds has no attribute
                        // form — it goes into the body instead.
                        if *tool == "run_command" && *to == "command" && s.contains('"') && s.contains('\'')
                        {
                            return Some(body_block("run_command", s));
                        }
                        attrs.push(format!("{to}={}", quote_attr(s)))
                    }
                    Some(Value::Number(n)) => attrs.push(format!("{to}=\"{n}\"")),
                    Some(Value::Bool(b)) => attrs.push(format!("{to}=\"{b}\"")),
                    _ => {}
                }
            }
            // A file's content is a body, not an attribute: the write tool
            // takes it between <content> and </content>.
            let content = text("content");
            if !content.is_empty() {
                return Some(format!(
                    "<tool {}><content>{}</content></tool>",
                    attrs.join(" "),
                    content
                ));
            }
            Some(format!("<tool {} />", attrs.join(" ")))
        }
    }
}

/// The error message inside a frame, if it carries one.
fn frame_error(payload: &Value) -> Option<String> {
    let err = payload.get("error")?;
    if let Some(message) = err.get("message").and_then(|m| m.as_str()) {
        return Some(message.to_string());
    }
    if let Some(message) = err.as_str() {
        return Some(message.to_string());
    }
    Some("upstream error".to_string())
}

/// Turn a gateway refusal into something the user can act on.
///
/// The gateway's error envelope carries a machine-readable `type`, and the
/// three that matter operationally need different words: a region refusal is
/// a property of the exit IP, a quota refusal means the session's budget is
/// spent, and the free-tier refusal means this client did not pass the
/// fingerprint gate — neither a key nor a model would fix that.
fn classify_failure(status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let kind = parsed
        .as_ref()
        .and_then(|p| p.get("error"))
        .and_then(|e| e.get("type"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let raw = parsed
        .as_ref()
        .and_then(|p| p.get("error"))
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let flat = raw.to_ascii_lowercase();
    let detail = if raw.is_empty() {
        body.chars().take(200).collect::<String>()
    } else {
        raw
    };
    match kind {
        "RegionError" => format!(
            "mô hình này không phục vụ khu vực mạng của bạn (region gate): {detail}"
        ),
        "FreeUsageLimitError" => format!("hết hạn mức miễn phí của phiên này: {detail}"),
        "ModelError" => format!("gateway không còn phục vụ model này: {detail}"),
        "FreeTierError" => format!(
            "gateway từ chối client fingerprint của lvaigent trên làn miễn phí (403): {detail}"
        ),
        _ => {
            if status == 429 {
                format!("hết hạn mức miễn phí (429): {detail}")
            } else if flat.contains("not available in your country") {
                format!("mô hình này không phục vụ khu vực mạng của bạn: {detail}")
            } else if flat.contains("model is unavailable") {
                format!("gateway không còn phục vụ model này: {detail}")
            } else {
                format!("HTTP {status} từ gateway: {detail}")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One model of the free lane, as the Settings UI shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeModelInfo {
    pub id: String,
    pub name: String,
    pub supports_image: bool,
}

/// Ids the lane serves without a per-user key even without a `-free` suffix.
const ALWAYS_FREE: [&str; 3] = ["union-alpha", "space-bunny-free", "big-pickle"];

/// Is this id on the keyless lane?
pub fn is_free_lane(id: &str) -> bool {
    let base = base_model_id(id);
    if ALWAYS_FREE.contains(&base) {
        return true;
    }
    // The upstream rule is "free" as a whole segment, at the start or after a
    // separator.
    base.split(['-', '_', '.']).any(|part| part == "free")
}

/// The picker's name for an upstream id.
pub fn display_model_name(id: &str) -> String {
    let base = base_model_id(id);
    let known: Option<&str> = match base {
        "mimo-v2.6-flash-free" => Some("MiMo V2.6 Flash"),
        "mimo-v2.5-free" => Some("MiMo V2.5"),
        "muse-spark-1.3-contributor-free" => Some("Muse Spark 1.3"),
        "muse-spark-1.2-contributor-free" => Some("Muse Spark 1.2"),
        "nemotron-3-ultra-free" => Some("Nemotron 3 Ultra"),
        "nemotron-3.5-lightning-free" => Some("Nemotron 3.5 Lightning"),
        "nemotron-3.5-super-vl-free" => Some("Nemotron 3.5 Super VL"),
        "ling-3.0-flash-fin-free" => Some("Ling 3.0 Flash Fin"),
        "space-bunny-free" => Some("Space Bunny"),
        "union-alpha" => Some("Union Alpha"),
        "deepseek-v4-flash-free" => Some("DeepSeek V4 Flash"),
        "deepseek-v4.1-flash-free" => Some("DeepSeek V4.1 Flash"),
        "glm-5.3-flash-free" => Some("GLM 5.3 Flash"),
        "jev-1.13-free" => Some("Jev 1.13"),
        "beam-free" => Some("Beam"),
        "flint-40b-free" => Some("Flint 40B"),
        "minimax-m3.1-flash-free" => Some("MiniMax M3.1 Flash"),
        "big-pickle" => Some("Big Pickle"),
        _ => None,
    };
    if let Some(name) = known {
        return name.to_string();
    }
    // Only the separators become spaces: a dot stays, so a version number
    // ("3.5") does not fall apart into two words.
    base.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) if !first.is_ascii_digit() => {
                    format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                }
                _ => word.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Does the lane accept an image for this model?
///
/// The upstream table records what the lane actually accepted under a direct
/// probe, not what a model card claims.
pub fn supports_image(id: &str) -> bool {
    let base = base_model_id(id);
    match base {
        "deepseek-v4.1-flash-free" | "glm-5.3-flash-free" | "nemotron-3.5-super-vl-free"
        | "space-bunny-free" | "big-pickle" => true,
        "longcat-2.5-preview-free" => false,
        _ => {
            let lower = base.to_ascii_lowercase();
            lower.starts_with("mimo")
                || lower.starts_with("muse-spark")
                || lower.starts_with("muse_spark")
                || lower.starts_with("space-bunny")
                || lower.starts_with("space_bunny")
                || lower.starts_with("union")
        }
    }
}

/// The models the lane serves right now.
///
/// The listing is the gateway's own, refreshed on every call — the lane keeps
/// no snapshot, so a model that disappears upstream disappears here too.
#[command]
pub async fn free_model_models() -> Result<Vec<FreeModelInfo>, String> {
    let session = canonical_session("lvaigent-models");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{UPSTREAM_BASE}{API_PATH}/models"))
        .headers(gateway_headers(&session, false))
        .send()
        .await
        .map_err(|e| format!("không lấy được danh sách model: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(classify_failure(status.as_u16(), &text));
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| "gateway trả về danh sách model không đọc được".to_string())?;
    let rows = parsed
        .get("data")
        .or_else(|| parsed.get("models"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<FreeModelInfo> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for row in rows {
        let id = match &row {
            Value::String(s) => s.clone(),
            other => other
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        };
        let id = id.trim().to_string();
        if id.is_empty() || !is_free_lane(&id) {
            continue;
        }
        let base = base_model_id(&id).to_string();
        if seen.contains(&base) {
            continue;
        }
        seen.push(base.clone());
        out.push(FreeModelInfo {
            name: display_model_name(&base),
            supports_image: supports_image(&base),
            id: base,
        });
    }
    Ok(out)
}

/// The headers the gateway fingerprints a genuine client by.
///
/// The User-Agent is sent alone on purpose: the v2 check matches the whole
/// string, so a prefix or a suffix (an attribution UA, say) stops it from
/// being "a v2 client".
fn gateway_headers(session: &str, stream: bool) -> reqwest::header::HeaderMap {
    use reqwest::header::{
        HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT,
    };
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(AUTHORIZATION, HeaderValue::from_static(POOL_CREDENTIAL));
    headers.insert(USER_AGENT, HeaderValue::from_static(CLIENT_UA));
    headers.insert(
        reqwest::header::HeaderName::from_static("x-opencode-client"),
        HeaderValue::from_static("cli"),
    );
    for name in [
        "x-opencode-session",
        "x-opencode-session-id",
        "x-session-affinity",
        "x-session-id",
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_static(name),
            HeaderValue::from_str(session).unwrap_or_else(|_| HeaderValue::from_static("ses_0")),
        );
    }
    headers.insert(
        reqwest::header::HeaderName::from_static("x-opencode-project"),
        HeaderValue::from_static("global"),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(if stream { "text/event-stream" } else { "*/*" }),
    );
    headers
}

/// One turn on the free lane, streamed back as text deltas.
#[command]
pub async fn free_model_chat(
    model: String,
    messages: Vec<ChatMessage>,
    session_seed: Option<String>,
    max_tokens: Option<usize>,
    on_event: Channel<FreeEvent>,
) -> Result<(), String> {
    let seed = session_seed
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "lvaigent".to_string());
    let session = canonical_session(&seed);
    let (wire, path) = wire_for(&model);
    let budget = max_tokens.unwrap_or(DEFAULT_MAX_TOKENS).clamp(256, 131_072);
    let body = build_body(wire, base_model_id(&model), &messages, budget);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .post(format!("{UPSTREAM_BASE}{path}"))
        .headers(gateway_headers(&session, true))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("gọi gateway miễn phí thất bại: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(classify_failure(status.as_u16(), &text));
    }

    let mut buf = String::new();
    let mut mode: Option<&'static str> = None;
    // A frame's `data:` lines accumulate until a blank line ends the frame.
    let mut frame: Vec<String> = Vec::new();
    // The partial line at the end of the last chunk: the next chunk
    // continues it, and a line cut in half is a frame the parser cannot read.
    let mut line_buf = String::new();
    let mut json_body = String::new();
    let mut turn = Turn::default();
    let mut decoder = Utf8Stream::default();

    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(e) => return Err(format!("đọc phản hồi gateway thất bị: {e}")),
        };
        let text = decoder.push(&chunk);
        if mode.is_none() {
            buf.push_str(&text);
            let shape = sniff_body(&buf);
            match shape {
                "sse" => {
                    mode = Some("sse");
                    // The sniffed bytes are the first frames: replay them.
                    let head = std::mem::take(&mut buf);
                    if let Err(e) = feed_sse(
                        &head,
                        wire,
                        &mut line_buf,
                        &mut frame,
                        &mut turn,
                        &on_event,
                    )
                    .await
                    {
                        return Err(e);
                    }
                }
                "json" => {
                    mode = Some("json");
                    json_body = std::mem::take(&mut buf);
                }
                "empty" => {}
                _ => {
                    // Not enough to tell yet: keep sniffing until the buffer
                    // is long enough to decide.
                    if buf.len() > 8192 {
                        mode = Some("json");
                        json_body = std::mem::take(&mut buf);
                    }
                }
            }
            continue;
        }
        match mode {
            Some("sse") => {
                if let Err(e) = feed_sse(
                    &text,
                    wire,
                    &mut line_buf,
                    &mut frame,
                    &mut turn,
                    &on_event,
                )
                .await
                {
                    return Err(e);
                }
            }
            _ => json_body.push_str(&text),
        }
    }

    // The stream ended mid-line: the rest of it is still a line, and the
    // frame it completes is still a frame.
    if !line_buf.is_empty() {
        let tail = std::mem::take(&mut line_buf);
        feed_sse(
            &format!("{tail}\n"),
            wire,
            &mut line_buf,
            &mut frame,
            &mut turn,
            &on_event,
        )
        .await?;
    }

    if mode == Some("json") {
        let parsed: Value = serde_json::from_str(&json_body)
            .map_err(|_| "gateway trả về phản hồi JSON không đọc được".to_string())?;
        if let Some(message) = frame_error(&parsed) {
            return Err(message);
        }
        let text = body_text(wire, &parsed).unwrap_or_default();
        if !text.is_empty() {
            turn.saw_content = true;
            let _ = on_event.send(FreeEvent::Delta { text });
        }
    } else if mode == Some("sse") && !frame.is_empty() {
        // A stream that ended without its final blank line still carries a
        // frame worth reading.
        let payload = frame.join("\n");
        frame.clear();
        if let Err(e) = emit_payload(wire, &payload, &mut turn, &on_event).await {
            return Err(e);
        }
    }
    // A stream that ended mid-call still carries the call: without the
    // finish frame the accumulated name and arguments are all there is.
    for block in turn.take_calls() {
        let _ = on_event.send(FreeEvent::Delta { text: block });
    }

    // A turn with neither an answer nor a tool call is not a turn the app can
    // do anything with, and the generic "empty response" would send the user
    // looking for a wrong API key. These models think first, and a turn that
    // spends its whole budget thinking ends exactly like this.
    if !turn.saw_content && !turn.saw_tool {
        return Err(if turn.saw_reasoning {
            "model chỉ suy nghĩ mà không có câu trả lời (ngân sách output chạy hết trong kênh suy nghĩ) — thử model khác, hoặc rút gọn ngữ cảnh"
                .into()
        } else {
            "gateway không trả về nội dung nào cho lượt này".into()
        });
    }

    let _ = on_event.send(FreeEvent::Done);
    Ok(())
}

/// Feed SSE text through the frame splitter, emitting the deltas.
///
/// The line buffer belongs to the caller, not to one chunk: a chunk can end
/// in the middle of a line, and a line treated as a whole one is a frame the
/// parser cannot read. That is not a rare shape — the tool-call frames of
/// this gateway are small enough that they land across chunk boundaries, and
/// a dropped one is a dropped tool call.
async fn feed_sse(
    text: &str,
    wire: FreeWire,
    line_buf: &mut String,
    frame: &mut Vec<String>,
    turn: &mut Turn,
    on_event: &Channel<FreeEvent>,
) -> Result<(), String> {
    line_buf.push_str(text);
    while let Some(pos) = line_buf.find('\n') {
        let mut line: String = line_buf.drain(..=pos).collect();
        // The drained range ends ON the newline, so the line still carries
        // it. Without dropping it, the blank line between two frames is
        // "\n" rather than "" — and no frame is ever dispatched.
        line.pop();
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !frame.is_empty() {
                let payload = frame.join("\n");
                frame.clear();
                if let Err(e) = emit_payload(wire, &payload, turn, on_event).await {
                    return Err(e);
                }
            }
            continue;
        }
        if line.starts_with(':') {
            // A comment frame: the gateway's keep-alive, and what it uses to
            // fill the silence while a model thinks.
            continue;
        }
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        let value = rest.strip_prefix(' ').unwrap_or(rest);
        if value.trim() == "[DONE]" {
            continue;
        }
        frame.push(value.to_string());
    }
    Ok(())
}

/// One complete frame: parse it and emit whatever text it carries.
async fn emit_payload(
    wire: FreeWire,
    payload: &str,
    turn: &mut Turn,
    on_event: &Channel<FreeEvent>,
) -> Result<(), String> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    if let Some(message) = frame_error(&parsed) {
        return Err(message);
    }
    if let Some(text) = delta_text(wire, &parsed) {
        if !text.is_empty() {
            turn.saw_content = true;
            if trace_on() {
                eprintln!("[free-text] {text:?}");
            }
            let _ = on_event.send(FreeEvent::Delta { text });
        }
    }
    if let Some(text) = delta_reasoning(wire, &parsed) {
        if !text.is_empty() {
            turn.saw_reasoning = true;
        }
    }
    for block in collect_tool_blocks(wire, &parsed, turn) {
        if trace_on() {
            eprintln!("[free-block] {block:?}");
        }
        let _ = on_event.send(FreeEvent::Delta { text: block });
    }
    Ok(())
}

/// Read the native tool calls of one frame and translate the finished ones.
///
/// The three wires announce a call differently: the Chat wire streams the
/// name and the arguments in `delta.tool_calls` and closes the call with
/// `finish_reason: "tool_calls"`; the Responses wire delivers the whole call
/// in `response.output_item.done`; the Anthropic-shaped wire opens a block
/// with the name, streams the arguments as partial JSON, and closes the
/// block.
fn collect_tool_blocks(wire: FreeWire, payload: &Value, turn: &mut Turn) -> Vec<String> {
    match wire {
        FreeWire::Chat => {
            if let Some(list) = payload.pointer("/choices/0/delta/tool_calls").and_then(|v| v.as_array()) {
                for call in list {
                    let index = call.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                    let name = call
                        .pointer("/function/name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let args = call
                        .pointer("/function/arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    turn.push(index, name, args);
                }
            }
            let finished = payload
                .pointer("/choices/0/finish_reason")
                .and_then(|v| v.as_str())
                == Some("tool_calls");
            if finished {
                turn.take_calls()
            } else {
                Vec::new()
            }
        }
        FreeWire::Responses => {
            let is_call = payload.get("type").and_then(|t| t.as_str()) == Some("response.output_item.done")
                && payload
                    .pointer("/item/type")
                    .and_then(|v| v.as_str())
                    == Some("function_call");
            if is_call {
                let name = payload
                    .pointer("/item/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let args = payload
                    .pointer("/item/arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                turn.push(0, name, args);
                turn.take_calls()
            } else {
                Vec::new()
            }
        }
        FreeWire::Messages => {
            match payload.get("type").and_then(|t| t.as_str()) {
                Some("content_block_start") => {
                    if payload
                        .pointer("/content_block/type")
                        .and_then(|v| v.as_str())
                        == Some("tool_use")
                    {
                        let name = payload
                            .pointer("/content_block/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        turn.push(0, name, "");
                    }
                    Vec::new()
                }
                Some("content_block_delta") => {
                    if payload.pointer("/delta/type").and_then(|v| v.as_str())
                        == Some("input_json_delta")
                    {
                        let partial = payload
                            .pointer("/delta/partial_json")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        turn.push(0, "", partial);
                    }
                    Vec::new()
                }
                Some("content_block_stop") => turn.take_calls(),
                _ => Vec::new(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_has_the_shape_the_gate_accepts() {
        let id = canonical_session("conversation-1");
        assert!(id.starts_with("ses_"));
        assert_eq!(id.len(), 4 + 12 + 14);
        let time = &id[4..16];
        assert!(time.chars().all(|c| c.is_ascii_hexdigit()));
        // The descending layout: the tenth hex digit is `f` and the eleventh is
        // in `c..=f`, which is where a counter of 1..=63 lands.
        assert_eq!(time.as_bytes()[9], b'f');
        assert!((b'c'..=b'f').contains(&time.as_bytes()[10]));
        let tail = &id[16..];
        assert!(tail.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn the_same_conversation_keeps_one_session() {
        assert_eq!(canonical_session("abc"), canonical_session("abc"));
        assert_ne!(canonical_session("abc"), canonical_session("abd"));
    }

    #[test]
    fn the_free_lane_filter_matches_the_upstream_rule() {
        assert!(is_free_lane("deepseek-v4.1-flash-free"));
        assert!(is_free_lane("muse-spark-1.3-contributor-free"));
        assert!(is_free_lane("union-alpha"));
        assert!(is_free_lane("big-pickle"));
        assert!(!is_free_lane("gpt-5.4-mini"));
        assert!(!is_free_lane("freek-model"));
    }

    #[test]
    fn the_wire_follows_the_model_id() {
        assert_eq!(wire_for("deepseek-v4.1-flash-free").0, FreeWire::Chat);
        assert_eq!(wire_for("muse-spark-1.3-contributor-free").0, FreeWire::Responses);
        assert_eq!(wire_for("union-alpha").0, FreeWire::Messages);
    }

    #[test]
    fn the_body_declares_both_gate_tools_and_never_a_none_choice() {
        let body = build_body(
            FreeWire::Chat,
            "m",
            &[ChatMessage {
                role: "system".into(),
                content: "sys".into(),
            }],
            1024,
        );
        assert!(body.contains("\"name\":\"read\""));
        assert!(body.contains("\"name\":\"shell\""));
        assert!(!body.contains("tool_choice"));
        // The note rides with the system prompt.
        assert!(body.contains("The only tools this gateway exposes as functions"));
        // The system turn keeps its own text.
        assert!(body.contains("\"content\":\"sys\\n\\nThe only tools"));
    }

    #[test]
    fn the_gate_tool_definitions_are_verbatim() {
        let body = build_body(
            FreeWire::Chat,
            "m",
            &[ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            1024,
        );
        assert!(body.contains(
            "Each text line is prefixed by its 1-based line number as <line>: <content>."
        ));
        assert!(body.contains("\"additionalProperties\":false"));
        assert!(body.contains("\"required\":[\"path\"]"));
        assert!(body.contains("\"required\":[\"command\"]"));
    }

    #[test]
    fn tool_feedback_travels_as_a_user_turn() {
        let body = build_body(
            FreeWire::Chat,
            "m",
            &[ChatMessage {
                role: "tool".into(),
                content: "result".into(),
            }],
            1024,
        );
        assert!(body.contains("\"role\":\"user\",\"content\":\"[tool_result] result\""));
    }

    #[test]
    fn the_body_shape_follows_the_wire() {
        let chat = build_body(
            FreeWire::Chat,
            "m",
            &[ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            512,
        );
        assert!(chat.contains("\"max_tokens\":512"));

        let responses = build_body(
            FreeWire::Responses,
            "m",
            &[ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            512,
        );
        assert!(responses.contains("\"max_output_tokens\":512"));
        assert!(responses.contains("\"input\":["));
        assert!(responses.contains("\"instructions\":"));

        let messages = build_body(
            FreeWire::Messages,
            "m",
            &[ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            512,
        );
        assert!(messages.contains("\"system\":"));
        assert!(messages.contains("\"input_schema\":"));
    }

    #[test]
    fn a_body_is_valid_json() {
        for wire in [FreeWire::Chat, FreeWire::Responses, FreeWire::Messages] {
            let body = build_body(
                wire,
                "model-x",
                &[
                    ChatMessage {
                        role: "system".into(),
                        content: "sys \"quoted\"".into(),
                    },
                    ChatMessage {
                        role: "user".into(),
                        content: "hi\nthere".into(),
                    },
                ],
                1024,
            );
            let parsed: Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("{wire:?} body is not JSON: {e}\n{body}"));
            assert_eq!(parsed["model"], "model-x");
            assert!(parsed["tools"].as_array().is_some_and(|t| t.len() == 2));
        }
    }

    #[test]
    fn the_body_shape_is_decided_by_the_bytes_not_the_header() {
        assert_eq!(sniff_body("data: {\"a\":1}"), "sse");
        assert_eq!(sniff_body(": keep-alive"), "sse");
        assert_eq!(sniff_body("{\"data\":[]}"), "json");
        assert_eq!(sniff_body("  \n{\"data\":[]}"), "json");
        assert_eq!(sniff_body(""), "empty");
    }

    #[test]
    fn the_thinking_is_told_apart_from_the_answer() {
        let frame: Value =
            serde_json::from_str("{\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}").unwrap();
        assert_eq!(delta_reasoning(FreeWire::Chat, &frame).as_deref(), Some("hmm"));
        assert_eq!(delta_text(FreeWire::Chat, &frame), None);
        let answer: Value = serde_json::from_str("{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}").unwrap();
        assert_eq!(delta_reasoning(FreeWire::Chat, &answer), None);
    }

    #[test]
    fn deltas_are_read_per_wire() {
        let chat: Value = serde_json::from_str("{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}").unwrap();
        assert_eq!(delta_text(FreeWire::Chat, &chat).as_deref(), Some("hi"));

        let resp: Value =
            serde_json::from_str("{\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}").unwrap();
        assert_eq!(delta_text(FreeWire::Responses, &resp).as_deref(), Some("hi"));
        let other: Value = serde_json::from_str("{\"type\":\"response.created\"}").unwrap();
        assert_eq!(delta_text(FreeWire::Responses, &other), None);

        let msg: Value =
            serde_json::from_str("{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}")
                .unwrap();
        assert_eq!(delta_text(FreeWire::Messages, &msg).as_deref(), Some("hi"));
    }

    #[test]
    fn refusals_are_named_by_what_they_are() {
        let region = classify_failure(403, r#"{"error":{"type":"RegionError","message":"no"}}"#);
        assert!(region.contains("khu vực"));

        let quota = classify_failure(429, r#"{"error":{"type":"FreeUsageLimitError","message":"no"}}"#);
        assert!(quota.contains("hết hạn mức"));

        let gate = classify_failure(403, r#"{"error":{"type":"FreeTierError","message":"no"}}"#);
        assert!(gate.contains("fingerprint"));

        let model = classify_failure(404, r#"{"error":{"type":"ModelError","message":"Model is unavailable"}}"#);
        assert!(model.contains("không còn phục vụ"));
    }

    #[test]
    fn the_display_name_never_leaks_a_raw_id() {
        assert_eq!(display_model_name("deepseek-v4.1-flash-free"), "DeepSeek V4.1 Flash");
        assert_eq!(display_model_name("some-unknown-model"), "Some Unknown Model");
        // A version number keeps its dot: "3.5" is one word, not two.
        assert_eq!(
            display_model_name("some-model-2.5-preview-free"),
            "Some Model 2.5 Preview Free"
        );
    }

    /// The gate's two native tools are lvaigent's own under other names, so a
    /// function-calling model's call has to become one of lvaigent's text
    /// tool blocks — otherwise the turn arrives with an empty answer.
    #[test]
    fn a_native_read_becomes_a_read_file_block() {
        let block = native_call_to_block("read", r#"{"path":"src/main.rs"}"#).unwrap();
        assert_eq!(block, "<tool name=\"read_file\" path=\"src/main.rs\" />");
        // The gate's offset is 1-based; lvaigent's start_line is 0-based.
        let with_offset = native_call_to_block("read", r#"{"path":"a.ts","offset":10}"#).unwrap();
        assert_eq!(with_offset, "<tool name=\"read_file\" path=\"a.ts\" start_line=\"9\" />");
    }

    #[test]
    fn a_native_shell_becomes_a_run_command_block() {
        let block = native_call_to_block("shell", r#"{"command":"npm test"}"#).unwrap();
        assert_eq!(block, "<tool name=\"run_command\" command=\"npm test\" />");
        let with_dir = native_call_to_block("shell", r#"{"command":"ls","workdir":"src"}"#).unwrap();
        assert_eq!(
            with_dir,
            "<tool name=\"run_command\" command=\"ls\" cwd=\"src\" />"
        );
    }

    #[test]
    fn a_command_with_quotes_survives_the_attribute_parser() {
        // The parser accepts either quote pair, so a value with a double quote
        // of its own is wrapped in single quotes.
        let block = native_call_to_block("shell", r#"{"command":"echo \"hi\""}"#).unwrap();
        assert_eq!(block, "<tool name=\"run_command\" command='echo \"hi\"' />");
    }

    #[test]
    fn a_call_the_app_cannot_run_is_passed_through_by_name() {
        let block = native_call_to_block("write", r#"{"path":"a.ts"}"#).unwrap();
        assert_eq!(block, "<tool name=\"write\" />");
    }

    /// The model reads lvaigent's tool list in the prompt and sometimes calls
    /// one of those tools as a function. The name still has to reach the
    /// right tool — with the arguments the model sent.
    #[test]
    fn a_native_call_of_a_lvaigent_tool_reaches_that_tool() {
        let block = native_call_to_block("run_command", r#"{"command":"npm test"}"#).unwrap();
        assert_eq!(block, "<tool name=\"run_command\" command=\"npm test\" />");
        let glob = native_call_to_block("glob", r#"{"pattern":"src/**/*.ts"}"#).unwrap();
        assert_eq!(glob, "<tool name=\"glob\" pattern=\"src/**/*.ts\" />");
        let grep = native_call_to_block("grep", r#"{"query":"TODO"}"#).unwrap();
        assert_eq!(grep, "<tool name=\"grep\" query=\"TODO\" />");
        let search = native_call_to_block("web_search", r#"{"query":"rust","count":3}"#).unwrap();
        assert_eq!(search, "<tool name=\"web_search\" query=\"rust\" count=\"3\" />");
    }

    /// A call with no arguments is still a call: the executor's own error is
    /// what tells the model what the tool needs.
    #[test]
    fn a_native_call_without_arguments_still_names_its_tool() {
        let block = native_call_to_block("run_command", "").unwrap();
        assert_eq!(block, "<tool name=\"run_command\" />");
    }

    /// A file's content is a body, not an attribute.
    #[test]
    fn a_native_write_carries_its_content_in_a_body() {
        let block = native_call_to_block("write_file", r#"{"path":"a.ts","content":"let x = 1;"}"#)
            .unwrap();
        assert_eq!(
            block,
            "<tool name=\"write_file\" path=\"a.ts\"><content>let x = 1;</content></tool>"
        );
    }

    #[test]
    fn a_native_call_is_collected_when_the_call_closes() {
        let mut turn = Turn::default();
        let open: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\"path\":"}}]}}]}"#,
        )
        .unwrap();
        assert!(collect_tool_blocks(FreeWire::Chat, &open, &mut turn).is_empty());
        let rest: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.ts\"}"}}]}}]}"#,
        )
        .unwrap();
        assert!(collect_tool_blocks(FreeWire::Chat, &rest, &mut turn).is_empty());
        let close: Value =
            serde_json::from_str(r#"{"choices":[{"finish_reason":"tool_calls"}]}"#).unwrap();
        let blocks = collect_tool_blocks(FreeWire::Chat, &close, &mut turn);
        assert_eq!(blocks, vec!["<tool name=\"read_file\" path=\"a.ts\" />"]);
        // A tool call is an answer of its own: the agent loop acts on it.
        assert!(turn.saw_tool);
        assert!(!turn.saw_content);
    }

    #[test]
    fn the_responses_wire_delivers_its_call_in_one_frame() {
        let mut turn = Turn::default();
        let frame: Value = serde_json::from_str(
            r#"{"type":"response.output_item.done","item":{"type":"function_call","name":"shell","arguments":"{\"command\":\"ls\"}"}}"#,
        )
        .unwrap();
        let blocks = collect_tool_blocks(FreeWire::Responses, &frame, &mut turn);
        assert_eq!(blocks, vec!["<tool name=\"run_command\" command=\"ls\" />"]);
    }

    #[test]
    fn the_anthropic_wire_streams_the_arguments_in_parts() {
        let mut turn = Turn::default();
        let start: Value = serde_json::from_str(
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","name":"read"}}"#,
        )
        .unwrap();
        assert!(collect_tool_blocks(FreeWire::Messages, &start, &mut turn).is_empty());
        let part: Value = serde_json::from_str(
            r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a.ts\"}"}}"#,
        )
        .unwrap();
        assert!(collect_tool_blocks(FreeWire::Messages, &part, &mut turn).is_empty());
        let stop: Value = serde_json::from_str(r#"{"type":"content_block_stop"}"#).unwrap();
        let blocks = collect_tool_blocks(FreeWire::Messages, &stop, &mut turn);
        assert_eq!(blocks, vec!["<tool name=\"read_file\" path=\"a.ts\" />"]);
    }

    /// A frame that arrives in two chunks must still be read.
    ///
    /// The chunk boundary lands wherever the network puts it, and the tool
    /// call frames of this gateway are small enough to be split. A reader
    /// that treats each chunk as a whole stream drops the frame — and a
    /// dropped tool call is a dropped tool.
    #[tokio::test]
    async fn a_frame_split_across_chunks_is_still_read() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel: tauri::ipc::Channel<FreeEvent> = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                sink.lock().unwrap().push(text);
            }
            Ok(())
        });

        let frame = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n";
        let cut = frame.len() / 2;
        let mut line_buf = String::new();
        let mut frame_lines: Vec<String> = Vec::new();
        let mut turn = Turn::default();

        feed_sse(
            &frame[..cut],
            FreeWire::Chat,
            &mut line_buf,
            &mut frame_lines,
            &mut turn,
            &channel,
        )
        .await
        .unwrap();
        feed_sse(
            &frame[cut..],
            FreeWire::Chat,
            &mut line_buf,
            &mut frame_lines,
            &mut turn,
            &channel,
        )
        .await
        .unwrap();

        let payloads = seen.lock().unwrap().clone();
        let text: String = payloads
            .iter()
            .filter_map(|p| serde_json::from_str::<Value>(p).ok())
            .filter(|v| v.get("event").and_then(|e| e.as_str()) == Some("delta"))
            .filter_map(|v| {
                v.get("data")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        assert_eq!(text, "hi");
    }

    #[test]
    fn a_character_split_across_chunks_stays_one_character() {
        let mut decoder = Utf8Stream::default();
        let text = "không có pip";
        let bytes = text.as_bytes();
        // Split in the middle of a multi-byte character.
        let cut = bytes
            .iter()
            .position(|b| *b >= 0x80)
            .map(|i| i + 1)
            .unwrap_or(0);
        assert!(cut > 0, "the sample has no multi-byte character");
        let first = decoder.push(&bytes[..cut]);
        let second = decoder.push(&bytes[cut..]);
        assert_eq!(format!("{first}{second}"), text);
        assert!(!format!("{first}{second}").contains('\u{FFFD}'));
    }

    /// A command with both quote kinds has no attribute form: the parser
    /// ends at the first inner quote, and a cut command is the wrong command.
    /// The body carries it verbatim.
    #[test]
    fn a_command_with_both_quote_kinds_travels_in_the_body() {
        let block = native_call_to_block("shell", r#"{"command":"py -3 -c \"print('hi')\""}"#)
            .unwrap();
        assert_eq!(
            block,
            "<tool name=\"run_command\"><content>py -3 -c \"print('hi')\"</content></tool>"
        );
        // A command with one kind of quote is still an attribute.
        let simple = native_call_to_block("shell", r#"{"command":"echo \"hi\""}"#).unwrap();
        assert_eq!(simple, "<tool name=\"run_command\" command='echo \"hi\"' />");
    }

    /// The note must name the two tools that ARE functions, and must say
    /// that the rest are text blocks.
    ///
    /// The model reads lvaigent's tool list in the prompt and takes it for a
    /// list of functions; without this rule it calls `run_command` as a
    /// function with no arguments, over and over.
    #[test]
    fn the_note_names_the_gate_tools_instead_of_forbidding_them() {
        assert!(!PLACEHOLDER_NOTE.contains("Do not call"));
        assert!(PLACEHOLDER_NOTE.contains("read"));
        assert!(PLACEHOLDER_NOTE.contains("shell"));
        assert!(PLACEHOLDER_NOTE.contains("text block"));
    }

    /// A live turn against the real gateway.
    ///
    /// Ignored by default: it spends the free quota and needs the network.
    /// Run it with `cargo test --lib -- --ignored live_free_lane` to check
    /// that the fingerprint, the body and the stream parser still agree with
    /// the gateway — the four facts that each turn the lane into a 403.
    #[tokio::test]
    #[ignore]
    async fn live_free_lane_answers_and_reaches_its_tools() {
        let session = canonical_session("lvaigent-live-test");
        assert!(session.starts_with("ses_"));

        let body = build_body(
            FreeWire::Chat,
            "deepseek-v4.1-flash-free",
            &[
                ChatMessage {
                    role: "system".into(),
                    content: "You are a helpful assistant.".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "Reply with exactly: OK".into(),
                },
            ],
            2048,
        );
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap();
        let resp = client
            .post(format!("{UPSTREAM_BASE}{}", wire_for("deepseek-v4.1-flash-free").1))
            .headers(gateway_headers(&session, true))
            .body(body)
            .send()
            .await
            .expect("the gateway must answer");
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        assert!(
            status.is_success(),
            "the free lane refused the client: HTTP {status} — {}",
            &text[..text.len().min(300)]
        );
        assert!(text.contains("data:"), "the answer is not an SSE stream");
    }

    /// The command itself, end to end, against the real gateway.
    ///
    /// Ignored by default: it spends the free quota and needs the network.
    /// It pins the one link the unit tests cannot reach — the shape of the
    /// payload the channel carries, which the frontend reads as
    /// `{event, data:{text}}`.
    #[tokio::test]
    #[ignore]
    async fn live_free_model_chat_streams_deltas_the_frontend_can_read() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel: tauri::ipc::Channel<FreeEvent> = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                sink.lock().unwrap().push(text);
            }
            Ok(())
        });

        free_model_chat(
            "deepseek-v4.1-flash-free".to_string(),
            vec![
                ChatMessage {
                    role: "system".into(),
                    content: "You are a helpful assistant.".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "Reply with exactly: OK".into(),
                },
            ],
            Some("lvaigent-live-command-test".into()),
            Some(2048),
            channel,
        )
        .await
        .expect("the free lane must answer");

        let payloads = seen.lock().unwrap().clone();
        assert!(!payloads.is_empty(), "no payload reached the channel");
        let mut answer = String::new();
        let mut done = false;
        for payload in &payloads {
            let value: Value = serde_json::from_str(payload).expect("the payload is JSON");
            match value.get("event").and_then(|v| v.as_str()) {
                Some("delta") => {
                    answer.push_str(
                        value
                            .get("data")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                            .unwrap_or(""),
                    );
                }
                Some("done") => done = true,
                other => panic!("unexpected event {other:?} in {payload}"),
            }
        }
        assert!(done, "the turn never ended");
        assert!(
            answer.to_lowercase().contains("ok"),
            "the answer was {answer:?}"
        );
    }

    /// A turn that needs a tool: the model's native call must arrive as one
    /// of lvaigent's own text tool blocks.
    ///
    /// Ignored by default: it spends the free quota and needs the network.
    #[tokio::test]
    #[ignore]
    async fn live_free_model_chat_turns_a_native_call_into_a_text_block() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel: tauri::ipc::Channel<FreeEvent> = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                sink.lock().unwrap().push(text);
            }
            Ok(())
        });

        let system = format!(
            "You are lvaigent, an AI coding assistant working inside the user's project.\n\n{PLACEHOLDER_NOTE}"
        );
        free_model_chat(
            "deepseek-v4.1-flash-free".to_string(),
            vec![
                ChatMessage {
                    role: "system".into(),
                    content: system,
                },
                ChatMessage {
                    role: "user".into(),
                    content: "Read the file package.json and tell me the project name.".into(),
                },
            ],
            Some("lvaigent-live-tool-test".into()),
            Some(4096),
            channel,
        )
        .await
        .expect("the free lane must answer");

        let payloads = seen.lock().unwrap().clone();
        let mut answer = String::new();
        for payload in &payloads {
            let value: Value = serde_json::from_str(payload).expect("the payload is JSON");
            if value.get("event").and_then(|v| v.as_str()) == Some("delta") {
                answer.push_str(
                    value
                        .get("data")
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or(""),
                );
            }
        }
        assert!(
            answer.contains("<tool name=\"read_file\""),
            "the native call did not become a text block: {answer:?}"
        );
        assert!(answer.contains("package.json"), "{answer:?}");
    }

    /// The roster the gateway publishes, read through the command.
    ///
    /// Ignored by default: it needs the network.
    #[tokio::test]
    #[ignore]
    async fn live_free_model_models_lists_the_free_ids_only() {        let models = free_model_models().await.expect("the roster must be readable");
        assert!(!models.is_empty(), "the gateway published no free model");
        for model in &models {
            assert!(
                is_free_lane(&model.id),
                "{} is not on the keyless lane",
                model.id
            );
            assert!(!model.name.is_empty());
            assert!(!model.name.contains('-'), "a raw id leaked as a name");
        }
    }
}
