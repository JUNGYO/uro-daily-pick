import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { readOriginal } from "../lib/fulltext";
import { ErrorNotice, Loading } from "../components/Status";

export default function FullText() {
  const { pmid } = useParams();
  const { user } = useAuth();
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [fontSize, setFontSize] = useState(17);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    let timedOut = false;
    setResult(null);
    setError("");
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 25000);
    readOriginal(pmid, user.id, controller.signal)
      .then((article) => {
        if (live) setResult({ article, userId: user.id, pmid });
      })
      .catch((err) => {
        if (live)
          setError(
            timedOut || err instanceof TypeError
              ? "Z8에 연결하지 못했습니다. Z8이 켜져 있고 인터넷에 연결돼 있는지 확인해 주세요."
              : err.message || "원문을 불러오지 못했습니다.",
          );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [pmid, user.id, retry]);
  // Clear previous content immediately on a route or authenticated identity change.
  const article = result?.userId === user.id && result?.pmid === pmid ? result.article : null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="page-shell max-w-4xl">
        <Link to="/" className="text-accent underline text-sm">
          Daily Pick으로 돌아가기
        </Link>
        <h1 className="page-title mt-5 break-words">{article?.title || "원문 보기"}</h1>
        <p className="help-text mt-3 mb-5">PMID {pmid} · Z8에 보관된 원문</p>
        {error ? (
          <ErrorNotice message={error} onRetry={() => setRetry((n) => n + 1)} />
        ) : !article ? (
          <Loading text="로그인 권한을 확인하고 원문을 불러오는 중…" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 mb-6">
              <label className="text-sm flex items-center gap-2">
                글자 크기
                <select
                  className="form-input !w-auto"
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                >
                  <option value={15}>작게</option>
                  <option value={17}>보통</option>
                  <option value={20}>크게</option>
                </select>
              </label>
              {article.doi && (
                <a
                  className="text-sm text-accent underline"
                  href={`https://doi.org/${encodeURIComponent(article.doi)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  출판사 원문
                </a>
              )}
            </div>
            <p className="help-text mb-5">
              읽기 편하게 추출한 본문입니다. 그림과 원래 지면 배치는 출판사 원문에서 확인할 수 있습니다.
            </p>
            <article
              aria-label="논문 본문"
              className="panel whitespace-pre-wrap break-words leading-[1.85]"
              style={{ fontSize, overflowWrap: "anywhere" }}
            >
              {article.content_text}
            </article>
          </>
        )}
      </div>
    </div>
  );
}
