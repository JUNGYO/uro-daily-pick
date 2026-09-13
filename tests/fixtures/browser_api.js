const scenario = new URLSearchParams(location.search).get("scenario") || "reader";
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
let user =
  scenario === "signed-out"
    ? null
    : { id: "reader", email: scenario === "admin" ? "crazyslime@gmail.com" : "reader@example.test" };
let listener = () => {};
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
  study_type: ["rct", "surgical", "biomarker", "prospective", "meta_analysis"][i],
  paper_type: "article",
  abstract:
    "This simulated research abstract is used only to verify the application interface. Participants were evaluated using prespecified clinical outcomes and patient-reported measures. The findings support further investigation, with interpretation limited by follow-up duration and the selected population. ".repeat(
      3,
    ),
  doi: "10.0000/test",
  keywords: ["prostate", "clinical outcomes"],
  mesh_terms: ["Prostatic Neoplasms"],
  summary_basis: i === 0 ? "fulltext" : "abstract",
  summary_ko:
    "이 내용은 화면 검증을 위한 가상 연구 요약입니다.\n연구 결과와 대상자 정보는 원문에서 확인할 수 있습니다.\n임상 적용에는 연구의 한계와 환자 상황을 함께 고려해야 합니다.",
  structured_data: {
    study_design: "Randomized trial (fixture)",
    sample_size: "Not reported",
    key_finding: "Simulated result for interface review",
    population: "Research participants",
  },
  clinical_relevance: 4,
  qa_data: [{ q: "이 연구의 주요 한계는 무엇인가요?", a: "이 화면은 가상 데이터를 사용한 테스트입니다." }],
}));
const db = {
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
  read_history: [{ id: 1, user_id: "reader", paper_id: 1, clicked_at: new Date().toISOString() }],
  collections: [{ id: 1, user_id: "reader", name: "Journal club", created_at: new Date().toISOString() }],
  collection_papers: [{ collection_id: 1, paper_id: 2 }],
  alerts: [{ id: 1, user_id: "reader", alert_type: "keyword", value: "bladder", is_active: true }],
};
if (scenario === "ai-regression") {
  Object.assign(papers[0], {
    title: "DNA mismatch repair in Veterans Affairs",
    abstract: "The role of DNA mismatch repair (MMR) remains incompletely defined. Available findings require further trials.",
    keywords: [], mesh_terms: [],
  });
  Object.assign(papers[1], {
    title: "AI-assisted diagnosis",
    abstract: "An AI tool was evaluated. Its role in repair remains uncertain.",
    keywords: [], mesh_terms: [],
  });
  for (const rec of db.recommendations) {
    rec.reasons = { matched_terms: ["AI"], reasons: [{ type: "keyword", label: "ai" }] };
  }
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
      filters.push((row) => row[k]?.toLowerCase().includes(v.replaceAll("%", "").toLowerCase()));
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
      action = "insert";
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
          if (scenario === "error") return { data: null, error: { message: "Simulated API outage" } };
          let rows = (db[table] || []).filter((row) => filters.every((fn) => fn(row)));
          if (action === "insert") {
            rows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ id: Date.now(), ...row }));
            db[table].push(...rows);
          }
          if (action === "update") rows.forEach((row) => Object.assign(row, payload));
          if (action === "delete") db[table] = db[table].filter((row) => !rows.includes(row));
          if (table === "collection_papers")
            rows = rows.map((row) => ({ ...row, paper: papers.find((p) => p.id === row.paper_id) }));
          if (range) rows = rows.slice(...range);
          return { data: single ? rows[0] || null : rows.map((row) => ({ ...row })), error: null };
        })
        .then(resolve, reject);
    },
  };
  return q;
}
export const supabase = {
  from: query,
  auth: {
    getSession: async () => ({ data: { session: user ? { user } : null } }),
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
    signUp: async () => ({ data: { session: null } }),
    resetPasswordForEmail: async () => ({}),
    updateUser: async () => ({}),
  },
  async rpc(name, args) {
    if (name === "set_paper_feedback") {
      if (scenario === "feedback-error") return { error: { message: "Simulated save failure" } };
      db.feedbacks = db.feedbacks.filter((f) => f.paper_id !== args.p_paper_id);
      if (args.p_action !== "none")
        db.feedbacks.push({ user_id: "reader", paper_id: args.p_paper_id, action: args.p_action });
    }
    if (name === "delete_own_account") {
      db.profiles = [];
      return {};
    }
    if (name === "admin_stats")
      return { data: { total_users: 3, total_papers: 5, total_feedbacks: 0, total_reads: 1 }, error: null };
    return { data: name.startsWith("admin_") ? [] : null, error: null };
  },
};
