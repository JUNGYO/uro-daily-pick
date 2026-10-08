import { useCallback, useEffect, useRef, useState } from "react";

// Refresh visible knowledge without unmounting its graph or reading pane.
// A new filter/account owns a new request generation; late replies are ignored.
export function useRefreshingResource(load, deps, pollMs = 30000) {
  const [state, setState] = useState({
    data: null,
    loading: true,
    refreshing: false,
    error: "",
    refreshError: "",
    checkedAt: null,
  });
  const refresh = useRef(null);
  const reload = useCallback(() => refresh.current?.(), []);

  useEffect(() => {
    let active = true;
    let pending = false;
    let hasData = false;
    let timer;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = () => {
      clearTimeout(timer);
      if (active && visible()) timer = setTimeout(request, pollMs);
    };
    const request = async () => {
      if (!active || pending || !visible()) return;
      clearTimeout(timer);
      pending = true;
      setState((old) => ({ ...old, loading: !hasData, refreshing: true }));
      try {
        const data = await load();
        if (!active) return;
        hasData = true;
        setState({
          data,
          loading: false,
          refreshing: false,
          error: "",
          refreshError: "",
          checkedAt: new Date(),
        });
      } catch (error) {
        if (!active) return;
        const denied = ["401", "403", "42501", "PGRST301", "PGRST302"].includes(
          String(error?.code || error?.status),
        );
        const message = error?.message || "Unable to refresh knowledge.";
        if (hasData && !denied) {
          setState((old) => ({ ...old, loading: false, refreshing: false, refreshError: message }));
        } else {
          hasData = false;
          setState({
            data: null,
            loading: false,
            refreshing: false,
            error: message,
            refreshError: "",
            checkedAt: null,
          });
        }
      } finally {
        pending = false;
        schedule();
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (visible()) request();
    };
    setState({ data: null, loading: true, refreshing: false, error: "", refreshError: "", checkedAt: null });
    refresh.current = request;
    document.addEventListener("visibilitychange", onVisibility);
    request();
    return () => {
      active = false;
      clearTimeout(timer);
      refresh.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [...deps, pollMs]);

  return { ...state, reload };
}
