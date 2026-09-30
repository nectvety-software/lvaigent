const en: Record<string, string> = {
  // ReviewPanel — diff markers & timeline
  "{count} dòng không đổi": "{count} unchanged lines",
  "Dòng này được thêm ở lượt {turn}": "This line was added in turn {turn}",
  "Bấm để quay lại diff tổng hợp": "Click to return to the combined diff",
  "Xem diff riêng của lượt này": "View this turn's diff only",
  "lượt {turn}": "turn {turn}",
  "không đổi": "unchanged",
  "đang xem · bấm để thoát": "viewing · click to exit",
  // ReviewPanel — per-file diff blocks
  "Lượt {turn} — riêng lượt này": "Turn {turn} — this turn only",
  "Tổng hợp cả phiên": "Whole-session summary",
  "Lượt {turn}": "Turn {turn}",
  "Số lượt agent đã sửa file này trong phiên":
    "Times the agent edited this file in the session",
  "{count} lượt": "{count} turn(s)",
  "chỉ hiển thị thay đổi của lượt được chọn":
    "showing only the selected turn's changes",
  "File nhị phân — không hiển thị diff.": "Binary file — diff not shown.",
  // ReviewPanel — Git stage & commit block
  "Git staging lỗi: {error}": "Git staging error: {error}",
  "Không gợi ý được: {error}": "Couldn't suggest a message: {error}",
  "Đã commit thay đổi staged": "Committed the staged changes",
  "Commit thất bại: {error}": "Commit failed: {error}",
  "Đang đọc git status…": "Reading git status…",
  "Git: working tree sạch — không có gì để stage/commit.":
    "Git: working tree clean — nothing to stage/commit.",
  "Stage tất cả": "Stage all",
  "Unstage tất cả": "Unstage all",
  "Đọc lại git status": "Reload git status",
  "Gợi ý message từ thay đổi": "Suggest a message from the changes",
  // ReviewPanel — header, scope/source switchers, empty states
  "Thay đổi của agent": "Agent changes",
  "{count} file": "{count} file(s)",
  "Chỉ lượt gửi gần nhất của agent": "The agent's latest send only",
  "Lượt này": "This turn",
  "Tác nhân đã thay đổi tệp — mọi file agent đã sửa trong phiên này":
    "Agent file changes — every file the agent edited in this session",
  "Cả phiên": "Whole session",
  "So với Git (trạng thái hiện tại của repo)":
    "Compare with Git (current repo state)",
  "So với snapshot trong bộ nhớ (trước/sau lượt agent)":
    "Compare with in-memory snapshot (before/after the agent's turn)",
  "Đọc lại Git diff và custom commands": "Reload Git diff and custom commands",
  "Undo chỉ dùng cho phạm vi \"Lượt này\"":
    "Undo only applies to the \"This turn\" scope",
  "Hoàn tác toàn bộ thay đổi này (/undo)": "Revert all of these changes (/undo)",
  "Đang đọc diff…": "Reading diff…",
  "Tác nhân chưa thay đổi tệp nào trong phiên này.":
    "The agent hasn't changed any files in this session.",
  "Chưa có thay đổi nào ở lượt gần nhất.": "No changes in the latest turn.",
  // PermissionPrompt — approval options
  "Chạy lần này": "Run this once",
  "Cho phép chạy lệnh này một lần.": "Allow this command to run once.",
  "Luôn cho phép": "Always allow",
  "Cho phép tool này mọi lần sau, không hỏi lại nữa.":
    "Allow this tool every time from now on, without asking again.",
  "Full access": "Full access",
  "Cấp cho agent toàn quyền, không hỏi lại nữa.":
    "Grant the agent full access without asking again.",
  "Từ chối": "Deny",
  "Không chạy lệnh này.": "Don't run this command.",
  "Luôn chặn": "Always block",
  "Chặn tool này vĩnh viễn, kể cả khi đang bật Full access.":
    "Permanently block this tool, even when Full access is on.",
  // PermissionPrompt — dialog copy
  "{path} — sẽ ghi đè toàn bộ file ({count} ký tự)":
    "{path} — will overwrite the entire file ({count} characters)",
  "Cần cấp quyền": "Permission required",
  "Agent muốn dùng": "The agent wants to use",
  "trong project của bạn:": "in your project:",
  "Tuỳ chọn cấp quyền": "Permission options",
  "Dùng ↑ / ↓ để chọn, Enter để xác nhận, Esc để từ chối.":
    "Use ↑ / ↓ to select, Enter to confirm, Esc to deny.",
};

export default en;
