import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { ErrorNotice, Loading } from "../components/Status";

export default function ResetPassword() {
  const { user, loading: sessionLoading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => navigate("/", { replace: true }), 2000);
    return () => clearTimeout(timer);
  }, [success, navigate]);
  if (sessionLoading) return <Loading text="Checking your reset link…" />;
  return (
    <div className="min-h-dvh grid place-items-center p-5">
      <div className="panel w-full max-w-md">
        <h1 className="page-title">Set new password</h1>
        {!user ? (
          <>
            <ErrorNotice message="This reset link is missing or has expired." />
            <Link className="text-accent underline" to="/login">
              Request another reset link
            </Link>
          </>
        ) : success ? (
          <p role="status">Password updated. Redirecting…</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setError("");
              if (password !== confirm) {
                setError("Passwords do not match.");
                return;
              }
              setBusy(true);
              try {
                const { error } = await supabase.auth.updateUser({ password });
                if (error) throw error;
                setSuccess(true);
              } catch (err) {
                setError(err.message || "Could not update password.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field-label">
              New password
              <input
                className="form-input mt-2"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field-label">
              Confirm password
              <input
                className="form-input mt-2"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {error && <ErrorNotice message={error} />}
            <button disabled={busy} className="btn-primary">
              {busy ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
