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
const db = {
  reader_states: [],
  saved_searches: [],
  summary_issues: [],
  project_notes: [],
  collection_members: [],
  profiles: [
    {
      id: "reader",
      name: "Research reader",
      institution: "Urology Research Center",
      keywords: ["prostate", "bladder"],
      preferred_journals: ["European Urology"],
      preferred_study_types: ["rct", "meta_analysis"],
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
    range = null;
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
    gte() {
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
    order() {
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
                Object.assign(existing, row);
                return existing;
              }
              const inserted = {
                id: Date.now(),
                created_at: new Date().toISOString(),
                enabled: true,
                ...row,
              };
              db[table].push(inserted);
              return inserted;
            });
          }
          if (action === "update")
            rows.forEach((row) => Object.assign(row, payload));
          if (action === "delete")
            db[table] = db[table].filter((row) => !rows.includes(row));
          if (["collection_papers", "reader_states", "feedbacks"].includes(table))
            rows = rows.map((row) => ({
              ...row,
              paper: papers.find((p) => p.id === row.paper_id),
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
      if (name === "preview_papers")
        return { data: db.papers.filter(ready).slice(0, 3) };
      if (name === "reader_daily" && args.p_day && args.p_day !== today)
        return { data: [] };
      if (name === "reader_daily")
        return {
          data: db.papers
            .filter(
              (p) =>
                ready(p) &&
                p.integrity_status !== "retracted" &&
                !p.summary_review_required,
            )
            .slice(0, 5)
            .map((p) => ({
              ...card(p),
              reason:
                scenario === "journal-alert" ? "구독 저널 · Urol" : "관심 주제",
            })),
        };
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
                access: { can_read: scenario.startsWith("admin") },
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
        Object.assign(s, args.p_patch);
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
          });
        return { data: null };
      }
      if (name === "search_papers") {
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
          matches = matches.filter((p) => p.journal === args.p_journal);
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
      if (name === "project_papers") {
        const items = db.collection_papers
          .filter((c) => c.collection_id === args.p_id)
          .map((c) => ({
            ...card(db.papers.find((p) => p.id === c.paper_id)),
            ...db.project_notes.find(
              (n) =>
                n.collection_id === c.collection_id &&
                n.paper_id === c.paper_id,
            ),
          }));
        return { data: { items, total: items.length, can_edit: true } };
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
          });
      }
      if (name === "delete_own_account") {
        db.profiles = [];
        return {};
      }
      if (name === "admin_fulltext_status")
        return {
          data: {
            ready_bodies: 5,
            local_bodies: 5,
            ready_summaries: 5,
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
