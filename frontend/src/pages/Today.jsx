import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Bookmark, Check, ChevronLeft, ChevronRight, List, X, ExternalLink } from "lucide-react";
import { kstDate, normalizeRec, shiftDate } from "../lib/data";
import { keywordPattern } from "../lib/keywords";
import { paperLink, publisherLink, sharedLink, plainCitation } from "../lib/workspace";
import { hasFulltextSummary } from "../lib/summary";
import { useAuth } from "../lib/auth";
import { useDailyReader } from "../lib/useDailyReader";
import { useReading } from "../lib/useReading";
import { Resource, StateBadge } from "../components/ReaderUI";
import { EvidenceLinks, IntegrityNotice, SummaryContent, StudyContent } from "../components/ReadingContent";
import "../today.css";

const TYPE_LABELS = {
  rct: "무작위시험",
  meta_analysis: "메타분석",
  review: "종설",
  systematic_review: "체계적 문헌고찰",
  retrospective: "후향적 연구",
  prospective: "전향적 연구",
  surgical: "수술 연구",
  biomarker: "바이오마커",
};
const REASON_LABELS = {
  keyword: "관심 주제",
  mesh: "관련 주제",
  journal: "관심 저널",
  author: "관심 저자",
  fresh: "최근 발표",
  review: "종설",
  learned: "읽기 선호",
  reading_pattern: "읽기 선호",
  alert: "구독",
};

