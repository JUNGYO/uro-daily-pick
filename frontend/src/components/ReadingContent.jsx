import { Link } from "react-router-dom";
import { hasFulltextSummary, summaryLines } from "../lib/summary";

export const FIELDS = [
  ["study_design", "설계"],
  ["population", "대상"],
  ["sample_size", "표본"],
  ["intervention", "중재"],
  ["comparator", "비교군"],
  ["follow_up", "추적 기간"],
  ["outcome", "주요 평가변수"],
  ["key_finding", "주요 결과"],
  ["limitations", "한계"],
];

export function IntegrityNotice({ paper: p }) {
  return (
    <>
      {p.integrity_status && p.integrity_status !== "current" && (
        <div className="reader-notice">
          <strong>
            {
              { retracted: "철회된 문헌", corrected: "정정된 문헌", concern: "우려 표명이 있는 문헌" }[
                p.integrity_status
              ]
            }
          </strong>
          {(p.related_notices || []).map((n, i) => (
            <p key={i}>
              <a
                href={"https://pubmed.ncbi.nlm.nih.gov/" + encodeURIComponent(n.pmid) + "/"}
                target="_blank"
                rel="noreferrer"
              >
                관련 공지 · PMID {n.pmid}
              </a>
            </p>
          ))}
        </div>
      )}
      {p.summary_review_required && (
        <div className="reader-notice" role="status">
          <strong>정정·우려 공지 이후 요약 재검토가 필요합니다.</strong>
          <p>
            아래 요약에는 최근 공지 내용이 반영되지 않았을 수 있습니다. 연결된 공지와 원문을 확인해 주세요.
          </p>
        </div>
      )}
    </>
  );
}

export function EvidenceLinks({ paper, claim, canRead, returnTo }) {
  const refs = paper.evidence?.claims?.[claim];
  if (!canRead || !refs?.length) return null;
  return (
    <span className="reading-evidence-links">
      {refs.map((ref, i) => (
        <Link
          key={ref}
          to={`/fulltext/${paper.pmid}?source=${encodeURIComponent(paper.evidence.content_hash)}#${encodeURIComponent(ref)}`}
          state={{ returnTo }}
        >
          근거 {refs.length > 1 ? i + 1 : "확인"} ·{" "}
          {ref.startsWith("figure-") ? "그림" : ref.startsWith("table-") ? "표" : "본문"}
        </Link>
      ))}
    </span>
  );
}

export function StudyFacts({ paper, fields = FIELDS, evidence = () => null }) {
  return (
    <dl className="reader-facts">
      {fields.map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>
            {paper.research_details?.[key] || paper.structured_data?.[key] || "확인 안됨"}
            {evidence(key)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SummaryContent({ paper: p, evidence = () => null, abstract = true, facts = true }) {
  return (
    <>
      {hasFulltextSummary(p) ? (
        <section className="reader-summary" aria-label="본문 기반 세 줄 요약">
          <h2>본문 기반 세 줄 요약</h2>
          <ol>
            {summaryLines(p).map((line, i) => (
              <li key={i}>
                {line}
                {evidence("summary_" + (i + 1))}
              </li>
            ))}
          </ol>
          <p className="reader-muted">AI 요약 · {new Date(p.summarized_at).toLocaleDateString("ko-KR")}</p>
        </section>
      ) : (
        <div className="reader-notice">
          <h2>{p.fulltext_available ? "원문 확보 · 요약 준비 중" : "서지정보 등록"}</h2>
          <p>
            {p.abstract
              ? "초록을 확인하거나 출판사에서 원문을 볼 수 있습니다."
              : "등록된 초록이 없습니다. 출판사에서 확인해 주세요."}
          </p>
        </div>
      )}
      {facts && <StudyFacts paper={p} fields={FIELDS.slice(0, 3)} />}
      {abstract && p.abstract && (
        <details>
          <summary>초록 보기</summary>
          <p className="whitespace-pre-wrap">{p.abstract}</p>
        </details>
      )}
    </>
  );
}

export function StudyContent({ paper: p, evidence = () => null }) {
  return (
    <>
      <StudyFacts paper={p} evidence={evidence} />
      <h2 className="mt-8">Q&A</h2>
      {p.qa_data?.length ? (
        p.qa_data.map((qa, i) => (
          <section className="reading-qa" key={i}>
            <h3>{qa.q}</h3>
            <p>{qa.a}</p>
            {evidence("qa_" + (i + 1))}
          </section>
        ))
      ) : (
        <p>현재 제공할 Q&A가 없습니다.</p>
      )}
    </>
  );
}
