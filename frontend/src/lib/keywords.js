// Match literal terms at Unicode word boundaries, including medical acronyms.
export function keywordPattern(terms) {
  const literals = [
    ...new Set(
      terms
        .filter((term) => typeof term === "string")
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((term) =>
      term
        .split(/\s+/u)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
    );
  return literals.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(${literals.join("|")})(?![\\p{L}\\p{N}_])`, "giu")
    : null;
}

export function keywordMatches(text, term) {
  return keywordPattern([term])?.test(text || "") || false;
}

export function paperMatchesKeyword(paper, term) {
  const normalized = (term || "").trim().toLowerCase();
  return (
    Boolean(normalized) &&
    (keywordMatches(paper.title, term) ||
      keywordMatches(paper.abstract, term) ||
      [...(paper.keywords || []), ...(paper.mesh_terms || [])].some(
        (value) => typeof value === "string" && value.trim().toLowerCase() === normalized,
      ))
  );
}
