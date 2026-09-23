import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { checked } from "../lib/data";
import { rpc, searchArgsV2, searchDateFields, expandQuery } from "../lib/workspace";
import ReviewTransfer from "../components/ReviewTransfer";
import {
  ReaderPage,
  PaperCard,
  Resource,
  useResource,
  ComparisonTray,
  selectComparison,
} from "../components/ReaderUI";
import "../discover.css";

const journalCache = new Map();

function JournalField({ value, onChange }) {
  const { user } = useAuth();
  const activeOption = useRef(null);
  const [options, setOptions] = useState([]),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(false);
    setOptions([]);
    setActive(-1);
    const key = `${user.id}:${value.trim().toLowerCase()}`;
    const cached = journalCache.get(key);
    if (cached && cached.until > Date.now()) {
      setOptions(cached.rows);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      rpc("search_journals", { p_query: value.trim() })
        .then((rows) => {
          if (live) {
            journalCache.set(key, { rows: rows || [], until: Date.now() + 300000 });
            if (journalCache.size > 30) journalCache.delete(journalCache.keys().next().value);
            setOptions(rows || []);
          }
        })
        .catch(() => {
          if (live) setError(true);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, open, user.id]);
  useEffect(() => {
    if (open && active >= 0) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  const choose = (name) => {
    onChange(name);
    setOpen(false);
    setActive(-1);
  };
  return (
    <div
      className="discover-journal"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor="discover-journal">저널 이름</label>
      <input
        id="discover-journal"
        name="journal"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="discover-journals"
        aria-activedescendant={open && active >= 0 ? `discover-journal-${active}` : undefined}
        aria-describedby="discover-journal-help"
        value={value}
        maxLength={200}
        placeholder="전체 저널 · 이름을 입력해 선택"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive((i) =>
              options.length
                ? i < 0
                  ? e.key === "ArrowDown"
                    ? 0
                    : options.length - 1
                  : (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
                : -1,
            );
          }
          if (e.key === "Enter" && open && active >= 0 && options[active]) {
            e.preventDefault();
            choose(options[active].name);
          }
        }}
      />
      <span id="discover-journal-help" className="reader-muted">
        등록된 저널명을 선택하세요. 비워 두면 전체 저널에서 검색합니다.
      </span>
      <div className="discover-journal-options" hidden={!open}>
        <ul id="discover-journals" role="listbox" aria-label="등록된 저널">
          {options.map((journal, i) => (
            <li
              key={journal.name}
              id={`discover-journal-${i}`}
              role="option"
              aria-selected={active === i}
              ref={active === i ? activeOption : null}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(journal.name)}
            >
              {journal.name}
            </li>
          ))}
        </ul>
        {loading && <p role="status">저널을 찾는 중…</p>}
        {error && (
          <p role="status">저널 목록을 불러오지 못했습니다. 정확한 저널명을 입력해 검색할 수 있습니다.</p>
        )}
        {!loading && !error && !options.length && <p role="status">일치하는 저널명이 없습니다.</p>}
      </div>
    </div>
  );
}

