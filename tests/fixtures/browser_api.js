const scenario =
  new URLSearchParams(location.search).get("scenario") || "reader";
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
let user =
  scenario === "signed-out"
    ? null
    : {
        id: "reader",
        email: scenario.startsWith("admin")
          ? "crazyslime@gmail.com"
          : "reader@example.test",
      };
let listener = () => {};
let catalogAttempt = 0;
let detailFailed = false,
  stateFailed = false;
const papers = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  pmid: String(12345670 + i),
  title: [
    "Personalized treatment strategies for localized prostate cancer: a randomized trial",
    "Long-term outcomes after robotic partial nephrectomy in patients with renal tumors",
    "A multicenter evaluation of biomarkers for early detection of bladder cancer",
    "Patient-reported quality of life after treatment for advanced prostate cancer",
    "Imaging surveillance in urologic oncology: a systematic review",
  ][i],
  journal: [
    "European Urology",
    "Journal of Urology",
    "BJU International",
    "European Urology Oncology",
    "Nature Reviews Urology",
  ][i],
  authors: ["Lee J", "Kim S", "Park H"],
  pub_date: today,
  study_type: ["rct", "surgical", "biomarker", "prospective", "meta_analysis"][
    i
  ],
  paper_type: "article",
  abstract:
    "This simulated research abstract is used only to verify the application interface. Participants were evaluated using prespecified clinical outcomes and patient-reported measures. The findings support further investigation, with interpretation limited by follow-up duration and the selected population. ".repeat(
      3,
    ),
  doi: "10.0000/test",
  keywords: ["prostate", "clinical outcomes"],
  mesh_terms: ["Prostatic Neoplasms"],
  fulltext_available: true,
  fulltext_storage: "z8",
  summary_basis: "fulltext",
  summary_source_hash: "a".repeat(64),
  summary_model: "fixture",
  summarized_at: new Date().toISOString(),
  summary_ko:
    "이 내용은 화면 검증을 위한 가상 연구 요약입니다.\n연구 결과와 대상자 정보는 원문에서 확인할 수 있습니다.\n임상 적용에는 연구의 한계와 환자 상황을 함께 고려해야 합니다.",
  structured_data: {
    study_design: "Randomized trial (fixture)",
    sample_size: "Not reported",
    key_finding: "Simulated result for interface review",
    population: "Research participants",
  },
  clinical_relevance: 4,
  qa_data: [
    {
      q: "이 연구의 주요 한계는 무엇인가요?",
      a: "이 화면은 가상 데이터를 사용한 테스트입니다.",
    },
  ],
}));
if (scenario === "reading-evidence" || scenario === "reading-evidence-no-access") {
  Object.assign(papers[0], {
    structured_data: {
      study_design: "Predictive biomarker analysis using discovery and validation cohorts from two randomized controlled trials (interface fixture)",
      sample_size: "255 participants in the discovery cohort and 563 in the validation cohort",
      population: "Patients with localized high-risk prostate cancer and no or minimal comorbidity",
      key_finding: "A prespecified interaction was evaluated across the two study cohorts. This is simulated content for interface testing.",
    },
    research_details: {
      intervention: "Radiotherapy combined with systemic treatment (interface fixture)",
      comparator: "Standard treatment (interface fixture)",
      follow_up: "Median follow-up of 10.36 years and 10.55 years",
      outcome: "All-cause mortality",
      limitations: "Limited representation across population groups; postrandomization analysis requires prospective validation.",
    },
    evidence: {
      content_hash: "a".repeat(64),
      claims: {
        summary_1: ["p-0000001"], summary_2: ["p-0000002", "table-0000001"],
        summary_3: ["p-0000003"], study_design: ["p-0000001", "p-0000004"],
        sample_size: ["p-0000002"], population: ["p-0000004"],
        key_finding: ["p-0000002", "figure-0000001"], limitations: ["p-0000003"],
        qa_1: ["p-0000003"],
      },
    },
  });
}
const db = {
  reader_states: [],
  saved_searches: [],
  summary_issues: [],
  project_notes: [],
  collection_members: [],
  research_workspaces: [],
  research_reference_entries: [],
  research_topic_entries: [],
  research_document_exports: [],
  profiles: [
    {
      id: "reader",
      name: "Research reader",
      institution: "Urology Research Center",
      keywords: ["prostate", "bladder"],
      preferred_journals: ["European Urology"],
      preferred_study_types: ["rct", "meta_analysis"],
      personalization_enabled: true,
      email_digest: true,
      digest_frequency: "daily",
      onboarding_done: scenario !== "onboarding",
    },
  ],
  papers: scenario === "empty" ? [] : papers,
  recommendations:
    scenario === "empty"
      ? []
      : papers.map((paper, i) => ({
          id: i + 1,
          user_id: "reader",
          paper_id: paper.id,
          rec_date: today,
          score: 9 - i,
          reasons: {
            personalization_enabled: true,
            reasons: [
              { type: "keyword", label: "prostate" },
              { type: "fresh", label: "Recent publication" },
            ],
            matched_terms: ["prostate"],
          },
          paper,
        })),
  feedbacks: [],
  read_history: [
    {
      id: 1,
      user_id: "reader",
      paper_id: 1,
      clicked_at: new Date().toISOString(),
    },
  ],
  collections: [
    {
      id: 1,
      user_id: "reader",
      name: "Journal club",
      created_at: new Date().toISOString(),
    },
  ],
  collection_papers: [{ collection_id: 1, paper_id: 2 }],
  alerts: [
    {
      id: 1,
      user_id: "reader",
      alert_type: "keyword",
      value: "bladder",
      is_active: true,
    },
  ],
};
const researchScenario = scenario.startsWith("research-");
const researchColumns = [
  { id: "population", label: "Population", instruction: "Describe study participants" },
  { id: "outcome", label: "Outcome", instruction: "Extract the principal outcome" },
];
function ensureResearchReference(collectionId, paperId) {
  const existing = db.research_reference_entries.find(
    (r) => r.collection_id === collectionId && r.paper_id === paperId,
  );
  if (existing) return existing;
  const paper = db.papers.find((p) => p.id === paperId);
  if (!paper) return null;
  const note = db.project_notes.find((n) => n.collection_id === collectionId && n.paper_id === paperId);
  const row = {
    id: Math.max(0, ...db.research_reference_entries.map((r) => r.id)) + 1,
    collection_id: collectionId,
    paper_id: paperId,
    bibliography: Object.fromEntries(["pmid", "title", "authors", "journal", "pub_date", "doi", "volume", "issue", "pages"].map((key) => [key, paper[key] ?? ""])),
    auto_values: {}, user_values: {}, evidence: {}, note: note?.note || "", tags: note?.tags || [],
    revision: 0, extraction_status: "not_requested", source_content_hash: null, extracted_at: null,
    created_at: new Date(Date.now() + paperId * 60000).toISOString(),
  };
  db.research_reference_entries.push(row);
  return row;
}
if (researchScenario) {
  db.papers = Array.from({ length: 26 }, (_, i) => ({
    ...papers[i % papers.length], id: i + 1, pmid: String(52345000 + i),
    title: `Research study ${String(i + 1).padStart(2, "0")}`,
    doi: `10.0000/research-${i + 1}`, fulltext_available: i !== 25,
  }));
  db.collections[0].name = "Research fixture project";
  if (scenario === "research-reader") db.collections[0].user_id = "project-owner";
  db.reader_states = db.papers.map((p, i) => ({
    user_id: "reader", paper_id: p.id, saved: i !== 0,
    reading_state: i === 2 ? "read" : i === 3 ? "reading" : "unread",
    note: i === 0 ? "Unsaved needle memo" : `Reading journal entry ${i + 1}`,
    tags: i === 0 ? ["unsaved-needle"] : ["review"],
    updated_at: new Date(Date.now() + i * 60000).toISOString(),
    read_at: null, saved_at: null,
  }));
  db.feedbacks = [{ user_id: "reader", paper_id: 5, action: "like" }];
  db.collection_papers = db.papers.map((p) => ({
    collection_id: 1, paper_id: p.id, added_at: new Date(Date.now() + p.id * 60000).toISOString(),
  }));
  db.project_notes = db.papers.map((p) => ({
    collection_id: 1, paper_id: p.id,
    note: p.id === 1 ? "Project needle rationale" : `Team entry ${p.id}`,
    tags: p.id === 1 ? ["special-cohort"] : ["team"], updated_by: "reader",
  }));
  db.research_workspaces = [{ collection_id: 1, question: "", template: "general", columns: researchColumns, revision: 0 }];
  for (const p of db.papers) {
    const ref = ensureResearchReference(1, p.id);
    if (p.fulltext_available) Object.assign(ref, {
      auto_values: { population: `Automatic cohort ${p.id}`, outcome: `Source outcome ${p.id}` },
      evidence: { population: ["p-0000001"], outcome: ["table-0000002"] },
      source_content_hash: "a".repeat(64), extracted_at: new Date().toISOString(), extraction_status: "complete",
    });
  }
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
if (scenario.startsWith("insights-")) {
  const metadata = [
    { keywords: ["prostate cancer", "prostate neoplasms"], mesh_terms: ["Prostatic Neoplasms", "Humans"] },
    { keywords: ["RCC"], mesh_terms: ["Carcinoma, Renal Cell"] },
    { keywords: ["bladder cancer"], mesh_terms: ["Urinary Bladder Neoplasms"] },
    { keywords: ["prostate cancer"], mesh_terms: ["Prostatic Neoplasms"] },
    { keywords: ["AI", "prostate cancer"], mesh_terms: ["Artificial Intelligence", "Prostatic Neoplasms"] },
  ];
  db.papers.forEach((paper, index) => Object.assign(paper, metadata[index]));
  db.papers.push({ ...papers[0], id: 6, pmid: "12345679", title: "Legacy completed paper without a known date" });
  db.reader_states = [
    { user_id: "reader", paper_id: 1, reading_state: "read", read_at: ago(2), saved: false, saved_at: null,
      note: "Verified first-paper memo", tags: ["follow-up"], updated_at: ago(0) },
    { user_id: "reader", paper_id: 3, reading_state: "unread", read_at: null, saved: true, saved_at: ago(4),
      note: "Saved bladder source", tags: ["biomarkers"], updated_at: ago(0) },
    { user_id: "reader", paper_id: 6, reading_state: "read", read_at: null, saved: false, saved_at: null,
      note: "A recent note edit is not a completion date", tags: [], updated_at: ago(0) },
  ];
  db.read_history = [{ id: 1, user_id: "reader", paper_id: 2, dwell_seconds: 10, clicked_at: ago(0) }];
  db.feedbacks = [{ id: 1, user_id: "reader", paper_id: 4, action: "like", created_at: ago(1) }];
  const qualified = scenario === "insights-qualified";
  for (const rec of db.recommendations) {
    rec.reasons.network = {
      status: qualified ? "qualified" : "insufficient", min_similar_readers: 3,
      min_shared_likes: 2, min_paper_support: 3, min_topic_papers: 2,
      ...(qualified ? { cohort_size: 4 } : {}),
      topics: qualified ? [{ id: "prostatic neoplasms", label: "prostatic neoplasms", reader_support: 3, paper_support: 2, source: "metadata" }] : [],
    };
    rec.reasons.reasons = [{ type: "keyword", label: rec.paper.keywords[0] }];
    if (qualified && rec.paper_id === 5) rec.reasons.reasons.unshift({
      type: "similar_readers", label: "비슷한 독자 3명이 좋아한 문헌", support: 3, cohort_size: 4,
    });
  }
}
if (scenario === "research-network" || scenario === "research-network-reader") {
  if (scenario === "research-network-reader") db.collections[0].user_id = "project-owner";
  db.papers.forEach((paper, index) => Object.assign(paper, {
    keywords: [index % 2 ? "bladder cancer" : "prostate cancer"],
    mesh_terms: [index % 2 ? "Urinary Bladder Neoplasms" : "Prostatic Neoplasms", "Humans"],
    publication_types: [],
  }));
  Object.assign(db.papers.find((paper) => paper.id === 24), { study_type: "surgical", structured_data: {} });
  Object.assign(db.papers.find((paper) => paper.id === 25), { summary_basis: "abstract" });
  db.research_topic_entries = [
    { id: 1, collection_id: 1, section: "discussion", title: "Validation needs independent evidence",
      body: "User-authored interpretation linked to retained sources.", reference_ids: [1, 25],
      cell_links: [{ reference_id: 25, column_id: "population" }], revision: 1 },
    { id: 2, collection_id: 1, section: "introduction", title: "Compare methods without equating conclusions",
      body: "These are related topics, not demonstrated causal relationships.", reference_ids: [24], cell_links: [], revision: 1 },
  ];
}
function enrichedReference(reference) {
  const paper = db.papers.find((paper) => paper.id === reference.paper_id);
  return {
    ...reference,
    paper: paper ? {
      id: paper.id, pmid: paper.pmid, title: paper.title,
      keywords: paper.keywords, mesh_terms: paper.mesh_terms,
      publication_types: paper.publication_types || [], study_type: paper.study_type,
      study_design: paper.structured_data?.study_design || null,
      fulltext_available: paper.fulltext_available,
      summary_ready: paper.fulltext_available === true && paper.summary_basis === "fulltext",
      integrity_status: paper.integrity_status || "unknown",
    } : null,
  };
}
function applyReaderTransition(state, patch, inserted = false) {
  const before = { ...state }, now = new Date().toISOString();
  Object.assign(state, patch);
  state.read_at = state.reading_state !== "read" ? null
    : inserted || before.reading_state !== "read" ? now : before.read_at ?? null;
  state.saved_at = !state.saved ? null : inserted || !before.saved ? now : before.saved_at ?? null;
  state.updated_at = now;
}
function applyProfileUpdate(profile, patch) {
  const previous = profile.personalization_enabled;
  Object.assign(profile, patch);
  if (profile.personalization_enabled !== previous)
    db.recommendations = db.recommendations.filter((rec) => rec.user_id !== profile.id);
}
const isResearchReader = () => ["research-reader", "research-network-reader"].includes(scenario);
globalThis.__uroFixtureSnapshot = () => structuredClone(db);
let researchConflict = scenario === "research-conflict";
function researchRpc(name, args) {
  const result = (data) => ({ data: structuredClone(data), error: null });
  const error = (code, message) => ({ data: null, error: { code, message } });
  const readOnly = isResearchReader();
  const ref = db.research_reference_entries.find((r) => r.id === args.p_id);
  const collectionId = ["save_research_reference", "request_research_extraction"].includes(name) ? ref?.collection_id : args.p_collection_id ?? args.p_id;
  const project = db.collections.find((p) => p.id === collectionId);
  if (name.startsWith("save_") || name.startsWith("delete_") || name.startsWith("request_") || name.startsWith("add_")) {
    if (readOnly) return error("42501", "Project editor required");
  }
  const workspace = db.research_workspaces.find((w) => w.collection_id === collectionId) || {
    collection_id: collectionId, question: "", template: "general", columns: researchColumns, revision: 0,
  };
  if (name === "research_workspace") return result({ workspace, can_edit: !readOnly });
  if (name === "save_research_workspace") {
    if (researchConflict) {
      researchConflict = false; workspace.revision += 1; workspace.question = "A collaborator saved a newer question";
    }
    if (args.p_expected_revision !== workspace.revision) return error("40001", "Workspace changed; reload before saving");
    Object.assign(workspace, { question: args.p_question, template: args.p_template, columns: args.p_columns, revision: workspace.revision + 1 });
    if (!db.research_workspaces.includes(workspace)) db.research_workspaces.push(workspace);
    for (const r of db.research_reference_entries.filter((r) => r.collection_id === collectionId && r.extraction_status !== "not_requested")) r.extraction_status = "stale";
    return result(workspace);
  }
  if (name === "research_references") {
    const q = (args.p_query || "").toLowerCase(), page = args.p_page || 0;
    const matches = db.research_reference_entries.filter((r) => r.collection_id === collectionId &&
      (!q || `${JSON.stringify(r.bibliography)} ${r.note} ${r.tags.join(" ")}`.toLowerCase().includes(q))).sort((a, b) => b.id - a.id);
    return result({ items: matches.slice(page * 20, (page + 1) * 20).map(enrichedReference), total: matches.length, page, can_edit: !readOnly });
  }
  if (name === "research_graph") {
    const query = (args.p_query || "").trim().toLowerCase(), limit = args.p_limit ?? 50;
    if (!project) return error("42501", "Project access required");
    if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return error("22023", "Invalid graph scope");
    const topics = db.research_topic_entries.filter((topic) => topic.collection_id === collectionId).sort((a, b) => a.id - b.id);
    const visibleTopics = topics.slice(0, 20);
    const linked = (ref) => visibleTopics.some((topic) => topic.reference_ids.includes(ref.id));
    const matches = db.research_reference_entries.filter((ref) => ref.collection_id === collectionId &&
      (!query || `${JSON.stringify(ref.bibliography)} ${ref.note} ${ref.tags.join(" ")}`.toLowerCase().includes(query)))
      .sort((a, b) => Number(linked(b)) - Number(linked(a)) || b.created_at.localeCompare(a.created_at) || b.id - a.id);
    return result({ references: matches.slice(0, limit).map(enrichedReference), topics: visibleTopics,
      total: matches.length, topic_total: topics.length, limit, truncated: matches.length > limit || topics.length > 20 });
  }
  if (name === "add_research_reference") return result(ensureResearchReference(collectionId, args.p_paper_id));
  if (name === "save_research_reference") {
    if (!ref || ref.revision !== args.p_expected_revision) return error("40001", "Reference changed; reload before saving");
    Object.assign(ref, { user_values: args.p_user_values, note: args.p_note, tags: args.p_tags, revision: ref.revision + 1 });
    const note = db.project_notes.find((n) => n.collection_id === ref.collection_id && n.paper_id === ref.paper_id);
    if (note) Object.assign(note, { note: ref.note, tags: ref.tags });
    return result(ref);
  }
  if (name === "research_topics") {
    const page = args.p_page || 0;
    const matches = db.research_topic_entries.filter((t) => t.collection_id === collectionId &&
      (!args.p_section || args.p_section === "all" || t.section === args.p_section));
    return result({ items: matches.slice(page * 20, (page + 1) * 20).map((t) => ({ ...t, references: db.research_reference_entries.filter((r) => t.reference_ids.includes(r.id)).map((r) => ({ id: r.id, bibliography: r.bibliography })) })), total: matches.length, page });
  }
  if (name === "save_research_topic") {
    let topic = db.research_topic_entries.find((t) => t.id === args.p_id);
    if (topic && topic.revision !== args.p_expected_revision) return error("40001", "Topic changed; reload before saving");
    if (!topic) {
      topic = { id: Math.max(0, ...db.research_topic_entries.map((t) => t.id)) + 1, collection_id: args.p_collection_id, revision: 0 };
      db.research_topic_entries.push(topic);
    }
    Object.assign(topic, { section: args.p_section, title: args.p_title, body: args.p_body, reference_ids: args.p_reference_ids, cell_links: args.p_cell_links || [], revision: topic.revision + 1 });
    return result(topic);
  }
  if (name === "delete_research_topic") {
    const topic = db.research_topic_entries.find((t) => t.id === args.p_id);
    if (!topic || topic.revision !== args.p_expected_revision) return error("40001", "Topic changed; reload before deleting");
    db.research_topic_entries = db.research_topic_entries.filter((t) => t !== topic);
    return result(null);
  }
  if (name === "request_research_extraction") {
    if (!ref) return error("42501", "Project editor required");
    const paper = db.papers.find((p) => p.id === ref.paper_id);
    ref.extraction_status = paper?.fulltext_available ? "queued" : "waiting_source";
    if (paper?.fulltext_available) setTimeout(() => {
      ref.auto_values = Object.fromEntries(workspace.columns.map((c) => [c.id, `Refreshed ${c.label} from original`]));
      ref.evidence = Object.fromEntries(workspace.columns.map((c) => [c.id, ["p-0000001"]]));
      ref.source_content_hash = "b".repeat(64); ref.extracted_at = new Date().toISOString(); ref.extraction_status = "complete";
    }, 100);
    return result({ status: ref.extraction_status });
  }
  if (name === "research_export_snapshot") {
    const snapshot = structuredClone({
      project: { id: project.id, name: project.name }, workspace,
      references: db.research_reference_entries.filter((r) => r.collection_id === collectionId),
      topics: db.research_topic_entries.filter((t) => t.collection_id === collectionId),
    });
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot))).then((hash) => result({
      ...snapshot, generated_at: new Date().toISOString(),
      export_fingerprint: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      revision_manifest: {
        references: snapshot.references.map((r) => ({ id: r.id, revision: r.revision })),
        topics: snapshot.topics.map((t) => ({ id: t.id, revision: t.revision })),
      },
    }));
  }
  if (name === "record_research_export") {
    const existing = db.research_document_exports.find((e) => e.export_id === args.p_export_id);
    const row = {
      export_id: args.p_export_id, collection_id: collectionId, created_by: "reader", format: args.p_format,
      workspace_revision: args.p_workspace_revision, fingerprint: args.p_fingerprint, manifest: args.p_manifest,
      reference_count: args.p_manifest.references.length, topic_count: args.p_manifest.topics.length, url: args.p_url ?? null,
    };
    if (existing) {
      const { created_at: _created, ...payload } = existing;
      return JSON.stringify(payload) === JSON.stringify(row) ? result(existing) : error("23505", "Export identifier already used");
    }
    row.created_at = new Date().toISOString(); db.research_document_exports.push(row); return result(row);
  }
  if (name === "research_document_exports") {
    const page = args.p_page || 0;
    const matches = db.research_document_exports.filter((e) => e.collection_id === collectionId && e.created_by === "reader").slice().reverse();
    return result({ items: matches.slice(page * 20, (page + 1) * 20), total: matches.length, page });
  }
  return undefined;
}
if (scenario === "search-filters") {
  const dates = [
    "2025-01-10",
    "2025-01-20",
    "2025-01-09",
    "2025-01-21",
    "2025-01-15",
  ];
  const titles = [
    "Prostate boundary start",
    "Prostate boundary end",
    "Prostate before interval",
    "Prostate after interval",
    "Prostate other journal",
  ];
  db.papers = papers.map((p, i) => ({
    ...p,
    title: titles[i],
    pub_date: dates[i],
    journal: i === 4 ? "European Urology Oncology" : "European Urology",
  }));
  db.papers.push(
    ...Array.from({ length: 21 }, (_, i) => ({
      ...papers[0],
      id: 100 + i,
      pmid: String(22345670 + i),
      title: `Prostate interval article ${i + 1}`,
      pub_date: "2025-01-15",
    })),
  );
  db.saved_searches = [
    {
      id: 1,
      name: "Legacy journal search",
      query: "boundary",
      enabled: true,
      filters: { year: 2025, until: 2025, journal: "European Urology" },
    },
  ];
}
if (scenario === "ai-regression") {
  Object.assign(papers[0], {
    title: "DNA mismatch repair in Veterans Affairs",
    abstract:
      "The role of DNA mismatch repair (MMR) remains incompletely defined. Available findings require further trials.",
    keywords: [],
    mesh_terms: [],
  });
  Object.assign(papers[1], {
    title: "AI-assisted diagnosis",
    abstract: "An AI tool was evaluated. Its role in repair remains uncertain.",
    keywords: [],
    mesh_terms: [],
  });
  for (const rec of db.recommendations) {
    rec.reasons = {
      matched_terms: ["AI"],
      reasons: [{ type: "keyword", label: "ai" }],
    };
  }
}
if (scenario === "journal-alert") {
  db.recommendations = [];
  db.read_history = [];
  db.profiles[0].keywords = [];
  db.profiles[0].preferred_journals = [];
  db.profiles[0].preferred_study_types = [];
  db.alerts = [
    {
      id: 1,
      user_id: "reader",
      alert_type: "journal",
      value: "Urol",
      is_active: true,
    },
  ];
}
if (scenario === "stale-picks") {
  for (const paper of papers) {
    paper.fetched_at = "2026-03-01";
    paper.pub_date = "2026-03-01";
  }
  const pending = {
    ...papers[0],
    id: 99,
    title: "Recent paper without a full text",
    fulltext_available: false,
    summary_basis: "abstract",
  };
  db.papers = [...papers, pending];
  db.recommendations = [
    db.recommendations[0],
    {
      id: 99,
      user_id: "reader",
      paper_id: 99,
      paper: pending,
      rec_date: today,
      score: 99,
    },
  ];
  db.read_history = [];
  db.feedbacks = [{ user_id: "reader", paper_id: 1, action: "like" }];
}
function query(table) {
  let action = "select",
    payload,
    single = false,
    filters = [],
    range = null,
    orderBy = null;
  const q = {
    select() {
      return q;
    },
    single() {
      single = true;
      return q;
    },
    eq(k, v) {
      filters.push((row) => row[k] === v);
      return q;
    },
    gte(k, v) {
      filters.push((row) => row[k] != null && row[k] >= v);
      return q;
    },
    lte(k, v) {
      filters.push((row) => row[k] != null && row[k] <= v);
      return q;
    },
    in(k, values) {
      filters.push((row) => values.includes(row[k]));
      return q;
    },
    ilike(k, v) {
      filters.push((row) =>
        row[k]?.toLowerCase().includes(v.replaceAll("%", "").toLowerCase()),
      );
      return q;
    },
    order(key, options = {}) {
      orderBy = [key, options.ascending !== false];
      return q;
    },
    limit(n) {
      range = [0, n];
      return q;
    },
    range(a, b) {
      range = [a, b + 1];
      return q;
    },
    upsert(data) {
      action = "upsert";
      payload = data;
      return q;
    },
    insert(data) {
      action = "insert";
      payload = data;
      return q;
    },
    update(data) {
      action = "update";
      payload = data;
      return q;
    },
    delete() {
      action = "delete";
      return q;
    },
    then(resolve, reject) {
      return Promise.resolve()
        .then(() => {
          if (scenario === "error")
            return { data: null, error: { message: "Simulated API outage" } };
          let rows = (db[table] || []).filter((row) =>
            filters.every((fn) => fn(row)),
          );
          if (action === "insert" || action === "upsert") {
            rows = (Array.isArray(payload) ? payload : [payload]).map((row) => {
              const existing =
                action === "upsert"
                  ? db[table].find((x) =>
                      table === "profiles"
                        ? x.id === row.id
                        : x.collection_id === row.collection_id &&
                          x.paper_id === row.paper_id,
                    )
                  : null;
              if (existing) {
                if (table === "profiles") applyProfileUpdate(existing, row);
                else if (table === "reader_states") applyReaderTransition(existing, row);
                else Object.assign(existing, row);
                if (table === "project_notes") {
                  const ref = ensureResearchReference(row.collection_id, row.paper_id);
                  if (ref) Object.assign(ref, { note: row.note, tags: row.tags, revision: ref.revision + 1 });
                }
                return existing;
              }
              const inserted = {
                id: Date.now(),
                created_at: new Date().toISOString(),
                enabled: true,
                ...row,
              };
              if (table === "profiles" && inserted.personalization_enabled == null) inserted.personalization_enabled = true;
              if (table === "reader_states") applyReaderTransition(inserted, {}, true);
              db[table].push(inserted);
              if (table === "collection_papers") ensureResearchReference(row.collection_id, row.paper_id);
              if (table === "project_notes") {
                const ref = ensureResearchReference(row.collection_id, row.paper_id);
                if (ref) Object.assign(ref, { note: row.note, tags: row.tags, revision: ref.revision + 1 });
              }
              return inserted;
            });
          }
          if (action === "update")
            rows.forEach((row) => {
              if (table === "profiles") applyProfileUpdate(row, payload);
              else if (table === "reader_states") applyReaderTransition(row, payload);
              else Object.assign(row, payload);
            });
          if (action === "delete")
            db[table] = db[table].filter((row) => !rows.includes(row));
          if (orderBy) {
            const [key, ascending] = orderBy;
            rows.sort((a, b) => (ascending ? 1 : -1) * String(a[key] ?? "").localeCompare(String(b[key] ?? "")));
          }
          if (
            ["collection_papers", "reader_states", "feedbacks", "read_history", "recommendations"].includes(table)
          )
            rows = rows.map((row) => ({
              ...row,
              paper: db.papers.find((p) => p.id === row.paper_id),
            }));
          if (range) rows = rows.slice(...range);
          return {
            data: single ? rows[0] || null : rows.map((row) => ({ ...row })),
            error: null,
          };
        })
        .then(resolve, reject);
    },
  };
  return q;
}
export const supabase = {
  from: query,
  auth: {
    getSession: async () => ({
      data: {
        session: user ? { user, access_token: "fixture.access.token" } : null,
      },
    }),
    onAuthStateChange(fn) {
      listener = fn;
      return {
        data: {
          subscription: {
            unsubscribe() {
              listener = () => {};
            },
          },
        },
      };
    },
    signOut: async () => {
      user = null;
      listener("SIGNED_OUT", null);
      return {};
    },
    signInWithPassword: async () => ({}),
    signInWithOAuth: async () => ({
      error: { message: "Provider test: redirect prepared" },
    }),
    signUp: async () => ({ data: { session: null } }),
    resetPasswordForEmail: async () => ({}),
    updateUser: async () => ({}),
  },
  rpc(name, args = {}) {
    const result = (async () => {
      const ready = (p) =>
        p.fulltext_available && p.summary_basis === "fulltext";
      const state = (id) =>
        db.reader_states.find((s) => s.paper_id === id) || {};
      const card = (p) => ({
        ...p,
        summary_ready: ready(p),
        insight: ready(p) ? p.summary_ko.split("\n")[1] : "",
        read: state(p.id).reading_state === "read",
      });
      if (scenario === "error")
        return { error: { message: "Simulated API outage" } };
      if (/^(research_|save_research_|add_research_|delete_research_|request_research_|record_research_)/.test(name)) {
        const research = researchRpc(name, args);
        if (research !== undefined) return research;
      }
      if (name === "search_library") {
        const term = (args.p_query || "").trim().toLowerCase(), tab = args.p_tab || "all", page = args.p_page || 0;
        const matches = db.papers.filter((p) => {
          const s = state(p.id), liked = db.feedbacks.some((f) => f.paper_id === p.id && f.user_id === "reader" && f.action === "like");
          if (!s.paper_id && !liked) return false;
          if (tab === "saved" && !s.saved || tab === "liked" && !liked || ["read", "reading"].includes(tab) && s.reading_state !== tab || tab === "notes" && !s.note?.trim() && !s.tags?.length) return false;
          return !term || `${p.title} ${p.pmid} ${p.doi} ${s.note || ""} ${(s.tags || []).join(" ")}`.toLowerCase().includes(term);
        }).sort((a, b) => String(state(b.id).updated_at || "").localeCompare(String(state(a.id).updated_at || "")) || b.id - a.id);
        return { data: { items: matches.slice(page * 20, (page + 1) * 20).map((p) => ({ ...card(p), note: state(p.id).note || "", tags: state(p.id).tags || [], saved: !!state(p.id).saved, reading_state: state(p.id).reading_state || "unread" })), total: matches.length, page } };
      }
      if (name === "reader_daily" && args.p_day && args.p_day !== today)
        return { data: [] };
      if (name === "reader_daily") {
        const profile = db.profiles.find((profile) => profile.id === user?.id) || {};
        const valid = (paper) => ready(paper) && paper.pub_date >= "2000-01-01" &&
          paper.integrity_status !== "retracted" && !paper.summary_review_required &&
          !db.feedbacks.some((feedback) => feedback.user_id === user?.id && feedback.paper_id === paper.id && feedback.action === "dislike");
        const stored = db.recommendations.filter((rec) => rec.user_id === user?.id && rec.rec_date === (args.p_day || today) &&
          (profile.personalization_enabled !== false || rec.reasons?.personalization_enabled === false))
          .sort((a, b) => b.score - a.score).map((rec) => db.papers.find((paper) => paper.id === rec.paper_id)).filter((paper) => paper && valid(paper));
        const seen = new Set(stored.map((paper) => paper.id));
        const candidates = db.papers.filter((paper) => valid(paper) && !seen.has(paper.id) && state(paper.id).reading_state !== "read" &&
          !["letter", "editorial", "comment", "erratum"].includes(paper.paper_type));
        return {
          data: [...stored, ...candidates].slice(0, 5).map((p) => ({
              ...card(p),
              reason:
                scenario === "journal-alert" ? "구독 저널 · Urol" : "관심 주제",
            })),
        };
      }
      if (name === "reader_paper") {
        if (scenario === "slow-daily")
          await new Promise((r) =>
            setTimeout(r, args.p_pmid === "12345671" ? 900 : 100),
          );
        if (
          scenario === "daily-detail-error" &&
          args.p_pmid === "12345670" &&
          !detailFailed
        ) {
          detailFailed = true;
          return { error: { message: "문헌을 불러오지 못했습니다." } };
        }
        const paper = db.papers.find((p) => p.pmid === args.p_pmid);
        return {
          data: paper
            ? {
                paper,
                state: state(paper.id),
                opinion: db.feedbacks.find((f) => f.paper_id === paper.id)
                  ?.action,
                access: { can_read: scenario.startsWith("admin") || scenario === "reading-evidence" },
                issues: db.summary_issues.filter(
                  (i) => i.paper_id === paper.id,
                ),
              }
            : null,
        };
      }
      if (name === "update_reader_state") {
        if (scenario === "slow-daily")
          await new Promise((r) => setTimeout(r, 500));
        if (
          scenario === "daily-state-error" &&
          args.p_patch.saved &&
          !stateFailed
        ) {
          stateFailed = true;
          return {
            error: { message: "저장하지 못했습니다. 다시 시도해 주세요." },
          };
        }
        let s = db.reader_states.find((s) => s.paper_id === args.p_paper_id);
        if (!s) {
          s = {
            user_id: "reader",
            paper_id: args.p_paper_id,
            saved: false,
            reading_state: "unread",
            position: 0,
            note: "",
            tags: [],
          };
          db.reader_states.push(s);
        }
        applyReaderTransition(s, args.p_patch);
        return { data: { ...s } };
      }
      if (name === "reader_opinion") {
        if (scenario === "feedback-error")
          return { error: { message: "Simulated save failure" } };
        db.feedbacks = db.feedbacks.filter(
          (f) => f.paper_id !== args.p_paper_id,
        );
        if (args.p_action !== "none")
          db.feedbacks.push({
            paper_id: args.p_paper_id,
            user_id: "reader",
            action: args.p_action,
            created_at: new Date().toISOString(),
          });
        return { data: null };
      }
      if (name === "search_journals") {
        const term = (args.p_query || "").toLowerCase();
        const journals = new Set();
        for (const p of db.papers) {
          if (p.journal.toLowerCase().includes(term)) journals.add(p.journal);
        }
        return {
          data: [...journals]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 30)
            .map((name) => ({ name })),
        };
      }
      if (name === "search_papers" || name === "search_papers_v2") {
        const term = (args.p_query || "")
          .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
          .toLowerCase();
        let matches = db.papers.filter(
          (p) =>
            !term ||
            p.pmid === term ||
            p.doi === term ||
            term
              .split(/\s+/)
              .every((t) =>
                new RegExp(
                  "\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
                  "i",
                ).test(p.title + " " + p.abstract),
              ),
        );
        if (args.p_state === "ready") matches = matches.filter(ready);
        if (args.p_state === "pending")
          matches = matches.filter((p) => !ready(p));
        if (args.p_journal)
          matches = matches.filter(
            (p) => p.journal.toLowerCase() === args.p_journal.toLowerCase(),
          );
        const from = args.p_from || `${args.p_year || 2000}-01-01`,
          to = args.p_to || `${args.p_until || 3000}-12-31`;
        matches = matches.filter((p) => p.pub_date >= from && p.pub_date <= to);
        if (args.p_type)
          matches = matches.filter((p) => p.study_type === args.p_type);
        if (args.p_integrity === "retracted")
          matches = matches.filter((p) => p.integrity_status === "retracted");
        else if (args.p_integrity !== "all")
          matches = matches.filter((p) => p.integrity_status !== "retracted");
        if (args.p_sort !== "relevance")
          matches.sort(
            (a, b) =>
              (args.p_sort === "oldest" ? 1 : -1) *
              (a.pub_date.localeCompare(b.pub_date) || a.id - b.id),
          );
        const page = args.p_page || 0;
        return {
          data: {
            items: matches.slice(page * 20, page * 20 + 20).map(card),
            total: matches.length,
            page,
          },
        };
      }
      if (name === "search_notifications")
        return {
          data: db.saved_searches.map((s) => ({
            ...s,
            new_count: s.enabled ? 1 : 0,
            last_seen_at: s.last_seen_at || new Date().toISOString(),
          })),
        };
      if (name === "project_invitations") return { data: [] };
      if (name === "project_papers" || name === "project_papers_v2") {
        const term = (args.p_query || "").trim().toLowerCase(), page = args.p_page || 0;
        const items = db.collection_papers
          .filter((c) => c.collection_id === args.p_id)
          .sort((a, b) => String(b.added_at || "").localeCompare(String(a.added_at || "")) || b.paper_id - a.paper_id)
          .map((c) => ({
            ...card(db.papers.find((p) => p.id === c.paper_id)),
            ...db.project_notes.find(
              (n) =>
                n.collection_id === c.collection_id &&
                n.paper_id === c.paper_id,
            ),
          })).filter((p) => !term || `${p.title} ${p.pmid} ${p.doi} ${p.note || ""} ${(p.tags || []).join(" ")}`.toLowerCase().includes(term));
        return { data: { items: items.slice(page * 20, (page + 1) * 20), total: items.length, page, can_edit: !isResearchReader() } };
      }
      if (name === "project_recommendations")
        return {
          data: db.papers
            .filter(
              (p) =>
                !db.collection_papers.some(
                  (c) => c.collection_id === args.p_id && c.paper_id === p.id,
                ),
            )
            .map(card),
        };
      if (name === "project_members") {
        if (args.p_email)
          db.collection_members.push({
            collection_id: args.p_id,
            user_id: "guest",
            email: args.p_email,
            role: args.p_role,
            accepted: false,
          });
        if (args.p_remove)
          db.collection_members = db.collection_members.filter(
            (m) => m.user_id !== args.p_remove,
          );
        return {
          data: db.collection_members.filter(
            (m) => m.collection_id === args.p_id,
          ),
        };
      }
      if (name === "admin_summary_issues") {
        if (args.p_id)
          Object.assign(
            db.summary_issues.find((i) => i.id === args.p_id),
            { status: args.p_status, resolution: args.p_resolution },
          );
        return {
          data: db.summary_issues.map((i) => ({
            ...i,
            ...{
              title: db.papers.find((p) => p.id === i.paper_id)?.title,
              pmid: db.papers.find((p) => p.id === i.paper_id)?.pmid,
            },
          })),
        };
      }
      if (name === "set_paper_feedback") {
        if (scenario === "feedback-error")
          return { error: { message: "Simulated save failure" } };
        db.feedbacks = db.feedbacks.filter(
          (f) => f.paper_id !== args.p_paper_id,
        );
        if (args.p_action !== "none")
          db.feedbacks.push({
            user_id: "reader",
            paper_id: args.p_paper_id,
            action: args.p_action,
            created_at: new Date().toISOString(),
          });
      }
      if (name === "delete_own_account") {
        db.profiles = [];
        return {};
      }
      if (name === "admin_worker_status")
        return {
          data: {
            workers: [
              {
                name: "Z8",
                state: "idle",
                last_seen_at: new Date().toISOString(),
              },
            ],
          },
          error: null,
        };
      if (
        name === "admin_catalog_status" &&
        scenario === "admin-partial-error" &&
        catalogAttempt++ === 0
      )
        return { error: { code: "57014", message: "Simulated query timeout" } };
      if (name === "admin_catalog_status")
        return {
          data: {
            counts_available: scenario !== "admin-counts-initializing",
            counts_updated_at: scenario === "admin-counts-initializing" ? null : "2026-09-18T01:00:00.000Z",
            catalog_papers: 5,
            automatic_papers: 4,
            originals_acquired: 3,
            summaries_ready: 2,
            undated_papers: 0,
            archived_papers: 1,
            qwen_summaries: 4,
            awaiting_qwen: 0,
            oldest_publication: "1937-11-01",
            newest_publication: "2026-09-14",
            metadata_examined: 5,
            metadata_unavailable: 0,
            ...(["admin-local-catalog", "admin-counts-initializing"].includes(scenario) ? {
              local_catalog: {
                available: true,
                stale: false,
                reported_at: new Date().toISOString(),
                registry_version: "fixture-local-catalog",
                local_papers: 200,
                synced_papers: 4,
                citation_pending: 196,
                local_originals: 35,
                local_summaries: 18,
                pending_originals: 32,
                pending_summaries: 16,
                sync_state: "capacity_blocked",
                last_sync_at: new Date().toISOString(),
              },
            } : {}),
            ...(scenario === "admin-counts-initializing" ? {
              catalog_papers: null,
              automatic_papers: null,
              originals_acquired: null,
              summaries_ready: null,
              undated_papers: null,
              archived_papers: null,
            } : {}),
            storage: {
              database_bytes: 450 * 1048576,
              budget_bytes: 450 * 1048576,
            },
          },
          error: null,
        };
      if (name === "admin_stats")
        return {
          data: {
            total_users: 3,
            total_papers: 5,
            total_feedbacks: 0,
            total_reads: 1,
          },
          error: null,
        };
      return { data: name.startsWith("admin_") ? [] : null, error: null };
    })();
    result.abortSignal = () => result;
    return result;
  },
};