function Highlight({ text, terms }) {
  const re = keywordPattern(terms);
  if (!re) return text;
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function validDay(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
    value >= "2000-01-01" &&
    value <= kstDate() &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export default function Today() {
  const { user } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const day = validDay(params.get("date")) ? params.get("date") : kstDate();
  const r = useDailyReader(user.id, day, params.get("paper"));
  const [listOpen, setListOpen] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const scrollRef = useRef(null),
    titleRef = useRef(null),
    focusNext = useRef(false),
    queueRef = useRef(null),
    listToggleRef = useRef(null);
  const selected = r.selected;
  // Never display another article's content or actions during a selection change.
  const data = r.detail.data?.paper?.pmid === selected?.pmid ? r.detail.data : null;
  const rec = data ? normalizeRec({ paper: data.paper, reasons: r.reasons[data.paper.id] }) : null;
  const p = rec?.paper,
    state = data?.state || {};
  const returnTo = location.pathname + location.search;
  const readCount = r.cards.filter((c) =>
    r.states[c.id] ? r.states[c.id].reading_state === "read" : c.read,
  ).length;
  useReading(user.id, p?.id, false, state.position);

  function choose(i) {
    if (!r.cards[i]) return;
    const next = new URLSearchParams(params);
    next.set("date", day);
    next.set("paper", r.cards[i].pmid);
    setListOpen(false);
    focusNext.current = true;
    setParams(next, { replace: true });
  }
  function changeDay(value) {
    if (!validDay(value)) return;
    const next = new URLSearchParams(params);
    next.set("date", value);
    next.delete("paper");
    setListOpen(false);
    setParams(next, { replace: true });
  }
  useEffect(() => {
    setShareMessage("");
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (p && focusNext.current) {
      titleRef.current?.focus({ preventScroll: true });
      focusNext.current = false;
    }
  }, [p?.pmid]);
  useEffect(() => {
    function keydown(e) {
      if (e.key === "Escape" && listOpen) {
        e.preventDefault();
        setListOpen(false);
        listToggleRef.current?.focus();
        return;
      }
      if (
        e.isComposing ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.target.closest("input,textarea,select,button,a,summary,[contenteditable=true]")
      )
        return;
      if (e.key.toLowerCase() === "j" || e.key === "ArrowRight") {
        e.preventDefault();
        choose(r.index + 1);
      }
      if (e.key.toLowerCase() === "k" || e.key === "ArrowLeft") {
        e.preventDefault();
        choose(r.index - 1);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [r.index, r.cards, day, params, listOpen]);
  useEffect(() => {
    if (listOpen) queueRef.current?.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
  }, [listOpen]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const resize = () => {
      if (media.matches) setListOpen(false);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  async function share(citation = false) {
    try {
      if (!citation && navigator.share) await navigator.share({ title: p.title, url: sharedLink(p) });
      else {
        await navigator.clipboard.writeText(citation ? plainCitation(p) : sharedLink(p));
        setShareMessage(citation ? "인용문을 복사했습니다." : "논문 주소를 복사했습니다.");
      }
    } catch (e) {
      if (e.name !== "AbortError") setShareMessage("복사하지 못했습니다. 다시 시도해 주세요.");
    }
  }
  const evidence = (claim) => (
    <EvidenceLinks paper={p} claim={claim} canRead={data?.access?.can_read} returnTo={returnTo} />
  );

  return (
    <div className="today-page reader-shell">
      <header className="today-header">
        <div className="today-heading">
          <h1>오늘 읽기</h1>
          <span className="reader-muted">하루의 문헌, 한 편씩</span>
        </div>
        <div className="today-date">
          <button
            className="today-icon"
            aria-label="이전 날짜"
            disabled={day <= "2000-01-01"}
            onClick={() => changeDay(shiftDate(day, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <label className="sr-only" htmlFor="reading-date">
            추천 날짜
          </label>
          <input
            id="reading-date"
            type="date"
            value={day}
            min="2000-01-01"
            max={kstDate()}
            onChange={(e) => changeDay(e.target.value)}
          />
          <button
            className="today-icon"
            aria-label="다음 날짜"
            disabled={day >= kstDate()}
            onClick={() => changeDay(shiftDate(day, 1))}
          >
            <ChevronRight size={18} />
          </button>
          {day !== kstDate() && (
            <button className="today-text-button" onClick={() => changeDay(kstDate())}>
              오늘
            </button>
          )}
        </div>
      </header>
      <Resource resource={r.queue}>
        {r.cards.length ? (
          <div className="today-workspace">
            <aside
              className={"today-queue " + (listOpen ? "is-open" : "")}
              aria-label="오늘의 논문 목록"
              id="today-queue"
              ref={queueRef}
            >
              <div className="today-queue-heading">
                <h2>오늘의 {r.cards.length}편</h2>
                <span>
                  {readCount}/{r.cards.length} 읽음
                </span>
              </div>
              <progress aria-label="오늘 추천 읽기 진행" max={r.cards.length} value={readCount} />
              <ol className="today-list">
                {r.cards.map((c, i) => {
                  const s = r.states[c.id] || (c.id === p?.id ? state : {});
                  const read = s.reading_state ? s.reading_state === "read" : c.read;
                  return (
                    <li key={c.id}>
                      <button
                        className={"today-queue-item " + (i === r.index ? "is-selected" : "")}
                        aria-current={i === r.index ? "true" : undefined}
                        onClick={() => choose(i)}
                      >
                        <span className="today-queue-number">
                          {read ? <Check size={15} aria-label="읽음" /> : String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="today-queue-copy">
                          <span className="today-journal">{c.journal}</span>
                          <span className="today-queue-title">{c.title}</span>
                          <span className="today-queue-meta">
                            {TYPE_LABELS[c.study_type] ||
                              c.study_design ||
                              (c.study_type || "문헌").replaceAll("_", " ")}
                            {s.saved && <span> · 저장됨</span>}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <div className="today-queue-links">
                <Link to="/discover">문헌 탐색</Link>
                <Link to="/collections">연구 프로젝트</Link>
                <Link to="/insights">읽기 기록</Link>
              </div>
              <p className="today-shortcuts">J / K 또는 ← / → 로 이전·다음</p>
            </aside>
            <div className="today-reader">
              <div className="today-position">
                <span aria-live="polite">
                  {r.index + 1} / {r.cards.length}편{" "}
                  <span className="reader-muted">· {readCount}편 읽음</span>
                </span>
                <button
                  className="today-list-toggle"
                  aria-controls="today-queue"
                  ref={listToggleRef}
                  aria-expanded={listOpen}
                  onClick={() => setListOpen(!listOpen)}
                >
                  <List size={16} /> {listOpen ? "목록 닫기" : "논문 목록"}
                </button>
                <Link className="today-desktop-link" to="/library">
                  내 서재
                </Link>
              </div>
              <div
                className="today-detail reader-scroll"
                ref={scrollRef}
                inert={listOpen ? "" : undefined}
                aria-hidden={listOpen || undefined}
              >
                <Resource resource={{ ...r.detail, loading: r.detail.loading || (!data && !r.detail.error) }}>
                  {p && (
                    <article key={p.pmid} aria-label="선택한 논문" className="today-article">
                      <div className="reader-meta">
                        <StateBadge paper={{ ...p, summary_ready: hasFulltextSummary(p) }} />
                        <span>
                          {p.journal} · {p.pub_date}
                        </span>
                      </div>
                      <h2 className="today-paper-title" ref={titleRef} tabIndex={-1}>
                        <Link to={paperLink(p)} state={{ returnTo }}>
                          <Highlight text={p.title} terms={rec.reasons.matched_terms} />
                        </Link>
                      </h2>
                      <p className="today-authors">
                        {p.authors.slice(0, 5).join(", ")}
                        {p.authors.length > 5 ? " 외" : ""} · PMID {p.pmid}
                      </p>
                      <div className="today-reasons" aria-label="추천 이유">
                        {rec.reasons.reasons.length ? (
                          <>
                            <span>추천 이유</span>
                            {rec.reasons.reasons.slice(0, 4).map((reason, i) => (
                              <span className="today-reason" key={i}>
                                {REASON_LABELS[reason.type] || "추천"}
                                {!["fresh", "review"].includes(reason.type) && ` · ${reason.label}`}
                              </span>
                            ))}
                          </>
                        ) : (
                          <span>추천 이유 · {selected.reason || "선정된 오늘의 문헌"}</span>
                        )}
                      </div>
                      <IntegrityNotice paper={p} />
                      <SummaryContent paper={p} evidence={evidence} abstract={false} />
                      <details className="today-study">
                        <summary>
                          연구 상세 · Q&A {p.qa_data.length > 0 && <span>{p.qa_data.length}</span>}
                        </summary>
                        <StudyContent paper={p} evidence={evidence} />
                      </details>
                      {p.abstract && (
                        <details>
                          <summary>초록 보기</summary>
                          <p className="whitespace-pre-wrap">
                            <Highlight text={p.abstract} terms={rec.reasons.matched_terms} />
                          </p>
                        </details>
                      )}
                      <div className="today-secondary-actions">
                        <Link to={paperLink(p) + "?tab=notes"} state={{ returnTo }}>
                          메모·프로젝트에 추가
                        </Link>
                        <button onClick={() => share()}>공유</button>
                        <button onClick={() => share(true)}>인용 복사</button>
                        <a
                          href={"https://pubmed.ncbi.nlm.nih.gov/" + p.pmid + "/"}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PubMed
                        </a>
                      </div>
                      <div className="today-feedback">
                        <span>다음 추천에 반영</span>
                        <button
                          disabled={r.busy}
                          aria-pressed={data.opinion === "like"}
                          onClick={() => r.opinion("like")}
                        >
                          관심 있음
                        </button>
                        <button
                          disabled={r.busy}
                          aria-pressed={data.opinion === "dislike"}
                          onClick={() => r.opinion("dislike")}
                        >
                          관심 없음
                        </button>
                      </div>
                      {shareMessage && <p role="status">{shareMessage}</p>}
                      {readCount === r.cards.length && (
                        <div className="today-complete" role="status">
                          <strong>오늘의 {r.cards.length}편을 모두 읽었습니다.</strong>
                          <p>
                            <Link to="/library">저장한 문헌 다시 보기</Link> ·{" "}
                            <Link to="/discover">다른 문헌 탐색</Link>
                          </p>
                        </div>
                      )}
                    </article>
                  )}
                </Resource>
              </div>
              {r.notice && (
                <div
                  className={"today-notice " + (r.notice.error ? "is-error" : "")}
                  role={r.notice.error ? "alert" : "status"}
                >
                  <span>{r.notice.message}</span>
                  {r.notice.undo && (
                    <button disabled={r.busy} onClick={r.undo}>
                      실행 취소
                    </button>
                  )}
                  <button className="today-icon" aria-label="알림 닫기" onClick={() => r.setNotice(null)}>
                    <X size={16} />
                  </button>
                </div>
              )}
              <footer
                className="today-controls"
                aria-label="논문 읽기 도구"
                inert={listOpen ? "" : undefined}
                aria-hidden={listOpen || undefined}
              >
                <button
                  className="today-nav-button"
                  aria-label="이전 논문"
                  disabled={r.index === 0}
                  onClick={() => choose(r.index - 1)}
                >
                  <ChevronLeft size={20} />
                  <span>이전</span>
                </button>
                <button
                  className={"today-action " + (state.saved ? "is-active" : "")}
                  aria-label={state.saved ? "저장됨" : "내 서재에 저장"}
                  aria-pressed={!!state.saved}
                  disabled={!p || r.busy}
                  onClick={() =>
                    r.change(
                      { saved: !state.saved },
                      state.saved ? "서재에서 저장을 해제했습니다." : "내 서재에 저장했습니다.",
                    )
                  }
                >
                  <Bookmark size={17} />
                  {state.saved ? "저장됨" : "저장"}
                </button>
                <button
                  className={"today-action " + (state.reading_state === "read" ? "is-active" : "")}
                  aria-label={state.reading_state === "read" ? "읽음" : "읽음 표시"}
                  aria-pressed={state.reading_state === "read"}
                  disabled={!p || r.busy}
                  onClick={() =>
                    r.change(
                      { reading_state: state.reading_state === "read" ? "unread" : "read" },
                      state.reading_state === "read" ? "읽음 표시를 해제했습니다." : "읽음으로 표시했습니다.",
                    )
                  }
                >
                  <Check size={17} />
                  읽음
                </button>
                {p ? (
                  data.access?.can_read ? (
                    <Link className="today-original" to={"/fulltext/" + p.pmid} state={{ returnTo }}>
                      <ExternalLink size={16} />
                      원문<span>·표·그림</span>
                    </Link>
                  ) : (
                    <a className="today-original" href={publisherLink(p)} target="_blank" rel="noreferrer">
                      <ExternalLink size={16} />
                      출판사<span> 원문</span>
                    </a>
                  )
                ) : (
                  <span className="today-original-placeholder" />
                )}
                <button
                  className="today-nav-button"
                  aria-label="다음 논문"
                  disabled={r.index === r.cards.length - 1}
                  onClick={() => choose(r.index + 1)}
                >
                  <span>다음</span>
                  <ChevronRight size={20} />
                </button>
              </footer>
            </div>
          </div>
        ) : (
          <div className="reader-empty">
            <h2>이 날짜에 제공할 추천이 없습니다</h2>
            <p>다른 날짜를 선택하거나 문헌을 직접 찾아보세요.</p>
            <div className="reader-actions justify-center">
              <Link className="btn-primary" to="/discover">
                문헌 탐색
              </Link>
              <Link className="btn-secondary" to="/library">
                내 서재
              </Link>
            </div>
          </div>
        )}
      </Resource>
    </div>
  );
}
