const number = new Intl.NumberFormat("ko-KR");
const known = (value) => Number.isFinite(value) && value >= 0;
const count = (value) => (known(value) ? number.format(value) : "—");
const difference = (a, b) => (known(a) && known(b) ? Math.max(0, a - b) : null);

function CompletionBar({ label, value, total }) {
  const percent = known(value) && known(total) && total > 0 ? Math.min(100, (100 * value) / total) : null;
  if (percent === null) return <p className="text-xs text-text2 mt-4">{label}: 집계 대기</p>;
  return (
    <div className="mt-4">
      <div className="flex justify-between gap-3 text-xs text-text2 mb-2">
        <span>{label}</span>
        <span>{percent === null ? "—" : percent.toFixed(1) + "%"}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? "집계 대기" : count(value) + " / " + count(total) + "편"}
        className="h-2 rounded-full bg-hover overflow-hidden"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: (percent || 0) + "%" }} />
      </div>
    </div>
  );
}

export default function CollectionOverview({ catalog }) {
  const metadata = catalog.automatic_papers;
  const originals = catalog.originals_acquired;
  const summaries = catalog.summaries_ready;
  const storage = catalog.storage;
  const used = storage?.database_bytes;
  const budget = storage?.budget_bytes;
  const storageKnown = known(used) && known(budget) && budget > 0;
  const paused = storageKnown && used >= budget;
  const scope = catalog.scope;
  const scopeKnown = Number.isInteger(scope?.target_journals) && scope.target_journals > 0;
  const scopeGroupsKnown =
    Number.isInteger(scope?.urology_journals) &&
    scope.urology_journals >= 0 &&
    Number.isInteger(scope?.ancillary_journals) &&
    scope.ancillary_journals >= 0 &&
    scope.urology_journals + scope.ancillary_journals === scope.target_journals;
  const local = catalog.local_catalog;
  const localAvailable = local?.available === true;
  const reportedAt = Date.parse(local?.reported_at);
  const localFresh =
    localAvailable &&
    local.stale === false &&
    Number.isFinite(reportedAt) &&
    Date.now() - reportedAt <= 2 * 3600000 &&
    reportedAt <= Date.now() + 5 * 60000;
  const localStages = [
    { label: "로컬 수집 완료", value: local?.local_papers },
    { label: "서비스 동기화 완료", value: local?.synced_papers },
    { label: "서지정보 동기화 대기", value: local?.citation_pending },
  ];
  const stages = [
    { label: "문헌 정보 등록", value: metadata, description: "제목·저자·발행일 등 서지 정보" },
    {
      label: "원문 확보",
      value: originals,
      description: "본문을 확보한 논문",
      total: metadata,
      progress: "등록 문헌 중 원문 확보율",
    },
    {
      label: "본문 요약 완료",
      value: summaries,
      description: "확보한 본문으로 요약한 논문",
      total: originals,
      progress: "확보 원문 중 요약 완료율",
    },
  ];
  return (
    <div>
      <p className="text-sm text-text2 mb-4">2000년 1월 1일 이후 발행 논문 · 추천은 최근 5년 우선</p>
      {scopeKnown && (
        <p className="text-sm text-text2 mb-4">
          수집 대상 {count(scope.target_journals)}개 저널
          {scopeGroupsKnown && (
            <span className="block text-xs mt-1">
              비뇨의학 관련 {count(scope.urology_journals)}개 · 종양학·종합의학{" "}
              {count(scope.ancillary_journals)}개
            </span>
          )}
        </p>
      )}
      {localAvailable && (
        <section aria-label="수집 및 동기화" className="mb-5">
          <h3 className="text-sm font-medium text-text1 mb-3">수집 및 동기화</h3>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {localStages.map((stage) => (
              <div key={stage.label} className="rounded-xl border border-border p-4 min-w-0">
                <dt className="text-xs text-text3 mb-3">{stage.label}</dt>
                <dd className="text-2xl font-semibold text-text1 tabular-nums">
                  {count(stage.value)}
                  <span className="text-sm font-normal ml-1">편</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-text2 mt-3">
            로컬 원문 {count(local.local_originals)}편 · 로컬 본문 요약 {count(local.local_summaries)}편
          </p>
          <p className="text-xs text-text2 mt-2">
            서비스 반영 대기: 원문 확보 정보 {count(local.pending_originals)}편 · 본문 요약{" "}
            {count(local.pending_summaries)}편
          </p>
          <p className="text-xs text-text2 mt-2">
            {localFresh
              ? {
                  idle: "동기화 대기",
                  syncing: "동기화 중",
                  capacity_blocked: "저장공간 확보 후 동기화 예정",
                  offline: "연결 복구 후 동기화 예정",
                  error: "동기화 오류 확인 필요",
                }[local.sync_state] || "동기화 상태 확인 필요"
              : "최근 수집 상태를 확인할 수 없습니다. 마지막 보고 수치입니다."}
            {Number.isFinite(reportedAt) && (
              <> · 마지막 보고 {new Date(reportedAt).toLocaleString("ko-KR")}</>
            )}
          </p>
        </section>
      )}
      {localAvailable && <h3 className="text-sm font-medium text-text1 mb-3">서비스 반영 현황</h3>}
      <ol aria-label="문헌 처리 단계" className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {stages.map((stage, index) => (
          <li key={stage.label} className="rounded-xl border border-border p-4 min-w-0">
            <p className="text-xs text-text3 mb-3">
              0{index + 1} · {stage.label}
            </p>
            <p className="text-3xl font-semibold text-text1 tabular-nums">
              {count(stage.value)}
              <span className="text-sm font-normal ml-1">편</span>
            </p>
            <p className="text-xs text-text2 mt-2">{stage.description}</p>
            {stage.progress && (
              <CompletionBar label={stage.progress} value={stage.value} total={stage.total} />
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-x-6 gap-y-2 py-4 text-sm text-text2">
        <span>
          원문 미확보 <strong className="text-text1">{count(difference(metadata, originals))}편</strong>
        </span>
        <span>
          원문 확보·요약 미제공{" "}
          <strong className="text-text1">{count(difference(originals, summaries))}편</strong>
        </span>
      </div>
      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-text1">서비스 DB 사용량</h3>
          <span className="text-xs text-text2">
            {storageKnown
              ? (used / 1048576).toFixed(1) + " / " + (budget / 1048576).toFixed(0) + " MiB"
              : "사용량 확인 중"}
          </span>
        </div>
        {storageKnown && (
          <div
            role="meter"
            aria-label="서비스 DB 사용량 사용률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, (100 * used) / budget)}
            aria-valuetext={
              (used / 1048576).toFixed(1) +
              " MiB 사용, 신규 등록 중단 기준 " +
              (budget / 1048576).toFixed(0) +
              " MiB"
            }
            className="h-2 bg-hover rounded-full overflow-hidden mt-3"
          >
            <div
              className={"h-full rounded-full " + (paused ? "bg-amber-600" : "bg-accent")}
              style={{ width: Math.min(100, (100 * used) / budget) + "%" }}
            />
          </div>
        )}
        <p className="text-sm text-text2 mt-3">
          {paused
            ? localFresh
              ? "저장공간 한도로 서비스 동기화가 대기 중입니다. 로컬에 저장된 자료는 보관됩니다."
              : "새 문헌 정보 등록이 일시 중지되었습니다. 저장공간 확보가 필요하며 로컬 수집의 현재 진행 여부는 확인되지 않았습니다."
            : storageKnown
              ? "새 문헌 정보는 등록 중단 기준에 도달할 때까지 등록합니다."
              : "저장공간 상태를 확인하고 있습니다."}
        </p>
      </div>
      <p className="text-xs text-text2 mt-3">
        DB 전체 사용량에는 서지 정보·초록·요약·사용자 데이터와 인덱스가 포함됩니다. 원문·그림은 제외됩니다.
        표시 기준은 요금제 용량과 별개인 신규 등록 중단 기준입니다.
      </p>
      <details className="mt-4 border-t border-border pt-3 text-sm text-text2">
        <summary className="cursor-pointer min-h-10 flex items-center">기존 문헌 정보 보관 현황</summary>
        <dl className="grid grid-cols-2 gap-2 pb-2">
          <dt>등록된 서지 정보 합계</dt>
          <dd className="text-right">{count(catalog.catalog_papers)}편</dd>
          <dt>2000년 이전 · 자동 처리 제외</dt>
          <dd className="text-right">{count(catalog.archived_papers)}편</dd>
          <dt>발행일 미확인 · 자동 처리 제외</dt>
          <dd className="text-right">{count(catalog.undated_papers)}편</dd>
        </dl>
      </details>
    </div>
  );
}

export function ProcessingHealth({ workers }) {
  if (!workers.length) return <p className="text-sm text-text2">자동 처리 연결을 확인해 주세요.</p>;
  return (
    <div className="space-y-3">
      {workers.map((worker, index) => {
        const last = Date.parse(worker.last_seen_at);
        const stale = !Number.isFinite(last) || Date.now() - last > 2 * 3600000;
        const label = stale
          ? "연결 확인 필요"
          : { running: "처리 중", idle: "다음 실행 대기", error: "최근 작업 오류", registered: "시작 대기" }[
              worker.state
            ] || "상태 확인 필요";
        return (
          <div key={index} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={
                  "w-2 h-2 rounded-full " +
                  (stale || worker.state === "error" ? "bg-amber-600" : "bg-emerald-600")
                }
              />
              {label}
            </p>
            <p className="text-xs text-text2">
              마지막 연결 {Number.isFinite(last) ? new Date(last).toLocaleString("ko-KR") : "확인되지 않음"}
            </p>
          </div>
        );
      })}
    </div>
  );
}
