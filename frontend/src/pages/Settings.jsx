import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Save, Plus, X, Bell, Check } from "lucide-react";

const inputCls = "h-11 bg-card border border-border rounded-lg px-3 text-[1rem] text-text1 outline-none focus:border-accent transition-colors";
const sectionCls = "bg-card rounded-xl border border-border p-6 mb-6";

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
      <div className="max-w-[720px] mx-auto p-6 lg:p-10">
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
          <div className="grid grid-cols-2 gap-4 mb-5">
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
          {/* MeSH — auto-learned, read only */}
          <LearnedSection label="MeSH Terms" items={form.mesh_terms} emptyMsg="Learned from your likes and reading history" />

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
          <div className="flex gap-2 mb-4">
            <select value={newAlertType} onChange={e => setNewAlertType(e.target.value)}
              className={`${inputCls} w-auto`}>
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
      </div>
    </div>
  );
}
