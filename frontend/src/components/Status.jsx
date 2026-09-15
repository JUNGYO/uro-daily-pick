import { Loader2 } from "lucide-react";

export function Loading({ text = "Loading…" }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 p-10 min-h-[180px] text-text3">
      <Loader2 className="animate-spin" size={22} />
      {text}
    </div>
  );
}

export function ErrorNotice({ message, onRetry, retryLabel = "Try again" }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 my-4 text-sm text-red-800">
      <p>{message}</p>
      {onRetry && (
        <button className="mt-3 font-semibold underline" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
