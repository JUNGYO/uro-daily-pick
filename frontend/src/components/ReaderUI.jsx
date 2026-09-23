import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ErrorNotice, Loading } from "./Status";
import { paperLink } from "../lib/workspace";
import { PaperFlowActions } from "./ReviewTransfer";
export function useResource(load, deps) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    setData(null);
    Promise.resolve()
      .then(load)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e.message || "불러오지 못했습니다.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [...deps, revision]);
  return { data, setData, error, setError, loading, reload: () => setRevision((n) => n + 1) };
}
export function Resource({ resource, children }) {
  return resource.loading ? (
    <Loading text="불러오는 중…" />
  ) : resource.error ? (
    <ErrorNotice message={resource.error} onRetry={resource.reload} retryLabel="다시 시도" />
  ) : (
    children
  );
}
export function ReaderPage({ title, description, children }) {
  return (
    <div className="reader-scroll h-full overflow-y-auto">
      <div className="reader-shell">
        <h1>{title}</h1>
        {description && <p className="reader-muted">{description}</p>}
        {children}
      </div>
    </div>
  );
}
export function StateBadge({ paper }) {
  return (
    <span className={"reader-badge " + (paper.integrity_status === "retracted" ? "danger" : "")}>
      {paper.integrity_status === "retracted"
        ? "철회된 문헌"
        : paper.summary_review_required
          ? "정정 공지 · 요약 재검토"
          : paper.summary_ready
            ? "본문 요약 제공"
            : paper.fulltext_available
              ? "원문 확보 · 요약 미제공"
              : "서지정보 등록"}
    </span>
  );
}
export function PaperCard({ paper, compare, onCompare, extra }) {
  const location = useLocation();
  return (
    <article className="reader-card">
      <div className="reader-meta">
        <StateBadge paper={paper} />
        <span>
          {paper.pub_date} · {paper.study_design || paper.study_type || "연구 유형 미분류"}
        </span>
      </div>
      <h2>
        {paper.external ? (
          paper.title
        ) : (
          <Link to={paperLink(paper)} state={{ returnTo: location.pathname + location.search }}>
            {paper.title}
          </Link>
        )}
      </h2>
      <p className="reader-muted">{paper.journal}</p>
      {paper.insight && <p>{paper.insight}</p>}
      {paper.reason && <p className="reader-muted">추천 이유 · {paper.reason}</p>}
      {paper.read && <span className="reader-badge">읽음</span>}
      {onCompare && (
        <label className="reader-check">
          <input type="checkbox" checked={compare} onChange={() => onCompare(paper.pmid)} />
          비교에 추가
        </label>
      )}
      {extra}
      <PaperFlowActions paper={paper} />
    </article>
  );
}
export function ComparisonTray({ selected, setSelected }) {
  return (
    selected.length > 0 && (
      <div className="reader-tray" role="status">
        <span>{selected.length}/5편 선택</span>
        {selected.length > 1 && (
          <Link className="btn-primary" to={"/compare?pmids=" + selected.join(",")}>
            비교하기
          </Link>
        )}
        <button className="btn-secondary" onClick={() => setSelected([])}>
          선택 해제
        </button>
      </div>
    )
  );
}
export function selectComparison(previous, id) {
  return previous.includes(id)
    ? previous.filter((x) => x !== id)
    : previous.length < 5
      ? [...previous, id]
      : previous;
}
