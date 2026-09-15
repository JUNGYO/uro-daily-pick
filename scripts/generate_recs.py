"""
Uro Daily Pick - Recommendation Generator
Scores papers with full-text summaries and saves up to five daily recommendations.
Run daily via GitHub Actions after fetch_papers.py.
"""
import os
import json
import math
from datetime import datetime, timedelta, timezone
from collections import Counter

import requests
from common import supabase_headers
from common import get_json, paginate, strings
from keywords import keyword_matches, keyword_count
from catalog_policy import AUTOMATIC_START_DATE, automatic_paper, recent_paper

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Scoring weights
W_CONTENT = 0.30
W_BEHAVIORAL = 0.25
W_COLLABORATIVE = 0.25
W_TEMPORAL = 0.20


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
    return paginate(lambda path, params: sb("GET", path, params), "profiles", {"select": "*", "onboarding_done": "eq.true", "name": "neq.[DELETED]", "order": "id"})


def get_catalog_papers():
    # Import time is not publication freshness. Backfilled bodies must become
    # candidates, while unready papers still supply existing feedback signals.
    papers = paginate(lambda path, params: sb("GET", path, params=params), "papers", {
        "select": "id,pmid,title,abstract,authors,journal,pub_date,mesh_terms,keywords,paper_type,study_type,summary_review_required,integrity_status,fulltext_available,summary_basis,summary_ko,summary_source_hash,summary_model,summarized_at",
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
        papers.extend(sb("GET","papers",params={"select":"*","id":"in.("+",".join(map(str,missing[start:start+100]))+")"}))
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
    title_lower = paper.get("title", "").lower()
    abstract_lower = paper.get("abstract", "").lower()
    paper_kws = set(k.lower() for k in (paper.get("keywords") or []))
    paper_mesh = set(m.lower() for m in (paper.get("mesh_terms") or []))
    all_paper_terms = paper_kws | paper_mesh

    score = 0.0
    matched = []
    for kw in user_keywords:
        kw_lower = kw.strip().lower()
        if not kw_lower:
            continue
        if kw_lower in all_paper_terms:
            score += 3.0  # exact keyword/mesh match
            matched.append(kw)
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

    # Normalize to 0-1 range (cap at 10)
    return min(1.0, score / 10.0), matched


def behavioral_score(paper, liked_papers, disliked_kws, dwell_papers):
    """Score based on user's past behavior."""
    score = 0.0
    reasons = []
    paper_kws = set(k.lower() for k in (paper.get("keywords") or []))
    paper_mesh = set(m.lower() for m in (paper.get("mesh_terms") or []))
    paper_authors = set(paper.get("authors") or [])
    paper_terms = paper_kws | paper_mesh

    # Liked keyword overlap
    liked_kw_match = 0
    for lp in liked_papers:
        lp_terms = set(k.lower() for k in (lp.get("keywords") or []))
        lp_terms |= set(m.lower() for m in (lp.get("mesh_terms") or []))
        overlap = paper_terms & lp_terms
        liked_kw_match += len(overlap)

    if liked_kw_match:
        score += min(1.0, liked_kw_match * 0.15)
        reasons.append({"type": "learned", "label": "Based on your likes"})

    # Liked author overlap
    liked_authors = set()
    for lp in liked_papers:
        liked_authors.update(lp.get("authors") or [])
    author_overlap = paper_authors & liked_authors
    if author_overlap:
        score += min(0.5, len(author_overlap) * 0.2)
        reasons.append({"type": "author", "label": ", ".join(list(author_overlap)[:2])})

    # Dislike penalty
    for dk in disliked_kws:
        if dk.strip() and (dk.strip().lower() in paper_terms or keyword_matches(paper.get("abstract"), dk)):
            score -= 0.4

    # Dwell-based signals
    dwell_terms = set()
    for dp in dwell_papers:
        dwell_terms |= set(k.lower() for k in (dp.get("keywords") or []))
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


def collaborative_score(paper_id, user_id, all_likes):
    """Jaccard-based: papers liked by similar users."""
    # Find user's liked papers
    my_likes = set(l["paper_id"] for l in all_likes if l["user_id"] == user_id)
    if not my_likes:
        return 0.0

    # Find users who share likes
    other_users = {}
    for l in all_likes:
        if l["user_id"] != user_id and l["paper_id"] in my_likes:
            other_users.setdefault(l["user_id"], set()).add(l["paper_id"])

    if not other_users:
        return 0.0

    # Check if similar users liked this paper
    score = 0.0
    for uid, shared in other_users.items():
        their_likes = set(l["paper_id"] for l in all_likes if l["user_id"] == uid)
        if paper_id in their_likes:
            jaccard = len(shared) / (len(my_likes) + len(their_likes) - len(shared))
            score += jaccard

    return min(1.0, score)


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


def score_paper(paper, profile, liked_papers, disliked_kws, dwell_papers, all_likes):
    """Compute final hybrid score for a paper."""
    content, matched_terms = text_match_score(paper, profile.get("keywords") or [])
    behav, behav_reasons = behavioral_score(paper, liked_papers, disliked_kws, dwell_papers)
    collab = collaborative_score(paper["id"], profile["id"], all_likes)
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

    final = (
        W_CONTENT * content +
        W_BEHAVIORAL * behav +
        W_COLLABORATIVE * collab +
        W_TEMPORAL * temporal
    ) * boost * study_type_boost

    return round(final * 15, 2), {
        "reasons": reasons[:5],
        "matched_terms": matched_terms[:10],
    }


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
    alerts = paginate(lambda path, params: sb("GET", path, params), "alerts", {"select": "user_id,alert_type,value", "is_active": "eq.true", "order": "id"})

    print(f"Users: {len(profiles)}, Papers pool: {len(papers)}, Total likes: {len(all_likes)}")
    print(f"Full-text summary candidates: {sum(has_fulltext_summary(p) for p in papers)}")

    for profile in profiles:
        uid = profile["id"]
        profile["alerts"] = [a for a in alerts if a["user_id"] == uid]
        feedbacks = get_user_feedbacks(uid)
        reads = get_user_reads(uid)

        fb_map = {f["paper_id"]: f["action"] for f in feedbacks}
        seen_ids = set(fb_map.keys()) | set(r["paper_id"] for r in reads)

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
            score, reasons = score_paper(paper, profile, liked_papers, disliked_kws, dwell_papers, all_likes)
            if score > 0:
                scored.append((paper, score, reasons))

        scored.sort(key=lambda x: (recent_paper(x[0]), x[1], x[0]["id"]), reverse=True)
        top5 = scored[:5]

        recs = [{"paper_id": p["id"], "score": score, "reasons": reasons} for p, score, reasons in top5]
        sb("POST", "rpc/replace_daily_recommendations", {"p_user_id": uid, "p_date": today, "p_recs": recs})

        print(f"  Generated {len(top5)} recommendations")

    print("Done.")


if __name__ == "__main__":
    main()
