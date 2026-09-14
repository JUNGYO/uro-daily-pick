import { useEffect, useState, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { checked, normalizePaper } from "../lib/data";
import { ErrorNotice, Loading } from "../components/Status";
import FullTextLink from "../components/FullTextLink";
import { FolderOpen, Plus, Trash2, ExternalLink } from "lucide-react";

export default function Collections() {
  const { user } = useAuth();
  const [collections, setCollections] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [papers, setPapers] = useState([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [papersLoading, setPapersLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const active = collections.find((c) => c.id === activeId);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    checked(
      supabase
        .from("collections")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
    )
      .then((data) => {
        if (live) setCollections(data || []);
      })
      .catch(() => {
        if (live) setError("Could not load collections.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [user.id, retry]);
  useEffect(() => {
    let live = true;
    setPapers([]);
    if (activeId === null) return;
    setPapersLoading(true);
    checked(
      supabase
        .from("collection_papers")
        .select("paper:papers(*)")
        .eq("collection_id", activeId)
        .order("added_at", { ascending: false }),
    )
      .then((data) => {
        if (live) setPapers((data || []).filter((d) => d.paper).map((d) => normalizePaper(d.paper)));
      })
      .catch(() => {
        if (live) setError("Could not load papers in this collection.");
      })
      .finally(() => {
        if (live) setPapersLoading(false);
      });
    return () => {
      live = false;
    };
  }, [activeId, retry]);
  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err.message || "Could not save changes.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="page-shell max-w-4xl">
        <div className="flex justify-between items-start gap-3">
          <div>
            <h1 className="page-title mb-2">Collections</h1>
            <p className="help-text mb-6">Keep papers together for your next research question.</p>
          </div>
          <button className="btn-primary gap-2" onClick={() => setCreating(true)}>
            <Plus size={18} />
            New
          </button>
        </div>
        {error && <ErrorNotice message={error} onRetry={() => setRetry((r) => r + 1)} />}
        {creating && (
          <form
            className="panel flex flex-wrap gap-3 mb-5"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const data = await checked(
                  supabase
                    .from("collections")
                    .insert({ user_id: user.id, name: name.trim() })
                    .select()
                    .single(),
                );
                setCollections((previous) => [data, ...previous]);
                setActiveId(data.id);
                setName("");
                setCreating(false);
              });
            }}
          >
            <label className="flex-1 min-w-[160px] field-label">
              Collection name
              <input
                className="form-input mt-2"
                maxLength={80}
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="btn-primary self-end" disabled={busy || !name.trim()}>
              Create
            </button>
            <button className="btn-secondary self-end" type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        )}
        {confirmDelete && (
          <section className="panel mb-5 border-red-200" aria-label="Confirm collection deletion">
            <p className="mb-3 text-sm">
              Delete “{confirmDelete.name}” and its saved list? The original papers remain available.
            </p>
            <div className="flex gap-3">
              <button
                className="btn-danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await checked(supabase.from("collections").delete().eq("id", confirmDelete.id));
                    setCollections((previous) => previous.filter((c) => c.id !== confirmDelete.id));
                    if (activeId === confirmDelete.id) setActiveId(null);
                    setConfirmDelete(null);
                  })
                }
              >
                Delete collection
              </button>
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
            </div>
          </section>
        )}
        {loading ? (
          <Loading text="Loading collections…" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {collections.map((col) => (
              <div
                key={col.id}
                className={`panel !p-0 flex items-start ${activeId === col.id ? "border-accent" : ""}`}
              >
                <button
                  className="flex-1 text-left p-4 min-w-0"
                  disabled={busy}
                  aria-pressed={activeId === col.id}
                  onClick={() => setActiveId(col.id)}
                >
                  <FolderOpen className="text-accent mb-3" size={22} />
                  <span className="font-semibold text-sm break-words">{col.name}</span>
                </button>
                <button
                  aria-label={`Delete ${col.name}`}
                  className="p-3 text-text3 hover:text-red-700"
                  onClick={() => setConfirmDelete(col)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        )}
        {!loading && !error && !collections.length && (
          <div className="panel text-center py-12">
            <FolderOpen className="mx-auto mb-4 text-accent" />
            <h2 className="section-title">Your reading list starts here</h2>
            <p className="help-text">
              Create a collection, or like a paper in Daily Pick to save it automatically.
            </p>
          </div>
        )}
        {active && (
          <section>
            <h2 className="section-title">{active.name}</h2>
            {!papersLoading && (
              <PaperSearch
                key={active.id}
                collectionId={active.id}
                existingIds={papers.map((p) => p.id)}
                onAdded={(paper) =>
                  setPapers((previous) => [paper, ...previous.filter((p) => p.id !== paper.id)])
                }
              />
            )}
            {papersLoading ? (
              <Loading text="Loading saved papers…" />
            ) : !papers.length ? (
              <p className="panel help-text">No papers in this collection yet.</p>
            ) : (
              <ul className="space-y-3">
                {papers.map((p) => (
                  <li key={p.id} className="panel flex gap-3 items-start">
                    <div className="min-w-0 flex-1">
                      <a
                        className="font-semibold text-base hover:text-accent"
                        href={
                          p.doi
                            ? `https://doi.org/${encodeURIComponent(p.doi)}`
                            : `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {p.title}
                        <ExternalLink size={14} className="inline ml-2" />
                      </a>
                      <p className="help-text mt-2">
                        {p.journal} · {p.pub_date || "Date unavailable"}
                      </p>
                      <div className="mt-3">
                        <FullTextLink paper={p} />
                      </div>
                    </div>
                    <button
                      className="text-sm text-red-700 p-2"
                      disabled={busy}
                      aria-label={`Remove ${p.title}`}
                      onClick={() =>
                        run(async () => {
                          const id = activeId;
                          await checked(
                            supabase
                              .from("collection_papers")
                              .delete()
                              .eq("collection_id", id)
                              .eq("paper_id", p.id),
                          );
                          setPapers((previous) => previous.filter((item) => item.id !== p.id));
                        })
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function PaperSearch({ collectionId, existingIds, onAdded }) {
  const [value, setValue] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      if (mounted.current) setError("Could not complete the request. Please retry.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="panel mb-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const data = await checked(
              supabase
                .from("papers")
                .select("id,pmid,title,journal,pub_date,doi")
                .ilike("title", `%${value.trim().replace(/[%_]/g, "")}%`)
                .order("pub_date", { ascending: false })
                .limit(10),
            );
            if (mounted.current) setResults(data || []);
          });
        }}
      >
        <label className="field-label flex-1 min-w-[150px]">
          Find a paper to add
          <input
            className="form-input mt-2"
            type="search"
            maxLength={100}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search the paper catalog"
          />
        </label>
        <button className="btn-secondary" disabled={busy || value.trim().length < 3}>
          Search papers
        </button>
      </form>
      {error && <ErrorNotice message={error} />}
      {results?.length === 0 && (
        <p role="status" className="help-text mt-3">
          No matching papers. Try another title keyword.
        </p>
      )}
      {results?.length > 0 && (
        <ul className="divide-y divide-border mt-3">
          {results.map((paper) => (
            <li key={paper.id} className="flex items-start gap-3 py-3">
              <span className="min-w-0 flex-1 text-sm">{paper.title}</span>
              <button
                className="btn-secondary"
                disabled={busy || existingIds.includes(paper.id)}
                aria-label={`Add ${paper.title}`}
                onClick={() =>
                  run(async () => {
                    await checked(
                      supabase
                        .from("collection_papers")
                        .upsert(
                          { collection_id: collectionId, paper_id: paper.id },
                          { onConflict: "collection_id,paper_id" },
                        ),
                    );
                    if (mounted.current) onAdded(normalizePaper(paper));
                  })
                }
              >
                {existingIds.includes(paper.id) ? "Added" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
