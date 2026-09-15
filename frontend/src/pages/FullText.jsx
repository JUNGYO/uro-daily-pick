import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { readOriginal } from "../lib/fulltext";
import ArticleFigure from "../components/ArticleFigure";
import { ErrorNotice, Loading } from "../components/Status";

export default function FullText() {
  const { pmid } = useParams();
  const { user } = useAuth();
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [fontSize, setFontSize] = useState(17);
  const [tab, setTab] = useState("body");
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    let timedOut = false;
    setResult(null);
    setTab("body");
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
              ? "원문을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
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
        <p className="help-text mt-3 mb-5">PMID {pmid}</p>
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
            <div
              className="flex gap-2 mb-5"
              role="tablist"
              aria-label="원문 내용"
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "body"
                    : event.key === "End"
                      ? "figures"
                      : tab === "body"
                        ? "figures"
                        : "body";
                setTab(next);
                event.currentTarget.querySelector(`#${next}-tab`).focus();
              }}
            >
              <button
                role="tab"
                tabIndex={tab === "body" ? 0 : -1}
                id="body-tab"
                aria-controls="body-panel"
                aria-selected={tab === "body"}
                className={tab === "body" ? "btn-primary" : "btn-secondary"}
                onClick={() => setTab("body")}
              >
                본문
              </button>
              <button
                role="tab"
                tabIndex={tab === "figures" ? 0 : -1}
                id="figures-tab"
                aria-controls="figures-panel"
                aria-selected={tab === "figures"}
                className={tab === "figures" ? "btn-primary" : "btn-secondary"}
                onClick={() => setTab("figures")}
              >
                그림 {article.figures?.length ? `(${article.figures.length})` : ""}
              </button>
            </div>
            <div id="body-panel" role="tabpanel" aria-labelledby="body-tab" hidden={tab !== "body"}>
              <article
                aria-label="논문 본문"
                className="panel whitespace-pre-wrap break-words leading-[1.85]"
                style={{ fontSize, overflowWrap: "anywhere" }}
              >
                {article.content_text}
              </article>
            </div>
            <div id="figures-panel" role="tabpanel" aria-labelledby="figures-tab" hidden={tab !== "figures"}>
              {tab === "figures" && (
                <>
                  {article.figure_status !== "complete" && (
                    <p className="help-text mb-4">
                      그림을 준비하고 있습니다. 확보된 그림부터 확인할 수 있습니다.
                    </p>
                  )}
                  {article.figure_status === "complete" && !article.figures.length && (
                    <p className="help-text">이 논문에는 별도로 표시할 그림이 없습니다.</p>
                  )}
                  {article.figures.map((figure) => (
                    <ArticleFigure key={figure.key} figure={figure} pmid={pmid} userId={user.id} />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
