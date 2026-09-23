import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import {
  reviewList,
  saveReview,
  reviewRequest,
  uid,
  importCatalogPage,
  downloadBlob,
  KIND_LABELS,
  VALUE_FIELDS,
  contextFields,
  initialContext,
  observationPayload,
} from "../lib/review";
import "./reviewWorkspace.css";
import AnalysisForm from "./ReviewAnalysisForm";
import ReviewSource from "./ReviewSource";

const tabs = [
  ["protocol", "연구계획"],
  ["sources", "검색·가져오기"],
  ["reports", "문헌 선별"],
  ["studies", "연구 연결"],
  ["observations", "데이터 추출"],
  ["assessments", "편향·근거 평가"],
  ["analysis", "분석·내보내기"],
  ["reviews", "리뷰"],
];
const decisions = { pending: "미판정", include: "포함", exclude: "제외", defer: "보류" };
const runLabels = {
  queued: "계산 대기",
  running: "계산 중",
  succeeded: "계산 완료",
  needs_review: "결과 검토 필요",
  failed: "계산 실패",
  cancelled: "취소",
};
const analysisMessages = {
  small_k_intervals_are_uncertain:
    "연구 수가 적어 구간 추정이 불안정할 수 있습니다. 민감도 분석을 함께 확인하세요.",
  single_study_no_pooling: "연구가 한 편이므로 개별 결과만 제시합니다.",
  model_nonconvergence: "모형이 수렴하지 않아 통합 추정치를 제시하지 않습니다.",
  boundary_variance_or_correlation: "분산 또는 상관 추정이 경계에 있습니다. 방법론 검토가 필요합니다.",
  small_k_methodological_review_required: "연구 수가 적어 진단 정확도 통합 결과의 방법론 검토가 필요합니다.",
  optimizer_start_disagreement: "계산 시작점에 따라 결과가 달라집니다. 통합 결과를 확인해 주세요.",
  invalid_covariance_no_interval: "추정 불확실성을 안정적으로 계산하지 못해 통합 구간을 제시하지 않습니다.",
  sparse_events_require_profile:
    "사건 수가 적어 현재 분석을 적용할 수 없습니다. 희소 사건용 방법과 연구계획을 검토하세요.",
  design_adjustment_required: "연구 설계에 맞게 보정한 효과값과 보정 근거가 필요합니다.",
  incompatible_design: "연구 설계가 다른 자료는 별도로 분석해 주세요.",
  worker_timeout: "계산 제한 시간을 초과했습니다. 자료 범위와 분석 방법을 확인해 주세요.",
  worker_calculation_failed: "계산을 완료하지 못했습니다. 입력 자료를 확인하고 다시 요청해 주세요.",
};
const field = (name, label, value = "", props = {}) => (
  <label key={name}>
    {label}
    <input name={name} defaultValue={value ?? ""} {...props} />
  </label>
);
const area = (name, label, value = "", props = {}) => (
  <label key={name}>
    {label}
    <textarea name={name} defaultValue={value ?? ""} rows={3} {...props} />
  </label>
);
const options = (name, label, value, items) => (
  <label>
    {label}
    <select name={name} defaultValue={value}>
      {items.map(([id, title]) => (
        <option key={id} value={id}>
          {title}
        </option>
      ))}
    </select>
  </label>
);
const payload = (form, names) => Object.fromEntries(names.map((k) => [k, String(form.get(k) || "")]));
const labelReport = (r) => r?.bibliography?.title || "보고서";

function Pages({ page, total, onChange }) {
  return (
    <div className="reader-actions">
      <button className="btn-secondary" disabled={!page} onClick={() => onChange(page - 1)}>
        이전
      </button>
      <span>
        {page + 1} / {Math.max(1, Math.ceil(total / 25))}
      </span>
      <button
        className="btn-secondary"
        disabled={(page + 1) * 25 >= total}
        onClick={() => onChange(page + 1)}
      >
        다음
      </button>
    </div>
  );
}
function Flow({ counts = {} }) {
  const stages = [
    ["records", "검색 기록"],
    ["reports", "중복 통합 후 보고서"],
    ["sought", "원문 검토 대상"],
    ["included", "포함 보고서"],
    ["studies", "포함 연구"],
  ];
  return (
    <div className="review-flow" aria-label="문헌 선별 흐름">
      {stages.map(([k, l], i) => (
        <div key={k}>
          <span>
            {i + 1}. {l}
          </span>
          <strong>{(counts[k] || 0).toLocaleString()}</strong>
        </div>
      ))}
      <p>
        제목·초록 대기 {counts.ta_pending || 0} · 원문 검토 대기 {counts.ft_pending || 0} · 원문 미확보{" "}
        {counts.unavailable || 0}
      </p>
    </div>
  );
}

