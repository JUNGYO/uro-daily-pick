import { stringList } from "./data";

const STOP = new Set([
  "humans",
  "male",
  "female",
  "aged",
  "middle aged",
  "aged, 80 and over",
  "adult",
  "young adult",
  "adolescent",
  "child",
  "animals",
  "treatment outcome",
  "follow-up studies",
  "time factors",
  "prognosis",
  "risk factors",
  "retrospective studies",
  "prospective studies",
  "cohort studies",
  "prevalence",
  "incidence",
  "survival rate",
  "survival analysis",
  "proportional hazards models",
  "multivariate analysis",
  "logistic models",
  "predictive value of tests",
  "sensitivity and specificity",
  "reproducibility of results",
  "reference values",
  "risk assessment",
  "united states",
  "europe",
  "japan",
  "korea",
  "china",
  "journal article",
  "research support",
  "english abstract",
  "comparative study",
  "multicenter study",
  "randomized controlled trial",
  "evaluation study",
  "clinical trial",
  "practice guideline",
  "meta-analysis",
  "systematic review",
  "review",
  "case reports",
  "editorial",
  "letter",
  "comment",
]);

export const normalizeTopicTerm = (value) =>
  typeof value === "string"
    ? value
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/[‐‑‒–—−]/g, "-")
        .replace(/\s+/g, " ")
    : "";

// Only explicit metadata aliases are merged; related diseases and methods stay distinct.
const GROUPS = [
  [
    "prostatic neoplasms",
    "전립선 종양",
    ["prostate cancer", "prostate neoplasm", "prostate neoplasms", "prostatic neoplasms"],
  ],
  [
    "urinary bladder neoplasms",
    "방광 종양",
    ["bladder cancer", "urinary bladder cancer", "bladder neoplasms", "urinary bladder neoplasms"],
  ],
  ["kidney neoplasms", "신장 종양", ["renal cancer", "kidney cancer", "kidney neoplasms"]],
  ["renal cell carcinoma", "신세포암", ["rcc", "renal cell carcinoma", "carcinoma, renal cell"]],
  [
    "prostatic hyperplasia",
    "전립선 비대증",
    ["bph", "benign prostatic hyperplasia", "prostatic hyperplasia"],
  ],
  ["artificial intelligence", "인공지능", ["ai", "artificial intelligence"]],
];
const ALIASES = new Map(
  GROUPS.flatMap(([id, label, values]) => values.map((value) => [value, { id, label }])),
);
const UNCLASSIFIED = { id: "unclassified", label: "미분류", source: "No topic metadata", sources: [] };

export function paperTopics(paper = {}) {
  const topics = new Map();
  for (const [field, source] of [
    ["mesh_terms", "MeSH"],
    ["keywords", "Keywords"],
  ]) {
    for (const value of stringList(paper[field])) {
      const term = normalizeTopicTerm(value);
      if (!term || STOP.has(term) || term.length < 2 || term.length > 100) continue;
      const topic = ALIASES.get(term) || { id: term, label: term };
      const previous = topics.get(topic.id);
      const sources = [...new Set([...(previous?.sources || []), source])];
      topics.set(topic.id, { ...topic, sources, source: sources.join(" + ") });
    }
  }
  return topics.size ? [...topics.values()] : [{ ...UNCLASSIFIED }];
}

const METHODS = [
  ["rct", "무작위 대조시험", ["rct", "randomized controlled trial", "randomised controlled trial"]],
  ["retrospective", "후향적 연구", ["retrospective", "retrospective study", "retrospective studies"]],
  ["prospective", "전향적 연구", ["prospective", "prospective study", "prospective studies"]],
  ["cohort", "코호트 연구", ["cohort", "cohort study", "cohort studies"]],
  ["case_control", "환자-대조군 연구", ["case control", "case-control study", "case-control studies"]],
  ["cross_sectional", "단면 연구", ["cross sectional", "cross-sectional study", "cross-sectional studies"]],
  ["meta_analysis", "메타분석", ["meta analysis", "meta-analysis"]],
  ["systematic_review", "체계적 문헌고찰", ["systematic review"]],
  ["review", "문헌고찰", ["review"]],
  ["guideline", "진료지침", ["guideline", "practice guideline"]],
  ["case_report", "증례보고", ["case report", "case reports"]],
  ["basic_research", "기초 연구", ["basic research"]],
];
const METHOD_ALIASES = new Map(
  METHODS.flatMap(([id, label, values]) => values.map((value) => [value, { id, label }])),
);

function describedMethod(value) {
  const text = normalizeTopicTerm(value).replaceAll("_", " ");
  const exact = METHOD_ALIASES.get(text);
  if (exact) return exact;
  // Study-design descriptions may add setting/population after a known design.
  // Restrict recognition to the leading design phrase, including modifiers.
  const lead = text.replace(
    /^(?:(?:a|an|multicenter|multicentre|single-center|single-centre|international|double-blind|open-label)\s+){1,4}/,
    "",
  );
  let id;
  if (/^(?:systematic review\b|meta-analysis\b)/.test(lead) && /\bmeta-analysis\b/.test(lead))
    id = "meta_analysis";
  else if (/^(?:(?:prospective|retrospective)[, ]+)?randomi[sz]ed controlled (?:trial|study)\b/.test(lead))
    id = "rct";
  else if (/^systematic review\b/.test(lead)) id = "systematic_review";
  else if (/^retrospective (?:cohort|observational|comparative|chart review|study|analysis)\b/.test(lead))
    id = "retrospective";
  else if (/^prospective (?:cohort|observational|comparative|study|analysis)\b/.test(lead))
    id = "prospective";
  else if (/^cohort (?:study|analysis)\b/.test(lead)) id = "cohort";
  else if (/^case-control (?:study|analysis)\b/.test(lead)) id = "case_control";
  else if (/^cross-sectional (?:study|analysis|survey)\b/.test(lead)) id = "cross_sectional";
  const definition = METHODS.find(([key]) => key === id);
  return definition ? { id: definition[0], label: definition[1] } : null;
}

export function studyMethod(paper = {}) {
  for (const [value, source] of [
    [paper.study_design || paper.structured_data?.study_design, "연구 설계 메타데이터"],
    [paper.study_type, "연구 유형 메타데이터"],
    ...stringList(paper.publication_types).map((value) => [value, "출판 유형 메타데이터"]),
  ]) {
    const method = describedMethod(value);
    if (method) return { ...method, source };
  }
  return { id: "unclassified", label: "미분류", source: "확인된 연구 방법 메타데이터 없음" };
}
