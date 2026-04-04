import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { FolderPlus, Trash2, FileText } from "lucide-react";

export default function Collections() {
  const { user } = useAuth();
  const [cols, setCols] = useState([]);
  const [activeCol, setActiveCol] = useState(null);
  const [papers, setPapers] = useState([]);
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase.from("collections").select("*").eq("user_id", user.id).order("created_at", { ascending: false })
      .then(({ data }) => setCols(data || []));
  }, [user]);

  const create = async () => {
    if (!newName.trim() || !user) return;
    const { data } = await supabase.from("collections").insert({ user_id: user.id, name: newName.trim() }).select().single();
    if (data) setCols(p => [data, ...p]);
    setNewName(""); setShowCreate(false);
  };

  const select = async (col) => {
    setActiveCol(col);
    const { data } = await supabase
      .from("collection_papers")
      .select("paper:papers(*)")
      .eq("collection_id", col.id);
    setPapers((data || []).map(d => d.paper));
  };

  const remove = async (id) => {
    await supabase.from("collections").delete().eq("id", id);
    setCols(p => p.filter(c => c.id !== id));
    if (activeCol?.id === id) { setActiveCol(null); setPapers([]); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto p-6 lg:p-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[1.333rem] font-bold text-text1">Collections</h1>
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 h-10 px-5 bg-accent text-white rounded-lg text-[0.889rem] font-medium hover:bg-[#0066D6] transition-colors">
            <FolderPlus size={16} />New
          </button>
        </div>

        {showCreate && (
          <div className="flex gap-2 mb-6">
            <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && create()}
              placeholder="Collection name" autoFocus
              className="flex-1 h-11 bg-card border border-border rounded-lg px-4 text-[1rem] text-text1 outline-none focus:border-accent" />
            <button onClick={create} className="h-11 px-5 bg-success text-white rounded-lg text-[0.889rem] font-medium">Create</button>
            <button onClick={() => setShowCreate(false)} className="h-11 px-4 text-text3 text-[0.889rem]">Cancel</button>
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
          {cols.map(col => (
            <div key={col.id} onClick={() => select(col)}
              className={`p-4 rounded-xl border cursor-pointer transition-colors
                ${activeCol?.id === col.id ? "border-accent bg-[rgba(0,122,255,0.04)]" : "border-border bg-card hover:border-text3"}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="w-3 h-3 rounded-full" style={{ background: col.color }} />
                <button onClick={e => { e.stopPropagation(); remove(col.id); }} className="text-text3 hover:text-danger transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
              <h3 className="text-[0.889rem] font-semibold text-text1">{col.name}</h3>
            </div>
          ))}
          {!cols.length && (
            <div className="col-span-full flex flex-col items-center py-12">
              <div className="w-16 h-16 rounded-2xl bg-hover flex items-center justify-center mb-4">
                <FolderPlus size={28} className="text-text3" />
              </div>
              <p className="text-[1rem] font-semibold text-text1 mb-1">No collections yet</p>
              <p className="text-[0.833rem] text-text3 mb-4">Like papers in Daily Pick to auto-save them.</p>
              <button onClick={() => setShowCreate(true)}
                className="h-10 px-5 bg-accent text-white rounded-lg text-[0.833rem] font-medium hover:bg-[#0066D6] transition-colors">
                Create collection
              </button>
            </div>
          )}
        </div>

        {activeCol && (
          <div>
            <h2 className="text-[1rem] font-semibold text-text1 mb-3">{activeCol.name}</h2>
            {!papers.length
              ? <p className="text-[0.889rem] text-text3 text-center py-8 bg-hover rounded-lg">No papers yet — like papers in Daily Pick to save them here.</p>
              : papers.map(p => (
                <div key={p.pmid} className="flex items-center gap-3 p-3 bg-card border border-border rounded-lg mb-2">
                  <FileText size={16} className="text-text3 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[0.889rem] font-medium text-text1 truncate">{p.title}</div>
                    <div className="text-[0.778rem] text-text3">{p.journal} · {p.pub_date}</div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
