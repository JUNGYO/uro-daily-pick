import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronRight, Download, List, Minus, Plus, RotateCcw } from "lucide-react";
import { CATEGORY_LABELS, categoryColor, edgeWidth } from "../lib/researchNetwork";
import {
  conceptAtlasLabels,
  conceptAtlasLayout,
  conceptMapCoverage,
  conceptMapSnapshot,
  isConceptGroup,
} from "../lib/conceptAtlas";
import "./conceptAtlas.css";

const number = (value) => Number(value || 0).toLocaleString("en-US");
const activate = (event, callback) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    callback();
  }
};
const nodeDescription = (node) =>
  `${node.label}, ${isConceptGroup(node) ? `${number(node.concept_count)} concepts, ` : ""}${number(node.document_count)} papers, ${CATEGORY_LABELS[node.kind] || "Unclassified"}${isConceptGroup(node) ? ". Open group" : ""}`;

export default function ConceptAtlas({
  data,
  selected,
  peer,
  onSelectConcept,
  onSelectEdge,
  onDrill,
  breadcrumbs = [],
  onBack,
  onReset,
  minimum = 1,
  setMinimum,
  loading = false,
}) {
  const [list, setList] = useState(false);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const [inspectedEdge, setInspectedEdge] = useState(null);
  const canvas = useRef(null);
  const drag = useRef(null);
  const graphTitle = useId();
  const nodes = useMemo(
    () =>
      (data.nodes || []).map((node) => ({
        ...node,
        label:
          isConceptGroup(node) && node.drill?.category && !node.drill.prefix
            ? CATEGORY_LABELS[node.kind] || node.label
            : node.label,
      })),
    [data.nodes],
  );
  const edges = data.edges || [];
  const coverage = conceptMapCoverage(data);
  const height = width < 500 ? 470 : 560;
  const scopeKey = `${data.map?.level || "overview"}:${data.map?.cluster || ""}:${data.map?.category || ""}:${data.map?.prefix || ""}:${selected || ""}:${peer || ""}`;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = () => {
      if (element.clientWidth) setWidth(Math.max(240, Math.floor(element.clientWidth)));
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHover(null);
    setInspectedEdge(null);
  }, [scopeKey]);
  const points = useMemo(
    () => conceptAtlasLayout(nodes, edges, width, height),
    [nodes, edges, width, height],
  );
  const byId = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const labels = conceptAtlasLabels(points, width, height, [selected, peer, hover], { zoom, pan });
  const highlighted = hover || selected;
  const neighbors = new Set(
    edges.flatMap((edge) =>
      edge.source === highlighted ? [edge.target] : edge.target === highlighted ? [edge.source] : [],
    ),
  );
  const hoveredNode = byId.get(hover);
  const openNode = (node) => {
    if (loading) return;
    setInspectedEdge(null);
    if (isConceptGroup(node)) onDrill?.(data.nodes?.find((item) => item.id === node.id) || node);
    else onSelectConcept?.(node.id);
  };
  const openEdge = (edge) => {
    if (loading) return;
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (!source || !target) return;
    if (!isConceptGroup(source) && !isConceptGroup(target)) onSelectEdge?.(source.id, target.id);
    else {
      setHover(null);
      setInspectedEdge({ source, target, weight: edge.weight });
    }
  };
  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const exportMap = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(conceptMapSnapshot(data), null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "research-network.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const groupMode = data.map?.grouping === "alphabetical_range";
  const communities = data.map?.grouping === "cooccurrence_community";
  const withinCommunity = communities && data.map?.level === "community";
  return (
    <div className="concept-atlas" aria-busy={loading}>
      {(breadcrumbs.length > 0 || onBack) && (
        <nav className="concept-atlas-path" aria-label="Concept map path">
          {onBack && (
            <button type="button" onClick={onBack} disabled={loading} aria-label="Back to previous map">
              <ArrowLeft size={15} />
            </button>
          )}
          <ol>
            {breadcrumbs.map((item, index) => (
              <li key={`${index}:${item.label}`}>
                {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
                {item.onClick ? (
                  <button type="button" onClick={item.onClick} disabled={loading}>
                    {item.label}
                  </button>
                ) : (
                  <span aria-current="location">{item.label}</span>
                )}
              </li>
            ))}
          </ol>
          {onReset && (data.map?.level !== "overview" || selected || peer) && (
            <button
              type="button"
              onClick={onReset}
              disabled={loading}
              className="concept-atlas-reset"
              title="Return to the whole concept map and its connections"
            >
              Whole map
            </button>
          )}
        </nav>
      )}
      <div className="concept-atlas-summary">
        <div>
          <strong>
            {number(coverage.represented)} concepts {coverage.complete ? "represented" : "in this view"}
          </strong>
          <span>
            {withinCommunity && "Within selected community · "}
            {coverage.groups > 0
              ? `${number(coverage.groups)} explorable groups${coverage.concepts ? ` + ${number(coverage.concepts)} individual concepts` : ""}`
              : "Every concept shown individually"}
          </span>
        </div>
        <span className="concept-atlas-scope">
          {number(data.map?.graph_papers ?? data.selected_documents ?? data.matched_documents)} indexed papers
          in this map level
          <span>
            {coverage.scope > coverage.represented
              ? withinCommunity
                ? `${number(coverage.scope)} concepts in the whole map`
                : `${number(coverage.scope)} concepts across the selected scope`
              : "within the current filters"}
          </span>
          {(selected || peer) && (
            <span>
              {number(data.selected_documents ?? data.matched_documents)} papers in selected evidence
            </span>
          )}
        </span>
      </div>
      <p className="concept-atlas-instruction">
        {withinCommunity
          ? "Showing connections within this community. Whole map restores the connections between communities."
          : coverage.groups > 0
            ? communities
              ? "Open a community to explore its concepts and supporting papers. Labels name actual concepts in that community."
              : groupMode
                ? "Open a label range to reach every concept in this category."
                : "Open a category to explore its concepts. Every indexed concept belongs to the map."
            : "Select a concept or connection to examine its supporting papers."}
      </p>
      <div className="concept-atlas-toolbar">
        <span>
          {communities
            ? "Full-text research communities"
            : groupMode
              ? "Concept ranges"
              : coverage.groups
                ? "Whole concept structure"
                : "Concept co-occurrence"}
        </span>
        {setMinimum && (
          <label className="concept-atlas-minimum">
            Shared papers{" "}
            <select
              aria-label="Minimum shared papers"
              value={minimum}
              onChange={(event) => setMinimum(Number(event.target.value))}
              disabled={loading}
            >
              {[1, 2, 3, 5, 10].map((value) => (
                <option key={value} value={value}>
                  {value} or more
                </option>
              ))}
            </select>
          </label>
        )}
        <div>
          <button
            type="button"
            onClick={() => setList((value) => !value)}
            aria-pressed={list}
            aria-label={list ? "Show graph" : "Show accessible concept list"}
            title={list ? "Show graph" : "Show list"}
          >
            <List size={17} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
            disabled={list || zoom <= 1}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={17} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(3, value + 0.5))}
            disabled={list || zoom >= 3}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={17} />
          </button>
          <button type="button" onClick={fit} disabled={list} aria-label="Reset graph view" title="Fit view">
            <RotateCcw size={17} />
          </button>
          <button type="button" onClick={exportMap} aria-label="Export data" title="Export map">
            <Download size={17} />
          </button>
        </div>
      </div>
      <div ref={canvas} className="concept-atlas-viewport network-canvas-scroll">
        {!nodes.length ? (
          <p className="concept-atlas-empty">
            No indexed concepts match this selection. Broaden the filters to return to the map.
          </p>
        ) : list ? (
          <ul
            className="concept-atlas-list atlas-node-list"
            aria-label="All concepts and groups in this view"
          >
            {nodes.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => openNode(node)}
                  disabled={loading}
                  aria-pressed={node.id === selected || node.id === peer}
                >
                  <i
                    className={isConceptGroup(node) ? "is-group" : ""}
                    style={{ background: node.color || categoryColor(node.kind) }}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{node.label}</strong>
                    <small>
                      {isConceptGroup(node)
                        ? `${number(node.concept_count)} concepts · Open group`
                        : CATEGORY_LABELS[node.kind] || "Unclassified"}
                    </small>
                  </span>
                  <span className="concept-atlas-list-count">
                    {number(node.document_count)}
                    <small>papers</small>
                  </span>
                  {isConceptGroup(node) && <ChevronRight size={15} aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <svg
            className="concept-atlas-graph atlas-graph"
            viewBox={`0 0 ${width} ${height}`}
            style={{ touchAction: zoom === 1 ? "pan-y" : "none" }}
            role="group"
            aria-label="Concept map from full texts"
            aria-describedby={graphTitle}
            onPointerDown={(event) => {
              // At the fitted view the whole map is already in frame. Leave
              // one-finger vertical gestures to page scrolling on phones.
              if (event.pointerType === "touch" && zoom === 1) return;
              if (event.target.closest('[role="button"]')) return;
              drag.current = { x: event.clientX, y: event.clientY, pan };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              const scale = width / event.currentTarget.getBoundingClientRect().width;
              setPan({
                x: Math.max(
                  -width,
                  Math.min(width, drag.current.pan.x + (event.clientX - drag.current.x) * scale),
                ),
                y: Math.max(
                  -height,
                  Math.min(height, drag.current.pan.y + (event.clientY - drag.current.y) * scale),
                ),
              });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <desc id={graphTitle}>
              Circle area represents distinct papers. Ringed circles contain groups of concepts. Select a
              group to unfold it. Line width represents shared papers. Every concept at this map level is
              represented, including concepts without links. Use the complete list for all names.
            </desc>
            <g
              transform={`translate(${width / 2 + pan.x} ${height / 2 + pan.y}) scale(${zoom}) translate(${-width / 2} ${-height / 2})`}
            >
              {edges.map((edge) => {
                const source = byId.get(edge.source),
                  target = byId.get(edge.target);
                if (!source || !target) return null;
                const active = peer
                  ? [selected, peer].includes(edge.source) && [selected, peer].includes(edge.target)
                  : edge.source === highlighted || edge.target === highlighted;
                const grouped = isConceptGroup(source) || isConceptGroup(target);
                const label = `${source.label} and ${target.label}: ${number(edge.weight)} shared papers${grouped ? ". Inspect group relationship" : ""}`;
                return (
                  <g
                    key={`${edge.source}:${edge.target}`}
                    className="concept-atlas-edge"
                    role="button"
                    tabIndex={loading ? -1 : 0}
                    aria-label={label}
                    aria-pressed={active}
                    onClick={() => openEdge(edge)}
                    onKeyDown={(event) => activate(event, () => openEdge(edge))}
                  >
                    <title>{label}</title>
                    <line
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={active ? "#244fb4" : "#8294ae"}
                      strokeOpacity={highlighted && !active ? 0.1 : active ? 0.8 : 0.28}
                      strokeWidth={1 + (edgeWidth(edge.weight) - 1) * 0.5}
                    />
                    <line
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke="transparent"
                      strokeWidth="14"
                    />
                  </g>
                );
              })}
              {points.map((point) => {
                const group = isConceptGroup(point),
                  active = point.id === selected || point.id === peer;
                const label = labels.get(point.id);
                return (
                  <g
                    key={point.id}
                    className={`concept-atlas-node atlas-node${group ? " is-group" : ""}`}
                    role="button"
                    tabIndex={loading ? -1 : 0}
                    aria-label={nodeDescription(point)}
                    aria-pressed={active}
                    onClick={() => openNode(point)}
                    onKeyDown={(event) => activate(event, () => openNode(point))}
                    onMouseEnter={() => setHover(point.id)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(point.id)}
                    onBlur={() => setHover(null)}
                  >
                    <title>{nodeDescription(point)}</title>
                    <circle cx={point.x} cy={point.y} r={Math.max(22, point.r + 7)} fill="transparent" />
                    {point.r < 3 && (
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r="3"
                        fill="none"
                        stroke={point.color || categoryColor(point.kind)}
                        strokeOpacity="0.65"
                        strokeWidth="1"
                      />
                    )}
                    {group && (
                      <circle
                        className="concept-atlas-group-ring"
                        cx={point.x}
                        cy={point.y}
                        r={point.r + 5}
                        fill="none"
                        stroke={point.color || categoryColor(point.kind)}
                        strokeOpacity="0.4"
                        strokeWidth="1.5"
                      />
                    )}
                    <circle
                      className="concept-atlas-disc"
                      cx={point.x}
                      cy={point.y}
                      r={point.r}
                      fill={point.color || categoryColor(point.kind)}
                      opacity={
                        !highlighted || point.id === highlighted || active || neighbors.has(point.id)
                          ? 1
                          : 0.3
                      }
                      stroke={active ? "#152b4b" : "#fff"}
                      strokeWidth={active ? 3 : 1.5}
                    />
                    {group && point.r > 16 && (
                      <text
                        className="concept-atlas-group-count"
                        x={point.x}
                        y={point.y + 4}
                        textAnchor="middle"
                      >
                        {number(point.concept_count)}
                      </text>
                    )}
                    {label && (
                      <text
                        className="concept-atlas-label"
                        x={label.x}
                        y={label.y}
                        textAnchor="middle"
                        style={{ fontSize: label.fontSize, strokeWidth: 4 / zoom }}
                      >
                        {label.label}
                        {group && (
                          <tspan
                            className="concept-atlas-label-detail"
                            x={label.x}
                            dy={label.lineHeight}
                            style={{ fontSize: label.detailSize }}
                          >
                            {number(point.concept_count)} concepts
                          </tspan>
                        )}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
      <div className="concept-atlas-readout" aria-live="polite">
        {hoveredNode ? (
          <p>
            <strong>{hoveredNode.label}</strong>
            <span>
              {isConceptGroup(hoveredNode) ? `${number(hoveredNode.concept_count)} concepts · ` : ""}
              {number(hoveredNode.document_count)} papers
            </span>
          </p>
        ) : inspectedEdge ? (
          <div>
            <p>
              <strong>
                {inspectedEdge.source.label} × {inspectedEdge.target.label}
              </strong>
              <span>{number(inspectedEdge.weight)} papers contain concepts from both endpoints.</span>
            </p>
            <div className="concept-atlas-edge-actions">
              {[inspectedEdge.source, inspectedEdge.target].filter(isConceptGroup).map((node) => (
                <button type="button" key={node.id} onClick={() => openNode(node)}>
                  Open {node.label}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="concept-atlas-help">
            {list
              ? "Every group can be unfolded; individual concepts lead to supporting papers."
              : "Select to explore · Drag to pan · Zoom for labels · List contains every visible group and concept"}
          </p>
        )}
      </div>
      <div className="concept-atlas-legend">
        {communities ? (
          <span>Color follows a co-occurrence community</span>
        ) : (
          [...new Set(nodes.map((node) => node.kind))].sort().map((kind) => (
            <span key={kind}>
              <i style={{ background: categoryColor(kind) }} />
              {CATEGORY_LABELS[kind] || "Unclassified"}
            </span>
          ))
        )}
        {coverage.groups > 0 && (
          <span>
            <i className="concept-atlas-ring-key" />
            Ring = explorable group
          </span>
        )}
      </div>
      <details className="concept-atlas-method">
        <summary>What this map represents</summary>
        {communities ? (
          <>
            <p>
              Every extracted concept is included, including rare concepts and those without a MeSH match.
              Communities are computed from the complete shared-paper network; they are not predefined disease
              categories. Each label lists actual representative concepts.
            </p>
            <p>
              Circle area = distinct indexed papers. A line counts distinct papers containing concepts from
              both endpoints. Color identifies a community; position is for navigation, not a measurement of
              clinical similarity. Shared papers changes visible connections, not community membership.
            </p>
            <p>
              Deterministic weighted modularity grouping, resolution {data.map.resolution}. Open a community
              to reach every original concept. Papers may support several communities; their counts must not
              be added. The map describes indexed full texts, not the entire catalog, citation direction,
              clinical effects or evidence quality.
            </p>
          </>
        ) : (
          <>
            <p>
              Filled circle area = distinct indexed papers; tiny nodes have a visibility outline. Line width =
              shared-paper count (log scale). Color = MeSH category. The shared-paper filter changes
              connections, never removes concepts. Positions help navigation; distance is not a measure of
              clinical similarity.
            </p>
            <p>
              Large views group every concept by MeSH category, then by alphabetical label ranges. These are
              navigation groups, not inferred research clusters. A group edge counts papers containing at
              least one concept from each endpoint. Papers can belong to multiple groups, so group paper
              counts must not be added together.
            </p>
            <p>
              The map covers indexed full texts within the current filters. Registered papers without indexed
              concepts are not represented. Counts do not measure clinical effect, study quality, or
              consensus. Grouping reduces visual detail without selecting only the most frequent concepts.
            </p>
          </>
        )}
      </details>
    </div>
  );
}
