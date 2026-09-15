import { supabase } from "./supabase";
import { withTimeout } from "./data";

// Deployment-controlled public origin; never take a destination from a URL or profile.
export function fulltextOrigin() {
  const value = import.meta.env.VITE_FULLTEXT_ORIGIN || "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : "";
  } catch {
    return "";
  }
}

export function canReadOriginal(user, paper) {
  // Only a display rule. Z8 independently authorizes every request.
  return Boolean(
    fulltextOrigin() &&
    user?.email?.toLowerCase() === "crazyslime@gmail.com" &&
    paper?.fulltext_storage === "z8" &&
    /^[1-9][0-9]{0,11}$/.test(paper?.pmid),
  );
}

const messages = {
  401: "로그인이 만료됐습니다. 다시 로그인해 주세요.",
  403: "이 계정에는 저장된 원문을 열람할 권한이 없습니다.",
  404: "이 논문의 원문은 아직 보관돼 있지 않습니다.",
  429: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  503: "원문을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
};

export async function readOriginal(pmid, userId, signal) {
  const response = await originalRequest(pmid, userId, signal);
  const article = await response.json();
  if (
    article.pmid !== pmid ||
    typeof article.content_text !== "string" ||
    article.content_text.length > 2000000 ||
    typeof article.title !== "string"
  )
    throw new Error(messages[503]);
  const figures = Array.isArray(article.figures)
    ? article.figures.filter(
        (f) =>
          f &&
          /^figure-[1-9][0-9]*$/.test(f.key) &&
          typeof f.caption === "string" &&
          typeof f.label === "string" &&
          (f.status !== "ready" ||
            (/^[0-9a-f]{64}$/.test(f.asset_id) &&
              /^image\/(png|jpeg|gif|webp|tiff|bmp)$/.test(f.content_type))),
      )
    : [];
  const blocks = Array.isArray(article.blocks)
    ? article.blocks
        .filter(
          (b) =>
            b &&
            /^(p|table|figure)-[0-9]{7}$/.test(b.id) &&
            Number.isInteger(b.start) &&
            Number.isInteger(b.end) &&
            b.start >= 0 &&
            b.end > b.start &&
            b.end <= article.content_text.length &&
            b.text === article.content_text.slice(b.start, b.end),
        )
        .slice(0, 4000)
    : [];
  return { ...article, blocks, figures, figure_status: article.figure_status || "pending" };
}

export async function readOriginalImage(pmid, assetId, userId, signal) {
  if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error(messages[404]);
  const response = await originalRequest(pmid, userId, signal, `/images/${assetId}`);
  if (Number(response.headers.get("content-length") || 0) > 20 * 1024 * 1024) throw new Error(messages[503]);
  const blob = await response.blob();
  if (!/^image\/(png|jpeg|gif|webp|tiff|bmp)$/.test(blob.type) || blob.size > 20 * 1024 * 1024)
    throw new Error(messages[503]);
  return blob;
}

async function originalRequest(pmid, userId, signal, suffix = "") {
  const origin = fulltextOrigin();
  if (!origin) throw new Error("원문 연결이 아직 설정되지 않았습니다.");
  if (!/^[1-9][0-9]{0,11}$/.test(pmid)) throw new Error("올바르지 않은 논문 번호입니다.");
  const { data, error } = await withTimeout(supabase.auth.getSession());
  if (error || !data?.session?.access_token || data.session.user.id !== userId) {
    throw new Error(messages[401]);
  }
  const response = await fetch(`${origin}/v1/fulltext/${pmid}${suffix}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(messages[response.status] || messages[503]);
  return response;
}
