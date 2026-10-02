import { useEffect, useMemo, useState } from "react";
import { originalParagraphs } from "../lib/originalText";

export default function OriginalBody({ article, activeId, onFigure }) {
  const [opened, setOpened] = useState(null);
  useEffect(() => setOpened(null), [article.pmid, article.content_hash]);
  const references = useMemo(
    () => new Map((article.reading_layout?.references || []).map((r) => [r.id, r])),
    [article.reading_layout],
  );
  const openReference = (citation, trigger) => {
    if (opened?.citation.start === citation.start) {
      setOpened(null);
      return;
    }
    setOpened({ citation, trigger });
    requestAnimationFrame(() => document.getElementById(`reference-detail-${citation.start}`)?.focus());
  };
  const closeReference = () => {
    opened?.trigger?.focus();
    setOpened(null);
  };
  const sourceProps = { activeId, references, opened, onReference: openReference };
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
                        <SourceRuns runs={cell.runs} {...sourceProps} />
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
          <SourceRuns runs={paragraph.runs} {...sourceProps} />
        </h2>
      ) : (
        <p className="original-paragraph">
          <SourceRuns runs={paragraph.runs} {...sourceProps} />
        </p>
      )}
      {opened && opened.citation.start >= paragraph.start && opened.citation.end <= paragraph.end && (
        <aside
          id={`reference-detail-${opened.citation.start}`}
          tabIndex={-1}
          aria-label={`참고문헌 ${citationLabel(opened.citation.text)}`}
          className="mt-3 rounded-lg border border-border bg-hover p-4 text-sm leading-relaxed whitespace-normal focus:outline-accent"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeReference();
            }
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="font-medium text-text1">참고문헌 [{citationLabel(opened.citation.text)}]</h3>
            <button
              className="text-accent underline px-2 py-1 shrink-0"
              onClick={closeReference}
              aria-label="참고문헌 닫기"
            >
              닫기
            </button>
          </div>
          {opened.citation.targets
            .map((id) => references.get(id))
            .filter(Boolean)
            .map((ref) => (
              <p key={ref.id} className="mt-2 text-text2 break-words">
                {ref.text}
              </p>
            ))}
        </aside>
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

function citationLabel(text) {
  return text
    .trim()
    .replace(/^\[\s*|\s*\]$/g, "")
    .replace(/(\d)\s+(?=\d)/g, "$1, ")
    .replace(/\s*[,;]\s*/g, ", ")
    .replace(/\s*[-–—]\s*/g, "–");
}

function SourceRuns({ runs, activeId, references, opened, onReference }) {
  const groups = [];
  for (const run of runs) {
    const previous = groups.at(-1);
    if (run.citation && previous?.citation === run.citation) previous.runs.push(run);
    else groups.push({ citation: run.citation, runs: [run] });
  }
  const sourceSpan = (run, index, content = run.text) => (
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
      {content}
    </span>
  );
  const citationElement = (group) => {
    const cite = group.citation;
    const label = citationLabel(cite.text);
    const numeric = /^[\d\s,;–—-]+$/.test(label);
    const available = cite.targets.some((id) => references.has(id));
    const Wrapper = numeric ? "sup" : "span";
    const highlighted = group.runs.some((run) => activeId && activeId === (run.locationId || run.id));
    return (
      <Wrapper
        key={`citation-${cite.start}`}
        className={`original-citation ${numeric ? "align-super text-[0.75em] leading-none" : "text-[0.9em]"} ${highlighted ? "bg-amber-100 rounded-sm outline outline-2 outline-amber-400" : ""}`}
      >
        {group.runs.filter((r) => r.id).map((run, i) => sourceSpan(run, i, ""))}
        {available ? (
          <button
            type="button"
            className="text-accent underline decoration-accent/40 underline-offset-2 rounded px-0.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`참고문헌 ${label} 보기`}
            aria-expanded={opened?.citation.start === cite.start}
            aria-controls={
              opened?.citation.start === cite.start ? `reference-detail-${cite.start}` : undefined
            }
            onClick={(event) => onReference(cite, event.currentTarget)}
          >
            [{label}]
          </button>
        ) : (
          <span className="text-accent px-0.5" aria-label={`참고문헌 ${label}`}>
            [{label}]
          </span>
        )}
      </Wrapper>
    );
  };
  const result = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index],
      next = groups[index + 1];
    if (group.citation) {
      result.push(citationElement(group));
      continue;
    }
    const run = group.runs[0];
    const tail = run.text.match(/\S+\s*$/u)?.[0];
    // Keep a short word and its reference together, including across source
    // locator boundaries. Long words/groups may wrap to preserve mobile width.
    if (
      tail &&
      next?.citation &&
      /^[\d\s,;–—-]+$/.test(citationLabel(next.citation.text)) &&
      tail.length + citationLabel(next.citation.text).length <= 24
    ) {
      const prefix = run.text.slice(0, -tail.length);
      if (prefix) result.push(sourceSpan(run, index, prefix));
      result.push(
        <span
          key={`attached-${next.citation.start}`}
          className="original-citation-attachment whitespace-nowrap"
        >
          {sourceSpan({ ...run, id: prefix ? undefined : run.id }, index, tail)}
          {citationElement(next)}
        </span>,
      );
      index++;
    } else result.push(sourceSpan(run, index));
  }
  return result;
}
