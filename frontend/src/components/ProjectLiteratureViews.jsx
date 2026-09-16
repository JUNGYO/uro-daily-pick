import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import {
  buildProjectLiterature,
  literatureDistribution,
  projectCell,
  projectGraphWindow,
  projectNeighbors,
} from "../lib/projectLiterature";
import "./projectLiteratureViews.css";

const kinds = { argument: "집필 논점", paper: "프로젝트 문헌", topic: "임상·연구 주제" };
const orderedKinds = ["argument", "paper", "topic"];
const sourceLabel = (source = "") =>
  ({
    "Study design metadata": "연구설계 정보",
    "Study type metadata": "연구 유형 정보",
    "Publication type metadata": "출판 유형 정보",
    "No recognized study method metadata": "확인 가능한 연구 방법 정보 없음",
    "No topic metadata": "주제 정보 없음",
  })[source] || source.replaceAll("Keywords", "키워드");
const sectionLabel = (topic) => (topic.section === "introduction" ? "서론" : "고찰");

function PaperActions({ node, onShowReference }) {
  return (
    <div className="project-literature-actions">
      {node.paper.pmid && (
        <Link
          className="btn-secondary"
          to={`/papers/${encodeURIComponent(node.paper.pmid)}?tab=study`}
          target="_blank"
          rel="noreferrer"
        >
          원문·근거 보기 ↗
        </Link>
      )}
      <button type="button" className="btn-secondary" onClick={() => onShowReference(node.reference)}>
        표에서 보기
      </button>
    </div>
  );
}

function SourceBadge({ node }) {
  return <span className={`project-source-badge project-source-${node.status.id}`}>{node.status.label}</span>;
}

