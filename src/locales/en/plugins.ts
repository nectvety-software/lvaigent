/**
 * English translations for Settings → Plugins.
 *
 * Keys are the exact Vietnamese source strings (vi is this app's source
 * language); {placeholder} names must match the tf() calls.
 */
const en: Record<string, string> = {
  Plugins: "Plugins",
  "Cài plugin theo định dạng marketplace của ZCode. Plugin thêm skill và lệnh /… vào agent; lvaigent chỉ đọc phần markdown, không chạy hook hay MCP server của plugin.":
    "Install plugins in ZCode's marketplace format. A plugin adds skills and /… commands to the agent; lvaigent reads only the markdown, and never runs the plugin's hooks or MCP server.",
  // Categories (marketplace.json `category` ids)
  "Công cụ dev": "Developer tools",
  "Năng suất": "Productivity",
  "Tiện ích": "Utilities",
  "Tài chính": "Finance",
  "Tài liệu hướng dẫn": "Guides",
  Khác: "Other",
  // Installed section
  "Đã cài ({n})": "Installed ({n})",
  "Chưa cài plugin nào. Chọn một plugin bên dưới rồi bấm Cài đặt.":
    "No plugins installed yet. Pick one below and press Install.",
  "{skills} skill · {commands} lệnh": "{skills} skill(s) · {commands} command(s)",
  "không chạy": "not run",
  "Gỡ plugin": "Uninstall plugin",
  "Bật plugin": "Enable plugin",
  "Skill và lệnh của plugin này đang được gửi cho agent.":
    "This plugin's skills and commands are being handed to the agent.",
  "Đang tắt — không có gì từ plugin vào prompt.":
    "Off — nothing from this plugin reaches the prompt.",
  "Markdown của plugin trở thành chỉ dẫn agent làm theo. Chỉ cài plugin bạn tin nguồn.":
    "A plugin's markdown becomes instructions the agent follows. Only install plugins you trust the source of.",
  // Catalog
  Catalog: "Catalog",
  "Làm mới catalog": "Refresh catalog",
  "Đang tải catalog…": "Loading catalog…",
  "Không tải được catalog": "Couldn't load the catalog",
  "Tìm plugin…": "Search plugins…",
  "Tất cả": "All",
  "Không có plugin nào khớp bộ lọc này.": "No plugin matches this filter.",
  "Đang bật: {skills} skill, {commands} lệnh":
    "Enabled: {skills} skill(s), {commands} command(s)",
  "làm mới lúc": "refreshed at",
  "Tác giả": "Author",
  "chỉ phát hành dạng zip": "published as a zip only",
  "Cài đặt": "Install",
  "Đang cài…": "Installing…",
  "Đã cài": "Installed",
  // Store actions (toasts)
  "Plugin không có trong catalog — làm mới danh sách rồi thử lại":
    "That plugin is not in the catalog — refresh the list and try again",
  "Đã cài {name} · {skills} skill, {commands} lệnh":
    "Installed {name} · {skills} skill(s), {commands} command(s)",
  "Plugin này còn có {kinds}, nhưng lvaigent không chạy chúng":
    "This plugin also ships {kinds}, which lvaigent does not run",
  "Cài plugin thất bại: {err}": "Plugin install failed: {err}",
  "Đã gỡ {name}": "Removed {name}",
  "Gỡ plugin thất bại: {err}": "Plugin uninstall failed: {err}",
};

export default en;
