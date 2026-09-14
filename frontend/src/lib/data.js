import { keywordMatches, paperMatchesKeyword } from "./keywords";

export async function checked(query) {
  const { data, error } = await withTimeout(query);
  if (error) throw error;
  return data;
}

export function jsonValue(value, fallback) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const stringList = (value) => jsonValue(value, []).filter((item) => typeof item === "string");
export const kstDate = (value = new Date()) =>
  new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
export const shiftDate = (day, offset) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export const appUrl = (path) =>
  new URL(`${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`, window.location.origin).href;

export async function allRows(queryFactory, pageSize = 500) {
  const result = [];
  for (;;) {
    const page = await checked(queryFactory().range(result.length, result.length + pageSize - 1));
    result.push(...(page || []));
    if (!page || page.length < pageSize) return result;
  }
}

export function normalizePaper(paper) {
  return {
    ...paper,
    authors: stringList(paper.authors),
    keywords: stringList(paper.keywords),
    mesh_terms: stringList(paper.mesh_terms),
    structured_data: Object.fromEntries(
      Object.entries(jsonValue(paper.structured_data, {})).filter(([, value]) => typeof value === "string"),
    ),
    qa_data: jsonValue(paper.qa_data, []).filter(
      (item) => item && typeof item.q === "string" && typeof item.a === "string",
    ),
  };
}

export function normalizeRec(rec) {
  const reasons = jsonValue(rec.reasons, {});
  const paper = normalizePaper(rec.paper);
  const oldTerms = stringList(reasons.matched_terms);
  const matched = oldTerms.filter((term) => paperMatchesKeyword(paper, term));
  const studyLabel = (paper.study_type || "").replaceAll("_", " ").toLowerCase();
  const validReason = (item) => {
    if (!item || typeof item.label !== "string") return false;
    const label = item.label.trim();
    if (label.startsWith("Alert: ") && ["keyword", "alert"].includes(item.type)) {
      const value = label.slice(7).trim();
      if (["journal", "author"].includes(item.alert_type)) {
        const text = item.alert_type === "journal" ? paper.journal || "" : paper.authors.join(" ");
        return Boolean(value) && text.toLowerCase().includes(value.toLowerCase());
      }
      if (item.alert_type === "keyword") {
        return keywordMatches(paper.title, value) || keywordMatches(paper.abstract, value);
      }
      return [paper.title, paper.abstract, paper.journal, ...paper.authors].some((text) =>
        keywordMatches(text, value),
      );
    }
    if (item.type !== "keyword") return true;
    // Historical reasons can omit matched_terms or use different casing.
    return label.toLowerCase() === studyLabel || paperMatchesKeyword(paper, label);
  };
  return {
    ...rec,
    paper,
    reasons: {
      reasons: jsonValue(reasons.reasons, []).filter(validReason),
      matched_terms: matched,
    },
  };
}

export async function withTimeout(promise, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Request timed out. Please try again.")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
