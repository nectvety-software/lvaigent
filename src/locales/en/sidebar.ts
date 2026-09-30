/**
 * English translations for the sidebar shell: App frame, Sidebar, TitleBar,
 * WorkspaceSwitcher, WorkspaceManager, CommandsManager, SkillsPromptSection.
 * Keys are the exact Vietnamese source strings; {placeholders} are preserved.
 */
const en: Record<string, string> = {
  // App shell
  "Kéo để thay đổi độ rộng sidebar": "Drag to resize the sidebar",

  // TitleBar
  "Ẩn sidebar": "Hide sidebar",
  "Hiện sidebar": "Show sidebar",
  "Ẩn trình duyệt lvaigent": "Hide lvaigent browser",
  "Hiện trình duyệt lvaigent cạnh khu vực AI Agents": "Show the lvaigent browser next to the AI Agents area",
  "Ẩn side pane": "Hide side pane",
  "Hiện side pane": "Show side pane",

  // Sidebar — panel
  "Chat mới": "New chat",
  "Mở project": "Open project",
  "{files} files · {dirs} thư mục": "{files} files · {dirs} folders",
  "Đóng project": "Close project",
  "Dự án gần đây": "Recent projects",
  "Lịch sử chat": "Chat history",
  "Đang hiện session của mọi workspace — bấm để chỉ hiện workspace đang chọn":
    "Showing sessions from all workspaces — click to show only the current workspace",
  "Đang chỉ hiện session của workspace đang chọn — bấm để hiện tất cả":
    "Showing only the current workspace's sessions — click to show all",
  "Tất cả workspace": "All workspaces",
  "Chưa có workspace": "No workspace yet",
  "lọc": "filter",
  "tất cả": "all",
  "Tìm trong lịch sử…": "Search history…",
  "Không tìm thấy hội thoại nào": "No conversations found",
  "Chưa có hội thoại nào": "No conversations yet",
  "Workspace này chưa có session nào": "This workspace has no sessions yet",
  "Chưa có session nào ngoài workspace": "No sessions outside a workspace",

  // Sidebar — workspace rail & context menu
  "(đã ghim)": "(pinned)",
  "Thêm dự án — quản lý workspace & sessions": "Add project — manage workspaces & sessions",
  "New Space — chọn thư mục gốc": "New Space — select the root folder",
  "Mở vị trí thư mục dự án": "Open project folder location",
  "Đã copy": "Copied",
  "Copy đường dẫn": "Copy path",
  "Bỏ ghim": "Unpin",
  "Ghim lên đầu rail": "Pin to top of rail",
  "Bỏ khỏi danh sách": "Remove from list",

  // WorkspaceSwitcher
  "Chuyển nhanh giữa các workspace": "Quickly switch between workspaces",
  "Chưa có workspace nào — mở một project để bắt đầu.": "No workspaces yet — open a project to get started.",
  "Quản lý workspace & sessions…": "Manage workspaces & sessions…",
  "Thêm dự án…": "Add project…",

  // WorkspaceManager
  "Thêm dự án": "Add project",
  "workspace & sessions": "workspace & sessions",
  "Mở thư mục dự án": "Open project folder",
  "Không mở được project: {err}": "Couldn't open project: {err}",
  "Chưa có dự án nào gần đây.": "No recent projects.",
  "Mở một thư mục để bắt đầu làm việc.": "Open a folder to start working.",
  "đang mở": "open",
  "Mở workspace này": "Open this workspace",
  "Mở vị trí thư mục": "Open folder location",
  "Đổi tên (Rename)": "Rename",
  "Chưa có session nào.": "No sessions yet.",
  "(không gắn với project)": "(not linked to a project)",
  "mở project hiện tại": "open current project",
  "{n} tin · {when}": "{n} msgs · {when}",
  "Xóa session": "Delete session",

  // CommandsManager
  "Frontmatter lỗi — chưa thể lưu": "Invalid frontmatter — can't save yet",
  "Cảnh báo frontmatter": "Frontmatter warnings",
  "Dòng {line}: ": "Line {line}: ",
  "$ARGUMENTS = args sau lệnh · $1, $2… = từng từ":
    "$ARGUMENTS = args after the command · $1, $2… = individual words",
  "Hủy": "Cancel",
  "Lưu": "Save",
  "Đã lưu /{name}": "Saved /{name}",
  "Không lưu được lệnh: {err}": "Couldn't save command: {err}",
  "Đã xóa /{name}": "Deleted /{name}",
  "Không xóa được: {err}": "Couldn't delete: {err}",
  "Đọc lại từ đĩa": "Reload from disk",
  "Mở một project để quản lý custom commands.": "Open a project to manage custom commands.",
  "Tạo lệnh mới": "Create new command",
  "Chưa có custom command nào trong project này.": "No custom commands in this project yet.",
  "Tạo file ": "Create a ",
  "hoặc bấm \"{btn}\".": "or click \"{btn}\".",
  "Sửa": "Edit",
  "Xóa file": "Delete file",

  // SkillsPromptSection
  "Chọn file Skills & Prompt (.md)": "Select Skills & Prompt files (.md)",
  "File .md rỗng — không có block nào để import": "Empty .md file — no blocks to import",
  "Đã import {n} block từ {files} file .md": "Imported {n} blocks from {files} .md files",
  "Import thất bại: {err}": "Import failed: {err}",
  "Skills & Prompt": "Skills & Prompt",
  "Chọn agent được dùng công cụ nào và phần nào của prompt được gửi đi. Tắt một skill sẽ bỏ nó khỏi prompt":
    "Choose which tools the agent can use and which prompt sections are sent. Disabling a skill removes it from the prompt",
  "và": "and",
  "chặn thực thi — model có tự phát lệnh cũng bị từ chối.":
    "blocks execution — commands emitted by the model are rejected too.",
  "Skills ({on} / {total})": "Skills ({on} / {total})",
  "Bật tất cả": "Enable all",
  "Tắt tất cả": "Disable all",
  "write_file và run_command có thể thay đổi project hoặc chạy lệnh trên máy.":
    "write_file and run_command can modify your project or run commands on your machine.",
  "Prompt ({on} / {total})": "Prompt ({on} / {total})",
  "Tắt": "Disabling",
  "sẽ khiến agent không còn cú pháp tool — nó chỉ trả lời như chat thường.":
    "will leave the agent without tool syntax — it will just answer like a regular chat.",
  "Import từ .md ({on} / {total})": "Imported from .md ({on} / {total})",
  "Đang đọc file…": "Reading files…",
  "Chưa import file nào. Chọn một file": "No files imported yet. Pick a",
  ", mỗi block": " file, each",
  "sẽ thành một phần của system prompt.": "block becomes part of the system prompt.",
  "Bỏ file này": "Remove this file",
  " (đã cắt còn {max} ký tự)": " (truncated to {max} chars)",
  "Import lại cùng một file sẽ thay thế các block cũ của file đó. Nội dung được lưu trong Settings.":
    "Re-importing a file replaces its previous blocks. Content is stored in Settings.",
};

export default en;
