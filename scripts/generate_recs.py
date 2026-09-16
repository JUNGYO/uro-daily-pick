"""
Uro Daily Pick - Recommendation Generator
Scores papers with full-text summaries and saves up to five daily recommendations.
Run daily via GitHub Actions after fetch_papers.py.
"""
import os
import math
from datetime import datetime, timedelta, timezone
from collections import Counter

import requests
from common import supabase_headers
from common import get_json, paginate, strings
from keywords import keyword_matches, keyword_count
from catalog_policy import AUTOMATIC_START_DATE, automatic_paper, recent_paper
from recommendation_topics import normalized_term, paper_topics, topic_id

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Scoring weights
W_CONTENT = 0.50
W_BEHAVIORAL = 0.25
W_COLLABORATIVE = 0.10
W_TEMPORAL = 0.15

MIN_SIMILAR_READERS = 3
MIN_SHARED_LIKES = 2
MIN_SIMILARITY = 0.20
MIN_PAPER_SUPPORT = 3
MIN_TOPIC_PAPERS = 2
MAX_SIMILAR_READERS = 50
MAX_NETWORK_TOPICS = 8
PAPER_FIELDS = "id,pmid,title,abstract,authors,journal,pub_date,mesh_terms,keywords,paper_type,study_type,summary_review_required,integrity_status,fulltext_available,summary_basis,summary_ko,summary_source_hash,summary_model,summarized_at"


