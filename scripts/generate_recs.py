"""
Uro Daily Pick - Recommendation Generator
Scores papers for each user and saves Top-10 daily recommendations.
Run daily via GitHub Actions after fetch_papers.py.
"""
import os
import json
import math
from datetime import datetime, timedelta, timezone
from collections import Counter

import requests

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
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if method == "GET":
        return requests.get(url, headers=headers, params=params or data, timeout=30).json()
    elif method == "POST":
        headers["Prefer"] = "return=minimal"
        return requests.post(url, headers=headers, json=data, timeout=30)
    elif method == "DELETE":
        return requests.delete(url, headers=headers, params=params, timeout=30)
    return None


def sb_patch(table, row_id, data):
    """Update a row by id."""
    url = f"{SUPABASE_URL}/rest/v1/{table}?id=eq.{row_id}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    return requests.patch(url, headers=headers, json=data, timeout=30)


def get_all_profiles():
    return sb("GET", "profiles", {"select": "*"})


def get_recent_papers(days=30):
    cutoff = (datetime.now(timezone(timedelta(hours=9))) - timedelta(days=days)).strftime("%Y-%m-%d")
    return sb("GET", "papers", {
        "select": "id,pmid,title,abstract,authors,journal,pub_date,mesh_terms,keywords,paper_type,study_type",
        "fetched_at": f"gte.{cutoff}",
        "order": "pub_date.desc",
        "limit": "500",
    })


def get_user_feedbacks(user_id):
    return sb("GET", "feedbacks", {"select": "paper_id,action", "user_id": f"eq.{user_id}"})


def get_user_reads(user_id):
    return sb("GET", "read_history", {
        "select": "paper_id,dwell_seconds",
        "user_id": f"eq.{user_id}",
        "order": "clicked_at.desc",
        "limit": "200",
    })


def get_all_feedbacks_likes():
    """For collaborative filtering: all users' likes."""
    return sb("GET", "feedbacks", {"select": "user_id,paper_id", "action": "eq.like"})


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
        kw_lower = kw.lower()
        if kw_lower in all_paper_terms:
            score += 3.0  # exact keyword/mesh match
            matched.append(kw)
        elif kw_lower in title_lower:
            score += 2.5  # in title — strong signal
            matched.append(kw)
        elif kw_lower in abstract_lower:
            # Count occurrences — single mention is weak
            count = abstract_lower.count(kw_lower)
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
        if dk.lower() in paper_terms or dk.lower() in (paper.get("abstract") or "").lower():
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
        if pj_lower in paper_journal or paper_journal in pj_lower:
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
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY not set")
        return

    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    print(f"=== Generating recommendations for {today} ===")

    profiles = get_all_profiles()
    papers = get_recent_papers(days=30)
    all_likes = get_all_feedbacks_likes()

    print(f"Users: {len(profiles)}, Papers pool: {len(papers)}, Total likes: {len(all_likes)}")

    for profile in profiles:
        uid = profile["id"]
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
            if paper["id"] in seen_ids:
                continue
            if paper.get("paper_type", "").lower() in skip_types:
                continue
            # Skip by title pattern
            t = paper.get("title", "").lower()
            if any(s in t for s in ["reply to", "letter to the editor", "research letter", "letter:", "re:", "comment on", "erratum", "corrigendum", "retraction", "editorial", "correspondence"]):
                continue
            # Skip short papers without abstract (likely editorials/comments)
            if not paper.get("abstract") or len(paper.get("abstract", "")) < 100:
                continue
            score, reasons = score_paper(paper, profile, liked_papers, disliked_kws, dwell_papers, all_likes)
            if score > 0:
                scored.append((paper, score, reasons))

        scored.sort(key=lambda x: x[1], reverse=True)
        top5 = scored[:5]

        # Delete old recs for today
        sb("DELETE", "recommendations", params={
            "user_id": f"eq.{uid}",
            "rec_date": f"eq.{today}",
        })

        # Insert new recs
        if top5:
            recs = [{
                "user_id": uid,
                "paper_id": p["id"],
                "score": s,
                "reasons": json.dumps(r, ensure_ascii=False) if isinstance(r, dict) else r,
                "rec_date": today,
            } for p, s, r in top5]
            sb("POST", "recommendations", recs)

        name = profile.get("name", uid)
        print(f"  [{name}] {len(top5)} recs")

    print("Done.")


if __name__ == "__main__":
    main()
