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
    await supabase.from("profiles").update({
      name: form.name, institution: form.institution, keywords: form.keywords,
      mesh_terms: form.mesh_terms, preferred_journals: form.preferred_journals,
      email_digest: form.email_digest, digest_frequency: form.digest_frequency,
    }).eq("id", user.id);
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
          {/* Journals — user editable */}
          <TagField
            label="Preferred Journals"
            tags={form.preferred_journals}
            onAdd={val => addTag("preferred_journals", val)}
            onRemove={val => removeTag("preferred_journals", val)}
            placeholder="e.g. European Urology, Journal of Urology"
          />

          <div className="flex items-center gap-4 pt-4 border-t border-border">
            <label className="flex items-center gap-2 cursor-pointer text-[0.889rem] text-text1">
              <input type="checkbox" checked={form.email_digest || false}
                onChange={e => setForm({ ...form, email_digest: e.target.checked })} className="accent-accent" />
              Email digest
            </label>
            {form.email_digest && (
              <select value={form.digest_frequency || "daily"}
                onChange={e => setForm({ ...form, digest_frequency: e.target.value })}
                className="h-9 bg-card border border-border rounded-lg px-3 text-[0.889rem] text-text1 outline-none">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            )}
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
  const [kakaoLinked, setKakaoLinked] = useState(profile?.login_provider === "kakao");
  const navigate = useNavigate();

  const linkKakao = async () => {
    setErr(""); setMsg("");
    const { error } = await supabase.auth.linkIdentity({
      provider: "kakao",
      options: {
        redirectTo: `${window.location.origin}/uro-daily-pick/settings`,
        scopes: "talk_message",
      },
    });
    if (error) setErr(error.message);
  };

  const unlinkKakao = async () => {
    setErr(""); setMsg("");
    // Get identities
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    const kakaoIdentity = currentUser?.identities?.find(i => i.provider === "kakao");
    if (kakaoIdentity) {
      const { error } = await supabase.auth.unlinkIdentity(kakaoIdentity);
      if (error) { setErr(error.message); return; }
    }
    await supabase.from("profiles").update({
      kakao_access_token: "", kakao_refresh_token: "", login_provider: "email",
    }).eq("id", user.id);
    setKakaoLinked(false);
    setMsg("Kakao disconnected.");
  };

  const changeEmail = async () => {
    if (!newEmail.trim()) return;
    setErr(""); setMsg("");
    const { error } = await supabase.auth.updateUser({ email: newEmail.trim() });
    if (error) { setErr(error.message); return; }
    setMsg("Confirmation email sent to your new address. Check both inboxes.");
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

      {/* Kakao connection */}
      <div className="mb-5 p-4 rounded-lg border border-border bg-bg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#191919"><path d="M12 3C6.48 3 2 6.36 2 10.5c0 2.7 1.8 5.1 4.5 6.45-.15.54-.6 2.1-.69 2.43-.1.42.15.42.33.3.13-.09 2.1-1.41 2.94-1.98.6.09 1.23.15 1.92.15 5.52 0 10-3.36 10-7.5S17.52 3 12 3z"/></svg>
            <span className="text-[0.889rem] font-semibold text-text1">KakaoTalk</span>
            {kakaoLinked && <span className="text-[0.722rem] font-medium text-success bg-[rgba(52,199,89,0.08)] px-2 py-0.5 rounded">Connected</span>}
          </div>
          {kakaoLinked ? (
            <button onClick={unlinkKakao} className="text-[0.778rem] text-danger hover:underline">Disconnect</button>
          ) : (
            <button onClick={linkKakao}
              className="h-9 px-4 rounded-lg text-[0.778rem] font-semibold transition-colors"
              style={{ background: "#FEE500", color: "#191919" }}>
              Connect Kakao
            </button>
          )}
        </div>
        <p className="text-[0.722rem] text-text3 mt-2">
          {kakaoLinked ? "Daily picks will be sent to your KakaoTalk every morning." : "Connect to receive daily picks via KakaoTalk."}
        </p>
      </div>

      {msg && <p className="text-[0.889rem] text-success mb-3">{msg}</p>}
      {err && <p className="text-[0.889rem] text-danger mb-3">{err}</p>}

      {/* Change email */}
      <div className="mb-5">
        <label className="text-[0.889rem] font-semibold text-text1 block mb-2 flex items-center gap-1.5">
          <Mail size={14} />Change email
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
            placeholder="New email address" type="email"
            className={`w-full sm:flex-1 ${inputCls}`} />
          <button onClick={changeEmail}
            className="h-12 px-4 bg-accent text-white rounded-lg text-[0.889rem] font-medium hover:bg-[#0066D6] transition-colors shrink-0">
            Update
          </button>
        </div>
      </div>

      {/* Change password */}
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