def sb(method, path, data=None, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        **supabase_headers(SUPABASE_KEY),
        "Content-Type": "application/json",
    }
    if method == "GET":
        return get_json(url, headers=headers, params=params or data)
    elif method == "POST":
        headers["Prefer"] = "return=minimal"
        response = requests.post(url, headers=headers, json=data, timeout=30)
        response.raise_for_status()
        return response
    elif method == "DELETE":
        response = requests.delete(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        return response
    return None


def sb_patch(table, row_id, data):
    """Update a row by id."""
    url = f"{SUPABASE_URL}/rest/v1/{table}?id=eq.{row_id}"
    headers = {
        **supabase_headers(SUPABASE_KEY),
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    response = requests.patch(url, headers=headers, json=data, timeout=30)
    response.raise_for_status()
    return response


def get_all_profiles():
    return paginate(lambda path, params: sb("GET", path, params), "profiles", {
        "select": "id,keywords,preferred_journals,preferred_study_types,personalization_enabled",
        "onboarding_done": "eq.true", "name": "neq.[DELETED]", "order": "id"})


def get_catalog_papers():
    # Import time is not publication freshness. Backfilled bodies must become
    # candidates, while unready papers still supply existing feedback signals.
    papers = paginate(lambda path, params: sb("GET", path, params=params), "papers", {
        "select": PAPER_FIELDS,
        "order": "pub_date.desc,id",
        "fulltext_available": "eq.true",
        "pub_date": "gte."+AUTOMATIC_START_DATE,
    })
    known={p["id"] for p in papers}
    signals=[]
    for table in ("feedbacks","read_history"):
        signals.extend(paginate(lambda path, params: sb("GET",path,params=params),table,{"select":"paper_id","order":"id"}))
    missing=sorted({p["paper_id"] for p in signals}-known)
    for start in range(0,len(missing),100):
        papers.extend(sb("GET","papers",params={"select":PAPER_FIELDS,"id":"in.("+",".join(map(str,missing[start:start+100]))+")"}))
    return papers


def has_fulltext_summary(paper):
    """Same delivery contract as the frontend summary reader; no abstract fallback."""
    return (paper.get("fulltext_available") is True
            and paper.get("summary_basis") == "fulltext"
            and all(isinstance(paper.get(field), str) and paper[field].strip()
                    for field in ("summary_source_hash", "summary_model", "summarized_at"))
            and isinstance(paper.get("summary_ko"), str)
            and len([line for line in paper["summary_ko"].splitlines() if line.strip()]) == 3)


def get_user_feedbacks(user_id):
    return paginate(lambda path, params: sb("GET", path, params), "feedbacks", {"select": "paper_id,action", "user_id": f"eq.{user_id}", "order": "id"})


def get_user_reads(user_id):
    return sb("GET", "read_history", {
        "select": "paper_id,dwell_seconds",
        "user_id": f"eq.{user_id}",
        "order": "clicked_at.desc",
        "limit": "200",
    })


def get_all_feedbacks_likes():
    """For collaborative filtering: all users' likes."""
    return paginate(lambda path, params: sb("GET", path, params), "feedbacks", {"select": "user_id,paper_id", "action": "eq.like", "order": "id"})


def text_match_score(paper, user_keywords):
    """BM25-like content matching: keyword overlap in title + abstract."""
    if not user_keywords:
        return 0.0, []
    title_lower = (paper.get("title") or "").lower()
    abstract_lower = (paper.get("abstract") or "").lower()
    paper_kws = set(normalized_term(k) for k in strings(paper.get("keywords")))
    paper_mesh = set(normalized_term(m) for m in strings(paper.get("mesh_terms")))
    all_paper_terms = paper_kws | paper_mesh

    score = 0.0
    matched = []
    seen_topics = set()
    for kw in user_keywords:
        kw_lower = normalized_term(kw)
        canonical = topic_id(kw)
        if not kw_lower or canonical in seen_topics:
            continue
        previous_score = score
        metadata_matches = sorted(term for term in all_paper_terms if topic_id(term) == canonical)
        if metadata_matches:
            score += 3.0  # exact keyword/mesh match
            matched.append(kw if kw_lower in all_paper_terms else metadata_matches[0])
        elif keyword_matches(title_lower, kw_lower):
            score += 2.5  # in title — strong signal
            matched.append(kw)
        elif keyword_matches(abstract_lower, kw_lower):
            # Count occurrences — single mention is weak
            count = keyword_count(abstract_lower, kw_lower)
            if count >= 3:
                score += 1.5  # mentioned multiple times — relevant
            else:
                score += 0.3  # mentioned once or twice — weak, probably tangential
            matched.append(kw)

        if score > previous_score:
            seen_topics.add(canonical)

    # Normalize to 0-1 range (cap at 10)
    return min(1.0, score / 10.0), matched


def behavioral_score(paper, liked_papers, disliked_kws, dwell_papers):
    """Score based on user's past behavior."""
    score = 0.0
    reasons = []
    paper_authors = set(paper.get("authors") or [])
    paper_terms = paper_topics(paper)

    # Liked keyword overlap
    liked_matches = set()
    for lp in liked_papers:
        liked_matches.update(paper_terms & paper_topics(lp))

    if liked_matches:
        score += min(1.0, len(liked_matches) * 0.15)
        reasons.append({"type": "learned", "label": "Based on your likes", "topics": sorted(liked_matches)[:3]})

    # Liked author overlap
    liked_authors = set()
    for lp in liked_papers:
        liked_authors.update(lp.get("authors") or [])
    author_overlap = paper_authors & liked_authors
    if author_overlap:
        score += min(0.5, len(author_overlap) * 0.2)
        reasons.append({"type": "author", "label": ", ".join(sorted(author_overlap)[:2])})

    # Dislike penalty
    for dk in disliked_kws:
        if dk.strip() and (topic_id(dk) in paper_terms or keyword_matches(paper.get("abstract"), dk)):
            score -= 0.4

    # Dwell-based signals
    dwell_terms = set()
    for dp in dwell_papers:
        dwell_terms.update(paper_topics(dp))
    dwell_overlap = paper_terms & dwell_terms
    if dwell_overlap:
        score += min(0.3, len(dwell_overlap) * 0.05)
        reasons.append({"type": "reading_pattern", "label": "Based on your reading"})

    # Journal preference (from reading history)
    dwell_journals = Counter(dp.get("journal","").lower() for dp in dwell_papers if dp.get("journal"))
    if paper.get("journal","").lower() in dwell_journals:
        score += 0.15
        reasons.append({"type": "journal", "label": paper["journal"]})

    return max(0, min(1.0, score)), reasons


def likes_by_user(all_likes, eligible_user_ids=None):
    """Internal-only index; duplicate rows never count as independent support."""
    indexed = {}
    for like in all_likes:
        uid, pid = like.get("user_id"), like.get("paper_id")
        if uid is None or pid is None or (eligible_user_ids is not None and uid not in eligible_user_ids):
            continue
        indexed.setdefault(uid, set()).add(pid)
    return indexed


def build_collaborative_context(user_id, indexed_likes, papers=(), enabled=True):
    """Build once per reader from opted-in likes, never notes or research projects.

    Thresholds are conservative product rules, not estimates of statistical
    confidence. Similarity weights ranking only; no probability is published.
    """
    network = {
        "status": "insufficient" if enabled else "disabled",
        "min_similar_readers": MIN_SIMILAR_READERS,
        "min_shared_likes": MIN_SHARED_LIKES,
        "min_paper_support": MIN_PAPER_SUPPORT,
        "min_topic_papers": MIN_TOPIC_PAPERS,
        "topics": [],
    }
    context = {"network": network, "paper_signals": {}}
    my_likes = indexed_likes.get(user_id, set())
    if not enabled or len(my_likes) < MIN_SHARED_LIKES:
        return context
    similar = []
    for uid, their_likes in indexed_likes.items():
        if uid == user_id:
            continue
        shared = len(my_likes & their_likes)
        similarity = shared / len(my_likes | their_likes)
        if shared >= MIN_SHARED_LIKES and similarity >= MIN_SIMILARITY:
            similar.append((uid, similarity, their_likes))
    similar.sort(key=lambda row: (-row[1], str(row[0])))
    similar = similar[:MAX_SIMILAR_READERS]
    if len(similar) < MIN_SIMILAR_READERS:
        return context

    network.update(status="qualified", cohort_size=len(similar))
    by_id = {p["id"]: p for p in papers
             if automatic_paper(p) and p.get("integrity_status") != "retracted"
             and not p.get("summary_review_required")}
    supporters, weighted_support = {}, Counter()
    topic_readers, topic_papers = {}, {}
    total_weight = sum(similarity for _, similarity, _ in similar)
    for uid, similarity, their_likes in similar:
        for pid in their_likes - my_likes:
            supporters.setdefault(pid, set()).add(uid)
            weighted_support[pid] += similarity
            for topic in paper_topics(by_id.get(pid, {})):
                topic_readers.setdefault(topic, set()).add(uid)
                topic_papers.setdefault(topic, set()).add(pid)
    for pid, readers in supporters.items():
        support = len(readers)
        if support >= MIN_PAPER_SUPPORT:
            # Shrink at the minimum support; the maximum CF contribution is 10%.
            score = weighted_support[pid] / total_weight * min(1.0, support / (2 * MIN_PAPER_SUPPORT))
            context["paper_signals"][pid] = {
                "score": score, "support": support, "cohort_size": len(similar),
            }
    topics = [{"id": topic, "label": topic, "reader_support": len(readers),
               "paper_support": len(topic_papers[topic]), "source": "metadata"}
              for topic, readers in topic_readers.items()
              if len(readers) >= MIN_SIMILAR_READERS and len(topic_papers[topic]) >= MIN_TOPIC_PAPERS]
    topics.sort(key=lambda topic: (-topic["reader_support"], -topic["paper_support"], topic["id"]))
    network["topics"] = topics[:MAX_NETWORK_TOPICS]
    return context


def collaborative_score(paper_id, user_id, all_likes):
    """Compatibility helper; callers must pass only opted-in users' likes."""
    context = build_collaborative_context(user_id, likes_by_user(all_likes))
    return context["paper_signals"].get(paper_id, {}).get("score", 0.0)


def temporal_score(pub_date_str):
    """Exponential decay: half-life 365 days, bonus for last 7 days."""
    if not pub_date_str:
        return 0.5
    try:
        pub_date = datetime.strptime(str(pub_date_str)[:10], "%Y-%m-%d")
        days_old = (datetime.now() - pub_date).days
        base = math.pow(2, -days_old / 365)
        # Bonus for very recent
        if days_old <= 7:
            base *= 1.5
        return min(1.0, base)
    except (ValueError, TypeError):
        return 0.5


def authority_boost(paper):
    """Boost for review papers and known journals."""
    boost = 1.0
    if paper.get("paper_type") == "review":
        boost *= 1.3
    return boost


def score_paper(paper, profile, liked_papers, disliked_kws, dwell_papers, all_likes, collaborative=None):
    """Compute final hybrid score for a paper."""
    personalized = profile.get("personalization_enabled", True) is True
    content, matched_terms = text_match_score(paper, profile.get("keywords") or [])
    behav, behav_reasons = behavioral_score(paper, liked_papers, disliked_kws, dwell_papers) if personalized else (0.0, [])
    if collaborative is None or not personalized:
        collaborative = build_collaborative_context(profile["id"], likes_by_user(all_likes), enabled=personalized)
    temporal = temporal_score(paper.get("pub_date"))
    boost = authority_boost(paper)

    # Keyword match reasons
    reasons = []
    for term in matched_terms[:3]:
        reasons.append({"type": "keyword", "label": term})
    reasons.extend(behav_reasons)
    if temporal > 0.9:
        reasons.append({"type": "fresh", "label": "Recent publication"})
    if paper.get("paper_type") == "review":
        reasons.append({"type": "review", "label": "Review / Meta-analysis"})

    # Preferred journal — fuzzy match (case-insensitive, partial)
    paper_journal = paper.get("journal", "").lower()
    for pj in (profile.get("preferred_journals") or []):
        pj_lower = pj.lower()
        if pj_lower and paper_journal and (pj_lower in paper_journal or paper_journal in pj_lower):
            content += 0.3
            reasons.append({"type": "journal", "label": paper["journal"]})
            break

    # Preferred study type boost
    pref_types = profile.get("preferred_study_types") or []
    paper_study_type = paper.get("study_type", "other")
    study_type_boost = 1.0
    if pref_types and paper_study_type in pref_types:
        study_type_boost = 1.25
        reasons.append({"type": "keyword", "label": paper_study_type.replace("_", " ").title()})

    for alert in profile.get("alerts", []):
        kind, value = alert.get("alert_type"), (alert.get("value") or "").strip().lower()
        haystack = {"journal": paper.get("journal") or "", "author": " ".join(paper.get("authors") or []),
                    "keyword": f"{paper.get('title') or ''} {paper.get('abstract') or ''}"}.get(kind, "")
        matches = (keyword_matches(paper.get("title"), value) or keyword_matches(paper.get("abstract"), value)) if kind == "keyword" else value in haystack.lower()
        if value and matches:
            content += 0.5
            reasons.insert(0, {"type": "alert", "alert_type": kind, "label": f"Alert: {alert['value']}"})
            break

    signal = collaborative["paper_signals"].get(paper["id"], {})
    # Collaborative activity supplements an actual personal content/behavior match.
    collab = signal.get("score", 0.0) if personalized and (content > 0 or behav > 0) else 0.0
    if collab:
        reasons.insert(0, {"type": "similar_readers",
                           "label": f"비슷한 독자 {signal['support']}명이 좋아한 문헌",
                           "support": signal["support"], "cohort_size": signal["cohort_size"]})

    final = (
        W_CONTENT * min(1.0, content) +
        W_BEHAVIORAL * behav +
        W_COLLABORATIVE * collab +
        W_TEMPORAL * temporal
    ) * boost * study_type_boost

    return round(final * 15, 2), {
        "reasons": reasons[:5],
        "matched_terms": matched_terms[:10],
        "personalization_enabled": personalized,
        "network": collaborative["network"],
    }


def diverse_picks(scored, limit=5):
    """A modest redundancy penalty keeps relevance and the five-year tier first."""
    remaining = list(scored)
    selected, journals, topics = [], Counter(), Counter()
    while remaining and len(selected) < limit:
        def rank(item):
            paper, score, _ = item
            journal = normalized_term(paper.get("journal"))
            paper_terms = paper_topics(paper)
            redundancy = max((topics[term] for term in paper_terms), default=0)
            adjusted = score * (0.9 ** journals[journal] if journal else 1.0) * 0.9 ** redundancy
            return recent_paper(paper), adjusted, score, paper["id"]
        choice = max(remaining, key=rank)
        remaining.remove(choice)
        selected.append(choice)
        journal = normalized_term(choice[0].get("journal"))
        if journal:
            journals[journal] += 1
        topics.update(paper_topics(choice[0]))
    return selected


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required")

    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    print(f"=== Generating recommendations for {today} ===")

    profiles = get_all_profiles()
    papers = get_catalog_papers()
    for paper in papers:
        for field in ("authors", "keywords", "mesh_terms"):
            paper[field] = strings(paper.get(field))
    all_likes = get_all_feedbacks_likes()
    eligible_users = {profile["id"] for profile in profiles if profile.get("personalization_enabled", True) is True}
    indexed_likes = likes_by_user(all_likes, eligible_users)
    alerts = paginate(lambda path, params: sb("GET", path, params), "alerts", {"select": "user_id,alert_type,value", "is_active": "eq.true", "order": "id"})

    print(f"Users: {len(profiles)}, Papers pool: {len(papers)}, Total likes: {len(all_likes)}")
    print(f"Full-text summary candidates: {sum(has_fulltext_summary(p) for p in papers)}")

    for profile in profiles:
        uid = profile["id"]
        personalized = profile.get("personalization_enabled", True) is True
        profile["alerts"] = [a for a in alerts if a["user_id"] == uid]
        feedbacks = get_user_feedbacks(uid)
        reads = get_user_reads(uid)

        fb_map = {f["paper_id"]: f["action"] for f in feedbacks}
        seen_ids = set(fb_map.keys())
        if personalized:
            seen_ids.update(r["paper_id"] for r in reads)

        # Liked papers (full data for behavioral scoring)
        liked_ids = [pid for pid, action in fb_map.items() if action == "like"]
        liked_papers = [p for p in papers if p["id"] in liked_ids]

        # Disliked keywords
        disliked_ids = [pid for pid, action in fb_map.items() if action == "dislike"]
        disliked_papers = [p for p in papers if p["id"] in disliked_ids]
        disliked_kws = set()
        for dp in disliked_papers:
            disliked_kws.update(k for k in (dp.get("keywords") or []))

        # Dwell papers (30s+)
        dwell_ids = set(r["paper_id"] for r in reads if r.get("dwell_seconds", 0) >= 30)
        dwell_papers = [p for p in papers if p["id"] in dwell_ids]
        collaborative = build_collaborative_context(uid, indexed_likes, papers, enabled=personalized)

        # Score unseen papers (skip letters/comments/erratum)
        skip_types = {"letter", "comment", "erratum", "editorial"}
        scored = []
        for paper in papers:
            if paper.get("integrity_status")=="retracted" or paper.get("summary_review_required") or not automatic_paper(paper) or not has_fulltext_summary(paper):
                continue
            if paper["id"] in seen_ids:
                continue
            if paper.get("paper_type", "").lower() in skip_types:
                continue
            # Skip by title pattern
            t = paper.get("title", "").lower()
            if any(s in t for s in ["reply to", "letter to the editor", "research letter", "letter:", "re:", "comment on", "erratum", "corrigendum", "retraction", "editorial", "correspondence"]):
                continue
            score, reasons = score_paper(paper, profile, liked_papers, disliked_kws, dwell_papers, [], collaborative)
            if score > 0:
                scored.append((paper, score, reasons))

        top5 = diverse_picks(scored)

        recs = [{"paper_id": p["id"], "score": score, "reasons": reasons} for p, score, reasons in top5]
        sb("POST", "rpc/replace_daily_recommendations", {"p_user_id": uid, "p_date": today, "p_recs": recs})

        print(f"  Generated {len(top5)} recommendations")

    print("Done.")


if __name__ == "__main__":
    main()
