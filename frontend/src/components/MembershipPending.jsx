import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";

export default function MembershipPending() {
  const { user, profile, loadProfile } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshing = useRef(false);
  const refresh = async () => {
    if (refreshing.current || document.hidden) return;
    refreshing.current = true;
    setBusy(true);
    try {
      await loadProfile(user.id);
      setError("");
    } catch {
      setError("승인 상태를 확인하지 못했습니다. 다시 확인해 주세요.");
    } finally {
      refreshing.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [user.id, loadProfile]);
  const rejected = profile.access_status === "rejected";
  return (
    <main className="min-h-dvh bg-bg flex items-center justify-center p-5">
      <section className="max-w-md w-full rounded-xl border border-border bg-card p-6 space-y-4">
        <p className="text-accent font-semibold">Uro Daily Pick</p>
        <h1 className="text-xl font-bold">
          {rejected ? "가입이 승인되지 않았습니다" : "관리자 승인을 기다리고 있습니다"}
        </h1>
        <p className="text-sm text-text2">
          {rejected
            ? "관리자 확인 후 이용할 수 있습니다."
            : "가입 신청이 접수되었습니다. 관리자가 승인하면 논문 읽기와 연구 기능을 이용할 수 있습니다."}
        </p>
        <p className="text-sm break-all">{user.email}</p>
        {profile.access_note && (
          <p className="text-sm rounded-lg bg-hover p-3">관리자 안내: {profile.access_note}</p>
        )}
        <p className="text-xs text-text3">이 화면에서 승인 상태가 자동으로 갱신됩니다.</p>
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            disabled={busy}
            onClick={refresh}
            className="min-h-11 px-4 rounded-lg bg-accent text-white disabled:opacity-50"
          >
            승인 상태 확인
          </button>
          <button
            className="min-h-11 px-4 rounded-lg border border-border"
            onClick={async () => {
              try {
                const result = await supabase.auth.signOut();
                if (result.error) throw result.error;
              } catch {
                setError("로그아웃하지 못했습니다. 다시 시도해 주세요.");
              }
            }}
          >
            로그아웃
          </button>
        </div>
      </section>
    </main>
  );
}
