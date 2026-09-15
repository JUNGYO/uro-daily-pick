import { kstDate } from "./data";

export const AUTOMATIC_START_DATE = "2000-01-01";
export const RECENT_YEARS = 5;

export function automaticPaper(paper) {
  const value = paper.pub_date;
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value &&
    value >= AUTOMATIC_START_DATE
  );
}

export function recentPaper(paper, today = kstDate()) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RECENT_YEARS);
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  return automaticPaper(paper) && paper.pub_date >= cutoff.toISOString().slice(0, 10);
}
