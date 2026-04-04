import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Save, Plus, X, Bell, Check, Shield, Trash2, Mail } from "lucide-react";

const inputCls = "h-12 bg-card border border-border rounded-lg px-4 text-[1rem] text-text1 outline-none focus:border-accent transition-colors";
const sectionCls = "bg-card rounded-xl border border-border p-4 sm:p-6 mb-4 sm:mb-6";

function TagField({ label, tags, onAdd, onRemove, placeholder }) {
  const [value, setValue] = useState("");

  const handleAdd = () => {
    if (!value.trim()) return;
    onAdd(value.trim());
    setValue("");
  };

  return (
    <div className="mb-5">
      <label className="text-[0.889rem] font-semibold text-text1 block mb-2">{label}</label>
      <div className="flex flex-wrap gap-2 mb-2">
        {(tags || []).map(tag => (
          <span key={tag} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[rgba(0,122,255,0.06)] text-accent text-[0.889rem] font-medium border border-[rgba(0,122,255,0.12)]">
            {tag}
            <button onClick={() => onRemove(tag)} className="hover:text-danger transition-colors"><X size={14} /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
          placeholder={placeholder || "Type and press Enter"}
          className={`flex-1 ${inputCls}`}
        />
        <button onClick={handleAdd} className="h-11 px-3 bg-hover border border-border rounded-lg hover:bg-border transition-colors">
          <Plus size={16} className="text-text3" />
        </button>
      </div>
    </div>
  );
}

function LearnedSection({ label, items, emptyMsg }) {
  const tags = items || [];
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-2">
        <label className="text-[0.889rem] font-semibold text-text1">{label}</label>
        <span className="text-[0.778rem] text-text3 bg-hover px-2 py-0.5 rounded">Auto-learned</span>
      </div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {tags.map(tag => (
            <span key={tag} className="inline-flex items-center h-8 px-3 rounded-lg bg-hover text-text2 text-[0.889rem] font-medium border border-border">
              {tag}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[0.889rem] text-text3 italic">{emptyMsg}</p>
      )}
    </div>
  );
}

export default function Settings() {
  const { user, profile, loadProfile } = useAuth();
  const [form, setForm] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [newAlertType, setNewAlertType] = useState("keyword");
  const [newAlertValue, setNewAlertValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile) setForm({ ...profile });
    if (user) supabase.from("alerts").select("*").eq("user_id", user.id).then(({ data }) => setAlerts(data || []));
  }, [profile, user]);

  if (!form) return <div className="flex items-center justify-center h-full text-text3">Loading...</div>;

  const handleSave = async () => {
    setSaving(true);
    const { error } = await supabase.from("profiles").update({
      name: form.name || "",
      institution: form.institution || "",
      keywords: form.keywords || [],
      preferred_journals: form.preferred_journals || [],
      preferred_study_types: form.preferred_study_types || [],
      digest_email: form.digest_email ?? true,
    }).eq("id", user.id);
    if (error) { console.error("Save error:", error); setSaving(false); return; }
    await loadProfile(user.id);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

  const addTag = (field, val) => {
    if (!form[field]?.includes(val)) {
      setForm({ ...form, [field]: [...(form[field] || []), val] });
    }
  };
  const removeTag = (field, val) => setForm({ ...form, [field]: (form[field] || []).filter(v => v !== val) });

  const addAlert = async () => {
    if (!newAlertValue.trim() || !user) return;
    const { data } = await supabase.from("alerts").insert({ user_id: user.id, alert_type: newAlertType, value: newAlertValue.trim() }).select().single();
    if (data) setAlerts(p => [...p, data]);
    setNewAlertValue("");
  };
  const removeAlert = async (id) => {
    await supabase.from("alerts").delete().eq("id", id);
    setAlerts(p => p.filter(a => a.id !== id));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto p-4 sm:p-6 lg:p-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[1.333rem] font-bold text-text1">Settings</h1>
          <button onClick={handleSave} disabled={saving}
            className={`flex items-center gap-2 h-10 px-5 rounded-lg text-[0.889rem] font-medium transition-colors
              ${saved ? "bg-success text-white" : "bg-accent text-white hover:bg-[#0066D6]"}`}>
            {saved ? <><Check size={16} />Saved</> : <><Save size={16} />{saving ? "Saving..." : "Save"}</>}
          </button>
        </div>

        {/* Profile */}
        <div className={sectionCls}>
          <h2 className="text-[1rem] font-semibold text-text1 mb-4">Profile</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            <div>
              <label className="text-[0.778rem] text-text3 block mb-1.5">Name</label>
              <input value={form.name || ""} onChange={e => setForm({ ...form, name: e.target.value })} className={`w-full ${inputCls}`} />
            </div>
            <div>
              <label className="text-[0.778rem] text-text3 block mb-1.5">Institution</label>
              <input value={form.institution || ""} onChange={e => setForm({ ...form, institution: e.target.value })} className={`w-full ${inputCls}`} />
            </div>
          </div>

          <TagField
            label="Research Keywords"
            tags={form.keywords}
            onAdd={val => addTag("keywords", val)}
            onRemove={val => removeTag("keywords", val)}
            placeholder="e.g. prostate cancer, robotic surgery"
          />
          {/* Study types */}
          <div className="mb-5">
            <label className="text-[0.889rem] font-semibold text-text1 block mb-2">Preferred Study Types</label>
            <div className="flex flex-wrap gap-2">
              {["rct","basic_research","biomarker","retrospective","prospective","meta_analysis","ai_ml","surgical","imaging","epidemiology","guideline","review"].map(t => {
                const active = (form.preferred_study_types || []).includes(t);
                const label = t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <button key={t} type="button" onClick={() => {
                    const cur = form.preferred_study_types || [];
                    setForm({ ...form, preferred_study_types: active ? cur.filter(x => x !== t) : [...cur, t] });
                  }}
                    className={`h-8 px-3 rounded-lg text-[0.778rem] font-medium border transition-colors
                      ${active ? "bg-[rgba(0,122,255,0.08)] text-accent border-accent" : "bg-card text-text3 border-border hover:border-text3"}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Journals — user editable */}
          <TagField
            label="Preferred Journals"
            tags={form.preferred_journals}
            onAdd={val => addTag("preferred_journals", val)}
            onRemove={val => removeTag("preferred_journals", val)}
            placeholder="e.g. European Urology, Journal of Urology"
          />

          <div className="pt-4 border-t border-border">
            <p className="text-[0.889rem] font-semibold text-text1 mb-3">Daily Digest</p>
            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors
              ${form.digest_email ? "border-accent bg-[rgba(0,122,255,0.04)]" : "border-border hover:bg-hover"}`}>
              <input type="checkbox" checked={form.digest_email || false}
                onChange={e => setForm({ ...form, digest_email: e.target.checked })}
                className="accent-accent" />
              <div>
                <span className="text-[0.889rem] font-medium text-text1">Email</span>
                <p className="text-[0.722rem] text-text3">Receive via email every morning</p>
              </div>
            </label>
          </div>
        </div>

        {/* Alerts */}
        <div className={sectionCls}>
          <h2 className="text-[1rem] font-semibold text-text1 mb-1 flex items-center gap-2">
            <Bell size={18} className="text-warning" />Keyword Alerts
          </h2>
          <p className="text-[0.778rem] text-text3 mb-4">Get notified when new papers match your criteria.</p>
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <select value={newAlertType} onChange={e => setNewAlertType(e.target.value)}
              className={`${inputCls} w-full sm:w-auto`}>
              <option value="keyword">Keyword</option>
              <option value="author">Author</option>
              <option value="journal">Journal</option>
            </select>
            <input value={newAlertValue} onChange={e => setNewAlertValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addAlert(); } }}
              placeholder="Enter keyword, author, or journal"
              className={`flex-1 min-w-0 ${inputCls}`} />
            <button onClick={addAlert} className="h-11 px-4 bg-warning text-white rounded-lg text-[0.889rem] font-medium hover:opacity-90 transition-opacity">Add</button>
          </div>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="flex items-center gap-3 p-3 bg-hover rounded-lg">
                <Bell size={14} className={a.is_active ? "text-warning" : "text-text3"} />
                <span className="text-[0.778rem] text-text3 bg-card border border-border px-2 py-0.5 rounded font-medium">{a.alert_type}</span>
                <span className="text-[0.889rem] text-text1 flex-1">{a.value}</span>
                <button onClick={() => removeAlert(a.id)} className="text-text3 hover:text-danger transition-colors"><X size={16} /></button>
              </div>
            ))}
            {!alerts.length && <p className="text-[0.889rem] text-text3 text-center py-4">No alerts set</p>}
          </div>
        </div>

        {/* Account */}
        <AccountSection user={user} profile={form} />
      </div>
    </div>
  );
}

