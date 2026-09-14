export const summaryLines = (paper) =>
  typeof paper?.summary_ko === "string"
    ? paper.summary_ko
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

// The reader and both recommendation paths must agree on what is deliverable.
export const hasFulltextSummary = (paper) =>
  paper?.fulltext_available === true &&
  paper.summary_basis === "fulltext" &&
  [paper.summary_source_hash, paper.summary_model, paper.summarized_at].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  ) &&
  summaryLines(paper).length === 3;
