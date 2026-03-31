"""
Uro Daily Pick - Daily Email Digest
Sends personalized paper recommendations via Resend.
Schedule: 21:30 UTC (= 06:30 KST)
"""
import os
import json
from datetime import datetime

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vwdcqzcoovczmtzdyzbc.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL = os.environ.get("FROM_EMAIL", "Uro Daily Pick <noreply@uro-daily-pick.com>")


def sb_get(path, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    return requests.get(url, headers=headers, params=params, timeout=30).json()


def get_digest_users():
    """Users with email_digest enabled."""
    return sb_get("profiles", {"select": "id,name,email_digest,digest_frequency", "email_digest": "eq.true"})


def get_user_email(uid):
    """Get email from Supabase Auth."""
    url = f"{SUPABASE_URL}/auth/v1/admin/users/{uid}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    r = requests.get(url, headers=headers, timeout=15)
    if r.status_code == 200:
        return r.json().get("email")
    return None


def get_today_recs(uid):
    today = datetime.now().strftime("%Y-%m-%d")
    recs = sb_get("recommendations", {
        "select": "score,reasons,paper:papers(title,journal,pub_date,pmid,authors)",
        "user_id": f"eq.{uid}",
        "rec_date": f"eq.{today}",
        "order": "score.desc",
        "limit": "5",
    })
    return recs or []


def build_html(name, recs):
    today_str = datetime.now().strftime("%B %d, %Y")

    rows = ""
    for i, rec in enumerate(recs, 1):
        paper = rec.get("paper", {})
        title = paper.get("title", "Untitled")
        journal = paper.get("journal", "")
        pub_date = paper.get("pub_date", "")
        pmid = paper.get("pmid", "")
        authors = (paper.get("authors") or [])[:3]
        author_str = ", ".join(authors)
        if len(paper.get("authors") or []) > 3:
            author_str += " et al."
        score = rec.get("score", 0)

        # Parse reasons
        reasons_raw = rec.get("reasons", "{}")
        if isinstance(reasons_raw, str):
            try:
                reasons_data = json.loads(reasons_raw)
            except json.JSONDecodeError:
                reasons_data = {}
        else:
            reasons_data = reasons_raw
        reason_labels = [r.get("label", "") for r in reasons_data.get("reasons", [])[:3]]
        reason_str = " | ".join(reason_labels) if reason_labels else ""

        rows += f"""
        <tr>
          <td style="padding:20px 0;border-bottom:1px solid #E5E5EA;">
            <div style="color:#007AFF;font-size:13px;font-weight:600;margin-bottom:6px;">
              {journal} &middot; {pub_date}
            </div>
            <a href="https://pubmed.ncbi.nlm.nih.gov/{pmid}/" target="_blank"
               style="color:#1D1D1F;font-size:17px;font-weight:700;text-decoration:none;line-height:1.4;">
              {title}
            </a>
            <div style="color:#86868B;font-size:14px;margin-top:6px;">{author_str}</div>
            {"<div style='color:#007AFF;font-size:13px;margin-top:8px;'>" + reason_str + "</div>" if reason_str else ""}
          </td>
        </tr>"""

    return f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="text-align:center;margin-bottom:32px;">
          <div style="font-size:24px;font-weight:700;color:#1D1D1F;">Uro Daily Pick</div>
          <div style="font-size:14px;color:#86868B;margin-top:4px;">{today_str}</div>
        </div>
        <div style="background:#FFFFFF;border-radius:16px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
          <div style="font-size:15px;color:#48494B;margin-bottom:20px;">
            Hi {name or "there"}, here are your top picks for today:
          </div>
          <table style="width:100%;border-collapse:collapse;">
            {rows}
          </table>
          <div style="text-align:center;margin-top:28px;">
            <a href="https://jungyo.github.io/uro-daily-pick/"
               style="display:inline-block;background:#007AFF;color:#FFFFFF;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">
              View All Picks
            </a>
          </div>
        </div>
        <div style="text-align:center;margin-top:24px;font-size:12px;color:#86868B;">
          You received this because you enabled email digests.
        </div>
      </div>
    </body>
    </html>"""


def send_email(to_email, subject, html):
    if not RESEND_API_KEY:
        print(f"  [DRY RUN] Would send to {to_email}: {subject}")
        return True

    r = requests.post("https://api.resend.com/emails", headers={
        "Authorization": f"Bearer {RESEND_API_KEY}",
        "Content-Type": "application/json",
    }, json={
        "from": FROM_EMAIL,
        "to": [to_email],
        "subject": subject,
        "html": html,
    }, timeout=15)

    if r.status_code == 200:
        return True
    else:
        print(f"  Resend error: {r.status_code} {r.text[:200]}")
        return False


def main():
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY not set")
        return

    today_str = datetime.now().strftime("%B %d")
    print(f"=== Sending digests for {today_str} ===")

    users = get_digest_users()
    print(f"Digest users: {len(users)}")

    sent = 0
    for user in users:
        uid = user["id"]
        name = user.get("name", "")
        email = get_user_email(uid)
        if not email:
            print(f"  [{name}] No email found, skipping")
            continue

        recs = get_today_recs(uid)
        if not recs:
            print(f"  [{name}] No recommendations, skipping")
            continue

        html = build_html(name, recs)
        subject = f"Your Uro Daily Pick - {today_str}"

        if send_email(email, subject, html):
            sent += 1
            print(f"  [{name}] Sent to {email} ({len(recs)} papers)")
        else:
            print(f"  [{name}] Failed to send")

    print(f"Done. Sent {sent}/{len(users)} emails.")


if __name__ == "__main__":
    main()
