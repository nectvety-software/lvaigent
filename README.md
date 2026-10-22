# lvaigent

Ứng dụng chat AI dạng agent chạy trên máy tính (Windows), đóng gói một file `.exe` duy nhất kèm trình cài đặt NSIS.

lvaigent kết nối tới nhiều nguồn model:

- **duck.ai** qua bridge WebView2 tích hợp sẵn (không cần API key) — gồm cả đường PoW/legacy và driver điều khiển trực tiếp trang SPA.
- **Our Free Model** — làn model miễn phí của OpenCode Zen gateway (DeepSeek V4.1 Flash, GLM 5.3 Flash, MiMo V2.6 Flash, Nemotron…). Không cần tài khoản, không cần API key: chọn provider là dùng được ngay. Danh sách model lấy từ chính gateway mỗi lần mở app.
- **Provider API tùy chỉnh** theo 3 giao thức: OpenAI Chat Completions, OpenAI Responses và Anthropic Messages.

## Tính năng chính

- **Agent tự chạy tool trên project đang mở**: 11 tool — `list_files`, `glob`, `grep`, `read_file`, `write_file`, `edit_file`, `run_command`, `ask_user`, `todo`, `web_read`, `web_search` (model phát tool call dạng text `<tool ... />`, app parse, thực thi trong Rust và gửi kết quả `[tool_result]` trở lại theo từng vòng).
- **Bộ công cụ lấy cảm hứng từ ZCode** (zai-org/ZCode): `edit_file` sửa chỗ một đoạn — bắt đọc file trước (`FILE_NOT_READ`), `old_string` phải duy nhất (`AMBIGUOUS_REPLACE`, gợi ý `replace_all`), không tìm thấy thì báo excerpt 400 ký tự, `old_string` rỗng thì tạo file mới; `ask_user` hỏi quyết định thuộc về user (multi-select, luôn có ô tự nhập — hủy hội thoại ≠ từ chối); `todo` liệt kê checklist công việc, hiển thị `[x] [~] [ ]` trong bubble chat.
- **Thanh hành động trên mỗi tin nhắn** (hover): 👍/👎 (lưu lại), copy, menu ⋯ với "Xóa tin nhắn" (xác nhận hai bước).
- **Chế độ PLAN / BUILD + hệ thống quyền**: duyệt từng thay đổi (Review panel, diff, `/undo`), luật cho phép/chặn theo tool, "Full access".
- **Bộ chỉnh sửa Provider**: thêm/xóa provider, base URL, API key, custom headers, quản lý model thủ hoặc kéo từ `/models`, test kết nối bằng một request chat thật (timeout + lý do lỗi cụ thể).
- **Làn miễn phí hoạt động như agent thật**: hai tool native của gateway (`read`, `shell`) được dịch sang tool của lvaigent (`read_file`, `run_command`), nên model vẫn đọc file, chạy lệnh và đi qua đúng hệ thống phân quyền như mọi provider khác.
- **Pane Browser** nhúng trang duck.ai như một cửa sổ con thật (native child webview, resize được như panel thường).
- **Workspace & lịch sử chat** lưu trên máy, file đính kèm (code/ảnh) hover xem trước, custom slash-commands, terminal phải song song với shell thật.

## Làn model miễn phí (Our Free Model)

Provider **Our Free Model** là làn miễn phí của OpenCode Zen gateway — không cần
tài khoản, không cần API key. Chọn provider là dùng được ngay; danh sách model
đọc từ chính gateway mỗi lần mở app (làn này không giữ snapshot, nên model bị
gateway gỡ sẽ biến mất khỏi danh sách).

**Vì sao phải viết bằng Rust** (`src-tauri/src/free_model.rs`): gateway kiểm tra
"vân tay" client, và mỗi điều kiện dưới đây là một lần 403 riêng biệt:

| Điều kiện | Vì sao bắt buộc |
|---|---|
| User-Agent `opencode/latest/2.0.26/cli`, gửi **đứng riêng** | gateway so khớp cả chuỗi — có tiền tố/hậu tố (kể cả UA ghi công) là 403. `fetch` của webview không set được header này, nên lượt chat phải đi từ Rust |
| Session id đúng encoding giảm dần `~(ts<<12\|counter)`, counter 1–63 | hình dạng `ses_...` đúng mà encoding sai vẫn bị từ chối |
| Hai khai báo tool `read`/`shell` **giống hệt** client chính thức | gateway so sánh cả description lẫn schema; rút gọn hay đổi câu là 403 |
| Không bao giờ gửi `tool_choice: "none"` | v2 từ chối thẳng |

Ba wire được hỗ trợ: `/inference/v1/chat/completions`, `/responses` và `/messages`
(tuỳ model). Body được dựng bằng **chuỗi thô** chứ không phải `json!`: `serde_json`
sắp xếp key của map, còn gateway so sánh theo thứ tự khai báo.

