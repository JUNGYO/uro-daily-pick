import { useEffect } from "react";
import { supabase } from "./supabase";
import { checked } from "./data";

// Visible content, clipped to its scrolling ancestors. Merely mounting a hidden
// desktop/mobile pane or a below-the-fold summary is not an observation.
export function visibleContent(element) {
  if (!element || element.closest("[hidden]")) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  let top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom);
  let left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none") return null;
    if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) {
      const box = parent.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
  }
  if (bottom - top < Math.min(40, rect.height) || right <= left) return null;
  return {
    start: Math.max(0, Math.floor(((top - rect.top) / rect.height) * 20)),
    end: Math.min(19, Math.floor(((bottom - rect.top - 1) / rect.height) * 20)),
  };
}

export function observeContent({ getElement, requiresIntent = false, send }) {
  let alive = true,
    intended = !requiresIntent,
    ready = false,
    busy = false;
  let seconds = 0,
    sentSeconds = 0,
    last = Date.now(),
    activity = last,
    moved = 0;
  let nextAttempt = 0,
    visibleSince = null;
  const held = Array(20).fill(0),
    sampled = new Set();
  const write = (final = false) => {
    if ((!final && busy) || !navigator.onLine || (ready && Math.floor(seconds) === sentSeconds)) return;
    busy = true;
    const value = ready ? Math.floor(seconds) : 0;
    Promise.resolve()
      .then(() => send(value, ready ? [...sampled].sort((a, b) => a - b) : []))
      .then(() => {
        if (alive) {
          ready = true;
          sentSeconds = value;
        }
      })
      .catch(() => {}) // No navigation failure and no invented successful observation.
      .finally(() => {
        busy = false;
      });
  };
  const interaction = (event) => {
    const element = getElement();
    if (!element) return;
    // Only the content or its actual reader scroll area can establish intent.
    const reader = element.closest(".reader-scroll, [data-original-scroll]") || element;
    if (reader.contains(event.target)) {
      activity = Date.now();
      intended = true;
    }
  };
  const scroll = (event) => {
    const el = getElement();
    if (el && (event.target === document || event.target?.contains?.(el))) moved = Date.now();
  };
  const pause = () => {
    last = Date.now();
    visibleSince = null;
    if (ready) write(true);
  };
  const tick = () => {
    const now = Date.now(),
      delta = Math.max(0, Math.min(1.5, (now - last) / 1000));
    last = now;
    if (!intended || document.hidden || !document.hasFocus() || !navigator.onLine) {
      visibleSince = null;
      return;
    }
    const range = visibleContent(getElement());
    if (!range) {
      visibleSince = null;
      return;
    }
    if (visibleSince === null) visibleSince = now;
    if (!ready) {
      if (now - visibleSince >= 1000 && now >= nextAttempt) {
        nextAttempt = now + 15000;
        write();
      }
      return;
    }
    // A fast scroll, a background timer and a long idle tab cannot earn reading time.
    if (now - activity > 90000 || now - moved < 750 || seconds >= 7200) return;
    seconds = Math.min(7200, seconds + delta);
    for (let i = range.start; i <= range.end; i++) {
      held[i] += delta;
      if (held[i] >= 2) sampled.add(i);
    }
    if (seconds - sentSeconds >= 15) write();
  };
  const timer = setInterval(tick, 1000);
  for (const type of ["pointerdown", "keydown", "wheel", "touchmove"])
    document.addEventListener(type, interaction, { passive: true });
  document.addEventListener("scroll", scroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", pause);
  window.addEventListener("blur", pause);
  window.addEventListener("pagehide", pause);
  return () => {
    if (ready) write(true);
    alive = false;
    clearInterval(timer);
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove"])
      document.removeEventListener(type, interaction);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("visibilitychange", pause);
    window.removeEventListener("blur", pause);
    window.removeEventListener("pagehide", pause);
  };
}

export function useContentReading(user, pmid, kind, enabled, requiresIntent = false) {
  useEffect(() => {
    if (!enabled || !user?.id || user.offline || !/^[0-9]{1,10}$/.test(String(pmid))) return;
    const session = crypto.randomUUID();
    return observeContent({
      requiresIntent,
      getElement: () => document.querySelector(`[data-reading-pmid="${pmid}"][data-reading-kind="${kind}"]`),
      send: async (seconds, sections) => {
        const { data } = await supabase.auth.getSession();
        if (data?.session?.user?.id !== user.id) throw new Error("Reader changed");
        return checked(
          supabase.rpc("record_reader_content", {
            p_pmid: String(pmid),
            p_kind: kind,
            p_session: session,
            p_seconds: seconds,
            p_sections: sections,
          }),
        );
      },
    });
  }, [user?.id, user?.offline, pmid, kind, enabled, requiresIntent]);
}
