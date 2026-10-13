export const subjectLabel = (value) => (value === "__unassigned__" ? "No subject metadata" : value);
export const yearLabel = (value) => (value == null || value === 0 ? "Unknown year" : String(value));

// Bins aggregate counts; they never sample papers or interpolate missing years.
export function landscapePeriods(years, width = 5) {
  const dated = years.map((y) => y.year).filter((y) => Number.isInteger(y));
  const result = [];
  if (dated.length) {
    const start = Math.floor(Math.min(...dated) / width) * width;
    const end = Math.max(...dated);
    for (let from = start; from <= end; from += width)
      result.push({
        key: String(from),
        from,
        to: from + width - 1,
        label: width === 1 ? String(from) : `${from}–${from + width - 1}`,
      });
  }
  if (years.some((y) => y.year == null))
    result.push({ key: "unknown", from: null, to: null, label: "Unknown" });
  return result;
}

export function periodCount(years, period) {
  return years.reduce(
    (sum, y) =>
      sum +
      ((period.from == null ? y.year == null : y.year != null && y.year >= period.from && y.year <= period.to)
        ? Number(y.papers)
        : 0),
    0,
  );
}

export function sortedFlows(flows) {
  return [...flows].sort(
    (a, b) => (b.source_year ?? -1) - (a.source_year ?? -1) || (b.target_year ?? -1) - (a.target_year ?? -1),
  );
}
