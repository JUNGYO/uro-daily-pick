import { supabase } from "./supabase";
import { checked, kstDate, normalizeRec, stringList, withTimeout, allRows } from "./data";
import { keywordMatches, paperMatchesKeyword } from "./keywords";

export async function getDailyPicks(userId, day) {
  const stored = await withTimeout(
    checked(
      supabase
        .from("recommendations")
        .select("*, paper:papers(*)")
        .eq("user_id", userId)
        .eq("rec_date", day)
        .order("score", { ascending: false }),
    ),
  );
  if (stored?.length) {
    const valid = stored.filter((rec) => rec.paper);
    const feedback = valid.length
      ? await checked(
          supabase
            .from("feedbacks")
            .select("paper_id,action")
            .eq("user_id", userId)
            .in(
              "paper_id",
              valid.map((r) => r.paper_id),
            ),
        )
      : [];
    const actions = Object.fromEntries((feedback || []).map((f) => [f.paper_id, f.action]));
    return valid.map((rec) => normalizeRec({ ...rec, feedback_action: actions[rec.paper_id] || null }));
  }
  // Historical dates must never receive today's fallback recommendations.
  if (day !== kstDate()) return [];
  const [profile, papers, feedback, reads, alerts] = await withTimeout(
    Promise.all([
      checked(
        supabase
          .from("profiles")
          .select("keywords,preferred_journals,preferred_study_types")
          .eq("id", userId)
          .single(),
      ),
      checked(
        supabase
          .from("papers")
          .select("*")
          .gte("fetched_at", new Date(Date.now() - 30 * 86400000).toISOString())
          .order("pub_date", { ascending: false })
          .limit(300),
      ),
      allRows(() => supabase.from("feedbacks").select("paper_id").eq("user_id", userId).order("id")),
      checked(
        supabase
          .from("read_history")
          .select("paper_id")
          .eq("user_id", userId)
          .order("clicked_at", { ascending: false })
          .limit(1000),
      ),
      checked(supabase.from("alerts").select("alert_type,value").eq("user_id", userId).eq("is_active", true)),
    ]),
  );
  const seen = new Set([...(feedback || []), ...(reads || [])].map((row) => row.paper_id));
  return rankPapers(papers || [], profile || {}, seen, alerts || [])
    .slice(0, 5)
    .map(({ paper, score, terms }) =>
      normalizeRec({
        id: `instant-${paper.id}`,
        paper_id: paper.id,
        user_id: userId,
        paper,
        score,
        rec_date: day,
        feedback_action: null,
        reasons: { reasons: terms.map((label) => ({ type: "keyword", label })), matched_terms: terms },
      }),
    );
}

export function rankPapers(papers, profile, seen = new Set(), alerts = []) {
  const keywords = stringList(profile.keywords)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  return papers
    .flatMap((paper) => {
      const title = (paper.title || "").toLowerCase(),
        abstract = (paper.abstract || "").toLowerCase();
      if (
        seen.has(paper.id) ||
        abstract.length < 100 ||
        ["letter", "editorial", "comment", "erratum"].includes(paper.paper_type) ||
        /^(re:|reply to|letter to|erratum|editorial|comment on)/i.test(title)
      )
        return [];
      const terms = keywords.filter((k) =>
        paperMatchesKeyword(
          { ...paper, keywords: stringList(paper.keywords), mesh_terms: stringList(paper.mesh_terms) },
          k,
        ),
      );
      let score = terms.reduce((sum, term) => sum + (keywordMatches(title, term) ? 3 : 1), 0);
      const journal = (paper.journal || "").toLowerCase();
      if (
        journal &&
        stringList(profile.preferred_journals).some((j) => j.trim() && journal.includes(j.toLowerCase()))
      )
        score += 2;
      if (stringList(profile.preferred_study_types).includes(paper.study_type)) score += 1.5;
      for (const alert of alerts) {
        const value = (alert.value || "").trim().toLowerCase();
        const haystack =
          {
            keyword: `${title} ${abstract}`,
            author: stringList(paper.authors).join(" ").toLowerCase(),
            journal,
          }[alert.alert_type] || "";
        const matches =
          alert.alert_type === "keyword"
            ? keywordMatches(title, value) || keywordMatches(abstract, value)
            : haystack.includes(value);
        if (value && matches) {
          score += 3;
          terms.unshift(`Alert: ${alert.value}`);
          break;
        }
      }
      const age = (Date.now() - Date.parse(paper.pub_date)) / 86400000;
      if (Number.isFinite(age)) score += Math.max(0, 1 - Math.max(0, age) / 30);
      return score > 0 ? [{ paper, score, terms }] : [];
    })
    .sort((a, b) => b.score - a.score || b.paper.id - a.paper.id);
}
