export function screeningLabel(report) {
  if (report.duplicate || report.duplicate_of) return "중복 문헌";
  if (report.ta_decision === "exclude" || report.ft_decision === "exclude") return "제외";
  if (report.ft_decision === "include") return "포함";
  if (report.ta_decision === "include") return "원문 검토";
  if (report.ta_decision === "defer") return "선별 보류";
  return "선별 대기";
}
export function projectLink(id, report) {
  return `/projects?${new URLSearchParams({ project: id, ...(report ? { view: "review", stage: "reports", report } : {}) })}`;
}
export function scopedLink(path, project) {
  return path + (project ? `?project=${encodeURIComponent(project)}` : "");
}
