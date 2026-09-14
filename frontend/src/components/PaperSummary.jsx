import { hasFulltextSummary, summaryLines } from "../lib/summary";

export default function PaperSummary({ paper }) {
  const lines = summaryLines(paper);
  const ready = hasFulltextSummary(paper);
  return (
    <section
      aria-label="본문 기반 세 줄 요약"
      className="bg-[rgba(0,122,255,0.03)] border border-[rgba(0,122,255,0.08)] rounded-lg p-4 mb-4"
    >
      <h3 className="text-sm font-semibold text-accent mb-2">본문 기반 세 줄 요약</h3>
      {ready ? (
        <>
          <ol className="list-decimal pl-5 space-y-2 text-[0.889rem] leading-[1.7] text-text1">
            {lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
          <p className="text-xs text-text3 mt-3">
            원문 본문을 바탕으로 생성한 AI 요약입니다. 수치와 해석은 원문에서 확인하세요.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-text2">
            {paper.fulltext_available
              ? "원문은 확보됐지만 본문 기반 요약이 아직 생성되지 않았습니다."
              : "원문이 아직 확보되지 않아 본문 기반 요약을 제공할 수 없습니다."}
          </p>
          {lines.length > 0 && (
            <details className="mt-3 text-sm text-text2">
              <summary className="cursor-pointer">
                기존 요약 보기 · {paper.summary_basis === "abstract" ? "초록 기반" : "출처 미검증"}
              </summary>
              <p className="whitespace-pre-line leading-relaxed mt-2">{paper.summary_ko}</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
