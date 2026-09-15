import { supabase } from "./supabase";
import { checked, withTimeout, appUrl } from "./data";
export const rpc = (name, args = {}) => withTimeout(checked(supabase.rpc(name, args)));
export const TERMS = {
  전립선암: "prostate cancer",
  방광암: "bladder cancer",
  신장암: "renal cancer",
  전립선비대증: "benign prostatic hyperplasia",
  요로결석: "urolithiasis",
  요실금: "urinary incontinence",
};
export function expandQuery(q) {
  return TERMS[q.trim()] || q.trim();
}
export function searchArgs(params) {
  return {
    p_query: expandQuery(params.get("q") || ""),
    p_year: Number(params.get("year")) || 2000,
    p_until: Number(params.get("until")) || 3000,
    p_journal: params.get("journal") || "",
    p_type: params.get("type") || "",
    p_state: params.get("state") || "all",
    p_sort: params.get("sort") || "recent",
    p_page: Number(params.get("page")) || 0,
    p_saved: params.get("saved") === "true",
    p_integrity: params.get("integrity") || "current",
  };
}
export function paperLink(p) {
  return "/papers/" + encodeURIComponent(p.pmid);
}
export function sharedLink(p) {
  return appUrl("papers/" + encodeURIComponent(p.pmid));
}
export function publisherLink(p) {
  return p.doi
    ? "https://doi.org/" + encodeURIComponent(p.doi)
    : "https://pubmed.ncbi.nlm.nih.gov/" + encodeURIComponent(p.pmid) + "/";
}
export function plainCitation(p) {
  return `${(p.authors || []).join(", ")}. ${p.title}. ${p.journal}. ${p.pub_date?.slice(0, 4) || ""}${p.volume ? ";" + p.volume : ""}${p.issue ? "(" + p.issue + ")" : ""}${p.pages ? ":" + p.pages : ""}. ${p.doi ? "doi:" + p.doi : "PMID: " + p.pmid}`;
}
const clean = (s) =>
  String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
const bib = (s) => clean(s).replace(/\\/g, "\\textbackslash{}").replace(/[{}]/g, "");
export function exportReferences(papers, format) {
  if (format === "ris")
    return papers
      .map((p) =>
        [
          "TY  - JOUR",
          `ID  - PMID${p.pmid}`,
          `TI  - ${clean(p.title)}`,
          ...(p.authors || []).map((a) => "AU  - " + clean(a)),
          `JO  - ${clean(p.journal)}`,
          p.pub_date && `PY  - ${p.pub_date.slice(0, 4)}`,
          p.volume && `VL  - ${clean(p.volume)}`,
          p.issue && `IS  - ${clean(p.issue)}`,
          p.pages && `SP  - ${clean(p.pages)}`,
          p.doi && `DO  - ${clean(p.doi)}`,
          `UR  - https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
          "ER  -",
        ]
          .filter(Boolean)
          .join("\r\n"),
      )
      .join("\r\n\r\n");
  return papers
    .map(
      (p) =>
        `@article{PMID${p.pmid},\n` +
        Object.entries({
          title: p.title,
          author: (p.authors || []).join(" and "),
          journal: p.journal,
          year: p.pub_date?.slice(0, 4),
          volume: p.volume,
          number: p.issue,
          pages: p.pages,
          doi: p.doi,
          url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        })
          .filter(([, v]) => v)
          .map(([k, v]) => `  ${k} = {${bib(v)}}`)
          .join(",\n") +
        "\n}",
    )
    .join("\n\n");
}
export function csv(rows) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map(
            (value) =>
              '"' +
              String(value ?? "")
                .replace(/^(\s*[=+@-]|[\t\r])/, "'$1")
                .replace(/"/g, '""') +
              '"',
          )
          .join(","),
      )
      .join("\r\n")
  );
}
export function download(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function cachedPapers(uid) {
  try {
    const items = JSON.parse(localStorage.getItem("uro-offline:" + uid) || "[]");
    return Array.isArray(items) ? items.slice(0, 100) : [];
  } catch {
    return [];
  }
}
export function cachePaper(uid, p) {
  const safe = {
    id: p.id,
    pmid: p.pmid,
    title: p.title,
    authors: p.authors,
    journal: p.journal,
    pub_date: p.pub_date,
    doi: p.doi,
    summary_ko: p.summary_ko,
    summary_basis: p.summary_basis,
    summary_source_hash: p.summary_source_hash,
    summary_model: p.summary_model,
    summarized_at: p.summarized_at,
    fulltext_available: p.fulltext_available,
    structured_data: p.structured_data,
    research_details: p.research_details,
    qa_data: p.qa_data,
    integrity_status: p.integrity_status,
    summary_review_required: p.summary_review_required,
    related_notices: p.related_notices,
    cached_at: new Date().toISOString(),
  };
  const items = [safe, ...cachedPapers(uid).filter((x) => x.pmid !== p.pmid)].slice(0, 100);
  const text = JSON.stringify(items);
  if (text.length > 1500000) throw new Error("오프라인 보관 용량을 초과했습니다. 이전 문헌을 삭제해 주세요.");
  localStorage.setItem("uro-offline:" + uid, text);
  localStorage.setItem("uro-offline-active", uid);
}
export function removeCached(uid, pmid) {
  localStorage.setItem(
    "uro-offline:" + uid,
    JSON.stringify(cachedPapers(uid).filter((p) => p.pmid !== pmid)),
  );
}
export function safeReturn(value) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\r\n]/.test(value) &&
    !value.startsWith("/login")
    ? value
    : "/";
}
