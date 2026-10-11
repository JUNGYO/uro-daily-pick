import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { checked, withTimeout } from "./data";

export function useMembershipCount(user) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    setCount(null);
    if (user?.offline || user?.email?.trim().toLowerCase() !== "crazyslime@gmail.com") return;
    let active = true,
      busy = false;
    const refresh = async () => {
      if (!active || busy || document.hidden || !navigator.onLine) return;
      busy = true;
      try {
        const value = await withTimeout(checked(supabase.rpc("admin_membership_count")));
        if (active) setCount(Number.isInteger(value) ? value : null);
      } catch {
        if (active) setCount(null);
      } finally {
        busy = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("uro-membership-reviewed", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("uro-membership-reviewed", refresh);
    };
  }, [user?.id, user?.email, user?.offline]);
  return count;
}
