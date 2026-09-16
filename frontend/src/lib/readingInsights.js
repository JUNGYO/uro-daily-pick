import { kstDate, shiftDate, stringList } from "./data";
import { paperTopics, studyMethod } from "./paperTaxonomy";

export const ACTIVITY_LABELS = { read: "Marked read", viewed: "Viewed", saved: "Saved", liked: "Liked" };
export const PERIODS = [
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["365", "Last year"],
  ["all", "All time"],
];
const eventDay = (value) => (value && Number.isFinite(Date.parse(value)) ? kstDate(value) : null);

export function buildReadingEntries({ papers = [], states = [], views = [], feedback = [] }) {
  const statesById = new Map(states.map((state) => [String(state.paper_id), state]));
  const likesById = new Map(
    feedback.filter((row) => row.action === "like").map((row) => [String(row.paper_id), row]),
  );
  const viewsById = new Map();
  for (const row of views) {
    const id = String(row.paper_id),
      day = eventDay(row.clicked_at);
    if (day) viewsById.set(id, [...new Set([...(viewsById.get(id) || []), day])]);
  }
  return [...new Map(papers.map((paper) => [String(paper.id), paper])).values()].map((paper) => {
    const id = String(paper.id),
      state = statesById.get(id) || {},
      liked = likesById.get(id);
    return {
      paper,
      state: { ...state, tags: stringList(state.tags) },
      topics: paperTopics(paper),
      method: studyMethod(paper),
      events: {
        read: state.reading_state === "read" ? [eventDay(state.read_at)] : [],
        saved: state.saved ? [eventDay(state.saved_at)] : [],
        liked: liked ? [eventDay(liked.created_at)] : [],
        viewed: viewsById.get(id) || [],
      },
    };
  });
}

export function periodStart(period, today = kstDate()) {
  return period === "all" ? null : shiftDate(today, -(Number(period) - 1));
}

export function periodEvents(entry, activity, period, today = kstDate()) {
  const start = periodStart(period, today);
  return (entry.events[activity] || []).filter((day) =>
    day === null ? period === "all" : day <= today && (!start || day >= start),
  );
}

export function activityEntries(entries, activity, period, today = kstDate(), filters = {}) {
  return entries.filter((entry) => {
    const days = periodEvents(entry, activity, period, today);
    return (
      days.length &&
      (!filters.topic || entry.topics.some((topic) => topic.id === filters.topic)) &&
      (!filters.method || entry.method.id === filters.method) &&
      (!filters.day || days.includes(filters.day)) &&
      (!filters.month || days.some((day) => day?.startsWith(filters.month)))
    );
  });
}

export function topicCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const topic of entry.topics) {
      const previous = counts.get(topic.id);
      const sources = [...new Set([...(previous?.sources || []), ...topic.sources])];
      counts.set(topic.id, {
        ...topic,
        sources,
        source: sources.join(" + ") || topic.source,
        count: (previous?.count || 0) + 1,
      });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function methodCounts(entries) {
  const counts = new Map();
  for (const { method } of entries)
    counts.set(method.id, { ...method, count: (counts.get(method.id)?.count || 0) + 1 });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function activityBuckets(entries, activity, period, today = kstDate(), unit = "day") {
  const buckets = new Map();
  for (const entry of entries) {
    for (const day of periodEvents(entry, activity, period, today)) {
      if (!day) continue;
      const key = unit === "month" ? day.slice(0, 7) : day;
      const ids = buckets.get(key) || new Set();
      ids.add(String(entry.paper.id));
      buckets.set(key, ids);
    }
  }
  return Object.fromEntries(
    [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([day, ids]) => [day, ids.size]),
  );
}

export function readingStreak(entries, today = kstDate()) {
  const days = activityBuckets(entries, "read", "all", today);
  let day = days[today] ? today : shiftDate(today, -1),
    streak = 0;
  while (days[day]) {
    streak++;
    day = shiftDate(day, -1);
  }
  return streak;
}

export function heatmapData(dayCounts, weeks, today = kstDate()) {
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const firstMonday = shiftDate(today, -weekday - (weeks - 1) * 7);
  const cells = [],
    months = [];
  for (let week = 0; week < weeks; week++) {
    const start = shiftDate(firstMonday, week * 7);
    const label = new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    if (months.at(-1)?.label === label) months.at(-1).span++;
    else months.push({ label, span: 1 });
    for (let day = 0; day < 7; day++) {
      const key = shiftDate(start, day);
      cells.push(key > today ? null : { date: key, count: dayCounts[key] || 0 });
    }
  }
  return { cells, months };
}
