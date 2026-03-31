import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Supabase sends the user here with a session after clicking the email link
  useEffect(() => {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        // User arrived from password reset email — ready to set new password
      }
    });
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault(); setError("");
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) { setError(error.message); return; }
    setSuccess(true);
    setTimeout(() => navigate("/"), 2000);
  };

  const inputCls = "w-full h-12 bg-card border border-border rounded-lg px-4 text-[1rem] text-text1 outline-none focus:border-accent transition-colors";

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-[400px]">
        <div className="bg-card rounded-xl border border-border p-8" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <h2 className="text-[1.222rem] font-bold text-text1 mb-2">Set new password</h2>
          {success ? (
            <p className="text-[0.889rem] text-success">Password updated. Redirecting...</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3 mt-4">
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="New password (min 6 chars)" required className={inputCls} />
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                placeholder="Confirm password" required className={inputCls} />
              {error && <p className="text-[0.889rem] text-danger">{error}</p>}
              <button type="submit" disabled={loading}
                className="w-full h-11 rounded-lg bg-accent text-white text-[0.889rem] font-semibold hover:bg-[#0066D6] disabled:opacity-50 transition-colors mt-2">
                {loading ? "..." : "Update password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
