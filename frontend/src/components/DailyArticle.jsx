import { Link } from "react-router-dom";
import { Tag, User2, BookOpen, FlaskConical, Clock, Star, TrendingUp, Zap } from "lucide-react";
import { keywordPattern } from "../lib/keywords";
import { paperLink } from "../lib/workspace";
import { EvidenceLinks, IntegrityNotice, SummaryContent } from "./ReadingContent";

// Preserve the original reading screen's study-type and recommendation vocabulary.
const TYPES = {
  rct: ["RCT", "#0066CC", "#edf5ff"],
  basic_research: ["Basic Research", "#8738B5", "#f8f1fc"],
  biomarker: ["Biomarker", "#965500", "#fff6e8"],
  retrospective: ["Retrospective", "#63636A", "#f1f1f4"],
  prospective: ["Prospective", "#187A36", "#edf9f0"],
  meta_analysis: ["Meta-analysis", "#C32D26", "#fff1f0"],
  ai_ml: ["AI / ML", "#5856D6", "#f1f0ff"],
  surgical: ["Surgical", "#00776F", "#eaf8f6"],
  imaging: ["Imaging", "#0066CC", "#edf5ff"],
  epidemiology: ["Epidemiology", "#965500", "#fff6e8"],
  guideline: ["Guideline", "#C32D26", "#fff1f0"],
  review: ["Review", "#63636A", "#f1f1f4"],
  systematic_review: ["Systematic Review", "#63636A", "#f1f1f4"],
  case_report: ["Case Report", "#63636A", "#f1f1f4"],
};
const CHIPS = {
  keyword: [Tag, "#0066CC", "#edf5ff"],
  mesh: [FlaskConical, "#187A36", "#edf9f0"],
  learned: [TrendingUp, "#5856D6", "#f1f0ff"],
  author: [User2, "#187A36", "#edf9f0"],
  journal: [BookOpen, "#63636A", "#f1f1f4"],
  fresh: [Zap, "#0066CC", "#edf5ff"],
  review: [Star, "#965500", "#fff6e8"],
  reading_pattern: [Clock, "#63636A", "#f1f1f4"],
};
const FIELDS = [
  ["study_design", "Design"],
  ["sample_size", "N"],
  ["population", "Pop"],
  ["key_finding", "Key"],
  ["intervention", "중재"],
  ["comparator", "비교군"],
  ["follow_up", "추적 기간"],
  ["outcome", "주요 평가변수"],
  ["limitations", "한계"],
];

export function TypeBadge({ type }) {
  const [label, color, background] = TYPES[type] || ["Article", "#63636A", "#f1f1f4"];
  return (
    <span className="today-type" style={{ color, background }}>
      {label}
    </span>
  );
}

function Highlight({ text, terms }) {
  const re = keywordPattern(terms);
  if (!text || !re) return text;
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

export default function DailyArticle({ rec, reason, canRead, returnTo, titleRef }) {
  const p = rec.paper;
  const evidence = (claim) => <EvidenceLinks paper={p} claim={claim} canRead={canRead} returnTo={returnTo} />;
  const facts = FIELDS.map(([key, label]) => [
    key,
    label,
    p.research_details?.[key] || p.structured_data?.[key],
  ]).filter(([, , value]) => value && !["N/A", "Not reported", "확인 안됨"].includes(value));
  const qa = (p.qa_data || []).filter(
    (item) => item && typeof item.q === "string" && typeof item.a === "string",
  );
  return (
    <article className="today-article" aria-label="선택한 논문">
      <div className="today-meta">
        <TypeBadge type={p.study_type} />
        <span className="today-journal-name">{p.journal}</span>
        <span>{p.pub_date}</span>
        {Number.isFinite(rec.score) && (
          <span title="관심 주제·저널·발행일 등을 반영한 개인화 추천 점수입니다.">
            추천 점수 {rec.score.toFixed(1)}
          </span>
        )}
        {p.abstract && (
          <span>{Math.max(1, Math.ceil(p.abstract.split(/\s+/).length / 200))}분 초록 읽기</span>
        )}
        {p.clinical_relevance >= 4 && (
          <span
            className="today-relevance"
            title="모델이 분류한 임상 관련성입니다. 연구의 근거 수준을 평가한 점수는 아닙니다."
          >
            AI 임상 관련성 {p.clinical_relevance}/5
          </span>
        )}
      </div>
      <h1 className="today-paper-title" ref={titleRef} tabIndex={-1}>
        <Link to={paperLink(p)} state={{ returnTo }}>
          <Highlight text={p.title} terms={rec.reasons.matched_terms} />
        </Link>
      </h1>
      <p className="today-authors">
        {(p.authors || []).slice(0, 5).join(", ")}
        {p.authors?.length > 5 ? " et al." : ""} <span>· PMID {p.pmid}</span>
      </p>
      <div className="today-reasons" aria-label="추천 이유">
        {rec.reasons.reasons.length ? (
          <>
            <p className="today-caption">
              Why this paper <span>· 추천 이유</span>
            </p>
            <div className="today-chips">
              {rec.reasons.reasons.map((item, i) => {
                const [Icon, color, background] = CHIPS[item.type] || CHIPS.keyword;
                return (
                  <span key={i} className="today-reason" style={{ color, background }}>
                    <Icon size={12} aria-hidden="true" />
                    {item.label}
                  </span>
                );
              })}
            </div>
          </>
        ) : (
          <p className="today-caption">추천 이유 · {reason || "선정된 오늘의 문헌"}</p>
        )}
      </div>
      <IntegrityNotice paper={p} />
      <SummaryContent paper={p} evidence={evidence} abstract={false} facts={false} />
      {(facts.length > 0 || qa.length > 0) && (
        <details className="today-study">
          <summary>
            Details &amp; Q&amp;A <span>· 연구 상세</span>
          </summary>
          <dl className="today-facts">
            {facts.map(([key, label, value]) => (
              <div key={key} className={key === "key_finding" ? "today-key-finding" : ""}>
                <dt>{label}:</dt>
                <dd>
                  {value}
                  {evidence(key)}
                </dd>
              </div>
            ))}
          </dl>
          {qa.map((item, i) => (
            <section className="today-qa" key={i}>
              <h2>Q. {item.q}</h2>
              <p>{item.a}</p>
              {evidence("qa_" + (i + 1))}
            </section>
          ))}
        </details>
      )}
      {p.abstract && (
        <section className="today-abstract" aria-label="초록">
          <h2>
            Abstract <span>· 초록</span>
          </h2>
          <p>
            <Highlight text={p.abstract} terms={rec.reasons.matched_terms} />
          </p>
        </section>
      )}
      <div className="today-research-links">
        <Link to={paperLink(p) + "?tab=notes"} state={{ returnTo }}>
          메모·프로젝트에 추가
        </Link>
        <Link to={paperLink(p)} state={{ returnTo }}>
          문헌 상세·오류 신고
        </Link>
      </div>
    </article>
  );
}
