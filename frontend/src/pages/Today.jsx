import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  X,
  ExternalLink,
  Share2,
  Copy,
} from "lucide-react";
import { kstDate, normalizeRec, shiftDate } from "../lib/data";
import { publisherLink, sharedLink, plainCitation } from "../lib/workspace";
import { useAuth } from "../lib/auth";
import { useDailyReader } from "../lib/useDailyReader";
import { useReading } from "../lib/useReading";
import { Resource } from "../components/ReaderUI";
import DailyArticle, { TypeBadge } from "../components/DailyArticle";
import "../today.css";

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
  const location = useLocation(),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const day = validDay(params.get("date")) ? params.get("date") : kstDate();
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [lastSelection, setLastSelection] = useState({ day, pmid: params.get("paper") });
  const active = !mobile || !!params.get("paper");
  const r = useDailyReader(
    user.id,
    day,
    params.get("paper") || (lastSelection.day === day ? lastSelection.pmid : null),
    active,
  );
  const [shareMessage, setShareMessage] = useState("");
  const [studyOpen, setStudyOpen] = useState(false);
  const scrollRef = useRef(null),
    titleRef = useRef(null),
    queueRef = useRef(null),
    focusNext = useRef(false),
    focusList = useRef(false);
  const selected = r.selected;
  // A loading selection must never show the previous article or mutate its state.
  const data = r.detail.data?.paper?.pmid === selected?.pmid ? r.detail.data : null;
  const rec = data
    ? normalizeRec({ paper: data.paper, reasons: r.reasons[data.paper.id], score: r.scores[data.paper.id] })
    : null;
  const p = rec?.paper,
    state = data?.state || {};
  const returnTo = location.pathname + location.search;
  const readCount = r.cards.filter((c) =>
    r.states[c.id] ? r.states[c.id].reading_state === "read" : c.read,
  ).length;
  useReading(user.id, active ? p?.id : null, false, state.position);

  function choose(index) {
    if (!r.cards[index]) return;
    const next = new URLSearchParams(params);
    next.set("date", day);
    next.set("paper", r.cards[index].pmid);
    setLastSelection({ day, pmid: r.cards[index].pmid });
    focusNext.current = true;
    // Enter mobile detail once. Further selections replace it so Back returns to the list.
    setParams(next, { replace: active, state: !active ? { dailyList: true } : location.state });
  }
  function closeMobile() {
    focusList.current = true;
    if (location.state?.dailyList) navigate(-1);
    else {
      const next = new URLSearchParams(params);
      next.delete("paper");
      setParams(next, { replace: true });
    }
  }
  function changeDay(value) {
    if (!validDay(value)) return;
    const next = new URLSearchParams(params);
    next.set("date", value);
    next.delete("paper");
    setLastSelection({ day: value, pmid: null });
    setParams(next, { replace: true });
  }
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const resize = () => setMobile(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (params.get("paper")) setLastSelection({ day, pmid: params.get("paper") });
  }, [day, params.get("paper")]);
  useEffect(() => {
    setShareMessage("");
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (p && active && focusNext.current) {
      titleRef.current?.focus({ preventScroll: true });
      focusNext.current = false;
    }
    if (!active && focusList.current) {
      queueRef.current?.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
      focusList.current = false;
    }
  }, [p?.pmid, active]);
  useEffect(() => {
    function keydown(e) {
      if (e.key === "Escape" && mobile && active) {
        e.preventDefault();
        closeMobile();
        return;
      }
      if (
        !active ||
        e.isComposing ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.target.closest("input,textarea,select,button,a,summary,[contenteditable=true]")
      )
        return;
      const key = e.key.toLowerCase();
      if (["j", "arrowright", "arrowdown"].includes(key)) {
        e.preventDefault();
        choose(r.index + 1);
      }
      if (["k", "arrowleft", "arrowup"].includes(key)) {
        e.preventDefault();
        choose(r.index - 1);
      }
      if (p && !r.busy && ["l", "d"].includes(key)) {
        e.preventDefault();
        r.opinion(key === "l" ? "like" : "dislike");
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [r.index, r.cards, r.busy, data, day, params, mobile, active]);
  async function share(citation = false) {
    const pmid = p.pmid;
    try {
      if (!citation && navigator.share) await navigator.share({ title: p.title, url: sharedLink(p) });
      else {
        await navigator.clipboard.writeText(citation ? plainCitation(p) : sharedLink(p));
        setShareMessage((citation ? "인용문" : "논문 주소") + "을 복사했습니다. · PMID " + pmid);
      }
    } catch (e) {
      if (e.name !== "AbortError") setShareMessage("복사하지 못했습니다. 다시 시도해 주세요.");
    }
  }
  const opinion = data?.opinion || "none";
  return (
    <div className={"today-page " + (mobile && active ? "today-mobile-open" : "")}>
      <div className="today-workspace">
        <aside className="today-queue" aria-label="오늘의 논문 목록" ref={queueRef} hidden={mobile && active}>
          <header className="today-queue-header">
            <h1>오늘 읽기</h1>
            <div className="today-date">
              <button
                className="today-icon"
                aria-label="이전 날짜"
                disabled={day <= "2000-01-01"}
                onClick={() => changeDay(shiftDate(day, -1))}
              >
                <ChevronLeft size={16} />
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
                <ChevronRight size={16} />
              </button>
            </div>
            {day !== kstDate() && (
              <button className="today-text-button" onClick={() => changeDay(kstDate())}>
                오늘
              </button>
            )}
          </header>
          <Resource resource={r.queue}>
            {r.cards.length > 0 ? (
              <>
                <div className="today-queue-heading">
                  <span>추천 {r.cards.length}편</span>
                  <span>
                    {readCount}/{r.cards.length} 읽음
                  </span>
                </div>
                <div
                  className="today-progress"
                  role="progressbar"
                  aria-label="오늘 추천 읽기 진행"
                  aria-valuemin={0}
                  aria-valuemax={r.cards.length}
                  aria-valuenow={readCount}
                >
                  {r.cards.map((c, i) => (
                    <span
                      key={c.id}
                      className={
                        (r.states[c.id]?.reading_state === "read" || (!r.states[c.id] && c.read)
                          ? "is-read "
                          : "") + (i === r.index ? "is-current" : "")
                      }
                    />
                  ))}
                </div>
                <ol className="today-list">
                  {r.cards.map((c, i) => {
                    const s = r.states[c.id] || (c.id === p?.id ? state : {});
                    const fb = r.opinions[c.id] ?? (c.id === p?.id ? opinion : c.opinion);
                    const read = s.reading_state ? s.reading_state === "read" : c.read;
                    return (
                      <li key={c.id}>
                        <button
                          className={
                            "today-queue-item " +
                            (i === r.index ? "is-selected " : "") +
                            (fb === "like" ? "is-liked" : "")
                          }
                          aria-current={i === r.index ? "true" : undefined}
                          onClick={() => choose(i)}
                        >
                          <span className="today-queue-number">{i + 1}</span>
                          <span className="today-queue-copy">
                            <span className="today-queue-meta">
                              <TypeBadge type={c.study_type} />
                              <span className="today-journal">{c.journal}</span>
                            </span>
                            <span className="today-queue-title">{c.title}</span>
                            {(read || s.saved || fb === "like" || fb === "dislike") && (
                              <span className="today-queue-state">
                                {read && (
                                  <span>
                                    <Check size={12} />
                                    읽음
                                  </span>
                                )}
                                {s.saved && (
                                  <span>
                                    <Bookmark size={12} />
                                    저장됨
                                  </span>
                                )}
                                {fb === "like" && (
                                  <span>
                                    <Heart size={12} />
                                    관심 있음
                                  </span>
                                )}
                                {fb === "dislike" && <span>관심 없음</span>}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <div className="today-empty">
                <h2>이 날짜에 제공할 추천이 없습니다</h2>
                <p>
                  다른 날짜를 선택하거나 <Link to="/discover">문헌을 탐색</Link>해 보세요.
                </p>
              </div>
            )}
          </Resource>
          <div className="today-queue-links">
            <Link to="/library?tab=liked">관심 표시한 논문</Link>
            <Link to="/settings">추천 설정</Link>
          </div>
          <p className="today-shortcuts">J / K 이전·다음 · L 관심 있음 · D 관심 없음</p>
        </aside>
        {active && (
          <div className="today-reader">
            {mobile && (
              <header className="today-mobile-header">
                <button className="today-back" aria-label="논문 목록" onClick={closeMobile}>
                  <ChevronLeft size={22} />
                  목록
                </button>
                <span className="today-position" aria-live="polite">
                  {r.index + 1} / {r.cards.length}편 · {readCount}편 읽음
                </span>
              </header>
            )}
            <div className="today-detail reader-scroll" ref={scrollRef}>
              <Resource resource={r.queue}>
                {r.cards.length > 0 ? (
                  <Resource
                    resource={{ ...r.detail, loading: r.detail.loading || (!data && !r.detail.error) }}
                  >
                    {rec && (
                      <DailyArticle
                        key={p.pmid}
                        rec={rec}
                        reason={selected.reason}
                        canRead={data.access?.can_read}
                        returnTo={returnTo}
                        titleRef={titleRef}
                        studyOpen={studyOpen}
                        setStudyOpen={setStudyOpen}
                      />
                    )}
                    {readCount === r.cards.length && (
                      <div className="today-complete" role="status">
                        <strong>오늘의 {r.cards.length}편을 모두 읽었습니다.</strong>
                        <p>
                          <Link to="/library">저장한 문헌 다시 보기</Link> ·{" "}
                          <Link to="/discover">다른 문헌 탐색</Link>
                        </p>
                      </div>
                    )}
                  </Resource>
                ) : (
                  <div className="today-empty">
                    <p>
                      날짜를 선택하거나 <Link to="/discover">다른 문헌을 찾아보세요.</Link>
                    </p>
                  </div>
                )}
              </Resource>
            </div>
            {(r.notice || shareMessage) && (
              <div
                className={"today-notice " + (r.notice?.error ? "is-error" : "")}
                role={r.notice?.error ? "alert" : "status"}
              >
                <span>{r.notice?.message || shareMessage}</span>
                {r.notice?.undo && (
                  <button disabled={r.busy} onClick={r.undo}>
                    실행 취소
                  </button>
                )}
                <button
                  className="today-icon"
                  aria-label="알림 닫기"
                  onClick={() => {
                    r.setNotice(null);
                    setShareMessage("");
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {r.cards.length > 0 && (
              <footer className="today-controls" aria-label="논문 읽기 도구">
                <div className="today-navigation">
                  <button
                    className="today-icon"
                    aria-label="이전 논문"
                    title="이전 논문 (K)"
                    disabled={r.index === 0}
                    onClick={() => choose(r.index - 1)}
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <span className="today-position">
                    {r.index + 1}/{r.cards.length}
                    <span className="sr-only"> · {readCount}편 읽음</span>
                  </span>
                  <button
                    className="today-icon"
                    aria-label="다음 논문"
                    title="다음 논문 (J)"
                    disabled={r.index === r.cards.length - 1}
                    onClick={() => choose(r.index + 1)}
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>
                <div className="today-personal-actions">
                  <button
                    className={"today-action today-dislike " + (opinion === "dislike" ? "is-active" : "")}
                    aria-label="관심 없음"
                    title="관심 없음 · 다음 추천에 반영 (D)"
                    aria-pressed={opinion === "dislike"}
                    disabled={!p || r.busy}
                    onClick={() => r.opinion("dislike")}
                  >
                    <X size={19} />
                    <span>관심 없음</span>
                  </button>
                  <button
                    className={"today-action today-like " + (opinion === "like" ? "is-active" : "")}
                    aria-label="관심 있음"
                    title="관심 있음 · 다음 추천에 반영 (L)"
                    aria-pressed={opinion === "like"}
                    disabled={!p || r.busy}
                    onClick={() => r.opinion("like")}
                  >
                    <Heart size={19} fill={opinion === "like" ? "currentColor" : "none"} />
                    <span>관심 있음</span>
                  </button>
                  <button
                    className={"today-action " + (state.saved ? "is-active" : "")}
                    aria-label={state.saved ? "저장됨" : "내 서재에 저장"}
                    title="내 서재에 저장"
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
                    <span>{state.saved ? "저장됨" : "저장"}</span>
                  </button>
                  <button
                    className={"today-action " + (state.reading_state === "read" ? "is-active" : "")}
                    aria-label={state.reading_state === "read" ? "읽음" : "읽음 표시"}
                    title="읽음 표시"
                    aria-pressed={state.reading_state === "read"}
                    disabled={!p || r.busy}
                    onClick={() =>
                      r.change(
                        { reading_state: state.reading_state === "read" ? "unread" : "read" },
                        state.reading_state === "read"
                          ? "읽음 표시를 해제했습니다."
                          : "읽음으로 표시했습니다.",
                      )
                    }
                  >
                    <Check size={17} />
                    <span>읽음</span>
                  </button>
                </div>
                <div className="today-source-actions">
                  <button
                    className="today-icon"
                    aria-label="공유"
                    title="논문 공유"
                    disabled={!p}
                    onClick={() => {
                      r.setNotice(null);
                      share();
                    }}
                  >
                    <Share2 size={16} />
                  </button>
                  <button
                    className="today-icon"
                    aria-label="인용 복사"
                    title="인용 복사"
                    disabled={!p}
                    onClick={() => {
                      r.setNotice(null);
                      share(true);
                    }}
                  >
                    <Copy size={16} />
                  </button>
                  {p && (
                    <>
                      {data.access?.can_read && (
                        <Link className="today-original" to={"/fulltext/" + p.pmid} state={{ returnTo }}>
                          <ExternalLink size={14} />
                          원문·표·그림
                        </Link>
                      )}
                      {p.doi && (
                        <a
                          className={data.access?.can_read ? "today-publisher" : "today-original"}
                          href={publisherLink(p)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Publisher
                          <ExternalLink size={13} />
                        </a>
                      )}
                      <a
                        className="today-pubmed"
                        href={"https://pubmed.ncbi.nlm.nih.gov/" + p.pmid + "/"}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PubMed
                        <ExternalLink size={13} />
                      </a>
                    </>
                  )}
                </div>
              </footer>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
