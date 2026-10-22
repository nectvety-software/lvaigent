/**
 * English translations for the Settings surface.
 *
 * Keys are the exact Vietnamese source strings used in the components
 * (SettingsDialog, AddProviderDialog, PathDirsSettings, PermissionRules);
 * `{placeholders}` are preserved verbatim in the English value.
 */
const en: Record<string, string> = {
  // SettingsDialog — time formatting (formatAge / ago)
  "vừa xong": "just now",
  "{n} giây": "{n} seconds",
  "{n} phút": "{n} minutes",
  "{n} giờ": "{n} hours",
  "{age} trước": "{age} ago",

  // SettingsDialog — bridge status
  "chưa sẵn sàng": "not ready",
  "sẵn sàng (CDP)": "ready (CDP)",
  "đang chờ Browser": "waiting for Browser",
  "chưa nhận được": "not received yet",
  "chưa giải": "not solved yet",
  "Quét gần nhất": "Last scan",
  "chưa quét": "not scanned yet",
  "chưa chạy": "not running yet",
  "đang chạy": "running",
  "dừng": "stopped",
  "⚠ Captcha đang hiển thị trên Browser": "⚠ Captcha showing in the Browser",
  "↻ Sẽ tự gửi lại tin nhắn sau khi giải captcha":
    "↻ The message will be resent automatically once the captcha is solved",
  "Cookie đã nhận từ Browser": "Cookies received from Browser",
  "Lần quét gần nhất:": "Last scan:",

  // SettingsDialog — connection / model fetch results (toasts + errors)
  "đang kiểm thử…": "testing…",
  "provider không có model nào để kiểm thử": "provider has no model to test",
  "{name}: API kiểm thử đạt ({ms}ms)": "{name}: API test passed ({ms}ms)",
  "{name}: API kiểm thử lỗi": "{name}: API test failed",
  "danh sách model rỗng": "the model list is empty",
  "Đã lấy {n} model từ {name}": "Fetched {n} models from {name}",
  "Đã quét lại từ Browser (cookie + PoW)": "Rescanned from Browser (cookie + PoW)",
  "Đã nhận cookie lvaigent (PoW chưa xong — sẽ tự thử lại)":
    "Received the lvaigent cookie (PoW not done yet — will retry automatically)",
  "Đã giải PoW mới (chưa lấy được cookie — Browser chưa sẵn sàng)":
    "Solved a new PoW (couldn't get the cookie — Browser not ready yet)",
  "Chưa quét được — Browser chưa sẵn sàng": "Scan failed — Browser not ready yet",

  // SettingsDialog — general tab
  "Ngôn ngữ": "Language",
  "Cấp cho agent toàn quyền dùng mọi tool — kể cả ghi file và chạy lệnh — không hỏi lại. Các tool bị chặn ở mục 'Luật cấp quyền' bên dưới vẫn bị chặn.":
    "Grant the agent full access to every tool — including writing files and running commands — without asking again. Tools blocked in the 'Permission rules' section below stay blocked.",
  "Luật cấp quyền": "Permission rules",
  "Rule đặt trong hộp thoại cấp quyền. \"Luôn chặn\" thắng \"Full access\".":
    "Rules are set in the permission dialog. \"Always block\" overrides \"Full access\".",

  // SettingsDialog — providers tab
  "Chọn provider dùng để chat. Provider API (OpenAI, Anthropic, OpenRouter, Groq, Ollama...) gọi trực tiếp chuẩn REST — ổn định hơn bridge Duckai.":
    "Pick a provider to use for chatting. API providers (OpenAI, Anthropic, OpenRouter, Groq, Ollama...) call the REST API directly — more stable than the Duckai bridge.",
  "Đang dùng": "In use",
  "Dùng provider này": "Use this provider",
  "bridge tích hợp trong app": "built-in app bridge",
  "miễn phí — không cần API key, không cần đăng nhập":
    "free — no API key, no sign-up",
  "Đã xóa {name}": "Deleted {name}",
  "Xóa provider": "Delete provider",
  "Lấy models": "Fetch models",
  "Gửi một request chat thật qua API để kiểm tra key/model/protocol":
    "Send a real chat request through the API to check the key/model/protocol",
  "Đang bật": "On",
  "Đang tắt": "Off",
  "Xóa model": "Delete model",
  "Thêm model id thủ công (vd: gpt-4o-mini)": "Manually add a model id (e.g. gpt-4o-mini)",
  "Thêm model": "Add model",
  "Headers tùy chỉnh": "Custom headers",
  "Xóa header": "Delete header",
  "giá trị": "value",
  "Thêm header": "Add header",
  "Thêm provider": "Add provider",
  "Đã thêm {name}": "Added {name}",
  "Thêm provider tùy chỉnh…": "Add custom provider…",
  "Đã thêm provider {name}": "Added provider {name}",
  "Duckai nâng cao (PoW, bridge, cookies — tự quét từ Browser)":
    "Advanced Duckai (PoW, bridge, cookies — auto-scanned from Browser)",
  "Đang quét Browser…": "Scanning Browser…",
  "Tự quét từ Browser": "Auto-scan from Browser",
  "Đang quét…": "Scanning…",
  "Quét lại ngay": "Rescan now",

  // AddProviderDialog
  "Đóng": "Close",
  "Custom (tùy chỉnh)": "Custom",
  "Tên provider (vd: MiniMax CN)": "Provider name (e.g. MiniMax CN)",
  "Ẩn key": "Hide key",
  "Hiện key": "Show key",
  "Xóa dòng": "Delete row",

  // PathDirsSettings
  "Chọn thư mục thêm vào PATH của agent": "Choose folders to add to the agent's PATH",
  "Đường dẫn PATH bổ sung": "Additional PATH directories",
  "Thêm thư mục": "Add folder",
  "Agent tìm lệnh trong các thư mục này trước, rồi mới đến PATH của hệ thống. Thêm thư mục chứa":
    "The agent looks for commands in these folders first, then falls back to the system PATH. Add a folder containing",
  ", emulator hoặc bộ build của bạn nếu chúng nằm ngoài PATH.":
    ", your emulator, or your build if they're not on the PATH.",
  "{path} — thư mục không tồn tại": "{path} — folder doesn't exist",
  "Bỏ {path}": "Remove {path}",
  "Shell của agent đang tìm lệnh trong {n} thư mục":
    "The agent's shell looks for commands in {n} folders",
  "· {n} thư mục ghim không tồn tại": "· {n} pinned folders don't exist",

  // PermissionRules
  "Chưa có luật nào. Chọn \"Luôn cho phép\" hoặc \"Luôn chặn\" trong hộp thoại cấp quyền.":
    "No rules yet. Choose \"Always allow\" or \"Always block\" in the permission dialog.",
  "luôn chặn": "always block",
  "luôn cho phép": "always allow",
  "Bỏ luật {tool}": "Remove {tool} rule",
};

export default en;
