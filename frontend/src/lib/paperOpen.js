import { useEffect } from "react";
import { supabase } from "./supabase";
import { checked } from "./data";

export function recordPaperOpen(user, pmid, kind) {
  if (
    !user?.id ||
    user.offline ||
    !navigator.onLine ||
    !/^[0-9]{1,10}$/.test(String(pmid)) ||
    !["detail", "original", "publisher"].includes(kind)
  )
    return Promise.resolve(false);
  const eventId = crypto.randomUUID();
  return checked(
    supabase.rpc("record_reader_open", {
      p_pmid: String(pmid),
      p_kind: kind,
      p_event_id: eventId,
    }),
  )
    .then(() => true)
    .catch(() => false);
}

// Link actions across all research screens, never route/mount/refresh observations.
export function usePaperOpenLinks(user) {
  useEffect(() => {
    if (!user?.id || user.offline) return;
    const onOpen = (event) => {
      if ((event.type === "click" ? event.button !== 0 : event.button !== 1) || event.detail > 1) return;
      const link = event.target.closest?.("a[href]");
      if (!link || link.hasAttribute("download") || link.getAttribute("aria-disabled") === "true") return;
      let url;
      try {
        url = new URL(link.href);
      } catch {
        return;
      }
      if (link.dataset.paperOpen === "publisher" && /^https?:$/.test(url.protocol)) {
        void recordPaperOpen(user, link.dataset.paperPmid, "publisher");
        return;
      }
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      if (url.origin !== window.location.origin || !url.pathname.startsWith(base + "/")) return;
      const match = url.pathname.slice(base.length).match(/^\/(papers|fulltext)\/([0-9]{1,10})\/?$/);
      if (match) void recordPaperOpen(user, match[2], match[1] === "fulltext" ? "original" : "detail");
    };
    document.addEventListener("click", onOpen, true);
    document.addEventListener("auxclick", onOpen, true);
    return () => {
      document.removeEventListener("click", onOpen, true);
      document.removeEventListener("auxclick", onOpen, true);
    };
  }, [user?.id, user?.offline]);
}
