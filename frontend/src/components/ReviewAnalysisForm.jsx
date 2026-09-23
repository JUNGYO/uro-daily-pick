import { useEffect, useState } from "react";
import { rpc } from "../lib/workspace";
import { reviewList, uid, contextFields } from "../lib/review";

const fields = ["outcome", "timepoint", "comparison", "unit", "analysis_population", "adjustment"];
const profiles = {
  "pairwise-binary-v1": { kind: "binary", measures: ["RR", "OR", "RD"] },
  "mh-common-binary-v1": { kind: "binary", measures: ["RR", "OR", "RD"] },
  "pairwise-continuous-v1": { kind: "continuous", measures: ["MD", "SMD"] },
  "pairwise-estimate-v1": { kind: "effect", measures: ["RR", "OR", "HR", "MD", "SMD"] },
  "dta-bivariate-v1": { kind: "diagnostic", measures: ["SeSp"] },
};
const labels = {
  "pairwise-binary-v1": "치료효과 · 이분형 · REML",
  "mh-common-binary-v1": "희소 사건 · Mantel–Haenszel 공통효과",
  "pairwise-continuous-v1": "치료효과 · 연속형 · REML",
  "pairwise-estimate-v1": "보고된 효과값 · REML",
  "dta-bivariate-v1": "진단정확도 · 이변량 이항 모형",
};

export default function ReviewAnalysisForm({ project, protocol, disabled, action, dirty = () => {} }) {
  const [data, setData] = useState({ items: [], total: 0 }),
    [page, setPage] = useState(0),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState({}),
    [profile, setProfile] = useState(
      protocol?.payload?.type === "diagnostic" ? "dta-bivariate-v1" : "pairwise-binary-v1",
    ),
    [config, setConfig] = useState({
      measure: protocol?.payload?.type === "diagnostic" ? "SeSp" : "RR",
      analysis_intent: "prespecified",
    }),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    reviewList(project.id, "observations", query, "", page)
      .then((x) => {
        if (live) setData(x);
      })
      .catch(() => {
        if (live) setError("관측값을 불러오지 못했습니다.");
      });
    return () => {
      live = false;
    };
  }, [project.id, page, query]);
  const first = Object.values(selected)[0];
  function choose(row) {
    dirty();
    if (!first)
      setConfig((x) => ({
        ...x,
        ...Object.fromEntries(fields.map((k) => [k, row.context[k]])),
        measure: row.kind === "effect" ? row.values.measure : x.measure,
      }));
    setSelected((old) => {
      const next = { ...old };
      if (next[row.id]) delete next[row.id];
      else next[row.id] = row;
      return next;
    });
  }
  function mismatch(row) {
    if (row.status !== "confirmed") return "원문 대조 확인 필요";
    if (row.kind !== profiles[profile].kind) return "다른 자료 유형";
    if (first && fields.some((k) => first.context[k] !== row.context[k]))
      return "평가변수·시점·비교 조건이 다름";
    return "";
  }
  return (
    <form
      className="reader-card review-form"
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        action(() =>
          rpc("review_start_analysis", {
            p_project: project.id,
            p_run_id: uid(),
            p_protocol_version: protocol?.version,
            p_rows: Object.values(selected).map((r) => ({ id: r.id, revision: r.revision })),
            p_config: { ...config, profile },
          }),
        );
      }}
    >
      <h3>분석 입력 확정</h3>
      <p>
        같은 평가변수·시점·비교의 확인된 수치를 선택하세요. 계산에는 계획서와 수치의 현재 버전이 고정됩니다.
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={disabled}>
        <label>
          분석 방법
          <select
            value={profile}
            onChange={(e) => {
              const p = e.target.value;
              setProfile(p);
              setSelected({});
              setConfig((x) => ({ ...x, measure: profiles[p].measures[0] }));
            }}
          >
            {Object.entries(labels)
              .filter(([p]) => (p === "dta-bivariate-v1") === (protocol?.payload?.type === "diagnostic"))
              .map(([p, label]) => (
                <option key={p} value={p}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label>
          평가변수로 관측값 찾기
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <h4>관측값 · 선택 {Object.keys(selected).length}개</h4>
        {!data.items.length && <p>선택할 자료가 없습니다. 데이터 추출에서 수치와 원문을 확인해 주세요.</p>}
        {data.items.map((o) => {
          const why = mismatch(o);
          return (
            <label className="review-check" key={o.id}>
              <input
                type="checkbox"
                disabled={!!why && !selected[o.id]}
                checked={!!selected[o.id]}
                onChange={() => choose(o)}
              />
              <span>
                {o.context.independence_group} · {o.context.outcome} · {o.context.timepoint}
                {why && <small className="reader-muted"> · {why}</small>}
              </span>
            </label>
          );
        })}
        <div className="reader-actions">
          <button type="button" className="btn-secondary" disabled={!page} onClick={() => setPage(page - 1)}>
            이전 관측값
          </button>
          <span>
            {page + 1} / {Math.max(1, Math.ceil(data.total / 25))}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={(page + 1) * 25 >= data.total}
            onClick={() => setPage(page + 1)}
          >
            다음 관측값
          </button>
          <button type="button" className="btn-secondary" onClick={() => setSelected({})}>
            선택 해제
          </button>
        </div>
        <div className="review-grid">
          <label>
            효과 지표
            <select
              name="measure"
              value={config.measure}
              onChange={(e) => setConfig((x) => ({ ...x, measure: e.target.value }))}
            >
              {profiles[profile].measures.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {fields.map((k) => (
            <label key={k}>
              {contextFields.find((x) => x[0] === k)?.[1] || k}
              <input
                required
                value={config[k] || ""}
                onChange={(e) => setConfig((x) => ({ ...x, [k]: e.target.value }))}
              />
            </label>
          ))}
          <label>
            분석 목적
            <select
              value={config.analysis_intent}
              onChange={(e) => setConfig((x) => ({ ...x, analysis_intent: e.target.value }))}
            >
              <option value="prespecified">사전 계획</option>
              <option value="exploratory">탐색적 분석</option>
            </select>
          </label>
        </div>
        <label>
          분석 선택의 근거
          <textarea
            required={profile === "mh-common-binary-v1"}
            value={config.justification || ""}
            onChange={(e) => setConfig((x) => ({ ...x, justification: e.target.value }))}
          />
        </label>
        {profile.startsWith("pairwise-") && (
          <label className="review-check">
            <input
              type="checkbox"
              checked={!!config.prediction_interval}
              onChange={(e) => setConfig((x) => ({ ...x, prediction_interval: e.target.checked }))}
            />
            예측구간 요청 · 5개 이상 독립 효과에서 계산
          </label>
        )}
        <button className="btn-primary" disabled={!first || protocol?.payload?.status !== "locked"}>
          입력 고정·계산 요청
        </button>
        {protocol?.payload?.status !== "locked" && <p>연구계획을 확정한 뒤 계산을 요청할 수 있습니다.</p>}
      </fieldset>
    </form>
  );
}
