import { useEffect } from "react";
import { supabase } from "./supabase";
import { checked } from "./data";
import { rpc } from "./workspace";

// Each mount owns its paper ID, position and active time; changing papers cannot mix them.
export function useReading(uid, paperId, offline, initialPosition) {
  useEffect(() => {
    if (!paperId || offline) return;
    const scroll = document.querySelector(".reader-scroll");
    if (!scroll) return;
    let position = initialPosition || 0,
      changed = false,
      timer;
    let seconds = 0,
      tick = Date.now(),
      activity = tick;
    const save = () => {
      clearTimeout(timer);
      if (!changed) return;
      changed = false;
      rpc("update_reader_state", { p_paper_id: paperId, p_patch: { position } }).catch(() => {});
    };
    const onScroll = () => {
      activity = Date.now();
      position = Math.min(
        1,
        Math.max(0, scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight)),
      );
      changed = true;
      clearTimeout(timer);
      timer = setTimeout(save, 1500);
    };
    const active = () => {
      activity = Date.now();
    };
    const interval = setInterval(() => {
      const now = Date.now();
      if (!document.hidden && now - activity < 30000) seconds += Math.min(2, (now - tick) / 1000);
      tick = now;
    }, 1000);
    const flush = () => {
      save();
      if (seconds >= 10) {
        const dwell = Math.min(300, Math.floor(seconds));
        seconds = 0;
        checked(
          supabase.from("read_history").insert({ user_id: uid, paper_id: paperId, dwell_seconds: dwell }),
        ).catch(() => {});
      }
    };
    const hidden = () => {
      if (document.hidden) flush();
      else active();
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    scroll.addEventListener("pointerdown", active, { passive: true });
    window.addEventListener("keydown", active);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      clearInterval(interval);
      clearTimeout(timer);
      scroll.removeEventListener("scroll", onScroll);
      scroll.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flush);
    };
  }, [uid, paperId, offline]);
}
