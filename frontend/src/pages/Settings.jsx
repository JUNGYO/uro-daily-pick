import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { checked, appUrl } from "../lib/data";
import { ErrorNotice } from "../components/Status";

const types = [
  "rct",
  "basic_research",
  "biomarker",
  "retrospective",
  "prospective",
  "meta_analysis",
  "ai_ml",
  "surgical",
  "imaging",
  "epidemiology",
  "guideline",
  "review",
];

function Tags({ label, values, onChange }) {
  const [value, setValue] = useState("");
  const add = () => {
    const next = value.trim();
    if (next && !values.includes(next) && values.length < 30) onChange([...values, next]);
    setValue("");
  };
  return (
    <div className="space-y-3">
      <label className="field-label">
        {label}
        <input
          aria-label={`Add ${label}`}
          className="form-input mt-2"
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Type and press Enter"
        />
      </label>
      <button type="button" className="btn-secondary" onClick={add}>
        Add {label.toLowerCase()}
      </button>
      <div className="flex flex-wrap gap-2">
        {values.map((item) => (
          <button
            type="button"
            className="rounded-lg border border-border bg-hover px-3 py-2 text-sm break-all"
            key={item}
            aria-label={`Remove ${item}`}
            onClick={() => onChange(values.filter((v) => v !== item))}
          >
            {item} ×
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Settings() {
  const { user, profile, setProfile } = useAuth();
  const [form, setForm] = useState(profile);
  const [alerts, setAlerts] = useState([]);
  const [newAlert, setNewAlert] = useState("");
  const [alertType, setAlertType] = useState("keyword");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setForm(profile);
  }, [profile]);
  useEffect(() => {
    let active = true;
    checked(supabase.from("alerts").select("*").eq("user_id", user.id).order("id"))
      .then((data) => {
        if (active) setAlerts(data || []);
      })
      .catch(() => {
        if (active) setError("Could not load your topic alerts.");
      });
    return () => {
      active = false;
    };
  }, [user.id, retry]);
  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      setError(err.message || "Could not save changes. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const data = await checked(
        supabase
          .from("profiles")
          .update({
            name: form.name.trim(),
            institution: form.institution?.trim() || "",
            keywords: form.keywords || [],
            preferred_journals: form.preferred_journals || [],
            preferred_study_types: form.preferred_study_types || [],
            email_digest: !!form.email_digest,
            digest_frequency: form.digest_frequency || "daily",
            personalization_enabled: form.personalization_enabled !== false,
          })
          .eq("id", user.id)
          .select()
          .single(),
      );
      if (!data) throw new Error("No profile was saved.");
      setProfile(data);
      setMessage("Settings saved.");
    });
  };
  if (!form) return <ErrorNotice message="Profile unavailable. Reload to try again." />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="page-shell max-w-3xl">
        <h1 className="page-title">Settings</h1>
        {error && (
          <ErrorNotice
            message={error}
            onRetry={() => {
              setError("");
              setRetry((v) => v + 1);
            }}
          />
        )}
        {message && (
          <p role="status" className="mb-4 text-sm text-green-800">
            {message}
          </p>
        )}
        <form onSubmit={save} className="panel space-y-6">
          <h2 className="section-title">Your research profile</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="field-label">
              Name
              <input
                className="form-input mt-2"
                autoComplete="name"
                maxLength={100}
                required
                value={form.name || ""}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="field-label">
              Institution
              <input
                className="form-input mt-2"
                autoComplete="organization"
                maxLength={200}
                value={form.institution || ""}
                onChange={(e) => setForm({ ...form, institution: e.target.value })}
              />
            </label>
          </div>
          <Tags
            label="Research keywords"
            values={form.keywords || []}
            onChange={(keywords) => setForm({ ...form, keywords })}
          />
          <fieldset>
            <legend className="field-label mb-3">Preferred study types</legend>
            <div className="flex flex-wrap gap-2">
              {types.map((type) => (
                <button
                  type="button"
                  key={type}
                  aria-pressed={(form.preferred_study_types || []).includes(type)}
                  className="choice-chip"
                  onClick={() =>
                    setForm({
                      ...form,
                      preferred_study_types: (form.preferred_study_types || []).includes(type)
                        ? form.preferred_study_types.filter((t) => t !== type)
                        : [...(form.preferred_study_types || []), type],
                    })
                  }
                >
                  {type.replaceAll("_", " ")}
                </button>
              ))}
            </div>
          </fieldset>
          <Tags
            label="Preferred journals"
            values={form.preferred_journals || []}
            onChange={(preferred_journals) => setForm({ ...form, preferred_journals })}
          />
          <fieldset className="border-t border-border pt-5 space-y-3">
            <legend className="field-label">추천 개인화</legend>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.personalization_enabled !== false}
                onChange={(e) => setForm({ ...form, personalization_enabled: e.target.checked })}
              />
              열람·좋아요 기록으로 관심 주제와 유사 독자 추천 받기
            </label>
            <p className="help-text">
              끄면 행동 기록을 개인화와 유사 독자 집계에 사용하지 않습니다. 직접 설정한 관심 주제·저널과 관심
              없음 표시는 계속 반영합니다. 메모와 비공개 프로젝트는 유사 독자 추천에 사용하지 않습니다.
            </p>
          </fieldset>
          <fieldset className="border-t border-border pt-5 space-y-3">
            <legend className="field-label">Email digest</legend>
            {import.meta.env.VITE_EMAIL_DELIVERY_READY === "false" && (
              <p className="help-text" role="status">
                Email digests are paused. Your preferences are saved for when delivery resumes.
              </p>
            )}
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={!!form.email_digest}
                onChange={(e) => setForm({ ...form, email_digest: e.target.checked })}
              />
              Send my paper recommendations by email
            </label>
            <label className="field-label">
              Frequency
              <select
                className="form-input mt-2"
                value={form.digest_frequency || "daily"}
                onChange={(e) => setForm({ ...form, digest_frequency: e.target.value })}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly · Monday</option>
              </select>
            </label>
            <p className="help-text">Delivery follows the morning paper update, in Korea time.</p>
          </fieldset>
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </form>
        <section className="panel mt-5">
          <h2 className="section-title">Topic alerts</h2>
          <p className="help-text mb-4">Matching papers receive a boost in your daily picks and digest.</p>
          <form
            className="flex flex-wrap gap-2 mb-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const data = await checked(
                  supabase
                    .from("alerts")
                    .insert({ user_id: user.id, alert_type: alertType, value: newAlert.trim() })
                    .select()
                    .single(),
                );
                setAlerts((previous) => [...previous, data]);
                setNewAlert("");
              });
            }}
          >
            <select
              aria-label="Alert type"
              className="form-input sm:w-auto"
              value={alertType}
              onChange={(e) => setAlertType(e.target.value)}
            >
              <option value="keyword">Keyword</option>
              <option value="author">Author</option>
              <option value="journal">Journal</option>
            </select>
            <input
              aria-label="Alert value"
              className="form-input flex-1 min-w-0"
              maxLength={150}
              required
              value={newAlert}
              onChange={(e) => setNewAlert(e.target.value)}
              placeholder="Topic, author, or journal"
            />
            <button className="btn-secondary" disabled={busy || !newAlert.trim()}>
              Add alert
            </button>
          </form>
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <li key={alert.id} className="flex items-center gap-3 rounded-lg bg-hover p-3 text-sm">
                <span className="text-text3">{alert.alert_type}</span>
                <span className="flex-1 break-words min-w-0">{alert.value}</span>
                <button
                  className="text-red-700 p-2"
                  disabled={busy}
                  aria-label={`Remove alert ${alert.value}`}
                  onClick={() =>
                    run(async () => {
                      await checked(supabase.from("alerts").delete().eq("id", alert.id));
                      setAlerts((previous) => previous.filter((a) => a.id !== alert.id));
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {!alerts.length && <p className="help-text">No topic alerts yet.</p>}
        </section>
        <AccountSection />
      </div>
    </div>
  );
}

function AccountSection() {
  const { user, profile, setProfile } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(user.email || "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [deletion, setDeletion] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err.message || "Account update failed. Please retry.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel mt-5 space-y-5">
      <h2 className="section-title">Account</h2>
      <p className="help-text break-all">Signed in as {user.email}</p>
      {error && <ErrorNotice message={error} />}
      {message && (
        <p role="status" className="text-sm text-green-800">
          {message}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const { error } = await supabase.auth.updateUser(
              { email: email.trim() },
              { emailRedirectTo: appUrl("settings") },
            );
            if (error) throw error;
            setMessage(
              "Check your email to confirm the new address. Digests continue to use your verified account email until confirmation.",
            );
          });
        }}
        className="space-y-3"
      >
        <label className="field-label">
          Account and digest email
          <input
            className="form-input mt-2"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <p className="help-text">
          Used for sign-in and digests. Confirm a new address through email before it takes effect.
        </p>
        <button className="btn-secondary" disabled={busy || email.trim() === user.email}>
          Change email address
        </button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            if (password !== confirm) throw new Error("Passwords do not match.");
            const { error } = await supabase.auth.updateUser({ password });
            if (error) throw error;
            setPassword("");
            setConfirm("");
            setMessage("Password updated.");
          });
        }}
        className="border-t border-border pt-5 space-y-3"
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
          Confirm new password
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
        <button className="btn-secondary" disabled={busy}>
          Update password
        </button>
      </form>
      <div className="border-t border-border pt-5">
        {!showDelete ? (
          <button className="text-sm text-red-700 underline" onClick={() => setShowDelete(true)}>
            Delete account
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await checked(supabase.rpc("delete_own_account"));
                await supabase.auth.signOut({ scope: "local" });
                navigate("/welcome", { replace: true });
              });
            }}
            className="space-y-3"
          >
            <p className="text-sm">
              This permanently deletes your account, preferences, reading history, feedback, and collections.
            </p>
            <label className="field-label">
              Type DELETE to confirm
              <input
                className="form-input mt-2"
                value={deletion}
                onChange={(e) => setDeletion(e.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="flex gap-3">
              <button className="btn-danger" disabled={busy || deletion !== "DELETE"}>
                Permanently delete account
              </button>
              <button type="button" className="btn-secondary" onClick={() => setShowDelete(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