export default function ReviewWorkspace({ project, onClose }) {
  const { user } = useAuth();
  const [workspace, setWorkspace] = useState(null),
    [tab, setTab] = useState("protocol"),
    [list, setList] = useState({ items: [], total: 0 }),
    [page, setPage] = useState(0),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState(null),
    [dirty, setDirty] = useState(false),
    [run, setRun] = useState(null);
  const alive = useRef(true),
    controller = useRef(null);
  const canEdit = workspace?.can_edit && !user.offline;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    let live = true;
    setError("");
    rpc("review_workspace", { p_project: project.id })
      .then((x) => {
        if (live) setWorkspace(x);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [project.id, revision]);
  const section = {
    sources: "searches",
    reports: "reports",
    studies: "studies",
    observations: "observations",
    assessments: "assessments",
    analysis: "runs",
  }[tab];
  useEffect(() => {
    let live = true;
    setList({ items: [], total: 0 });
    if (section)
      reviewList(project.id, section, query, filter, page)
        .then((x) => {
          if (live) setList(x);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [project.id, section, page, query, filter, revision]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => {
    if (tab !== "analysis" || !list.items.some((r) => ["queued", "running"].includes(r.status))) return;
    const timer = setInterval(() => {
      if (!document.hidden && !busy) setRevision((x) => x + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, [tab, list.items, busy]);
  useEffect(() => {
    if (!run?.id || tab !== "analysis") return;
    let live = true;
    rpc("review_analysis", { p_project: project.id, p_id: run.id })
      .then((value) => {
        if (live) setRun(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [project.id, tab, run?.id, revision]);
  async function action(fn, successMessage = "저장했습니다.") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await fn();
      if (alive.current) {
        setMessage(successMessage);
        setDirty(false);
        setEditing(null);
        setRevision((x) => x + 1);
      }
      return result;
    } catch (e) {
      if (alive.current)
        setError(
          e?.code === "40001"
            ? "다른 곳에서 자료가 변경되었습니다. 입력을 보관한 뒤 최신 자료를 불러와 주세요."
            : e.message || "처리를 완료하지 못했습니다.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function changeTab(next) {
    if (dirty && !window.confirm("저장하지 않은 입력을 닫고 이동할까요?")) return;
    setTab(next);
    setPage(0);
    setQuery("");
    setFilter("");
    setEditing(null);
    setRun(null);
    setDirty(false);
    setError("");
    setMessage("");
  }
  async function exportRun(id) {
    controller.current = new AbortController();
    const blob = await reviewRequest(
      "export",
      project.id,
      user.id,
      { run_id: id },
      { blob: true, signal: controller.current.signal },
    );
    downloadBlob(blob, `review-${id}.zip`);
  }
  if (error && !workspace)
    return (
      <section className="reader-card" role="alert">
        <p>{error}</p>
        <button className="btn-secondary" onClick={() => setRevision((x) => x + 1)}>
          다시 불러오기
        </button>
      </section>
    );
  if (!workspace) return <p role="status">연구프로젝트를 불러오는 중입니다.</p>;
  return (
    <section className="review-workspace" aria-label="체계적 고찰과 메타분석">
      <div className="review-heading">
        <div>
          <h2>체계적 고찰·메타분석</h2>
          <p className="reader-muted">
            {project.name} · {canEdit ? "편집 가능" : "읽기 전용"}
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={() => {
            if (!dirty || window.confirm("저장하지 않은 입력을 닫을까요?")) onClose();
          }}
        >
          프로젝트로 돌아가기
        </button>
      </div>
      <nav className="review-tabs" aria-label="연구 단계">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "btn-primary" : "btn-secondary"}
            aria-current={tab === id ? "step" : undefined}
            onClick={() => changeTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="review-error">
          {error}
        </p>
      )}
      <p role="status">{busy ? "처리 중입니다." : message}</p>
      {tab === "protocol" && (
        <>
          <Flow counts={workspace.counts} />
          <Protocol
            key={workspace.protocol?.version || 0}
            protocol={workspace.protocol}
            canEdit={canEdit && !busy}
            dirty={() => setDirty(true)}
            save={(p) =>
              action(() =>
                rpc("review_save_protocol", {
                  p_project: project.id,
                  p_expected_version: workspace.protocol?.version || 0,
                  p_payload: p,
                }),
              )
            }
          />
        </>
      )}
      {tab === "sources" && (
        <Sources
          project={project}
          user={user}
          canEdit={canEdit && !busy}
          action={action}
          searches={list.items}
        />
      )}
      {section && tab !== "sources" && tab !== "analysis" && (
        <form
          className="reader-search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(String(new FormData(e.currentTarget).get("q") || ""));
            setPage(0);
          }}
        >
          <label className="query">
            이 단계에서 찾기
            <input name="q" defaultValue={query} maxLength={200} />
          </label>
          <button className="btn-secondary">검색</button>
        </form>
      )}
      {tab === "reports" && (
        <>
          <Flow counts={workspace.counts} />
          <div className="reader-actions">
            {[
              ["", "전체"],
              ["ta_pending", "제목·초록 대기"],
              ["ft_pending", "원문 검토 대기"],
              ["included", "포함"],
              ["excluded", "제외"],
              ["duplicates", "중복"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={filter === v ? "btn-primary" : "btn-secondary"}
                onClick={() => {
                  setFilter(v);
                  setPage(0);
                  setEditing(null);
                }}
              >
                {l}
              </button>
            ))}
          </div>
          {list.items.map((r) => (
            <article className="reader-card" key={r.id}>
              <h3>{labelReport(r)}</h3>
              <p className="reader-muted">
                {r.bibliography.journal} · {r.bibliography.year} · 제목·초록 {decisions[r.ta_decision]} · 원문{" "}
                {decisions[r.ft_decision]}
                {r.duplicate_of ? " · 중복" : ""}
              </p>
              <ReportLinks report={r} />
              {r.bibliography.abstract && (
                <details>
                  <summary>초록</summary>
                  <p>{r.bibliography.abstract}</p>
                </details>
              )}
              {editing?.id === r.id ? (
                <Screening
                  project={project}
                  report={r}
                  disabled={!canEdit || busy}
                  dirty={() => setDirty(true)}
                  save={(p) => action(() => saveReview("report", project.id, r.id, r.revision, p))}
                />
              ) : (
                <button className="btn-secondary" onClick={() => setEditing(r)}>
                  {canEdit ? "선별·출처 기록" : "선별 기록 보기"}
                </button>
              )}
            </article>
          ))}
        </>
      )}
      {tab === "studies" && (
        <>
          <p>
            여러 보고서가 같은 연구를 다룰 수 있습니다. 동일 연구의 보고서를 연결하면 중복 분석을 확인할 수
            있습니다.
          </p>
          {canEdit && (
            <button className="btn-secondary" onClick={() => setEditing({ id: uid(), revision: 0 })}>
              연구 연결 만들기
            </button>
          )}
          {editing && (
            <StudyForm
              key={editing.id}
              study={editing}
              project={project}
              disabled={!canEdit || busy}
              dirty={() => setDirty(true)}
              save={(p) => action(() => saveReview("study", project.id, editing.id, editing.revision, p))}
            />
          )}{" "}
          {list.items.map((s) => (
            <article className="reader-card" key={s.id}>
              <h3>{s.label}</h3>
              <p>
                {s.design} · 연결 보고서 {s.report_ids?.length || 0}편
              </p>
              <p>{s.population}</p>
              {s.overlap_group && <p>겹치는 표본: {s.overlap_group}</p>}
              <button className="btn-secondary" onClick={() => setEditing(s)}>
                연구 정보 열기
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "observations" && (
        <>
          <p>원문의 군·시점·분모와 출처를 함께 기록합니다. AI 요약을 분석 수치의 근거로 사용하지 않습니다.</p>
          {canEdit && (
            <button
              className="btn-secondary"
              onClick={() => setEditing({ id: uid(), revision: 0, context: initialContext, kind: "binary" })}
            >
              관측값 추가
            </button>
          )}
          {editing && (
            <ObservationForm
              key={editing.id}
              observation={editing}
              project={project}
              disabled={!canEdit || busy}
              dirty={() => setDirty(true)}
              save={(p) =>
                action(() => saveReview("observation", project.id, editing.id, editing.revision, p))
              }
            />
          )}{" "}
          {list.items.map((o) => (
            <article className="reader-card" key={o.id}>
              <h3>
                {o.context.outcome} · {o.context.timepoint}
              </h3>
              <p>
                {KIND_LABELS[o.kind]} · {o.context.comparison} ·{" "}
                {o.status === "confirmed"
                  ? "원문 대조 확인"
                  : o.status === "needs_revalidation"
                    ? "출처 변경 · 다시 확인 필요"
                    : o.status === "excluded"
                      ? "분석 제외"
                      : "초안"}
              </p>
              <dl className="review-values">
                {Object.entries(o.values)
                  .filter(([k]) => k !== "missing")
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>{VALUE_FIELDS[o.kind]?.find((x) => x[0] === k)?.[1] || k}</dt>
                      <dd>{v ?? `미보고 · ${o.values.missing?.[k] || "확인 필요"}`}</dd>
                    </div>
                  ))}
              </dl>
              <p className="reader-muted">출처: {o.evidence.locator || "미입력"}</p>
              <button className="btn-secondary" onClick={() => setEditing(o)}>
                수치·근거 열기
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "assessments" && (
        <>
          <p>평가변수별 판단과 이유를 기록합니다. 자동 합산 점수로 근거 확실성을 결정하지 않습니다.</p>
          {canEdit && (
            <button
              className="btn-secondary"
              onClick={() => setEditing({ id: uid(), revision: 0, kind: "bias" })}
            >
              평가 기록 추가
            </button>
          )}
          {editing && (
            <AssessmentForm
              project={project}
              key={editing.id}
              assessment={editing}
              disabled={!canEdit || busy}
              dirty={() => setDirty(true)}
              save={(p) =>
                action(() => saveReview("assessment", project.id, editing.id, editing.revision, p))
              }
            />
          )}{" "}
          {list.items.map((a) => (
            <article key={a.id} className="reader-card">
              <h3>{a.target}</h3>
              <p>
                {a.tool} {a.tool_version} · {a.judgment}
              </p>
              <p>{a.reason}</p>
              <button className="btn-secondary" onClick={() => setEditing(a)}>
                평가 열기
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "analysis" && (
        <>
          <AnalysisForm
            dirty={() => setDirty(true)}
            project={project}
            protocol={workspace.protocol}
            disabled={!canEdit || busy}
            action={action}
          />
          {list.items.map((r) => (
            <article className="reader-card" key={r.id}>
              <h3>
                {r.config.outcome} · {r.config.measure}
              </h3>
              <p>
                {runLabels[r.status]} · {new Date(r.created_at).toLocaleString("ko-KR")}
              </p>
              <div className="reader-actions">
                <button
                  className="btn-secondary"
                  onClick={() =>
                    action(
                      async () => setRun(await rpc("review_analysis", { p_project: project.id, p_id: r.id })),
                      "결과를 불러왔습니다.",
                    )
                  }
                >
                  결과·입력 보기
                </button>
                {["succeeded", "needs_review"].includes(r.status) && (
                  <button
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => action(() => exportRun(r.id), "재현 자료를 내려받았습니다.")}
                  >
                    재현 자료 ZIP
                  </button>
                )}
                {canEdit && ["queued", "running"].includes(r.status) && (
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      action(() =>
                        rpc("review_analysis", { p_project: project.id, p_id: r.id, p_cancel: true }),
                      )
                    }
                  >
                    계산 취소
                  </button>
                )}
              </div>
            </article>
          ))}
          <button className="btn-secondary" onClick={() => setRevision((x) => x + 1)}>
            계산 상태 새로고침
          </button>
          {run && <Result key={run.id} run={run} project={project} user={user} />}
        </>
      )}
      {tab === "reviews" && (
        <section className="reader-card">
          <h3>리뷰</h3>
          <div className="review-grid">
            <div>
              <h4>사람 리뷰</h4>
              <p>미실시 · 검토 기능 준비 중</p>
            </div>
            <div>
              <h4>AI 리뷰</h4>
              <p>미연결 · 검토 기능 준비 중</p>
            </div>
          </div>
          <p>
            문헌 정리와 수동 데이터 분석을 계속할 수 있습니다. 실제 검토 전에는 검토 완료로 표시하지 않습니다.
          </p>
          <p className="reader-muted">
            개인 AI 기능을 사용할 때만 API 키를 입력하며, 키는 저장하지 않습니다.
          </p>
        </section>
      )}
      {section && <Pages page={page} total={list.total} onChange={setPage} />}
    </section>
  );
}

function Protocol({ protocol, canEdit, dirty, save }) {
  const p = protocol?.payload || {};
  return (
    <form
      className="reader-card review-form"
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save(
          payload(f, [
            "question",
            "type",
            "population",
            "intervention",
            "comparator",
            "outcomes",
            "timepoints",
            "eligibility",
            "search_plan",
            "analysis_plan",
            "registration",
            "amendment_reason",
            "status",
          ]),
        );
      }}
    >
      <h3>연구계획 {protocol ? `· 버전 ${protocol.version}` : ""}</h3>
      <fieldset disabled={!canEdit}>
        {options("type", "연구 질문 유형", p.type || "intervention", [
          ["intervention", "치료효과"],
          ["diagnostic", "진단정확도"],
        ])}
        {area("question", "연구 질문", p.question, { required: true, maxLength: 4000 })}
        <div className="review-grid">
          {field("population", "대상 집단", p.population)}
          {field("intervention", "중재 또는 검사", p.intervention)}
          {field("comparator", "비교군 또는 참조표준", p.comparator)}
          {field("outcomes", "평가변수와 정의", p.outcomes)}
          {field("timepoints", "측정 시점·허용 범위", p.timepoints)}
          {field("registration", "등록번호·계획서 주소", p.registration)}
        </div>
        {area("eligibility", "포함·제외 기준", p.eligibility)}
        {area("search_plan", "자료원·검색 전략·기간·제한", p.search_plan)}
        {area("analysis_plan", "효과 지표·분석 모형·결측·중복 처리 계획", p.analysis_plan)}
        {protocol && area("amendment_reason", "계획 변경 이유", "", { required: p.status === "locked" })}
        {options("status", "계획 상태", p.status || "draft", [
          ["draft", "초안"],
          ["locked", "확정 · 이후 변경은 새 버전"],
        ])}
        <button className="btn-primary">연구계획 저장</button>
      </fieldset>
    </form>
  );
}

function Sources({ project, user, canEdit, action, searches }) {
  const [preview, setPreview] = useState(null),
    [source, setSource] = useState("RIS / Zotero"),
    [query, setQuery] = useState(""),
    [format, setFormat] = useState("ris"),
    [mapping, setMapping] = useState({}),
    [total, setTotal] = useState(""),
    [status, setStatus] = useState("complete");
  const file = useRef(null),
    abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function parse() {
    const f = file.current.files?.[0];
    if (!f) throw new Error("가져올 파일을 선택하세요.");
    if (f.size > 8e6) throw new Error("8 MB 이하의 파일을 선택하세요.");
    abort.current = new AbortController();
    setPreview(
      await reviewRequest(
        "import",
        project.id,
        user.id,
        { format, text: await f.text(), ...(format === "csv" ? { mapping } : {}) },
        { signal: abort.current.signal },
      ),
    );
  }
  async function commit() {
    const prior = searches.find(
      (s) =>
        s.file_hash === preview.file_hash &&
        s.source === source &&
        s.query === query &&
        s.status === "partial",
    );
    const id = prior?.id || uid();
    if (!prior)
      await rpc("review_save_search", {
        p_project: project.id,
        p_id: id,
        p_expected_revision: 0,
        p_payload: {
          source,
          query,
          searched_at: new Date().toISOString(),
          limits: { import_format: format },
          reported_hits: total === "" ? preview.source_count : Number(total),
          status: "partial",
          file_hash: preview.file_hash,
        },
      });
    for (let i = 0; i < preview.items.length; i += 100)
      await rpc("review_import_records", {
        p_project: project.id,
        p_search: id,
        p_items: preview.items.slice(i, i + 100),
      });
    await rpc("review_save_search", {
      p_project: project.id,
      p_id: id,
      p_expected_revision: prior?.revision || 1,
      p_payload: {
        source,
        query,
        searched_at: new Date().toISOString(),
        status: preview.errors.length ? "partial" : status,
      },
    });
    setPreview(null);
  }
  return (
    <>
      <section className="reader-card">
        <h3>외부 문헌 가져오기</h3>
        <p>
          프로젝트에는 2000년 이전 문헌과 서비스에 없는 문헌도 추가할 수 있습니다. 가져오기는 검색 출처와 함께
          기록됩니다.
        </p>
        <fieldset disabled={!canEdit}>
          <div className="review-grid">
            <label>
              파일 형식
              <select
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setPreview(null);
                  setMapping({});
                }}
              >
                <option value="ris">RIS · Zotero / EndNote</option>
                <option value="nbib">NBIB · PubMed</option>
                <option value="csl-json">CSL-JSON · Zotero</option>
                <option value="bibtex">BibTeX</option>
                <option value="csv">CSV · 열 이름 연결</option>
              </select>
            </label>
            <label>
              자료원
              <input value={source} onChange={(e) => setSource(e.target.value)} maxLength={200} />
            </label>
            <label>
              검색식
              <textarea value={query} onChange={(e) => setQuery(e.target.value)} maxLength={6000} />
            </label>
            <label>
              자료원에 표시된 검색 결과 수
              <input type="number" min="0" value={total} onChange={(e) => setTotal(e.target.value)} />
            </label>
            <label>
              이번 검색의 수신 상태
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="complete">검색 결과 전체 수신</option>
                <option value="partial">일부만 수신</option>
              </select>
            </label>
            <label>
              서지 파일
              <input
                ref={file}
                type="file"
                accept=".ris,.nbib,.json,.bib,.bibtex,.txt,.csv"
                onChange={() => {
                  setPreview(null);
                  setMapping({});
                }}
              />
            </label>
          </div>
          {format === "csv" && preview?.columns && (
            <fieldset>
              <legend>CSV 열 연결 · 제목은 필수, 저자는 세미콜론으로 구분</legend>
              <div className="review-grid">
                {[
                  ["title", "제목"],
                  ["authors", "저자"],
                  ["journal", "저널"],
                  ["year", "발행연도"],
                  ["doi", "DOI"],
                  ["pmid", "PMID"],
                  ["abstract", "초록"],
                  ["volume", "권"],
                  ["issue", "호"],
                  ["pages", "쪽"],
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <select
                      value={mapping[key] || ""}
                      onChange={(e) =>
                        setMapping((old) => {
                          const next = { ...old };
                          if (e.target.value) next[key] = e.target.value;
                          else delete next[key];
                          return next;
                        })
                      }
                    >
                      <option value="">연결 안 함</option>
                      {preview.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p>열을 연결한 뒤 가져오기 미리보기를 다시 누르세요.</p>
            </fieldset>
          )}
          <button
            className="btn-secondary"
            onClick={() => action(parse, "미리보기를 준비했습니다. 아직 프로젝트에 저장하지 않았습니다.")}
          >
            가져오기 미리보기
          </button>
          {preview && (
            <div>
              <p>
                {preview.source_count}개 기록 · 가져오기 가능 {preview.items.length}개 · 오류{" "}
                {preview.errors.length}개
              </p>
              <ul>
                {preview.items.slice(0, 5).map((r) => (
                  <li key={r.source_record_id}>{r.bibliography.title}</li>
                ))}
              </ul>
              {preview.errors.map((x) => (
                <p key={x.record} role="alert">
                  기록 {x.record}: {x.error}
                </p>
              ))}
              <button className="btn-primary" disabled={!preview.items.length} onClick={() => action(commit)}>
                확인한 문헌 가져오기
              </button>
            </div>
          )}
        </fieldset>
      </section>
      <section className="reader-card">
        <h3>현재 프로젝트 문헌</h3>
        <p>기존 프로젝트 문헌을 페이지별로 가져오며, 이미 등록한 식별자는 중복 보고서로 추가하지 않습니다.</p>
        <button
          className="btn-secondary"
          disabled={!canEdit}
          onClick={() =>
            action(async () => {
              let page = 0;
              while (true) {
                const result = await rpc("project_papers", { p_id: project.id, p_page: page });
                if (!result.items.length) break;
                await importCatalogPage(project.id, result.items, {
                  source: "Project library",
                  query: "Project " + project.id,
                  limits: { page, selection: "project_page" },
                  total: result.total,
                });
                page++;
                if (page * 20 >= result.total) break;
                if (page > 2500)
                  throw new Error("이번 가져오기 범위를 초과했습니다. 검색 결과를 나누어 가져오세요.");
              }
            })
          }
        >
          프로젝트 문헌 가져오기
        </button>
      </section>
      <h3>검색 기록</h3>
      {searches.map((s) => (
        <article className="reader-card" key={s.id}>
          <h4>{s.source}</h4>
          <p>{s.query || "검색식 미기록"}</p>
          <p>
            {new Date(s.searched_at).toLocaleString("ko-KR")} ·{" "}
            {s.status === "complete" ? "수신 완료" : s.status === "failed" ? "실패" : "일부 수신"} · 자료원
            검색 결과 {s.reported_hits ?? "미기록"}
          </p>
        </article>
      ))}
    </>
  );
}

function ReportLinks({ report }) {
  const b = report.bibliography;
  return (
    <div className="reader-actions">
      {b.pmid && <Link to={`/papers/${encodeURIComponent(b.pmid)}`}>문헌 상세</Link>}
      {b.pmid && report.local_source && <Link to={`/fulltext/${encodeURIComponent(b.pmid)}`}>원문 열기</Link>}
      {b.doi && (
        <a href={`https://doi.org/${encodeURIComponent(b.doi)}`} target="_blank" rel="noreferrer">
          출판사 원문
        </a>
      )}
    </div>
  );
}
function Screening({ report, project, disabled, dirty, save }) {
  const [duplicate, setDuplicate] = useState(report.duplicate_of || null);
  return (
    <form
      className="review-form"
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save({
          ...payload(f, ["ta_decision", "ft_decision", "exclusion_reason", "acquisition", "note"]),
          duplicate_of: duplicate,
          source: {
            hash: String(f.get("hash") || "") || null,
            locator: String(f.get("locator") || ""),
            type: "fulltext",
          },
        });
      }}
    >
      <fieldset disabled={disabled}>
        <div className="review-grid">
          {options("ta_decision", "제목·초록 판정", report.ta_decision, Object.entries(decisions))}
          {options("acquisition", "원문 확보 상태", report.acquisition, [
            ["unknown", "미확인"],
            ["requested", "확보 요청"],
            ["acquired", "확보"],
            ["unavailable", "미확보"],
          ])}
          {options("ft_decision", "원문 판정", report.ft_decision, Object.entries(decisions))}
          {field("exclusion_reason", "제외 사유", report.exclusion_reason, { maxLength: 1000 })}
          <ReviewSource
            key={report.id}
            name="hash"
            initialHash={report.local_source?.hash || report.source.hash || ""}
            fixed={!!report.local_source?.hash}
            onChange={dirty}
          />
          {field("locator", "출처 위치·파일명", report.source.locator)}
          <details>
            <summary>중복 보고서로 연결</summary>
            <Picker
              project={project}
              section="reports"
              label="대표 보고서"
              value={duplicate}
              excludedId={report.id}
              onSelect={(r) => {
                setDuplicate(r.id);
                dirty();
              }}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setDuplicate(null);
                dirty();
              }}
            >
              중복 연결 해제
            </button>
            {duplicate && <p>대표 보고서를 선택했습니다.</p>}
          </details>
        </div>
        {area("note", "선별 메모", report.note, { maxLength: 4000 })}
        <button className="btn-primary">선별·출처 저장</button>
      </fieldset>
    </form>
  );
}

function Picker({ project, section, label, value, onSelect, multiple = false, excludedId = null }) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(0),
    [data, setData] = useState({ items: [], total: 0 });
  useEffect(() => {
    let live = true;
    reviewList(project.id, section, q, "", page)
      .then((x) => {
        if (live) setData(x);
      })
      .catch(() => {
        if (live) setData({ items: [], total: 0 });
      });
    return () => {
      live = false;
    };
  }, [project.id, section, q, page]);
  return (
    <fieldset className="review-picker">
      <legend>{label}</legend>
      <input
        type="search"
        aria-label={`${label} 검색`}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(0);
        }}
      />
      {data.items
        .filter((r) => r.id !== excludedId)
        .map((r) => (
          <label key={r.id}>
            <input
              type={multiple ? "checkbox" : "radio"}
              name={`pick-${section}`}
              checked={multiple ? (value || []).includes(r.id) : value === r.id}
              onChange={() => onSelect(r)}
            />
            <span>{section === "studies" ? r.label : labelReport(r)}</span>
          </label>
        ))}
      <div className="reader-actions">
        <button type="button" className="btn-secondary" disabled={!page} onClick={() => setPage(page - 1)}>
          이전 목록
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={(page + 1) * 25 >= data.total}
          onClick={() => setPage(page + 1)}
        >
          다음 목록
        </button>
      </div>
    </fieldset>
  );
}
function StudyForm({ study, project, disabled, dirty, save }) {
  const [ids, setIds] = useState(study.report_ids || []);
  return (
    <form
      className="reader-card review-form"
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        save({
          ...payload(new FormData(e.currentTarget), [
            "label",
            "design",
            "registry_id",
            "overlap_group",
            "population",
            "notes",
            "link_reason",
          ]),
          report_ids: ids,
        });
      }}
    >
      <h3>연구 정보</h3>
      <fieldset disabled={disabled}>
        <div className="review-grid">
          {field("label", "연구 식별명", study.label, { required: true, maxLength: 300 })}
          {options("design", "연구 설계", study.design || "parallel_RCT", [
            ["parallel_RCT", "평행군 무작위시험"],
            ["cohort", "코호트 연구"],
            ["case_control", "환자대조군 연구"],
            ["diagnostic", "진단정확도 연구"],
            ["cluster", "군집 무작위시험"],
            ["crossover", "교차시험"],
            ["other", "기타"],
          ])}
          {field("registry_id", "연구 등록번호", study.registry_id)}
          {field("overlap_group", "표본이 겹치는 연구의 공통 식별명", study.overlap_group)}
        </div>
        {area("population", "모집 집단·기관·기간", study.population)}
        <Picker
          project={project}
          section="reports"
          label="연결 보고서"
          multiple
          value={ids}
          onSelect={(r) => {
            setIds((x) => (x.includes(r.id) ? x.filter((id) => id !== r.id) : [...x, r.id]));
            dirty();
          }}
        />
        {area("link_reason", "같은 연구로 연결한 근거", "", { required: true })}
        {area("notes", "연구 메모", study.notes)}
        <button className="btn-primary">연구 연결 저장</button>
      </fieldset>
    </form>
  );
}

function ObservationForm({ observation: o, project, disabled, dirty, save }) {
  const [kind, setKind] = useState(o.kind),
    [study, setStudy] = useState(o.study_id ? { id: o.study_id } : null),
    [report, setReport] = useState(null),
    [sourceType, setSourceType] = useState(o.evidence?.source_type || "fulltext"),
    [formError, setFormError] = useState("");
  useEffect(() => {
    if (!o.report_id) return;
    let live = true;
    reviewList(project.id, "reports", o.report_id).then((x) => {
      if (live) setReport(x.items.find((r) => r.id === o.report_id) || null);
    });
    return () => {
      live = false;
    };
  }, [project.id, o.report_id]);
  return (
    <form
      className="reader-card review-form"
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        try {
          setFormError("");
          save(observationPayload(f, kind, study?.id, report, String(f.get("status"))));
        } catch (error) {
          setFormError(error.message);
        }
      }}
    >
      <h3>수치와 원문 근거</h3>
      {formError && <p role="alert">{formError}</p>}
      <fieldset disabled={disabled}>
        <Picker
          project={project}
          section="studies"
          label="대상 연구"
          value={study?.id}
          onSelect={(r) => {
            setStudy(r);
            dirty();
          }}
        />
        <Picker
          project={project}
          section="reports"
          label="값을 보고한 문헌"
          value={report?.id}
          onSelect={(r) => {
            setReport(r);
            dirty();
          }}
        />
        {report && <ReportLinks report={report} />}
        <label>
          자료 유형
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABELS).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <div className="review-grid" key={kind}>
          {(VALUE_FIELDS[kind] || []).map(([k, l]) => (
            <div key={k}>
              {field(k, l, o.values?.[k], { type: "number", step: "any" })}
              {field(`missing_${k}`, "미보고·결측 사유 (값이 없을 때)", o.values?.missing?.[k], {
                maxLength: 300,
              })}
            </div>
          ))}
          {kind === "effect" &&
            options(
              "measure",
              "효과 지표",
              o.values?.measure || "HR",
              ["RR", "OR", "HR", "MD", "SMD"].map((x) => [x, x]),
            )}
          {kind === "descriptive" && area("text", "정성적 결과", o.values?.text, { required: true })}
        </div>
        <h4>분석 맥락</h4>
        <div className="review-grid">
          {contextFields.map(([k, l]) =>
            field(k, l, o.context?.[k] ?? initialContext[k], { required: k !== "covariates" }),
          )}
          {options("direction", "값의 유리한 방향", o.context?.direction || "lower_better", [
            ["lower_better", "낮을수록 좋음"],
            ["higher_better", "높을수록 좋음"],
            ["not_applicable", "해당 없음"],
          ])}
          {options("value_type", "측정값 유형", o.context?.value_type || "final", [
            ["final", "최종값"],
            ["change", "변화량"],
          ])}
          {options("value_origin", "값의 출처", o.context?.value_origin || "reported", [
            ["reported", "직접 보고"],
            ["transformed", "변환 · 공식과 원값 기록 필요"],
          ])}
          {field("transformation", "변환 공식·원값·가정", o.context?.transformation)}
          {kind === "diagnostic" &&
            [
              ["index_test", "검사명"],
              ["threshold", "양성 역치·연산자·단위"],
              ["reference_standard", "참조표준"],
            ].map(([k, l]) => field(k, l, o.context?.[k], { required: true }))}
        </div>
        <h4>원문 위치</h4>
        <div className="review-grid">
          <ReviewSource
            key={`${report?.id || "empty-source"}:${sourceType}`}
            name="source_hash"
            initialHash={
              sourceType === "fulltext"
                ? report?.local_source?.hash || report?.source?.hash || ""
                : sourceType === o.evidence?.source_type
                  ? o.evidence?.source_hash || ""
                  : ""
            }
            fixed={sourceType === "fulltext" && !!report?.local_source?.hash}
            onChange={dirty}
          />
          <label>
            자료 종류
            <select name="source_type" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {[
                ["fulltext", "원문"],
                ["supplement", "보충자료"],
                ["registry", "연구 등록원"],
                ["author_data", "저자 제공 자료"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {field("source_version", "자료 버전", o.evidence?.source_version || "1")}
          {field("locator", "페이지·절·표 위치", o.evidence?.locator)}
          {field("table", "표", o.evidence?.table)}
          {field("row", "행 제목", o.evidence?.row)}
          {field("column", "열 제목·군", o.evidence?.column)}
          {field("footnote", "각주", o.evidence?.footnote)}
        </div>
        <label className="review-check">
          <input
            key={`${report?.id}:${sourceType}`}
            type="checkbox"
            name="source_checked"
            defaultChecked={false}
          />
          원문에서 군·시점·분모·단위·부호를 대조했습니다.
        </label>
        {options("status", "저장 상태", o.status === "confirmed" ? "confirmed" : "draft", [
          ["draft", "초안"],
          ["confirmed", "원문 대조 확인"],
          ["excluded", "이번 분석에서 제외"],
        ])}
        {field("reason", "제외·변경 사유", o.reason)}
        <button className="btn-primary" disabled={!study || !report}>
          관측값 저장
        </button>
      </fieldset>
    </form>
  );
}

function AssessmentForm({ assessment: a, project, disabled, dirty, save }) {
  const [domains, setDomains] = useState(
    a.domains?.length ? a.domains : [{ id: "", judgment: "", reason: "" }],
  );
  const [studyId, setStudyId] = useState(a.study_id || null);
  function updateDomain(index, key, value) {
    setDomains((rows) => rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
    dirty();
  }
  return (
    <form
      className="reader-card review-form"
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save({
          ...payload(f, ["kind", "target", "tool", "tool_version", "judgment", "reason"]),
          study_id: studyId,
          domains,
          evidence: { locator: String(f.get("locator") || "") },
        });
      }}
    >
      <fieldset disabled={disabled}>
        {options("kind", "평가 종류", a.kind || "bias", [
          ["bias", "편향 위험"],
          ["certainty", "근거 확실성"],
        ])}
        <div className="review-grid">
          {field("target", "평가 대상 결과·비교·시점", a.target, { required: true })}
          <Picker
            project={project}
            section="studies"
            label="평가 대상 연구 (선택)"
            value={studyId}
            onSelect={(s) => {
              setStudyId(s.id);
              dirty();
            }}
          />
          {field("tool", "도구 (RoB 2 / ROBINS-I / QUADAS / GRADE)", a.tool, { required: true })}
          {field("tool_version", "도구 버전", a.tool_version, { required: true })}
          {field("judgment", "최종 판단", a.judgment, { required: true })}
          {field("locator", "근거 위치", a.evidence?.locator)}
        </div>
        <h4>영역별 판단</h4>
        {domains.map((domain, i) => (
          <div className="reader-card" key={i}>
            <div className="review-grid">
              <label>
                영역
                <input required value={domain.id} onChange={(e) => updateDomain(i, "id", e.target.value)} />
              </label>
              <label>
                판단
                <input
                  required
                  value={domain.judgment}
                  onChange={(e) => updateDomain(i, "judgment", e.target.value)}
                />
              </label>
            </div>
            <label>
              판단 근거
              <textarea
                required
                value={domain.reason}
                onChange={(e) => updateDomain(i, "reason", e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              disabled={domains.length === 1}
              onClick={() => {
                setDomains((rows) => rows.filter((_, n) => n !== i));
                dirty();
              }}
            >
              이 영역 삭제
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary"
          disabled={domains.length >= 20}
          onClick={() => {
            setDomains((rows) => [...rows, { id: "", judgment: "", reason: "" }]);
            dirty();
          }}
        >
          평가 영역 추가
        </button>
        {area("reason", "최종 판단 이유", a.reason, { required: true })}
        <button className="btn-primary">평가 저장</button>
      </fieldset>
    </form>
  );
}

function Result({ run, project, user }) {
  const [figure, setFigure] = useState(null),
    [figureError, setFigureError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let url,
      live = true;
    if (["succeeded", "needs_review"].includes(run.status))
      reviewRequest("figure", project.id, user.id, { run_id: run.id }, { blob: true, signal: abort.signal })
        .then((blob) => {
          if (live) {
            url = URL.createObjectURL(blob);
            setFigure(url);
          }
        })
        .catch((e) => {
          if (live) setFigureError(e.message);
        });
    return () => {
      live = false;
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [run.id, run.status, project.id, user.id]);
  const result = run.result,
    fmt = (x) => (Number.isFinite(x) ? Number(x).toPrecision(4) : "—");
  return (
    <section className="reader-card">
      <h3>분석 결과 · {runLabels[run.status]}</h3>
      {run.stale_input && (
        <p role="alert">
          이 계산 이후 입력이나 원문 상태가 변경되었습니다. 이 결과는 당시 버전의 기록이며, 현재 자료로 다시
          분석해야 합니다.
        </p>
      )}
      <p className="reader-muted">사람·AI 동료 검토 미실시 · 입력값 확인과 별도 상태입니다.</p>
      {(run.error_code || result?.error_code) && (
        <p role="alert">
          {analysisMessages[run.error_code || result.error_code] ||
            "입력 자료 또는 수치 계산을 확인해야 합니다. 아래 계산 설정에서 상세 상태를 확인하세요."}
        </p>
      )}
      {result?.warnings?.map((w) => (
        <p key={w} role="status">
          {analysisMessages[w] || "계산 조건에 대한 추가 검토가 필요합니다."}
        </p>
      ))}
      {result?.pooled && (
        <p>
          {result.pooled.display_estimate !== undefined
            ? `${run.config.measure} ${fmt(result.pooled.display_estimate)} (95% CI ${result.pooled.display_ci.map(fmt).join("–")})`
            : `민감도 ${fmt(result.pooled.sensitivity)} · 특이도 ${fmt(result.pooled.specificity)}`}
        </p>
      )}
      {result?.pooled && typeof result.pooled.tau2 === "number" && (
        <dl className="review-values">
          <div>
            <dt>독립 효과 수</dt>
            <dd>{result.pooled.k}</dd>
          </div>
          <div>
            <dt>신뢰구간 방법</dt>
            <dd>{result.pooled.ci_method}</dd>
          </div>
          <div>
            <dt>I²</dt>
            <dd>{fmt(result.pooled.i2)}%</dd>
          </div>
          <div>
            <dt>τ²</dt>
            <dd>{fmt(result.pooled.tau2)}</dd>
          </div>
          {result.pooled.prediction_interval && (
            <div>
              <dt>예측구간</dt>
              <dd>{result.pooled.prediction_interval.map(fmt).join("–")}</dd>
            </div>
          )}
        </dl>
      )}
      {figure && (
        <div className="review-table-wrap">
          <img
            src={figure}
            alt="연구별 효과와 95% 신뢰구간 Forest plot"
            style={{ minWidth: 700, width: "100%" }}
          />
        </div>
      )}
      {figureError && (
        <p role="status">그래프를 불러오지 못했습니다. 아래 수치 표에서 결과를 확인할 수 있습니다.</p>
      )}
      {result?.rows?.length > 0 && (
        <div className="review-table-wrap">
          <table>
            <caption>연구별 추정치와 95% 신뢰구간</caption>
            <thead>
              <tr>
                <th>연구</th>
                <th>효과 / 민감도</th>
                <th>95% CI</th>
                <th>가중치 / 특이도</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <th>{r.label}</th>
                  <td>{fmt(r.estimate ?? r.sensitivity)}</td>
                  <td>{(r.ci || r.sensitivity_ci || []).map(fmt).join("–")}</td>
                  <td>{fmt(r.weight ?? r.specificity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary>계산 설정과 버전</summary>
        <p>
          {result?.engine?.name} {result?.engine?.version}
        </p>
        <p>입력 hash: {run.input_hash}</p>
        <pre>
          {JSON.stringify(
            { config: run.config, error: run.error_code || result?.error_code, warnings: result?.warnings },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
