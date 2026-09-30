const en: Record<string, string> = {
  // ChatView — empty-state suggestions
  "Giải thích luồng của đoạn code này": "Explain how this code works",
  "Tìm và sửa lỗi trong project": "Find and fix bugs in the project",
  "Thêm một tính năng nhỏ": "Add a small feature",
  "Viết test cho module chính": "Write tests for the main module",
  // ChatView — slash commands
  "Lệnh không rõ: {name} — /init /undo /redo /stop /clear":
    "Unknown command: {name} — /init /undo /redo /stop /clear",
  // ChatView — project banner
  'Đang mở project "{path}"…': 'Opening project "{path}"…',
  "Đang mở project…": "Opening project…",
  'Không mở được project{path}: {error}. Kiểm tra thư mục còn tồn tại không.':
    'Couldn\'t open project{path}: {error}. Check that the folder still exists.',
  "lỗi không rõ": "unknown error",
  "Chưa mở project — agent không đọc/sửa được file. Hãy mở project trước khi yêu cầu chỉnh sửa code.":
    "No project open — the agent can't read or edit files. Open a project before asking for code changes.",
  "Thử lại": "Retry",
  "Mở project": "Open project",
  "Mở Project": "Open Project",
  "Không mở được project: {error}": "Couldn't open project: {error}",
  // ChatView — welcome / empty state
  "Đang làm việc trong “{name}”.": "Working in “{name}”.",
  "Trợ lý code chạy trên lvaigent. Mở một project để bắt đầu.":
    "A coding assistant running on lvaigent. Open a project to get started.",
  "Xem thay đổi của agent": "Review the agent's changes",
  "cắt": "truncated",
  // ChatView — composer
  "Hỏi về project này… (Shift+Enter xuống dòng)":
    "Ask about this project… (Shift+Enter for a new line)",
  "Nhập câu hỏi… (Shift+Enter xuống dòng)": "Ask a question… (Shift+Enter for a new line)",
  "Chưa có model — mở Settings → Providers để lấy model.":
    "No models yet — open Settings → Providers to add one.",
  // ChatView — run menu (mode + full access)
  "Chế độ chạy & quyền của agent": "Agent run mode & permissions",
  "Chế độ": "Mode",
  "Tab để đổi nhanh": "Tab to toggle",
  "Agent đọc và sửa file trong project.": "The agent reads and edits files in the project.",
  "Chỉ đọc và đề xuất kế hoạch, không sửa file.": "Read-only: proposes a plan, never edits files.",
  "Cho agent chạy lệnh và sửa file không hỏi lại.":
    "Let the agent run commands and edit files without asking.",
  // ChatView — attachment picker
  "Đính kèm ảnh, tệp hoặc thư mục": "Attach images, files, or folders",
  "Nhập từ máy": "Import from computer",
  "Chọn một hay nhiều ảnh": "Choose one or more images",
  "Ảnh…": "Images…",
  "Chọn một hay nhiều tệp văn bản/bất kỳ": "Choose one or more text or any files",
  "Tệp…": "Files…",
  "Chọn cả thư mục: cây tệp + nội dung các tệp văn bản":
    "Choose whole folders: file tree + text file contents",
  "Thư mục…": "Folders…",
  "Chọn thư mục để đính kèm": "Choose folders to attach",
  "Chọn ảnh để đính kèm": "Choose images to attach",
  "Chọn tệp để đính kèm": "Choose files to attach",
  "Ảnh": "Images",
  "Tệp trong {name}": "Files in {name}",
  "Không có file": "No files",
  "Không nhập được tệp: {error}": "Couldn't import files: {error}",
  // ChatView — send/stop + footer
  "Dừng phản hồi": "Stop response",
  "Agent đang chạy": "Agent is running",
  "Dừng": "Stop",
  "lvaigent — agent tự xác minh mọi thay đổi trước khi hoàn tất":
    "lvaigent — the agent verifies every change before finishing",
  // MessageBubble — inline diff badge
  "Thu gọn diff": "Collapse diff",
  // MessageBubble — agent run status (ZCode v3.14.3-style)
  "LIVE · bước {done}/{total} · đang chạy {tool}":
    "LIVE · step {done}/{total} · running {tool}",
  "{total} bước đã hoàn tất": "{total} steps completed",
  "Xem tất cả {n} bước": "Show all {n} steps",
  "Thu gọn": "Collapse",
  "Xem diff ngay tại đây": "View the diff right here",
  "Mở review panel": "Open review panel",
  "Đang đọc diff…": "Reading diff…",
  "File nhị phân — không hiển thị diff.": "Binary file — diff not shown.",
  "Không đọc được diff Git của file này.": "Couldn't read this file's Git diff.",
  // MessageBubble — status chips
  "Đang suy nghĩ": "Thinking",
  "PLAN — chỉ đề xuất, không sửa file": "PLAN — suggestions only, no file edits",
  "Đã dừng bởi người dùng": "Stopped by user",
  // HoverPreview — attachment chips
  "tệp": "file",
  "ảnh": "image",
  "thư mục": "folder",
  "Không đọc được nội dung": "Couldn't read content",
  "Không xem trước được (quá lớn hoặc sai định dạng)":
    "No preview available (too large or wrong format)",
  "Thư mục rỗng": "Empty folder",
  "Đang tải…": "Loading…",
  // RightPanel — side pane
  "Kéo để thay đổi độ rộng panel": "Drag to resize the panel",
  "Xóa terminal": "Clear terminal",
  "Đóng side pane": "Close side pane",
  "Đã copy": "Copied",
  "Terminal trống. Gõ một lệnh bên dưới.": "Terminal is empty. Type a command below.",
  "Lệnh trong project…": "Command in project…",
  "Lệnh…": "Command…",
  "Nhật ký hoạt động của agent (lệnh agent chạy sẽ hiện ở cả Terminal).":
    "Agent activity log (commands the agent runs also appear in Terminal).",
  // BrowserPane
  "Kéo để thay đổi độ rộng Browser": "Drag to resize the browser",
  "Đóng Browser": "Close browser",
  // DiffRows
  "{count} dòng không đổi": "{count} unchanged lines",
  // Toast
  "Đóng thông báo": "Dismiss notification",
};

export default en;
