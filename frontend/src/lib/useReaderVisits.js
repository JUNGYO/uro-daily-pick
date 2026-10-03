import { useEffect } from "react";
import { supabase } from "./supabase";
import { checked } from "./data";

// A restored session is a visit too. Background refreshes and idle timers are not.
export function useReaderVisits(user) {
  useEffect(() => {
    if (!user?.id || user.offline) return;
    let busy = false;
    let nextAttempt = 0;
    const visit = () => {
      if (document.hidden || !navigator.onLine || busy || Date.now() < nextAttempt) return;
      busy = true;
      nextAttempt = Date.now() + 60000;
      checked(supabase.rpc("record_reader_visit"))
        .catch(() => { nextAttempt = Date.now() + 15000; })
        .finally(() => { busy = false; });
    };
    visit();
    document.addEventListener("visibilitychange", visit);
    window.addEventListener("online", visit);
    window.addEventListener("focus", visit);
    window.addEventListener("pointerdown", visit, { passive: true });
    window.addEventListener("keydown", visit);
    window.addEventListener("scroll", visit, { passive: true, capture: true });
    return () => {
      document.removeEventListener("visibilitychange", visit);
      window.removeEventListener("online", visit);
      window.removeEventListener("focus", visit);
      window.removeEventListener("pointerdown", visit);
      window.removeEventListener("keydown", visit);
      window.removeEventListener("scroll", visit, { capture: true });
    };
  }, [user?.id, user?.offline]);
}
