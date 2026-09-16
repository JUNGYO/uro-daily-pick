import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function AdminPanel({ title, rpc, params, refresh, children, list = false, pollMs = 0 }) {
  const [state, setState] = useState({ data: null, loading: true, error: "", updated: null });
  const [retry, setRetry] = useState(0);
  const parameters = JSON.stringify(params || {});

  useEffect(() => {
    let active = true;
    let pending = false;
    let controller;
    let deadlineTimer;
    let pollTimer;
    const polling = Number.isFinite(pollMs) && pollMs > 0;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = () => {
      clearTimeout(pollTimer);
      if (active && polling && visible()) pollTimer = setTimeout(() => load(true), pollMs);
    };
    const load = async (background = false) => {
      if (!active || pending || (background && !visible())) return;
      clearTimeout(pollTimer);
      pending = true;
      controller = new AbortController();
      const requestController = controller;
      let settled = false;
      const finish = (update) => {
        if (!active || settled) return;
        settled = true;
        pending = false;
        clearTimeout(deadlineTimer);
        setState(update);
        schedule();
      };
      if (!background) setState((old) => ({ ...old, loading: true, error: "" }));
      deadlineTimer = setTimeout(() => {
        finish((old) => ({
          ...old,
          loading: false,
          error: "조회 시간이 초과됐습니다. 다시 시도해 주세요.",
        }));
        requestController.abort();
      }, 15000);
      try {
        const { data, error } = await supabase
          .rpc(rpc, JSON.parse(parameters))
          .abortSignal(requestController.signal);
        if (error) throw error;
        const value = list && data === null ? [] : data;
        if (list ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Invalid analytics response");
        }
        finish({ data: value, loading: false, error: "", updated: new Date() });
      } catch (error) {
        finish((old) => ({
          ...old,
          loading: false,
          error:
            error?.code === "42501"
              ? "관리자 권한을 확인할 수 없습니다. 로그인 상태를 확인해 주세요."
              : "이 항목을 불러오지 못했습니다. 다시 시도해 주세요.",
        }));
      }
    };
    const onVisibility = () => {
      clearTimeout(pollTimer);
      if (visible()) load(true);
    };
    if (polling) document.addEventListener("visibilitychange", onVisibility);
    if (!polling || visible()) load();
    return () => {
      active = false;
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      if (polling) document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
    };
  }, [rpc, parameters, refresh, retry, list, pollMs]);

  return (
    <section aria-label={title} className="min-w-0 bg-card rounded-xl border border-border p-4 sm:p-5 mb-4">
      <h2 className="font-semibold text-text1 mb-3">{title}</h2>
      {state.loading && (
        <p role="status" className="text-sm text-text3 mb-3">
          {state.data ? "새로고침 중…" : "불러오는 중…"}
        </p>
      )}
      {state.error && (
        <div role="alert" className="text-sm text-text2 mb-3">
          <p>{state.error}</p>
          <button
            type="button"
            className="text-accent mt-2 min-h-10"
            onClick={() => setRetry((value) => value + 1)}
          >
            다시 시도
          </button>
        </div>
      )}
      {state.data !== null && children(state.data)}
      {state.updated && (
        <p className="text-xs text-text3 mt-3">
          {state.error || state.loading ? "이전 조회 결과" : "최근 조회"}: {state.updated.toLocaleString()}
        </p>
      )}
    </section>
  );
}
