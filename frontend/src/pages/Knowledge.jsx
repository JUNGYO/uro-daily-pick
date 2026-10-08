import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import { ReaderPage, Resource, useResource } from "../components/ReaderUI";
import "../knowledge.css";

const TYPES = {
  condition: "질환",
  intervention: "치료·중재",
  test: "검사",
  outcome: "평가 지표",
  method: "연구 방법",
};
const COLORS = {
  condition: "#2364aa",
  intervention: "#237b61",
  test: "#8455ae",
  outcome: "#a56412",
  method: "#526475",
};
const number = (n) => Number(n || 0).toLocaleString("ko-KR");
const date = (s) => (s ? new Date(s).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "");
const detailUrl = (id) => "/knowledge/" + encodeURIComponent(id);

function Pager({ page, more, change }) {
  return (
    <nav className="knowledge-pager" aria-label="지식 탐색 페이지">
      <button className="btn-secondary" disabled={!page} onClick={() => change(page - 1)}>
        이전
      </button>
      <span>{page + 1}페이지</span>
      <button className="btn-secondary" disabled={!more} onClick={() => change(page + 1)}>
        다음
      </button>
    </nav>
  );
}

export function KnowledgeMap({ focus = null }) {
  const { user } = useAuth();
  const r = useResource(() => rpc("knowledge_graph", { p_id: focus }), [user.id, focus]);
  const [selected, setSelected] = useState(null);
  const [group, setGroup] = useState("");
  useEffect(() => setSelected(null), [focus]);
  const allNodes = r.data?.nodes || [];
  const groups = (r.data?.groups || []).filter((g) =>
    g.concepts.some((id) => allNodes.some((n) => n.id === id)),
  );
  const currentGroup = groups.find((g) => g.id === group);
  const nodes = currentGroup ? allNodes.filter((n) => currentGroup.concepts.includes(n.id)) : allNodes,
    edges = r.data?.edges || [];
  const points = new Map(
    nodes.map((n, i) => {
      const angle = i * 2.399963229728653,
        radius = 40 + 210 * Math.sqrt(i / Math.max(1, nodes.length - 1));
      return [n.id, { x: 300 + Math.cos(angle) * radius, y: 280 + Math.sin(angle) * radius }];
    }),
  );
  const active = nodes.find((n) => n.id === selected);
  const linked = edges.filter((e) => e.source === selected || e.target === selected);
  return (
    <Resource resource={r}>
      {!nodes.length ? (
        <div className="reader-empty">
          원문에서 지식 연결을 구축하고 있습니다. 연결된 개념이 준비되면 지도가 표시됩니다.
        </div>
      ) : (
        <>
          <p className="reader-muted">
            개념을 선택하면 함께 연구된 주제와 연결 이유를 볼 수 있습니다. 선은 같은 논문에서 다뤄진 관계이며,
            치료 효과나 근거의 강도를 뜻하지 않습니다.
          </p>
          {!!groups.length && (
            <div className="knowledge-group-picker">
              <label htmlFor="knowledge-group">자동 주제 묶음</label>
              <select
                id="knowledge-group"
                value={currentGroup?.id || ""}
                onChange={(e) => {
                  setGroup(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">전체 지도</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label} 관련
                  </option>
                ))}
              </select>
              <p className="reader-muted">
                함께 등장하는 개념으로 묶었습니다. 현재 지도에 포함된 묶음을 표시합니다.
              </p>
            </div>
          )}
          <div className="knowledge-map-layout">
            <svg
              className="knowledge-map"
              viewBox="0 0 600 560"
              role="group"
              aria-label="원문에서 추출한 개념 연결 지도"
            >
              {edges.map((e) => {
                const a = points.get(e.source),
                  b = points.get(e.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={e.source + e.target}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      selected && (e.source === selected || e.target === selected) ? "#2364aa" : "#cbd5e1"
                    }
                    strokeWidth={Math.min(4, 1 + Math.log2(e.weight + 1))}
                    opacity={selected && e.source !== selected && e.target !== selected ? 0.25 : 0.8}
                  />
                );
              })}
              {nodes.map((n, i) => {
                const p = points.get(n.id);
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.label_ko}, ${n.document_count}편`}
                    aria-pressed={selected === n.id}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n.id);
                      }
                    }}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={selected === n.id ? 24 : 20}
                      fill={COLORS[n.kind] || COLORS.method}
                      stroke={selected === n.id ? "#111827" : "white"}
                      strokeWidth="3"
                    />
                    <text
                      x={p.x}
                      y={p.y + 5}
                      textAnchor="middle"
                      fill="white"
                      fontSize="15"
                      fontWeight="600"
                      aria-hidden="true"
                    >
                      {i + 1}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="knowledge-map-info" aria-live="polite">
              {active ? (
                <>
                  <span className="knowledge-kind">{TYPES[active.kind]}</span>
                  <h2>{active.label_ko}</h2>
                  <p>{active.label}</p>
                  <Link className="btn-primary" to={detailUrl(active.id)}>
                    지식 페이지 읽기
                  </Link>
                  <h3>함께 연구된 개념</h3>
                  {!linked.length && <p>현재 지도 범위에 연결된 개념이 없습니다.</p>}
                  <ul>
                    {linked.map((e) => {
                      const n = nodes.find((x) => x.id === (e.source === selected ? e.target : e.source));
                      return (
                        n && (
                          <li key={n.id}>
                            <button onClick={() => setSelected(n.id)}>{n.label_ko}</button>
                            <span>공통 논문 {number(e.weight)}편</span>
                          </li>
                        )
                      );
                    })}
                  </ul>
                </>
              ) : (
                <p>지도 또는 아래 목록에서 개념을 선택하세요.</p>
              )}
            </div>
          </div>
          <ol className="knowledge-node-list">
            {nodes.map((n, i) => (
              <li key={n.id}>
                <button aria-pressed={n.id === selected} onClick={() => setSelected(n.id)}>
                  <span className="knowledge-dot" style={{ background: COLORS[n.kind] }}>
                    {i + 1}
                  </span>
                  <span>
                    {n.label_ko}
                    <small>{n.label}</small>
                  </span>
                  <span>{number(n.document_count)}편</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="reader-muted">
            {focus ? "선택한 개념 주변" : "연결 문헌이 많은 개념"} 최대 30개를 표시합니다. 전체 개념은 지식
            검색에서 찾을 수 있습니다.
          </p>
        </>
      )}
    </Resource>
  );
}

export function KnowledgeLinks({ pmid }) {
  const { user } = useAuth();
  const r = useResource(
    () => rpc("knowledge_search", { p_query: "", p_pmid: pmid, p_page: 0 }),
    [user.id, pmid],
  );
  if (!r.data?.items?.length || r.error) return null;
  return (
    <div className="knowledge-inline">
      <span>관련 지식</span>
      {r.data.items.slice(0, 4).map((c) => (
        <Link key={c.id} to={detailUrl(c.id)}>
          {c.label_ko}
        </Link>
      ))}
    </div>
  );
}

function KnowledgeDetail({ id }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, Math.min(10000, Number(params.get("page")) || 0));
  const r = useResource(() => rpc("knowledge_page", { p_id: id, p_page: page }), [user.id, id, page]);
  const data = r.data;
  return (
    <ReaderPage title={data?.concept?.label_ko || "지식 페이지"}>
      <nav className="knowledge-nav">
        <Link to="/knowledge">지식 탐색</Link>
        <Link to="/insights?view=knowledge">전체 문헌 지도</Link>
        <Link to="/discover">문헌 탐색</Link>
      </nav>
      <Resource resource={r}>
        {data ? (
          <>
            <p className="reader-muted">
              {data.concept.label} · {TYPES[data.concept.kind]} · 연결 원문{" "}
              {number(data.concept.document_count)}편
            </p>
            {data.wiki?.status === "ready" && data.wiki.paragraphs.length ? (
              <article className="knowledge-article" aria-label="원문 기반 지식 문서">
                <p className="knowledge-caption">
                  원문에서 추출한 연구 내용을 AI가 정리했습니다. 전체 연결 문헌 중 아래 출처를 사용했으며,
                  체계적 문헌고찰을 대신하지 않습니다.
                </p>
                {data.wiki.paragraphs.map((p, i) => (
                  <section key={i}>
                    <p>{p.text}</p>
                    <div className="knowledge-citations">
                      {p.sources.map((s) => (
                        <Link
                          key={s.pmid}
                          to={`/fulltext/${s.pmid}?source=${encodeURIComponent(s.content_hash)}#${encodeURIComponent(s.locations[0])}`}
                        >
                          출처 · PMID {s.pmid}
                        </Link>
                      ))}
                    </div>
                  </section>
                ))}
                <p className="knowledge-caption">갱신 {date(data.wiki.updated_at)}</p>
              </article>
            ) : (
              <p className="reader-empty" role="status">
                {data.wiki?.status === "updating"
                  ? "출처가 변경되어 지식 문서를 갱신하고 있습니다. 아래에서 현재 연결된 논문을 확인할 수 있습니다."
                  : "지식 문서를 작성하고 있습니다. 연결된 논문은 먼저 탐색할 수 있습니다."}
              </p>
            )}
            {!!data.neighbors.length && (
              <section className="knowledge-section">
                <h2>함께 연구된 주제</h2>
                <div className="knowledge-related">
                  {data.neighbors.map((n) => (
                    <Link to={detailUrl(n.id)} key={n.id}>
                      {n.label_ko}
                      <small>공통 논문 {number(n.shared_papers)}편</small>
                    </Link>
                  ))}
                </div>
                <Link to={"/insights?view=knowledge&concept=" + data.concept.id}>주변 연결 지도</Link>
              </section>
            )}
            <section className="knowledge-section">
              <h2>연결된 논문</h2>
              <p className="reader-muted">
                각 논문의 대상과 연구 조건을 확인하세요. 문헌 수는 독립된 연구 수와 다를 수 있습니다.
              </p>
              {data.papers.slice(0, 20).map((p) => (
                <article className="reader-card" key={p.pmid}>
                  <h3>
                    <Link to={"/papers/" + p.pmid}>{p.title}</Link>
                  </h3>
                  <p className="reader-muted">
                    {p.journal} · {p.pub_date}
                  </p>
                  <Link to={"/fulltext/" + p.pmid}>원문 읽기</Link>
                </article>
              ))}
              <Pager
                page={page}
                more={data.papers.length > 20}
                change={(next) => setParams(next ? { page: next } : {})}
              />
            </section>
          </>
        ) : (
          <p className="reader-empty">
            이 개념의 현재 연결 문헌을 찾을 수 없습니다. 지식 탐색에서 다시 검색해 주세요.
          </p>
        )}
      </Resource>
    </ReaderPage>
  );
}

