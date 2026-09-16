import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { kstDate, checked, jsonValue, normalizeRec } from "../lib/data";
import { paperLink, rpc } from "../lib/workspace";
import { paperTopics } from "../lib/paperTaxonomy";
import { ACTIVITY_LABELS, periodEvents } from "../lib/readingInsights";
import { ErrorNotice } from "./Status";

export const COLORS = ["#0066CC", "#187A36", "#965500", "#8738B5", "#C32D26", "#00776F"];
export const HEAT = ["#F5F5F7", "#DBEAFE", "#93C5FD", "#3B82F6", "#1D4ED8", "#1E3A5F"];
export const PAPER_FIELDS =
  "id,pmid,title,journal,pub_date,keywords,mesh_terms,study_type,publication_types,structured_data,fulltext_available";

export function Ring({ value, max, color, label, icon: Icon, unit = "papers" }) {
  const circ = 2 * Math.PI * 34;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        className="w-[68px] h-[68px] sm:w-[84px] sm:h-[84px]"
        viewBox="0 0 84 84"
        role="img"
        aria-label={`${label}: ${value} ${unit}`}
      >
        <circle cx="42" cy="42" r="34" fill="none" stroke="#F2F2F7" strokeWidth="6" />
        <circle
          cx="42"
          cy="42"
          r="34"
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={`${Math.min(1, value / Math.max(1, max)) * circ} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 42 42)"
        />
        <text x="42" y="39" textAnchor="middle" fontSize="16" fontWeight="700" fill="#1D1D1F">
          {value}
        </text>
        <text x="42" y="52" textAnchor="middle" fontSize="8" fill="#64646B">
          {unit}
        </text>
      </svg>
      <div className="flex items-center gap-1">
        <Icon size={11} style={{ color }} />
        <span className="text-[0.667rem] text-text3 font-medium">{label}</span>
      </div>
    </div>
  );
}

export function HeatmapTable({ weeks, cells, months, selected, activity, onSelect }) {
  let col = 2;
  return (
    <div
      className="insights-heat-scroll"
      role="region"
      tabIndex={0}
      aria-label="Activity calendar, scroll horizontally for more dates"
    >
      <div
        className="insights-heat"
        style={{ gridTemplateColumns: `20px repeat(${weeks}, minmax(20px, 1fr))` }}
      >
        <div />
        {months.map((month, i) => {
          const start = col;
          col += month.span;
          return (
            <div
              key={i}
              className="insights-month-label"
              style={{ gridColumn: `${start} / ${col}`, gridRow: 1 }}
            >
              {month.label}
            </div>
          );
        })}
        {["M", "T", "W", "T", "F", "S", "S"].map((day, row) => (
          <div key={row} className="insights-day-label" style={{ gridColumn: 1, gridRow: row + 2 }}>
            {day}
          </div>
        ))}
        {cells.map((cell, index) =>
          cell ? (
            <button
              key={cell.date}
              className="insights-heat-cell"
              style={{
                gridColumn: Math.floor(index / 7) + 2,
                gridRow: (index % 7) + 2,
                background: HEAT[Math.min(5, cell.count)],
              }}
              title={`${cell.date}: ${cell.count} ${activity.toLowerCase()} papers`}
              aria-label={`${cell.date}: ${cell.count} ${activity.toLowerCase()} papers`}
              aria-pressed={selected === cell.date}
              onClick={() => onSelect(cell.date)}
            />
          ) : (
            <span key={index} style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: (index % 7) + 2 }} />
          ),
        )}
      </div>
    </div>
  );
}

export function PaperResults({ entries, activity, period, today, title, returnTo, limit, onMore }) {
  return (
    <>
      <h2 id="insights-results-title">{title}</h2>
      <p className="insights-caption" role="status">
        {entries.length} papers. Counts use distinct papers; one paper may have several topics.
      </p>
      {!entries.length && (
        <p className="insights-empty">No papers match this selection. Try another activity or period.</p>
      )}
      <ol className="insights-paper-list">
        {entries.slice(0, limit).map((entry) => {
          const { paper, state } = entry;
          const dates = periodEvents(entry, activity, period, today).filter(Boolean).sort();
          return (
            <li key={paper.id}>
              <div className="insights-paper-meta">
                <span>{paper.journal}</span>
                <span>{paper.pub_date?.slice(0, 4)}</span>
                <span>{paper.fulltext_available ? "Original acquired" : "Citation record"}</span>
              </div>
              <h3>
                <Link to={paperLink(paper)} state={{ returnTo }}>
                  {paper.title}
                </Link>
              </h3>
              <p className="insights-caption">
                {ACTIVITY_LABELS[activity]} · {dates.at(-1) || "Date not recorded"}
                {dates.length > 1 ? ` · ${dates.length} different days` : ""}
              </p>
              {state.note && (
                <p className="insights-note">
                  <strong>My note · </strong>
                  {state.note.slice(0, 240)}
                  {state.note.length > 240 ? "…" : ""}
                </p>
              )}
              {state.tags?.length > 0 && (
                <div className="insights-tags" role="group" aria-label="My tags">
                  {state.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
              <Link className="insights-detail-link" to={paperLink(paper)} state={{ returnTo }}>
                Read, edit notes or add to a project →
              </Link>
            </li>
          );
        })}
      </ol>
      {entries.length > limit && (
        <button className="btn-secondary" onClick={onMore}>
          Show 20 more papers
        </button>
      )}
    </>
  );
}

export function InterestExpansion({ userId, personalized, topic, returnTo }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    (async () => {
      try {
        const day = kstDate(),
          cards = await rpc("reader_daily", { p_day: day });
        const ids = (cards || []).map((paper) => paper.id);
        if (!ids.length) {
          if (active) setData({ personalized, items: [] });
          return;
        }
        const [papers, reasons] = await Promise.all([
          checked(supabase.from("papers").select(`${PAPER_FIELDS},abstract,authors`).in("id", ids)),
          checked(
            supabase
              .from("recommendations")
              .select("paper_id,reasons")
              .eq("user_id", userId)
              .eq("rec_date", day)
              .in("paper_id", ids)
              .limit(5),
          ),
        ]);
        const byId = new Map((papers || []).map((paper) => [String(paper.id), paper]));
        const reasonById = new Map(
          (reasons || []).map((row) => [String(row.paper_id), jsonValue(row.reasons, {})]),
        );
        const loaded = cards.map((card) => {
          const paper = { ...card, ...byId.get(String(card.id)) },
            raw = reasonById.get(String(card.id)) || {};
          const network = raw.network || {};
          const eligible =
            personalized &&
            raw.personalization_enabled === true &&
            network.status === "qualified" &&
            Number.isInteger(network.cohort_size) &&
            network.cohort_size >= Math.max(3, Number(network.min_similar_readers) || 3);
          const labels = normalizeRec({ paper, reasons: raw }).reasons.reasons.filter((reason) => {
            if (reason.type === "similar_readers")
              return (
                eligible &&
                Number.isInteger(reason.support) &&
                reason.support >= Math.max(3, Number(network.min_paper_support) || 3) &&
                reason.cohort_size === network.cohort_size &&
                reason.support <= reason.cohort_size
              );
            if (["learned", "reading_pattern", "author"].includes(reason.type))
              return personalized && raw.personalization_enabled !== false;
            return ["keyword", "alert", "journal", "fresh", "review"].includes(reason.type);
          });
          return { paper, labels, network: eligible ? network : null, fallback: card.reason };
        });
        if (active) setData({ personalized, items: loaded });
      } catch {
        if (active) setError("Could not load interest suggestions.");
      }
    })();
    return () => {
      active = false;
    };
  }, [userId, personalized, retry]);
  // Preference changes hide the previous cohort/candidate data in the same render.
  const currentData = data?.personalized === personalized ? data.items : null;
  const items = (currentData || []).filter(
    ({ paper }) => !topic || paperTopics(paper).some((item) => item.id === topic.id),
  );
  const network = personalized && (currentData || []).map((item) => item.network).find(Boolean);
  const suggestedTopics = (Array.isArray(network?.topics) ? network.topics : [])
    .filter(
      (item) =>
        typeof item?.id === "string" &&
        typeof item.label === "string" &&
        Number.isInteger(item.reader_support) &&
        item.reader_support >= 3 &&
        item.reader_support <= network.cohort_size &&
        Number.isInteger(item.paper_support) &&
        item.paper_support >= 2 &&
        item.source === "metadata",
    )
    .slice(0, 6);
  return (
    <section className="insights-panel" aria-labelledby="interest-expansion-title">
      <h2 id="interest-expansion-title">Interest expansion</h2>
      <p className="insights-caption">
        Explore today's suggestions with their recorded reasons. Open a paper to save it, update your interest
        or add it to a project.
      </p>
      <p className="insights-cohort-status">
        {!personalized
          ? "Behavior-based personalization is off. Suggestions use your explicit profile and content preferences."
          : network
            ? "Similar-reader evidence is available only where the minimum group and support counts are met."
            : "Not enough verified similar-reader evidence is available. Content and profile interests remain the starting point."}{" "}
        <Link to="/settings">Recommendation settings</Link>
      </p>
      {suggestedTopics.length > 0 && (
        <div className="insights-tags" role="group" aria-label="Topics from similar readers">
          {suggestedTopics.map((item) => (
            <Link
              key={item.id}
              to={`/discover?q=${encodeURIComponent(item.id)}`}
              title={`${item.reader_support} readers · ${item.paper_support} papers · metadata topic`}
            >
              {item.label} · {item.reader_support} readers / {item.paper_support} papers
            </Link>
          ))}
        </div>
      )}
      {error ? (
        <ErrorNotice message={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : currentData === null ? (
        <p role="status">Loading suggestions…</p>
      ) : !items.length ? (
        <p className="insights-empty">
          {topic
            ? "No current suggestion matches this topic. Explore the catalog for more papers."
            : "No current suggestions yet. Set your interests or explore a topic to get started."}
        </p>
      ) : (
        <ol className="insights-paper-list">
          {items.map(({ paper, labels, fallback }) => (
            <li key={paper.id}>
              <h3>
                <Link to={paperLink(paper)} state={{ returnTo }}>
                  {paper.title}
                </Link>
              </h3>
              <p className="insights-caption">
                {paper.journal} · {paper.pub_date}
              </p>
              <p className="insights-reasons">
                <strong>Why this paper · </strong>
                {labels.length
                  ? labels
                      .map((reason) =>
                        reason.type === "similar_readers"
                          ? `Liked by ${reason.support} similar readers (group: ${reason.cohort_size})`
                          : reason.label,
                      )
                      .join(" · ")
                  : fallback || "Content and profile interests"}
              </p>
              <Link className="insights-detail-link" to={paperLink(paper)} state={{ returnTo }}>
                Open paper and actions →
              </Link>
            </li>
          ))}
        </ol>
      )}
      <Link
        className="btn-secondary"
        to={
          topic && topic.id !== "unclassified" ? `/discover?q=${encodeURIComponent(topic.id)}` : "/discover"
        }
      >
        {topic && topic.id !== "unclassified" ? `Explore ${topic.label}` : "Explore papers"}
      </Link>
    </section>
  );
}
