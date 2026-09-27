import { CheckCircle, XCircle, Info, X } from "lucide-react";
import { useStore } from "../store";

export default function Toast() {
  const { toasts, removeToast } = useStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="flex items-center gap-2 px-3 h-9 rounded-2xl bg-toast border border-popover-border shadow-lg animate-slide-up text-ui-base"
        >
          {toast.type === "success" && (
            <CheckCircle className="size-3.5 text-success shrink-0" />
          )}
          {toast.type === "error" && (
            <XCircle className="size-3.5 text-destructive shrink-0" />
          )}
          {toast.type === "info" && (
            <Info className="size-3.5 text-foreground-subtle shrink-0" />
          )}
          <span className="text-foreground">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="flex items-center justify-center size-6 rounded-md hover:bg-hover text-foreground-subtlest hover:text-foreground transition-colors ml-1"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
