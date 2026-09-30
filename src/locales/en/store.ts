/**
 * English translations for user-facing toast messages dispatched from
 * src/store/index.ts. Keys are the exact Vietnamese source strings;
 * {placeholder} tokens must match the tf() calls in the store.
 */
const en: Record<string, string> = {
  "{count} custom command(s) từ .duckchat/commands":
    "Loaded {count} custom command(s) from .duckchat/commands",
  "Không mở được project: {message}": "Could not open project: {message}",
  "Không đọc được {name}: {error}": "Could not read {name}: {error}",
  "Đã đính kèm {count} ảnh — model chỉ nhận đường dẫn, không nhận nội dung ảnh":
    "Attached {count} image(s) — the model only receives file paths, not image content",
  "Chỉ đính kèm được tối đa {max} mục": "You can attach at most {max} items",
  "Không mở được thư mục {name}: {error}": "Could not open folder {name}: {error}",
  "Đã đính kèm thư mục {name} · {total} tệp (nạp nội dung {loaded} tệp văn bản)":
    "Attached folder {name} · {total} files (loaded content of {loaded} text files)",
  "Không có thay đổi nào để hoàn tác": "Nothing to undo",
  "Không tìm thấy project — không thể hoàn tác": "Project not found — cannot undo",
  "Đã hoàn tác {count} file": "Reverted {count} files",
  "Undo thất bại: {error}": "Undo failed: {error}",
  "Không có thay đổi nào để làm lại": "Nothing to redo",
  "Không tìm thấy project — không thể làm lại": "Project not found — cannot redo",
  "Đã làm lại {count} file": "Re-applied {count} files",
  "Redo thất bại: {error}": "Redo failed: {error}",
  "Mở một project trước khi chạy /init": "Open a project before running /init",
  "Chưa có thay đổi nào để xem": "No changes to review yet",
  "Phân tích codebase và tạo AGENTS.md ở thư mục gốc project":
    "Analyze the codebase and create AGENTS.md at the project root",
  "Hoàn tác thay đổi file của lượt agent gần nhất":
    "Undo the file changes of the latest agent turn",
  "Làm lại thay đổi vừa hoàn tác": "Redo the changes just undone",
  "Dừng phản hồi đang chạy": "Stop the running response",
  "Bắt đầu chat mới": "Start a new chat",
  "Xem diff các file agent đã sửa ở lượt gần nhất":
    "Review the diff of files the agent edited in the latest turn",
  // duck.ai transport failures — shown as the assistant message body
  "⚠️ duck.ai từ chối phiên xác thực (418). Bản gửi trực tiếp (PoW) đã bị anti-bot chặn — mở cửa sổ bridge lvaigent, giải captcha nếu hiện ra, rồi gửi lại tin nhắn.":
    "⚠️ duck.ai rejected the auth session (418). The direct PoW send is blocked by its anti-bot — open the lvaigent bridge window, solve the captcha if one appears, then send the message again.",
  "⚠️ Bridge lvaigent chưa sẵn sàng, mà duck.ai thì từ chối gửi trực tiếp (418). Đã mở cửa sổ bridge — giải captcha nếu nó hiện ra; tin nhắn được giữ lại và sẽ tự gửi lại khi bridge trả lời.":
    "⚠️ The lvaigent bridge isn't ready, and duck.ai refuses direct sends (418). The bridge window is open now — solve the captcha if it shows one; this message is kept and will be sent again automatically once the bridge answers.",
  "⚠️ duck.ai báo yêu cầu không hợp lệ (400): model hoặc định dạng tin nhắn đã đổi phía server. Thử model khác, hoặc dùng bridge lvaigent.":
    "⚠️ duck.ai reported an invalid request (400): the model or message format changed server-side. Try another model, or use the lvaigent bridge.",
  "⚠️ Nội dung gửi quá dài so với giới hạn của duck.ai — thu gọn ngữ cảnh rồi thử lại.":
    "⚠️ The payload is longer than duck.ai's input limit — trim the context and try again.",
  "❌ Tin nhắn này quá dài để gửi sang lvaigent: giới hạn là {limit} ký tự mỗi lượt, mà chỉ dẫn agent cùng tin nhắn của bạn đã chiếm {used}. lvaigent chưa gửi gì cả — hãy rút gọn yêu cầu hoặc bớt file đính kèm.":
    "❌ This message is too long for lvaigent: the limit is {limit} characters per turn, and the agent instructions plus your message already take {used}. Nothing was sent — shorten the request or drop some attachments.",
  "⚠️ lvaigent đang giới hạn tốc độ (429). Chờ 30–60 giây rồi thử lại.":
    "⚠️ lvaigent is rate-limited (429). Wait 30–60 seconds and try again.",
};

export default en;
