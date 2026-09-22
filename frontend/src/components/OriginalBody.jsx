import { useMemo } from "react";
import { originalParagraphs } from "../lib/originalText";

export default function OriginalBody({ article, activeId, onFigure }) {
  const paragraphs = useMemo(() => {
    const result = [];
    for (const paragraph of originalParagraphs(
      article.content_text,
      article.blocks,
      article.reading_layout,
    )) {
      const previous = result.at(-1);
      // Legacy XML stores a section label before the identical publisher title.
      // Show it once, but keep both source locations on that same heading.
      if (
        paragraph.kind === "heading" &&
        previous?.kind === "heading" &&
        paragraph.runs
          .map((r) => r.text)
          .join("")
          .trim() ===
          previous.runs
            .map((r) => r.text)
            .join("")
            .trim()
      ) {
        previous.aliases.push(...paragraph.runs.filter((r) => r.id));
      } else result.push({ ...paragraph, aliases: [] });
    }
    return result;
  }, [article.content_text, article.blocks, article.reading_layout]);
  return paragraphs.map((paragraph) => (
    <div key={paragraph.start} className="mb-4 last:mb-0">
      {paragraph.rows ? (
        <div className="overflow-x-auto max-w-full" role="region" aria-label="논문 표" tabIndex={0}>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {paragraph.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, i) => {
                    const Cell = cell.header ? "th" : "td";
                    return (
                      <Cell
                        key={i}
                        rowSpan={cell.rowspan}
                        colSpan={cell.colspan}
                        className="border border-slate-300 p-3 text-left align-top min-w-[7rem]"
                      >
                        <SourceRuns runs={cell.runs} activeId={activeId} />
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : paragraph.kind === "heading" ? (
        <h2
          className={`original-paragraph font-semibold mt-6 mb-2 ${paragraph.aliases.some((run) => run.id === activeId) ? "bg-amber-100 rounded-sm outline outline-2 outline-amber-400" : ""}`}
        >
          {paragraph.aliases.map((run) => (
            <span key={run.id} id={run.id} tabIndex={-1} aria-hidden="true" />
          ))}
          <SourceRuns runs={paragraph.runs} activeId={activeId} />
        </h2>
      ) : (
        <p className="original-paragraph">
          <SourceRuns runs={paragraph.runs} activeId={activeId} />
        </p>
      )}
      {paragraph.figures.map((block) => {
        const number = block.text.match(/^\s*Fig(?:ure)?[.]?\s+(\d+)/i)?.[1];
        const figure =
          number && article.figures.find((f) => f.label.match(/Fig(?:ure)?[.]?\s*(\d+)/i)?.[1] === number);
        return figure ? (
          <button key={block.id} className="btn-secondary block mt-3" onClick={() => onFigure(figure)}>
            이 그림 보기
          </button>
        ) : null;
      })}
    </div>
  ));
}

function SourceRuns({ runs, activeId }) {
  return runs.map((run, index) => (
    <span
      key={run.id || index}
      id={run.id}
      tabIndex={run.id ? -1 : undefined}
      className={
        activeId && activeId === (run.locationId || run.id)
          ? "bg-amber-100 rounded-sm outline outline-2 outline-amber-400"
          : undefined
      }
    >
      {run.text}
    </span>
  ));
}
