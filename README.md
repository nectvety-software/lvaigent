# lvaigent

Ứng dụng chat AI dạng agent chạy trên máy tính (Windows), đóng gói một file `.exe` duy nhất kèm trình cài đặt NSIS.

lvaigent kết nối tới nhiều nguồn model:

- **duck.ai** qua bridge WebView2 tích hợp sẵn (không cần API key) — gồm cả đường PoW/legacy và driver điều khiển trực tiếp trang SPA.
- **Provider API tùy chỉnh** theo 3 giao thức: OpenAI Chat Completions, OpenAI Responses và Anthropic Messages.

## Tính năng chính

- **Agent tự chạy tool trên project đang mở**: `list_files`, `glob`, `grep`, `read_file`, `write_file`, `run_command` — model phát tool call dạng text `<tool ... />`, app parse, thực thi trong Rust và gửi kết quả `[tool_result]` trở lại theo từng vòng.
- **Chế độ PLAN / BUILD + hệ thống quyền**: duyệt từng thay đổi (Review panel, diff, `/undo`), luật cho phép/chặn theo tool, "Full access".
- **Bộ chỉnh sửa Provider**: thêm/xóa provider, base URL, API key, custom headers, quản lý model thủ hoặc kéo từ `/models`, test kết nối bằng một request chat thật (timeout + lý do lỗi cụ thể).
- **Pane Browser** nhúng trang duck.ai như một cửa sổ con thật (native child webview, resize được như panel thường).
- **Workspace & lịch sử chat** lưu trên máy, file đính kèm (code/ảnh) hover xem trước, custom slash-commands, terminal phải song song với shell thật.

## Công nghệ

- **Shell desktop**: Tauri 2 (Rust) + WebView2
- **Giao diện**: React 18 + TypeScript + Vite 6, Tailwind CSS, zustand, lucide-react
- **Test**: Vitest — transport được kiểm chứng bằng HTTP/SSE mock server thật trong process

## Phát triển

```bash
npm install
npm run dev          # web-only (cần backend giả nếu thiếu)
npm run tauri dev    # app thật (Windows, WebView2)
npm test             # unit/integration tests
npm run tauri build  # sinh installer NSIS ở src-tauri/target/release/bundle/nsis/
```

## Cấu trúc

```
src/            frontend React (components/, lib/ transport + agent protocol, store/)
src-tauri/      Rust: commands IPC, child webview duck.ai, filesystem/shell tools
assets/         icon các kích thước cho bundle
```

## Bản đóng gói

`npm run tauri build` sinh `lvaigent_x.y.z_x64-setup.exe` (NSIS, per-user). Identifier: `com.qeafivels.lvaigent`.