function AccountSection({ user, profile }) {
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const navigate = useNavigate();

  const changeEmail = async () => {
    if (!newEmail.trim()) return;
    setErr(""); setMsg("");
    // Save email to profile (for digest), don't change auth email (breaks session)
    const { error } = await supabase.from("profiles").update({
      digest_email_address: newEmail.trim(),
    }).eq("id", user.id);
    if (error) { setErr(error.message); return; }
    setMsg("Email saved for digest delivery.");
    setNewEmail("");
  };

  const changePassword = async () => {
    setErr(""); setMsg("");
    if (newPassword.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (newPassword !== confirmPassword) { setErr("Passwords don't match."); return; }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) { setErr(error.message); return; }
    setMsg("Password updated.");
    setNewPassword(""); setConfirmPassword("");
  };

  const deleteAccount = async () => {
    // Note: Supabase doesn't allow users to delete themselves via client SDK.
    // We mark the profile and the admin can clean up, or use an Edge Function.
    await supabase.from("profiles").update({ name: "[DELETED]", keywords: [], preferred_journals: [], email_digest: false }).eq("id", user.id);
    await supabase.auth.signOut();
    navigate("/login");
  };

  return (
    <div className={sectionCls}>
      <h2 className="text-[1rem] font-semibold text-text1 mb-4 flex items-center gap-2">
        <Shield size={18} className="text-accent" />Account
      </h2>

      <p className="text-[0.889rem] text-text3 mb-4">
        Signed in as <span className="text-text1 font-medium break-all">{user?.email}</span>
      </p>

      {msg && <p className="text-[0.889rem] text-success mb-3">{msg}</p>}
      {err && <p className="text-[0.889rem] text-danger mb-3">{err}</p>}

      {/* Change email — for all users (email digest needs this) */}
      <div className="mb-5">
        <label className="text-[0.889rem] font-semibold text-text1 block mb-2 flex items-center gap-1.5">
          <Mail size={14} />Email for digest
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
            placeholder={user?.email || "Enter email for digest"}
            type="email"
            className={`w-full sm:flex-1 ${inputCls}`} />
          <button onClick={changeEmail}
            className="h-12 px-4 bg-accent text-white rounded-lg text-[0.889rem] font-medium hover:bg-[#0066D6] transition-colors shrink-0">
            Update
          </button>
        </div>
        <p className="text-[0.722rem] text-text3 mt-1">Email digest will be sent to this address.</p>
      </div>

      {/* Change password — only for email users */}
      {user?.app_metadata?.provider === "email" && (
        <div className="mb-5">
          <label className="text-[0.889rem] font-semibold text-text1 block mb-2 flex items-center gap-1.5">
            <Shield size={14} />Change password
          </label>
          <div className="flex flex-col gap-2">
            <input value={newPassword} onChange={e => setNewPassword(e.target.value)}
              placeholder="New password (min 6 chars)" type="password"
              className={`w-full ${inputCls}`} />
            <input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password" type="password"
              className={`w-full ${inputCls}`} />
            <button onClick={changePassword}
              className="h-12 px-4 bg-accent text-white rounded-lg text-[0.889rem] font-medium hover:bg-[#0066D6] transition-colors self-start">
              Update password
            </button>
          </div>
        </div>
      )}

      {/* Delete account */}
      <div className="pt-4 border-t border-border">
        {!showDelete ? (
          <button onClick={() => setShowDelete(true)}
            className="flex items-center gap-1.5 text-[0.889rem] text-danger hover:underline">
            <Trash2 size={14} />Delete account
          </button>
        ) : (
          <div className="bg-[rgba(255,59,48,0.04)] border border-[rgba(255,59,48,0.15)] rounded-lg p-4">
            <p className="text-[0.889rem] text-text1 mb-3">Are you sure? This cannot be undone.</p>
            <div className="flex gap-2">
              <button onClick={deleteAccount}
                className="h-10 px-5 bg-danger text-white rounded-lg text-[0.889rem] font-medium">
                Yes, delete my account
              </button>
              <button onClick={() => setShowDelete(false)}
                className="h-10 px-5 text-text3 text-[0.889rem]">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
