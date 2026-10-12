import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { checked } from "../lib/data";

const buttonClass = "min-h-11 px-4 py-2 border border-border rounded-lg text-accent disabled:opacity-50";
const unwrap = checked;
function errorMessage(error) {
  if (/verification_failed|invalid.*code/i.test(error?.code || error?.message || ""))
    return "인증번호가 맞지 않습니다. 인증 앱의 최신 6자리 번호를 입력해 주세요.";
  if (error?.status === 429 || /rate_limit/.test(error?.code || ""))
    return "인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.";
  return "인증 상태를 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.";
}

// The database separately enforces administrator identity, AAL2 and a verified factor.
// QR secrets and codes exist only in this mounted component, never in storage/logs.
export default function AdminMfaGate({ children }) {
  const [mode, setMode] = useState("loading");
  const [factors, setFactors] = useState([]);
  const [unfinished, setUnfinished] = useState([]);
  const [factorId, setFactorId] = useState("");
  const [enrollment, setEnrollment] = useState(null);
  const enrollmentRef = useRef(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const actionBusy = useRef(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    epoch.current++;
    setMode("loading");
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      // Do not call async Auth methods inside this callback (the SDK holds a lock).
      if (event !== "INITIAL_SESSION") refresh();
    });
    const focus = () => {
      if (!document.hidden && !actionBusy.current) refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      epoch.current++;
      enrollmentRef.current = null;
      data.subscription.unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);

  useEffect(() => {
    const current = ++epoch.current;
    (async () => {
      try {
        const [assurance, list] = await Promise.all([
          unwrap(supabase.auth.mfa.getAuthenticatorAssuranceLevel()),
          unwrap(supabase.auth.mfa.listFactors()),
        ]);
        if (current !== epoch.current) return;
        const verified = (list.all || []).filter((factor) => factor.status === "verified");
        const totp = verified.filter((factor) => factor.factor_type === "totp");
        setFactors(totp);
        setUnfinished(
          (list.all || []).filter(
            (factor) => factor.status === "unverified" && factor.factor_type === "totp",
          ),
        );
        if (assurance.currentLevel === "aal2" && verified.length) {
          const status = await unwrap(supabase.rpc("admin_security_status"));
          if (current !== epoch.current) return;
          if (status?.verified !== true) throw new Error("Server verification required");
          enrollmentRef.current = null;
          setEnrollment(null);
          setCode("");
          setError("");
          setMode("verified");
          window.dispatchEvent(new Event("uro-admin-verified"));
        } else {
          setFactorId(totp[0]?.id || enrollmentRef.current?.id || "");
          setMode(totp.length ? "challenge" : "enroll");
          setError("");
        }
      } catch (failure) {
        if (current === epoch.current) {
          setError(errorMessage(failure));
          setMode("error");
        }
      }
    })();
    return () => {
      epoch.current++;
    };
  }, [revision]);

  const run = async (operation) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true);
    setError("");
    const current = epoch.current;
    try {
      await operation(current);
    } catch (failure) {
      if (current === epoch.current) setError(errorMessage(failure));
    } finally {
      actionBusy.current = false;
      setBusy(false);
    }
  };
  const enroll = () =>
    run(async (current) => {
      const result = await unwrap(
        supabase.auth.mfa.enroll({
          factorType: "totp",
          issuer: "Uro Daily Pick",
          friendlyName: `Admin ${Date.now()}`,
        }),
      );
      if (current !== epoch.current) return;
      enrollmentRef.current = result;
      setEnrollment(result);
      setFactorId(result.id);
      setCode("");
    });
  const clearUnfinished = () =>
    run(async () => {
      // Only remove unverified factors, and only after an explicit user action.
      const list = await unwrap(supabase.auth.mfa.listFactors());
      for (const factor of list.all || []) {
        if (factor.status === "unverified" && factor.factor_type === "totp")
          await unwrap(supabase.auth.mfa.unenroll({ factorId: factor.id }));
      }
      enrollmentRef.current = null;
      setEnrollment(null);
      setCode("");
      refresh();
    });
  const verify = (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code) || !factorId) return;
    const submitted = code;
    setCode("");
    run(async () => {
      await unwrap(supabase.auth.mfa.challengeAndVerify({ factorId, code: submitted }));
      refresh();
    });
  };

  if (mode === "verified") return children;
  const qr = enrollment?.totp?.qr_code;
  const qrSrc = qr?.startsWith("data:image/")
    ? qr
    : qr?.startsWith("<svg")
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`
      : null;
  return (
    <section className="h-full overflow-y-auto p-4 sm:p-6" aria-labelledby="admin-mfa-title">
      <div className="max-w-lg mx-auto bg-card border border-border rounded-xl p-4 sm:p-6 space-y-4">
        <h1 id="admin-mfa-title" className="text-xl font-bold">
          관리자 2단계 인증
        </h1>
        <p className="text-sm text-text2">
          회원 승인과 권한 관리 등 관리자 기능을 사용하려면 인증 앱으로 본인 확인이 필요합니다.
        </p>
        {mode === "loading" && <p role="status">인증 상태 확인 중…</p>}
        {mode === "enroll" && !enrollment && (
          <>
            <p className="text-sm">
              Google Authenticator, Microsoft Authenticator 등 인증 앱을 준비하고 등록을 시작해 주세요.
            </p>
            <button type="button" className={buttonClass} disabled={busy} onClick={enroll}>
              인증 앱 등록 시작
            </button>
            {unfinished.length > 0 && (
              <div>
                <p className="text-sm mb-2">
                  완료하지 않은 등록이 있습니다. 등록을 시작할 수 없으면 미완료 등록을 지우고 다시 시작해
                  주세요.
                </p>
                <button type="button" className={buttonClass} disabled={busy} onClick={clearUnfinished}>
                  미완료 등록 지우기
                </button>
              </div>
            )}
          </>
        )}
        {mode === "enroll" && enrollment && (
          <>
            <p className="text-sm">
              인증 앱에서 QR 코드를 스캔한 뒤 아래에 6자리 번호를 입력해 주세요. 등록 정보는 다른 사람에게
              공유하지 마세요.
            </p>
            {qrSrc && (
              <img src={qrSrc} alt="인증 앱 등록 QR 코드" className="w-56 max-w-full mx-auto bg-white" />
            )}
            <details>
              <summary className="cursor-pointer text-sm min-h-11">QR 스캔 대신 설정 키 직접 입력</summary>
              <code className="block break-all select-all text-sm">{enrollment.totp?.secret}</code>
            </details>
          </>
        )}
        {(mode === "challenge" || (mode === "enroll" && enrollment)) && (
          <form onSubmit={verify} className="space-y-3">
            {factors.length > 1 && (
              <label className="block text-sm">
                인증 앱
                <select
                  className="block w-full min-h-11 bg-card border border-border rounded p-2"
                  value={factorId}
                  onChange={(event) => setFactorId(event.target.value)}
                  disabled={busy}
                >
                  {factors.map((factor, index) => (
                    <option key={factor.id} value={factor.id}>
                      {factor.friendly_name || `인증 앱 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-sm" htmlFor="admin-mfa-code">
              인증 앱의 6자리 번호
            </label>
            <input
              id="admin-mfa-code"
              className="w-full min-h-11 border border-border rounded-lg bg-card p-3 tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              disabled={busy}
              required
            />
            <button className={buttonClass} disabled={busy || code.length !== 6}>
              {busy ? "확인 중…" : "인증하고 관리자 화면 열기"}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {mode === "error" && (
          <button type="button" className={buttonClass} onClick={refresh}>
            다시 시도
          </button>
        )}
        <p className="text-xs text-text3">
          인증 앱을 삭제하거나 기기를 바꾸기 전에 앱의 안전한 백업·이전 기능을 확인해 주세요. 기기를
          분실했다면 서비스 운영자의 계정 복구가 필요합니다. 일반 논문 읽기는 계속 이용할 수 있습니다.
        </p>
      </div>
    </section>
  );
}