function KnowledgeBrowse() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "",
    page = Math.max(0, Math.min(1000, Number(params.get("page")) || 0));
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const r = useResource(
    () => rpc("knowledge_search", { p_query: query.slice(0, 200), p_page: page }),
    [user.id, query, page],
  );
  return (
    <ReaderPage title="지식 탐색" description="확보한 원문을 개념과 연구 내용으로 연결해 탐색합니다.">
      <nav className="knowledge-nav">
        <Link to="/discover">문헌 탐색</Link>
        <Link to="/insights?view=knowledge">전체 문헌 지도</Link>
      </nav>
      <form
        className="knowledge-search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(draft.trim() ? { q: draft.trim() } : {});
        }}
      >
        <label htmlFor="knowledge-query">개념·질환·치료법 검색</label>
        <div>
          <input
            id="knowledge-query"
            maxLength={200}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="예: 전립선암, active surveillance"
          />
          <button className="btn-primary" type="submit">
            검색
          </button>
        </div>
      </form>
      <Resource resource={r}>
        {r.data && (
          <>
            <p className="reader-muted">
              지식 색인에 반영된 원문 {number(r.data.indexed_documents)}편
              {r.data.updated_at && ` · 최근 반영 ${date(r.data.updated_at)}`}
            </p>
            {!r.data.items.length && (
              <div className="reader-empty">
                {query
                  ? "일치하는 개념이 없습니다. 다른 표현으로 검색하거나 문헌 탐색을 이용하세요."
                  : "원문에서 지식을 구축하고 있습니다. 처리된 개념부터 순차적으로 표시됩니다."}
              </div>
            )}
            <div className="knowledge-grid">
              {r.data.items.slice(0, 20).map((c) => (
                <article className="knowledge-card" key={c.id}>
                  <span className="knowledge-kind">{TYPES[c.kind]}</span>
                  <h2>
                    <Link to={detailUrl(c.id)}>{c.label_ko}</Link>
                  </h2>
                  <p>{c.label}</p>
                  <div className="knowledge-caption">
                    <span>연결 원문 {number(c.document_count)}편</span>
                    <span>{c.status === "ready" ? "지식 문서 제공" : "문헌 연결 제공"}</span>
                  </div>
                </article>
              ))}
            </div>
            <Pager
              page={page}
              more={r.data.items.length > 20}
              change={(next) =>
                setParams({ ...(query ? { q: query } : {}), ...(next ? { page: next } : {}) })
              }
            />
          </>
        )}
      </Resource>
    </ReaderPage>
  );
}

export default function Knowledge() {
  const { id } = useParams();
  return id ? <KnowledgeDetail key={id} id={id} /> : <KnowledgeBrowse />;
}