function SearchForm({ params, submit, clear }) {
  const [journal, setJournal] = useState(params.get("journal") || ""),
    [dates, setDates] = useState(() => searchDateFields(params)),
    [error, setError] = useState("");
  return (
    <form
      className="discover-search"
      aria-label="문헌 검색 조건"
      onSubmit={(e) => {
        e.preventDefault();
        const next = new URLSearchParams(params);
        for (const [key, raw] of new FormData(e.currentTarget).entries()) {
          const value = String(raw).trim();
          value ? next.set(key, value) : next.delete(key);
        }
        for (const key of ["year", "until", "page"]) next.delete(key);
        try {
          searchArgsV2(next);
          setError("");
          submit(next);
        } catch (err) {
          setError(err.message);
        }
      }}
    >
      <div className="discover-primary-fields">
        <label className="discover-query">
          키워드·PMID·DOI
          <input
            name="q"
            type="search"
            maxLength={200}
            defaultValue={params.get("q") || ""}
            placeholder="전립선암, PMID 또는 DOI"
          />
        </label>
        <JournalField value={journal} onChange={setJournal} />
        <fieldset className="discover-dates">
          <legend>발행 기간</legend>
          <div>
            <label>
              시작일
              <input
                name="from"
                type="date"
                min="2000-01-01"
                max="3000-12-31"
                value={dates.from}
                aria-invalid={!!error}
                aria-describedby={error ? "discover-date-error" : "discover-date-help"}
                onChange={(e) => {
                  setDates((d) => ({ ...d, from: e.target.value }));
                  setError("");
                }}
              />
            </label>
            <label>
              종료일
              <input
                name="to"
                type="date"
                min="2000-01-01"
                max="3000-12-31"
                value={dates.to}
                aria-invalid={!!error}
                aria-describedby={error ? "discover-date-error" : "discover-date-help"}
                onChange={(e) => {
                  setDates((d) => ({ ...d, to: e.target.value }));
                  setError("");
                }}
              />
            </label>
          </div>
          <p id="discover-date-help" className="reader-muted">
            시작일과 종료일을 포함합니다. 비워 두면 2000년 이후 전체 기간입니다.
          </p>
        </fieldset>
      </div>
      <details
        open={["type", "state", "sort", "integrity"].some(
          (key) => params.has(key) && !["all", "recent", "current", ""].includes(params.get(key)),
        )}
      >
        <summary>상세 검색 · 연구 유형, 요약 상태, 정렬</summary>
        <div className="discover-advanced-fields">
          <label>
            연구 유형
            <select name="type" defaultValue={params.get("type") || ""}>
              <option value="">모든 유형</option>
              {[
                ["rct", "무작위 임상시험"],
                ["meta_analysis", "메타분석"],
                ["prospective", "전향적 연구"],
                ["retrospective", "후향적 연구"],
                ["review", "종설"],
                ["surgical", "수술"],
                ["biomarker", "바이오마커"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            요약 상태
            <select name="state" defaultValue={params.get("state") || "all"}>
              <option value="all">모든 상태</option>
              <option value="ready">본문 요약 있음</option>
              <option value="pending">요약 준비중</option>
            </select>
          </label>
          <label>
            정렬
            <select name="sort" defaultValue={params.get("sort") || "recent"}>
              <option value="recent">최신순</option>
              <option value="oldest">오래된 순</option>
              <option value="relevance">검색 관련도</option>
            </select>
          </label>
          <label>
            철회 문헌
            <select name="integrity" defaultValue={params.get("integrity") || "current"}>
              <option value="current">철회 문헌 제외</option>
              <option value="all">포함</option>
              <option value="retracted">철회 문헌만</option>
            </select>
          </label>
        </div>
      </details>
      {error && (
        <p id="discover-date-error" role="alert">
          {error}
        </p>
      )}
      <div className="reader-actions">
        <button className="btn-primary" type="submit">
          검색
        </button>
        <button className="btn-secondary" type="button" onClick={clear}>
          필터 초기화
        </button>
      </div>
    </form>
  );
}

export default function Discover() {
  const [params, setParams] = useSearchParams(),
    { user } = useAuth(),
    [selected, setSelected] = useState([]),
    [formRevision, setFormRevision] = useState(0),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const searchKey = new URLSearchParams([...params].filter(([key]) => key !== "project")).toString();
  const r = useResource(() => rpc("search_papers_v2", searchArgsV2(params)), [searchKey, user.id]);
  async function saveSearch() {
    setBusy(true);
    try {
      const args = searchArgsV2(params);
      await checked(
        supabase.from("saved_searches").insert({
          user_id: user.id,
          name:
            (params.get("q") || params.get("journal") || "내 검색") +
            " · " +
            new Date().toLocaleDateString("ko-KR"),
          query: args.p_query,
          filters: {
            ...searchDateFields(params),
            journal: args.p_journal,
            type: args.p_type,
            state: args.p_state,
            sort: args.p_sort,
            integrity: args.p_integrity,
          },
        }),
      );
      setMessage("검색을 저장했습니다. 내 서재에서 새 문헌 알림을 확인할 수 있습니다.");
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReaderPage
      title="문헌 탐색"
      description="2000년 이후 등록된 문헌에서 키워드, 저널, 발행 기간을 함께 검색하세요. 원하는 조건만 입력해도 됩니다."
    >
      <SearchForm
        key={params.toString() + ":" + formRevision}
        params={params}
        submit={(next) => {
          setMessage("");
          setParams(next);
        }}
        clear={() => {
          setMessage("");
          setFormRevision((revision) => revision + 1);
          setParams(params.get("project") ? { project: params.get("project") } : {});
        }}
      />
      {expandQuery(params.get("q") || "") !== params.get("q") && params.get("q") && (
        <p className="reader-muted">적용된 검색어: {expandQuery(params.get("q"))}</p>
      )}
      <div className="reader-actions">
        <button className="btn-secondary" disabled={busy || r.loading || !!r.error} onClick={saveSearch}>
          검색 저장·새 결과 알림
        </button>
        <Link to="/library?tab=searches">저장된 검색</Link>
      </div>
      <p role="status">{message}</p>
      <Resource resource={r}>
        {r.data && (
          <>
            <p role="status">
              검색 결과 {r.data.total.toLocaleString()}편 · {Number(params.get("page") || 0) + 1}페이지
            </p>
            {!r.data.items.length && (
              <div className="reader-empty">
                <h2>등록된 문헌에서 찾지 못했습니다</h2>
                <p>기간을 넓히거나 키워드를 줄여 보세요. 저널은 등록된 이름과 정확히 일치해야 합니다.</p>
                <a
                  className="btn-secondary"
                  href={
                    "https://pubmed.ncbi.nlm.nih.gov/?term=" +
                    encodeURIComponent(expandQuery(params.get("q") || ""))
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  PubMed에서 검색
                </a>
              </div>
            )}
            <ReviewTransfer
              key={new URLSearchParams([...params].filter(([k]) => k !== "project")).toString()}
              papers={r.data.items}
              provenance={{
                source: "Uro Daily Pick 문헌 탐색",
                query: JSON.stringify(searchArgsV2(params)),
                total: r.data.total,
                limits: {
                  journal: params.get("journal") || "",
                  from: params.get("from") || "",
                  to: params.get("to") || "",
                  page: Number(params.get("page") || 0),
                  coverage_note: "서비스 등록 문헌 중 선택한 페이지 · 전체 문헌 검색 완료가 아님",
                },
              }}
            >
              {r.data.items.map((p) => (
                <PaperCard
                  key={p.id}
                  paper={p}
                  compare={selected.includes(p.pmid)}
                  onCompare={(id) => setSelected((prev) => selectComparison(prev, id))}
                />
              ))}
            </ReviewTransfer>
            <div className="reader-actions">
              <button
                className="btn-secondary"
                disabled={!Number(params.get("page"))}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("page", Number(next.get("page")) - 1);
                  setParams(next);
                }}
              >
                이전 페이지
              </button>
              <button
                className="btn-secondary"
                disabled={(Number(params.get("page") || 0) + 1) * 20 >= r.data.total}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("page", Number(next.get("page") || 0) + 1);
                  setParams(next);
                }}
              >
                다음 페이지
              </button>
            </div>
          </>
        )}
      </Resource>
      <ComparisonTray selected={selected} setSelected={setSelected} />
    </ReaderPage>
  );
}