**Tool protocol.** Model của làn này gọi tool dạng native function, còn lvaigent
dùng tool dạng text `<tool … />`. Hai native tool được dịch sang tool của lvaigent
(`read` → `read_file`, `shell` → `run_command`) nên model vẫn đọc file, chạy lệnh và
đi qua **đúng hệ thống phân quyền** như mọi provider khác. Lệnh chứa cả dấu
nháy kép và dấu nháy đơn không biểu diễn được bằng attribute (parser dừng ở dấu
nháy trong), nên lệnh đó đi trong thân block và không bị cắt.

Theo dõi giao thức (in ra stderr, tắt mặc định):

```bash
FREE_DEBUG=1 lvaigent.exe
```

## Đọc web & tìm kiếm

`web_read` (đọc một URL thành text) và `web_search` (tìm trên web: tiêu đề + URL
+ trích đoạn) chạy thẳng trong Rust và không phụ thuộc provider đang chọn.
`web_read` thử Jina Reader trước rồi fallback sang fetch thẳng + bóc HTML thành
text; `web_search` dùng DuckDuckGo HTML — cả hai không cần API key. Nguồn: kênh
`web` và `search` của [Agent-Reach](https://github.com/Panniantong/Agent-Reach).

## Công nghệ

- **Shell desktop**: Tauri 2 (Rust) + WebView2
- **Giao diện**: React 18 + TypeScript + Vite 6, Tailwind CSS, zustand, lucide-react
- **Test**: Vitest — transport được kiểm chứng bằng HTTP/SSE mock server thật trong process; phần Rust có unit test cho từng hàm thuần và **live test** gọi gateway thật

## Phát triển

```bash
npm install
npm run dev          # web-only (cần backend giả nếu thiếu)
npm run tauri dev    # app thật (Windows, WebView2)
npm test             # unit/integration tests (frontend)
npm run tauri build  # sinh installer NSIS ở src-tauri/target/release/bundle/nsis/
```

Test phía Rust (chạy trong `src-tauri/`):

```bash
cargo test --lib                        # unit test, không cần mạng
cargo test --lib -- --ignored live_free # gọi gateway thật — cần mạng, tốn quota miễn phí
```

## Cấu trúc

```
src/            frontend React (components/, lib/ transport + agent protocol, store/)
  lib/free-model.ts   transport của làn miễn phí (gọi lệnh Rust)
src-tauri/      Rust: commands IPC, child webview duck.ai, filesystem/shell tools
  src/free_model.rs   làn miễn phí: session id, vân tay client, 3 wire, dịch tool
assets/         icon các kích thước cho bundle
```

Nguồn gốc của hai lớp khả năng đã port:
[Agent-Reach](https://github.com/Panniantong/Agent-Reach) (web + search) và
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) (làn miễn phí).

## Bản đóng gói

`npm run tauri build` sinh `lvaigent_x.y.z_x64-setup.exe` (NSIS, per-user — cài vào
`%LOCALAPPDATA%\lvaigent`, không cần quyền admin; dùng `/S` để cài im lặng).
Identifier: `com.qeafivels.lvaigent`.

Trước mỗi bản build, đồng bộ version ở **ba nơi** (hay bị lệch nhau):

| File | Field |
|---|---|
| `src-tauri/tauri.conf.json` | `version` — nguồn sự thật, đặt tên file setup + metadata |
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |

Không hardcode version trong UI — Settings đọc runtime qua `getVersion()`
(`@tauri-apps/api/app`, đã có trong `core:default` ⊃ `core:app:default` ⊃ `allow-version`).

Cấu hình hiện tại: `targets: ["nsis"]` (một file duy nhất), `webviewInstallMode:
downloadBootstrapper` (setup ~3,5 MB; runtime WebView2 tải lúc cài nếu máy chưa có —
cài trên chính máy dev thì bỏ qua). Muốn setup tự chứa ~200 MB runtime thì đổi sang
`offlineInstaller`.

Kiểm chứng installer — **bằng cấu trúc và kích thước, không grep** (NSIS nén LZMA,
grep "WebView2" trong setup.exe luôn "not found" dù file đúng):

```bash
node scripts/verify-installer.mjs 0.3.0   # PE header · NSIS signature · entropy · payload delta
```

Log build giữ ở `changelog/build-exe-<ver>.log`. Bản mới nhất (0.3.0, 2026-10-18)
đã cài trên máy; bản copy để cài nhanh nằm ở `release/` — thư mục này là **artifact
build, không commit** (đã khai trong `.gitignore`).

Bản NSIS sau khi cài sẽ patch 3 byte trong `lvaigent.exe`
(`__TAURI_BUNDLE_TYPE_VAR_UNK` → `VAR_NSS`) để đánh dấu bản cài qua NSIS — nên
hash bản trong `target/release/` khác hash bản đã cài là bình thường.
