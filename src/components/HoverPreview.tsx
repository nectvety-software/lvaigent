import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AttachmentKind } from "../types";
import { t, useLang } from "../lib/i18n";
import { PREVIEW_CHARS, previewDataUrl, previewText, textExcerpt } from "../lib/attachment-preview";

/** Raw Vietnamese keys; resolved through the dictionary at render time. */
const KIND_LABEL: Record<AttachmentKind, string> = {
  file: "tệp",
  image: "ảnh",
  folder: "thư mục",
};

const EMPTY_HINT: Record<AttachmentKind, string> = {
  file: "Không đọc được nội dung",
  image: "Không xem trước được (quá lớn hoặc sai định dạng)",
  folder: "Thư mục rỗng",
};

/**
 * Wraps an attachment chip and reveals a thumbnail (images) or a text/listing
 * excerpt (files, folders) on hover.
 *
 * Deliberately hover-only and `pointer-events-none`: it must never cover the
 * chip's own remove button or steal focus while composing.
 */
export default function HoverPreview({
  name,
  path,
  kind,
  content,
  placement = "above",
  children,
}: {
  name: string;
  path: string;
  kind: AttachmentKind;
  /** Already-loaded text, so a composer chip costs no extra read. */
  content?: string;
  placement?: "above" | "below";
  children: ReactNode;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 180);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState("loading");
    if (kind === "image") {
      void previewDataUrl(path).then((url) => {
        if (!alive) return;
        setDataUrl(url);
        setState(url ? "ready" : "empty");
      });
      return () => {
        alive = false;
      };
    }
    const known = content !== undefined && content.trim() !== "";
    void (
      known
        ? Promise.resolve(textExcerpt(content, PREVIEW_CHARS))
        : previewText(path, kind)
    ).then((body) => {
      if (!alive) return;
      setText(body);
      setState(body ? "ready" : "empty");
    });
    return () => {
      alive = false;
    };
  }, [open, kind, path, content]);

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open && (
        <div
          className={`pointer-events-none absolute left-0 z-50 w-72 rounded-xl border border-border bg-surface p-2 shadow-lg animate-fade-in ${
            placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
        >
          <div className="flex items-baseline justify-between gap-2 px-0.5 pb-1.5">
            <span className="text-ui-xs font-medium text-foreground truncate">
              {name}
            </span>
            <span className="text-ui-xs text-foreground-subtlest shrink-0">
              {t(KIND_LABEL[kind])}
            </span>
          </div>

          {state === "loading" && (
            <div className="h-14 grid place-items-center text-ui-xs text-foreground-subtlest">
              {t("Đang tải…")}
            </div>
          )}

          {state === "empty" && (
            <div className="h-14 grid place-items-center px-2 text-center text-ui-xs text-foreground-subtlest">
              {t(EMPTY_HINT[kind])}
            </div>
          )}

          {state === "ready" && kind === "image" && dataUrl && (
            <img
              src={dataUrl}
              alt={name}
              className="max-h-48 w-full rounded-lg bg-background object-contain"
            />
          )}

          {state === "ready" && kind !== "image" && text && (
            <pre className="max-h-44 overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-background px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-foreground-subtle">
              {text}
            </pre>
          )}

          <div className="mt-1.5 px-0.5 text-[10px] leading-tight text-foreground-subtlest break-all">
            {path}
          </div>
        </div>
      )}
    </span>
  );
}