function CellDetail({ reference, columnId, columns, onShowReference }) {
  const cell = projectCell(reference, columnId, columns);
  return (
    <div className="project-literature-cell">
      <button
        type="button"
        className="research-text-button"
        onClick={() => onShowReference(reference, columnId)}
      >
        표 항목 · {cell.label}
      </button>
      <p>{cell.value}</p>
      <small>
        {cell.origin}
        {!cell.current && cell.origin === "자동 정리" ? " · 현재 원문과 재확인 필요" : ""}
      </small>
      {!!cell.evidence.length && (
        <div className="project-literature-actions">
          {cell.current && reference.bibliography?.pmid ? (
            cell.evidence.map((location, index) => (
              <Link
                key={location}
                to={`/fulltext/${encodeURIComponent(reference.bibliography.pmid)}?source=${encodeURIComponent(reference.source_content_hash)}#${encodeURIComponent(location)}`}
                target="_blank"
                rel="noreferrer"
                className="research-text-button"
              >
                {location.startsWith("table-") ? "표" : location.startsWith("figure-") ? "그림" : "본문"} 근거{" "}
                {index + 1} 보기 ↗
              </Link>
            ))
          ) : (
            <span className="reader-muted">
              저장된 근거 {cell.evidence.length}곳 · 현재 원문과 재확인 필요
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function NodeDetail({ model, node, columns, onSelect, onShowReference, onShowTopic }) {
  if (!node)
    return <p className="reader-muted">항목을 선택하면 연결된 문헌과 집필 논점을 확인할 수 있습니다.</p>;
  const neighbors = projectNeighbors(model, node.id);
  return (
    <section className="project-literature-detail" aria-label="선택한 자료 상세">
      <p className="reader-muted">{kinds[node.kind]}</p>
      <h3>{node.label}</h3>
      {node.kind === "paper" && (
        <>
          <SourceBadge node={node} />
          <p className="reader-muted">
            {[node.paper.journal, node.paper.pub_date].filter(Boolean).join(" · ")}
          </p>
          <p>
            연구 방법: {node.method.label} <small>({sourceLabel(node.method.source)})</small>
          </p>
          <p>
            주제: {node.topics.map((topic) => `${topic.label} (${sourceLabel(topic.source)})`).join(" · ")}
          </p>
          <PaperActions node={node} onShowReference={onShowReference} />
        </>
      )}
      {node.kind === "argument" && (
        <>
          <p className="project-literature-body">{node.topic.body || "작성된 본문이 없습니다."}</p>
          <button type="button" className="btn-secondary" onClick={() => onShowTopic(node.topic)}>
            {sectionLabel(node.topic)} 논점에서 보기
          </button>
          {!!node.omittedReferences && (
            <p className="reader-muted">
              연결 문헌 {node.omittedReferences}편은 현재 표시 범위 밖에 있습니다.
            </p>
          )}
        </>
      )}
      {node.kind === "topic" && (
        <p>저장된 MeSH·키워드에 따른 주제 분류입니다. 아래 문헌들이 같은 결론을 지지한다는 뜻은 아닙니다.</p>
      )}
      {!!neighbors.length && (
        <>
          <h4>연결된 자료 {neighbors.length}개</h4>
          <ul className="project-literature-neighbors">
            {neighbors.slice(0, 50).map(({ node: related, edge }) => (
              <li key={edge.id}>
                <button
                  type="button"
                  className="project-literature-neighbor"
                  onClick={() => onSelect(related.id)}
                >
                  <small>
                    {edge.kind === "linked"
                      ? "사용자가 연결한 자료"
                      : `주제 분류 · ${sourceLabel(edge.source)}`}
                  </small>
                  <span>{related.label}</span>
                </button>
                {(edge.cellLinks || []).map((link) => {
                  const reference = node.kind === "paper" ? node.reference : related.reference;
                  return reference ? (
                    <CellDetail
                      key={link.column_id}
                      reference={reference}
                      columnId={link.column_id}
                      columns={columns}
                      onShowReference={onShowReference}
                    />
                  ) : null;
                })}
              </li>
            ))}
          </ul>
          {neighbors.length > 50 && (
            <p className="reader-muted">처음 50개 연결을 표시합니다. 다른 항목을 선택해 이어서 확인하세요.</p>
          )}
        </>
      )}
      {!neighbors.length && <p className="reader-muted">표시 범위에서 확인된 연결이 없습니다.</p>}
    </section>
  );
}

function Distribution({ model, onSelect }) {
  const [dimension, setDimension] = useState("topics");
  const [groupId, setGroupId] = useState("");
  const groups = literatureDistribution(model, dimension);
  const group = groups.find((item) => item.id === groupId);
  return (
    <section aria-label="프로젝트 문헌 분포">
      <div className="project-literature-switch" role="group" aria-label="분포 기준">
        {[
          ["topics", "임상·연구 주제"],
          ["methods", "연구 방법"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={dimension === id}
            className={dimension === id ? "btn-primary" : "btn-secondary"}
            onClick={() => {
              setDimension(id);
              setGroupId("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="reader-muted">
        {dimension === "topics"
          ? "MeSH·키워드 분류입니다. 한 문헌이 여러 주제에 포함될 수 있습니다."
          : "저장된 연구 설계·출판 유형을 기준으로 분류합니다. AI·영상·수술은 연구 방법으로 세지 않습니다."}{" "}
        미분류는 확인 가능한 분류 정보가 없는 문헌입니다.
      </p>
      <ul className="project-distribution-bars">
        {groups.map((item) => (
          <li key={item.id}>
            <button type="button" aria-pressed={item.id === groupId} onClick={() => setGroupId(item.id)}>
              <span>{item.label}</span>
              <strong>{item.papers.length}편</strong>
              <span className="project-distribution-track" aria-hidden="true">
                <span
                  style={{
                    width: `${model.papers.length ? (item.papers.length / model.papers.length) * 100 : 0}%`,
                  }}
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {group && (
        <section className="project-distribution-papers" aria-label={`${group.label} 문헌`}>
          <h3>
            {group.label} · {group.papers.length}편
          </h3>
          <ul>
            {group.papers.map((paper) => (
              <li key={paper.id}>
                <button
                  type="button"
                  className="project-literature-neighbor"
                  onClick={() => onSelect(paper.id)}
                >
                  <span>{paper.label}</span>
                  <SourceBadge node={paper} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function Network({ model, selectedId, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const [listView, setListView] = useState(false);
  const visible = projectGraphWindow(model, selectedId, expanded);
  const groups = orderedKinds.map((kind) => ({
    kind,
    nodes: visible.nodes.filter((node) => node.kind === kind),
  }));
  const height = Math.max(350, ...groups.map((group) => group.nodes.length * 90 + 30));
  const positions = new Map(
    groups.flatMap((group, column) =>
      group.nodes.map((node, index) => [node.id, { x: 17 + column * 33, y: 48 + index * 90 }]),
    ),
  );
  const select = (id) => {
    setExpanded(false);
    onSelect(id);
  };
  return (
    <section aria-label="프로젝트 연결 지도">
      <div className="project-literature-actions">
        <button
          type="button"
          className="btn-secondary"
          aria-pressed={expanded}
          disabled={!selectedId || (!expanded && !visible.hiddenNeighbors)}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "기본 범위로 접기" : "선택한 항목의 연결 펼치기"}
        </button>
        <button
          type="button"
          className="btn-secondary project-network-list-toggle"
          aria-pressed={listView}
          onClick={() => setListView((value) => !value)}
        >
          {listView ? "지도로 보기" : "목록으로 보기"}
        </button>
        <span className="reader-muted">
          항목 {visible.nodes.length}/{visible.totalNodes}개
          {visible.hiddenNeighbors ? ` · 선택 항목의 숨은 연결 ${visible.hiddenNeighbors}개` : ""}
        </span>
      </div>
      <p className="project-network-legend">
        <span>
          <i />
          사용자가 연결한 자료
        </span>
        <span>
          <i className="classified" />
          주제 분류
        </span>
      </p>
      <p className="reader-muted">
        사용자의 자료 연결은 근거 지지 판정이 아닙니다. 실제 참고문헌 인용이 확인된 데이터가 없어 인용·인과
        관계는 표시하지 않습니다.
      </p>
      <div className={`project-network ${listView ? "is-list" : ""}`}>
        <div className="project-network-canvas">
          <div className="project-network-headings">
            {groups.map((group) => (
              <span key={group.kind}>{kinds[group.kind]}</span>
            ))}
          </div>
          <div className="project-network-scroll">
            <div className={`project-network-space${selectedId ? " has-selection" : ""}`} style={{ height }}>
              <svg aria-hidden="true" viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none">
                {visible.edges.map((edge) => {
                  const from = positions.get(edge.from),
                    to = positions.get(edge.to);
                  return (
                    <path
                      key={edge.id}
                      d={`M ${from.x * 10} ${from.y} C ${(from.x + to.x) * 5} ${from.y}, ${(from.x + to.x) * 5} ${to.y}, ${to.x * 10} ${to.y}`}
                      className={`${edge.kind}${edge.from === selectedId || edge.to === selectedId ? " selected" : ""}`}
                    />
                  );
                })}
              </svg>
              {visible.nodes.map((node) => {
                const position = positions.get(node.id);
                return (
                  <button
                    type="button"
                    key={node.id}
                    className={`project-network-node ${node.kind}`}
                    style={{ left: `${position.x}%`, top: position.y }}
                    aria-pressed={selectedId === node.id}
                    title={node.label}
                    onClick={() => select(node.id)}
                  >
                    <small>{node.kind === "paper" ? node.status.label : kinds[node.kind]}</small>
                    <span>{node.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="project-network-list" role="region" aria-label="연결 지도 목록">
          {groups
            .filter((group) => group.nodes.length)
            .map((group) => (
              <section key={group.kind}>
                <h3>{kinds[group.kind]}</h3>
                <ul>
                  {group.nodes.map((node) => (
                    <li key={node.id}>
                      <button
                        type="button"
                        className="project-literature-neighbor"
                        aria-pressed={selectedId === node.id}
                        onClick={() => select(node.id)}
                      >
                        <span>{node.label}</span>
                        <small>
                          {node.kind === "paper"
                            ? node.status.label
                            : `${projectNeighbors(model, node.id).length}개 연결`}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </div>
    </section>
  );
}

export default function ProjectLiteratureViews({
  projectId,
  filter,
  view,
  onViewChange,
  columns,
  onShowReference,
  onShowTopic,
  onError,
}) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const context = `${projectId}:${filter}`;
  const active = view !== "table";
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setError("");
    rpc("research_graph", { p_id: projectId, p_query: filter, p_limit: 50 })
      .then((data) => {
        if (!alive) return;
        setResult({ ...data, context });
      })
      .catch((failure) => {
        if (!alive) return;
        setError(failure.message || "문헌 보기를 불러오지 못했습니다.");
        errorHandler.current?.(failure);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, filter, context, active, revision]);
  const current = result?.context === context ? result : null;
  const model = useMemo(() => buildProjectLiterature(current?.references, current?.topics), [current]);
  const selected = model.byId.get(selectedId);
  return (
    <div className="project-literature-views">
      <div className="project-literature-switch" role="group" aria-label="선행연구 보기 방식">
        {[
          ["table", "표"],
          ["distribution", "분포"],
          ["network", "연결 지도"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={view === id}
            className={view === id ? "btn-primary" : "btn-secondary"}
            onClick={() => onViewChange(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {active && (
        <>
          <div className="project-literature-actions">
            <p className="reader-muted">
              {current
                ? `표시 문헌 ${model.papers.length} / 검색 범위 ${current.total}편 · 집필 논점 ${current.topics?.length || 0} / ${current.topic_total ?? current.topics?.length ?? 0}개`
                : "프로젝트의 문헌과 집필 연결을 불러옵니다."}
            </p>
            <button
              type="button"
              className="btn-secondary"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              보기 새로고침
            </button>
          </div>
          {current && (current.truncated || current.total > model.papers.length) && (
            <p className="reader-muted">
              최대 50편의 표시 자료에 대한 분포입니다. 전체 프로젝트의 분포로 해석하지 마세요. 문헌 검색으로
              범위를 좁힐 수 있습니다.
            </p>
          )}
          {loading && <p role="status">문헌 보기를 불러오는 중…</p>}
          {error && <p role="alert">{error}</p>}
          {!loading &&
            !error &&
            current &&
            (!model.papers.length ? (
              <p>이 검색 범위에 표시할 프로젝트 문헌이 없습니다.</p>
            ) : (
              <>
                {view === "distribution" ? (
                  <Distribution model={model} onSelect={setSelectedId} />
                ) : (
                  <Network model={model} selectedId={selected?.id || ""} onSelect={setSelectedId} />
                )}
                <NodeDetail
                  model={model}
                  node={selected}
                  columns={columns}
                  onSelect={setSelectedId}
                  onShowReference={onShowReference}
                  onShowTopic={onShowTopic}
                />
              </>
            ))}
        </>
      )}
    </div>
  );
}
