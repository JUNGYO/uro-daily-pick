import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { checked } from "../lib/data";
import { rpc, searchArgs, expandQuery } from "../lib/workspace";
import {
  ReaderPage,
  PaperCard,
  Resource,
  useResource,
  ComparisonTray,
  selectComparison,
} from "../components/ReaderUI";
export default function Discover() {
  const [params, setParams] = useSearchParams(),
    { user } = useAuth(),
    [selected, setSelected] = useState([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const r = useResource(() => rpc("search_papers", searchArgs(params)), [params.toString(), user.id]);
  const change = (key, value) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    next.delete("page");
    setParams(next);
  };
  async function saveSearch() {
    setBusy(true);
    try {
      await checked(
        supabase.from("saved_searches").insert({
          user_id: user.id,
          name: (params.get("q") || "새 문헌") + " · " + new Date().toLocaleDateString("ko-KR"),
          query: expandQuery(params.get("q") || ""),
          filters: Object.fromEntries(
            ["year", "until", "journal", "type", "state", "integrity"].map((k) => [
              k,
              params.get(k) || ({ year: 2000, until: 3000, state: "all", integrity: "current" }[k] ?? ""),
            ]),
          ),
        }),
      );
      setMessage("검색을 저장했습니다. 내 서재에서 새 결과 알림을 확인할 수 있습니다.");
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReaderPage
      title="문헌 탐색"
      description="등록된 문헌에서 검색 · 2000년 이후. 본문 요약 제공 여부와 관계없이 찾을 수 있습니다."
    >
      <form
        key={params.toString()}
        className="reader-search"
        onSubmit={(e) => {
          e.preventDefault();
          change("q", new FormData(e.currentTarget).get("q"));
        }}
      >
        <label className="query">
          제목·주제·PMID·DOI
          <input
            name="q"
            type="search"
            maxLength={200}
            defaultValue={params.get("q") || ""}
            placeholder="전립선암, PMID 또는 DOI"
          />
        </label>
        <button className="btn-primary">검색</button>
      </form>
      {expandQuery(params.get("q") || "") !== params.get("q") && params.get("q") && (
        <p className="reader-muted">적용한 검색어: {expandQuery(params.get("q"))}</p>
      )}
      <form
        key={params.toString()}
        className="reader-search"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams(params);
          for (const [key, value] of new FormData(e.currentTarget).entries())
            value ? next.set(key, value) : next.delete(key);
          next.delete("page");
          setParams(next);
        }}
      >
        <label>
          발행 시작 연도
          <input type="number" min="2000" max="3000" name="year" defaultValue={params.get("year") || 2000} />
        </label>
        <label>
          발행 종료 연도
          <input
            type="number"
            min="2000"
            max="3000"
            name="until"
            placeholder="전체 기간"
            defaultValue={params.get("until") || ""}
          />
        </label>
        <label>
          저널 이름
          <input name="journal" defaultValue={params.get("journal") || ""} placeholder="정확한 저널명" />
        </label>
        <label>
          연구 유형
          <select name="type" defaultValue={params.get("type") || ""}>
            <option value="">모든 유형</option>
            {[
              ["rct", "무작위 대조시험"],
              ["meta_analysis", "메타분석"],
              ["prospective", "전향적 연구"],
              ["retrospective", "후향적 연구"],
              ["review", "종설"],
              ["surgical", "수술"],
              ["biomarker", "바이오마커"],
            ].map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          요약 상태
          <select name="state" defaultValue={params.get("state") || "all"}>
            <option value="all">모든 상태</option>
            <option value="ready">본문 요약 제공</option>
            <option value="pending">요약 미제공</option>
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
        <button className="btn-primary">조건 적용</button>
      </form>
      <div className="reader-actions">
        <button className="btn-secondary" onClick={() => setParams({})}>
          조건 초기화
        </button>
        <button className="btn-secondary" disabled={busy} onClick={saveSearch}>
          검색 저장·새 결과 알림
        </button>
        <Link to="/library?tab=searches">저장한 검색</Link>
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
                <p>조건을 줄이거나 식별자를 확인해 주세요.</p>
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
            {r.data.items.map((p) => (
              <PaperCard
                key={p.id}
                paper={p}
                compare={selected.includes(p.pmid)}
                onCompare={(id) => setSelected((prev) => selectComparison(prev, id))}
              />
            ))}
            <div className="reader-actions">
              <button
                className="btn-secondary"
                disabled={!Number(params.get("page"))}
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.set("page", Number(n.get("page")) - 1);
                  setParams(n);
                }}
              >
                이전 페이지
              </button>
              <button
                className="btn-secondary"
                disabled={(Number(params.get("page") || 0) + 1) * 20 >= r.data.total}
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.set("page", Number(n.get("page") || 0) + 1);
                  setParams(n);
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
