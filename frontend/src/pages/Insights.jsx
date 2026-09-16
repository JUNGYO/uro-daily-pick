import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { kstDate, checked, allRows } from "../lib/data";
import {
  ACTIVITY_LABELS,
  PERIODS,
  buildReadingEntries,
  activityEntries,
  activityBuckets,
  periodEvents,
  topicCounts,
  methodCounts,
  readingStreak,
  heatmapData,
} from "../lib/readingInsights";
import { ErrorNotice } from "../components/Status";
import {
  Ring,
  HeatmapTable,
  PaperResults,
  InterestExpansion,
  COLORS,
  HEAT,
  PAPER_FIELDS,
} from "../components/InsightsPanels";
import { Loader2, TrendingUp, BookOpen, Zap } from "lucide-react";
import "../insights.css";

export default function Insights() {
  const { user, profile } = useAuth();
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    resultsRef = useRef(null);
  const [loaded, setLoaded] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [limit, setLimit] = useState(20);
  const today = kstDate();
  const period = PERIODS.some(([key]) => key === params.get("period")) ? params.get("period") : "90";
  const activity = Object.hasOwn(ACTIVITY_LABELS, params.get("activity")) ? params.get("activity") : "read";
  const filters = {
    topic: params.get("topic") || "",
    method: params.get("method") || "",
    day: /^\d{4}-\d{2}-\d{2}$/.test(params.get("day") || "") ? params.get("day") : "",
    month: /^\d{4}-\d{2}$/.test(params.get("month") || "") ? params.get("month") : "",
  };
  const returnTo = location.pathname + location.search;
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    setLoading(true);
    setError("");
    setLoaded(null);
    (async () => {
      try {
        const [states, views, feedback] = await Promise.all([
          allRows(() =>
            supabase
              .from("reader_states")
              .select("paper_id,reading_state,read_at,saved,saved_at,note,tags")
              .eq("user_id", user.id)
              .order("paper_id"),
          ),
          allRows(() =>
            supabase.from("read_history").select("paper_id,clicked_at").eq("user_id", user.id).order("id"),
          ),
          allRows(() =>
            supabase
              .from("feedbacks")
              .select("paper_id,action,created_at")
              .eq("user_id", user.id)
              .eq("action", "like")
              .order("id"),
          ),
        ]);
        const ids = [...new Set([...states, ...views, ...feedback].map((row) => row.paper_id))],
          papers = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
          if (!active) return;
          papers.push(
            ...((await checked(
              supabase
                .from("papers")
                .select(PAPER_FIELDS)
                .in("id", ids.slice(offset, offset + 100)),
            )) || []),
          );
        }
        if (active)
          setLoaded({ uid: user.id, entries: buildReadingEntries({ papers, states, views, feedback }) });
      } catch {
        if (active) setError("Could not load insights. Please retry.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [user?.id, retry]);
  useEffect(() => setLimit(20), [returnTo]);
  const entries = loaded?.uid === user?.id ? loaded.entries : [];
  const selected = useMemo(
    () => activityEntries(entries, activity, period, today),
    [entries, activity, period, today],
  );
  const topics = useMemo(() => topicCounts(selected), [selected]);
  const methods = useMemo(() => methodCounts(selected), [selected]);
  const matching = activityEntries(entries, activity, period, today, filters).sort(
    (a, b) =>
      (periodEvents(b, activity, period, today).filter(Boolean).sort().at(-1) || "").localeCompare(
        periodEvents(a, activity, period, today).filter(Boolean).sort().at(-1) || "",
      ) || Number(b.paper.id) - Number(a.paper.id),
  );
  const counts = Object.fromEntries(
    Object.keys(ACTIVITY_LABELS).map((key) => [key, activityEntries(entries, key, period, today).length]),
  );
  const days = activityBuckets(selected, activity, period, today),
    months = Object.entries(activityBuckets(selected, activity, period, today, "month"));
  const weeks = period === "30" ? 5 : period === "90" ? 13 : 26,
    heatmap = heatmapData(days, weeks, today);
  const unknownCount = entries.filter((entry) => entry.events[activity].includes(null)).length;
  const currentTopic =
    topics.find((topic) => topic.id === filters.topic) ||
    (filters.topic ? { id: filters.topic, label: filters.topic } : null);
  const topJournal = Object.entries(
    selected.reduce((result, { paper }) => {
      if (paper.journal) result[paper.journal] = (result[paper.journal] || 0) + 1;
      return result;
    }, {}),
  ).sort((a, b) => b[1] - a[1])[0];
  function change(values, drill = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
    if (drill)
      requestAnimationFrame(() =>
        resultsRef.current?.scrollIntoView?.({
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start",
        }),
      );
  }
  if (error)
    return (
      <div className="page-shell max-w-3xl">
        <ErrorNotice message={error} onRetry={() => setRetry((n) => n + 1)} />
      </div>
    );
  if (loading || loaded?.uid !== user?.id)
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={32} className="text-accent animate-spin" aria-label="Loading insights" />
      </div>
    );
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Insights content"
      className="insights-page h-full overflow-y-auto"
    >
      <div className="p-4 sm:p-6 max-w-[800px] mx-auto">
        <h1 className="text-[1.111rem] font-bold text-text1 mb-5">Research Insights</h1>
        <div className="insights-controls">
          <label>
            Period{" "}
            <select
              value={period}
              onChange={(event) => change({ period: event.target.value, day: "", month: "" })}
            >
              {PERIODS.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span className="insights-caption">Activity dates use Korea Standard Time.</span>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 mb-4 flex items-center justify-around">
          <Ring
            value={counts.read}
            max={Math.max(...Object.values(counts), 1)}
            color="#0066CC"
            label="Marked read"
            icon={BookOpen}
          />
          <Ring
            value={counts.liked}
            max={Math.max(...Object.values(counts), 1)}
            color="#187A36"
            label="Liked"
            icon={TrendingUp}
          />
          <Ring
            value={readingStreak(entries, today)}
            max={30}
            color="#965500"
            label="Current streak"
            icon={Zap}
            unit="days"
          />
        </div>
        <div className="insights-activity-tabs" role="group" aria-label="Activity to explore">
          {Object.entries(ACTIVITY_LABELS).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={activity === key}
              onClick={() => change({ activity: key, day: "", month: "", method: "", topic: "" })}
            >
              {label}
              <strong>{counts[key]}</strong>
            </button>
          ))}
        </div>
        <p className="insights-caption insights-definition">
          Marked read counts your explicit reading status. Viewed records active viewing, not completion.
          Saved and liked are separate actions. The current streak uses dated marked-read records.
        </p>
        {unknownCount > 0 && (
          <p className="insights-caption">
            {unknownCount} {ACTIVITY_LABELS[activity].toLowerCase()} papers have no recorded action date;{" "}
            {period === "all" ? (
              "included in totals, excluded from the calendar."
            ) : (
              <button
                className="insights-text-button"
                onClick={() => change({ period: "all", day: "", month: "" })}
              >
                show them in All time
              </button>
            )}
          </p>
        )}
        {!entries.some((entry) => Object.values(entry.events).some((events) => events.length)) && (
          <div className="insights-panel insights-empty">
            <BookOpen size={30} />
            <h2>No data yet</h2>
            <p>
              View, save, like or mark papers read in Daily Pick. Each action will appear separately here.
            </p>
            <Link to="/">Start reading</Link>
          </div>
        )}
        {topics.length > 0 && (
          <div className="bg-[rgba(0,122,255,0.04)] border border-[rgba(0,122,255,0.1)] rounded-xl p-4 mb-4">
            <p className="text-[0.833rem] text-text1 leading-relaxed">
              In this period, your {ACTIVITY_LABELS[activity].toLowerCase()} papers most often include{" "}
              <strong>{topics[0].label}</strong>
              {topics[1] ? (
                <>
                  {" "}
                  and <strong>{topics[1].label}</strong>
                </>
              ) : null}
              .{topJournal ? ` Most frequent journal: ${topJournal[0]} (${topJournal[1]} papers).` : ""}
            </p>
          </div>
        )}
        <section className="insights-panel" aria-labelledby="activity-heading">
          <div className="insights-panel-heading">
            <h2 id="activity-heading">Reading Activity · {ACTIVITY_LABELS[activity]}</h2>
            <span className="insights-caption">Recent {weeks} weeks</span>
          </div>
          <HeatmapTable
            weeks={weeks}
            cells={heatmap.cells}
            months={heatmap.months}
            selected={filters.day}
            activity={ACTIVITY_LABELS[activity]}
            onSelect={(day) =>
              change({ day: filters.day === day ? "" : day, month: "", topic: "", method: "" }, true)
            }
          />
          <div className="insights-legend" aria-hidden="true">
            <span>Less</span>
            {HEAT.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
            <span>More</span>
          </div>
          <p className="insights-caption">
            Choose a date or month to open its paper list. Month counts deduplicate repeated views of the same
            paper.
          </p>
          <div className="insights-timeline" role="group" aria-label="Monthly activity">
            {months.map(([month, count]) => (
              <button
                key={month}
                aria-pressed={filters.month === month}
                aria-label={`${month}: ${count} ${ACTIVITY_LABELS[activity].toLowerCase()} papers`}
                onClick={() =>
                  change(
                    { month: filters.month === month ? "" : month, day: "", topic: "", method: "" },
                    true,
                  )
                }
              >
                <span>{month}</span>
                <span
                  className="insights-month-bar"
                  style={{
                    height: `${Math.max(5, (count / Math.max(...months.map(([, count]) => count))) * 45)}px`,
                  }}
                />
                <strong>{count}</strong>
              </button>
            ))}
          </div>
          {!months.length && (
            <p className="insights-empty">
              No dated {ACTIVITY_LABELS[activity].toLowerCase()} activity in this period.
            </p>
          )}
        </section>
        <section className="insights-panel" aria-labelledby="topics-heading">
          <h2 id="topics-heading">Research Topics</h2>
          <p className="insights-caption">
            MeSH and keyword metadata, with explicit aliases merged once per paper. Topics and study methods
            are counted separately.
          </p>
          <div className="insights-topics">
            {topics.slice(0, 10).map((topic, i) => (
              <button
                key={topic.id}
                aria-pressed={filters.topic === topic.id}
                onClick={() =>
                  change(
                    { topic: filters.topic === topic.id ? "" : topic.id, day: "", month: "", method: "" },
                    true,
                  )
                }
                style={{ background: COLORS[i % COLORS.length], flexGrow: topic.count }}
              >
                <span>{topic.label}</span>
                <strong>{topic.count} papers</strong>
                <small>{topic.source}</small>
              </button>
            ))}
          </div>
          {!topics.length && <p className="insights-empty">No topics for this activity and period.</p>}
          {topics.length > 10 && (
            <label className="insights-topic-select">
              More topics{" "}
              <select
                value={filters.topic}
                onChange={(event) =>
                  change({ topic: event.target.value, day: "", month: "", method: "" }, true)
                }
              >
                <option value="">All topics</option>
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.label} ({topic.count})
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
        <section className="insights-panel" aria-labelledby="methods-heading">
          <h2 id="methods-heading">Study Types</h2>
          <p className="insights-caption">
            Recognized study methods from metadata. Clinical topics such as imaging and AI are not treated as
            methods.
          </p>
          <div className="insights-methods">
            {methods.map((method, i) => (
              <button
                key={method.id}
                aria-pressed={filters.method === method.id}
                onClick={() =>
                  change(
                    { method: filters.method === method.id ? "" : method.id, topic: "", day: "", month: "" },
                    true,
                  )
                }
              >
                <span>
                  {method.label}
                  <strong>{method.count}</strong>
                </span>
                <span className="insights-method-track">
                  <i
                    style={{
                      width: `${(method.count / Math.max(...methods.map((item) => item.count))) * 100}%`,
                      background: COLORS[i % COLORS.length],
                    }}
                  />
                </span>
              </button>
            ))}
          </div>
          {!methods.length && <p className="insights-empty">No study methods for this selection.</p>}
        </section>
        <section
          ref={resultsRef}
          className="insights-panel insights-results"
          aria-labelledby="insights-results-title"
        >
          {Object.values(filters).some(Boolean) && (
            <div className="insights-filter-summary">
              <span>
                {[
                  currentTopic?.label,
                  methods.find((method) => method.id === filters.method)?.label || filters.method,
                  filters.day,
                  filters.month,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <button
                className="insights-text-button"
                onClick={() => change({ topic: "", method: "", day: "", month: "" })}
              >
                Clear chart selection
              </button>
            </div>
          )}
          <PaperResults
            entries={matching}
            activity={activity}
            period={period}
            today={today}
            title={`${ACTIVITY_LABELS[activity]} papers${currentTopic ? ` · ${currentTopic.label}` : ""}`}
            returnTo={returnTo}
            limit={limit}
            onMore={() => setLimit((n) => n + 20)}
          />
        </section>
        <InterestExpansion
          key={user.id}
          userId={user.id}
          personalized={profile?.personalization_enabled !== false}
          topic={currentTopic}
          returnTo={returnTo}
        />
      </div>
    </div>
  );
}
