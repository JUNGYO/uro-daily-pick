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
  const origin = fulltextOrigin();
  if (!origin) throw new Error("원문 연결이 아직 설정되지 않았습니다.");
  if (!/^[1-9][0-9]{0,11}$/.test(pmid)) throw new Error("올바르지 않은 논문 번호입니다.");
  const { data, error } = await withTimeout(supabase.auth.getSession());
  if (error || !data?.session?.access_token || data.session.user.id !== userId) {
    throw new Error(messages[401]);
  }
  const response = await fetch(`${origin}/v1/fulltext/${pmid}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(messages[response.status] || messages[503]);
  const article = await response.json();
  if (
    article.pmid !== pmid ||
    typeof article.content_text !== "string" ||
    article.content_text.length > 2000000 ||
    typeof article.title !== "string"
  ) {
    throw new Error(messages[503]);
  }
  return article;
}
