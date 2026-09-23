import { supabase } from "./supabase";
import { rpc } from "./workspace";
import { fulltextOrigin } from "./fulltext";

export const uid = () => crypto.randomUUID();
export const reviewList = (project, section, query = "", filter = "", page = 0) =>
  rpc("review_list", {
    p_project: project,
    p_section: section,
    p_query: query,
    p_filter: filter,
    p_page: page,
  });
export const saveReview = (kind, project, id, revision, payload) =>
  rpc(`review_save_${kind}`, {
    p_project: project,
    p_id: id,
    p_expected_revision: revision,
    p_payload: payload,
  });
export async function reviewRequest(path, project, userId, body = {}, { signal, blob = false } = {}) {
  const configured = import.meta.env.VITE_REVIEW_ORIGIN;
  const origin = configured || (fulltextOrigin() ? `${fulltextOrigin()}/review` : "");
  if (!origin) throw new Error("연구 처리 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token || data.session.user.id !== userId)
    throw new Error("다시 로그인해 주세요.");
  const response = await fetch(`${origin}/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify({ ...body, project_id: project }),
    signal,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    const messages = {
      400: "입력 자료를 확인해 주세요.",
      401: "다시 로그인해 주세요.",
      403: "이 프로젝트의 처리 권한이 없습니다.",
      409: "자료가 변경되었습니다. 새로 불러온 뒤 다시 시도해 주세요.",
      413: "한 번에 처리할 자료가 너무 큽니다.",
      429: "요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
      503: "연구 처리 서버가 준비 중입니다. 저장한 자료는 유지됩니다.",
    };
    // Never reflect provider errors, request headers, or credentials.
    throw new Error(
      messages[response.status] ||
        "처리를 완료하지 못했습니다. 저장한 진행 상황에서 다시 시도할 수 있습니다.",
    );
  }
  return blob ? response.blob() : response.json();
}
export function catalogBibliography(p) {
  return {
    title: p.title,
    authors: p.authors || [],
    journal: p.journal || "",
    year: p.pub_date?.slice(0, 4) || "",
    date: p.pub_date || "",
    doi: p.doi || "",
    pmid: p.pmid || "",
    volume: p.volume || "",
    issue: p.issue || "",
    pages: p.pages || "",
  };
}
export async function importCatalogPage(project, papers, provenance) {
  const id = uid();
  await rpc("review_save_search", {
    p_project: project,
    p_id: id,
    p_expected_revision: 0,
    p_payload: {
      source: provenance.source,
      query: provenance.query || "",
      searched_at: provenance.searched_at || new Date().toISOString(),
      limits: provenance.limits || {},
      reported_hits: provenance.total ?? papers.length,
      status: "partial",
    },
  });
  const result = await rpc("review_import_records", {
    p_project: project,
    p_search: id,
    p_items: papers.map((p) => ({
      source_record_id: `PMID:${p.pmid}`,
      paper_id: p.id,
      bibliography: catalogBibliography(p),
    })),
  });
  // A selected page is a partial search capture, never a completed database search.
  return { ...result, search_id: id };
}
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const KIND_LABELS = {
  binary: "이분형 결과",
  continuous: "연속형 결과",
  effect: "보고된 효과값",
  diagnostic: "진단 2×2표",
  descriptive: "정성적 결과",
};
export const VALUE_FIELDS = {
  binary: [
    ["events_t", "중재군 사건 수"],
    ["n_t", "중재군 분석 인원"],
    ["events_c", "대조군 사건 수"],
    ["n_c", "대조군 분석 인원"],
  ],
  continuous: [
    ["n_t", "중재군 분석 인원"],
    ["mean_t", "중재군 평균"],
    ["sd_t", "중재군 SD"],
    ["n_c", "대조군 분석 인원"],
    ["mean_c", "대조군 평균"],
    ["sd_c", "대조군 SD"],
  ],
  effect: [
    ["estimate", "효과값 (비율 지표는 log 값)"],
    ["se", "표준오차 (효과값과 같은 척도)"],
  ],
  diagnostic: [
    ["tp", "참양성 TP"],
    ["fp", "위양성 FP"],
    ["fn", "위음성 FN"],
    ["tn", "참음성 TN"],
  ],
};
export const contextFields = [
  ["cohort", "코호트"],
  ["independence_group", "독립 표본 식별명"],
  ["outcome", "평가변수"],
  ["timepoint", "측정 시점"],
  ["comparison", "중재 / 비교군"],
  ["unit", "분석 단위"],
  ["analysis_population", "분석 집단 (ITT/PP 등)"],
  ["adjustment", "보정 여부"],
  ["covariates", "보정 변수"],
];
export const initialContext = {
  cohort: "",
  independence_group: "",
  outcome: "",
  timepoint: "",
  comparison: "",
  unit: "participant",
  direction: "lower_better",
  analysis_population: "",
  adjustment: "unadjusted",
  value_origin: "reported",
  value_type: "final",
};
export function observationPayload(form, kind, studyId, report, status) {
  const context = {};
  for (const [k] of [
    ...contextFields,
    ["direction"],
    ["value_origin"],
    ["value_type"],
    ["transformation"],
    ["index_test"],
    ["threshold"],
    ["reference_standard"],
  ])
    if (form.has(k)) context[k] = String(form.get(k));
  const values = {};
  const missing = {};
  for (const [k] of VALUE_FIELDS[kind] || []) {
    const raw = String(form.get(k) ?? "").trim();
    if (raw === "") {
      const reason = String(form.get(`missing_${k}`) || "").trim();
      if (status === "confirmed" || !reason)
        throw new Error(
          "미보고 수치는 결측 사유를 적어 초안으로 저장해 주세요. 확인 완료하려면 모든 필수 수치가 필요합니다.",
        );
      values[k] = null;
      missing[k] = reason;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("올바른 수치를 입력해 주세요.");
    values[k] = n;
  }
  if (Object.keys(missing).length) values.missing = missing;
  if (kind === "effect") {
    values.measure = String(form.get("measure"));
    values.scale = ["RR", "OR", "HR"].includes(values.measure) ? "log" : "identity";
  }
  if (kind === "descriptive") values.text = String(form.get("text") || "");
  const evidence = {
    source_hash: String(form.get("source_hash") || ""),
    source_type: String(form.get("source_type") || "fulltext"),
    source_version: String(form.get("source_version") || "1"),
    locator: String(form.get("locator") || ""),
    table: String(form.get("table") || ""),
    row: String(form.get("row") || ""),
    column: String(form.get("column") || ""),
    footnote: String(form.get("footnote") || ""),
    source_checked: form.get("source_checked") === "on",
    report_revision: report.revision,
  };
  return {
    study_id: studyId,
    report_id: report.id,
    kind,
    context,
    values,
    evidence,
    status,
    reason: String(form.get("reason") || ""),
  };
}
