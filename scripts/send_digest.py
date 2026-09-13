"""
Uro Daily Pick - Daily Email Digest
Sends personalized paper recommendations via Resend.
Runs after successful recommendations in the daily pipeline.
"""
import os
import json
from html import escape
from datetime import datetime, timezone, timedelta

import requests
from common import supabase_headers
from urllib.parse import quote
from common import get_json, paginate, strings, json_value

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL = os.environ.get("FROM_EMAIL", "")
APP_URL = (os.environ.get("APP_URL") or "https://jungyo.github.io/uro-daily-pick/").rstrip("/") + "/"
KST = timezone(timedelta(hours=9))


def sb_get(path, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {**supabase_headers(SUPABASE_KEY)}
    return get_json(url, headers=headers, params=params)


def get_digest_users(now=None):
    """Users with email digest enabled."""
    now = now or datetime.now(KST)
    users = paginate(sb_get, "profiles", {
        "select": "id,name,digest_frequency",
        "email_digest": "eq.true", "onboarding_done": "eq.true", "order": "id",
    })
    # Weekly digests are delivered on Monday, in Korea time.
    return [user for user in users if user.get("name") != "[DELETED]"
            and (user.get("digest_frequency", "daily") == "daily"
                 or now.astimezone(KST).weekday() == 0)]


def get_user_email(uid):
    """Get email from Supabase Auth."""
    url = f"{SUPABASE_URL}/auth/v1/admin/users/{uid}"
    headers = {**supabase_headers(SUPABASE_KEY)}
    user = get_json(url, headers=headers)
    return user.get("email") if user.get("email_confirmed_at") else None


def get_today_recs(uid, frequency="daily"):
    now = datetime.now(KST)
    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    recs = sb_get("recommendations", {
        "select": "score,reasons,paper:papers(title,journal,pub_date,pmid,authors)",
        "user_id": f"eq.{uid}",
        "rec_date": f"gte.{(now - timedelta(days=6)).date()}" if frequency == "weekly" else f"eq.{today}",
        "order": "score.desc",
        "limit": "35" if frequency == "weekly" else "5",
    })
    seen = set()
    unique = []
    for rec in recs or []:
        paper = rec.get("paper")
        if paper and paper.get("pmid") not in seen:
            seen.add(paper.get("pmid"))
            unique.append(rec)
    return unique[:5]


def build_html(name, recs):
    today_str = datetime.now(timezone(timedelta(hours=9))).strftime("%B %d, %Y")

    rows = ""
    for i, rec in enumerate(recs, 1):
        paper = rec.get("paper") or {}
        title = escape(paper.get("title") or "Untitled")
        journal = escape(paper.get("journal") or "")
        pub_date = escape(paper.get("pub_date") or "")
        pmid = quote(str(paper.get("pmid") or ""), safe="")
        authors = strings(paper.get("authors"))[:3]
        author_str = escape(", ".join(authors))
        if len(strings(paper.get("authors"))) > 3:
            author_str += " et al."
        score = rec.get("score", 0)

        reasons_data = json_value(rec.get("reasons"), {})
        reason_labels = [r["label"] for r in reasons_data.get("reasons", [])[:3]
                         if isinstance(r, dict) and isinstance(r.get("label"), str)] if isinstance(reasons_data.get("reasons", []), list) else []
        reason_str = escape(" | ".join(reason_labels))

        rows += f"""
        <tr>
          <td style="padding:20px 0;border-bottom:1px solid #E5E5EA;">
            <div style="color:#007AFF;font-size:13px;font-weight:600;margin-bottom:6px;">
              {journal} &middot; {pub_date}
            </div>
            <a href="https://pubmed.ncbi.nlm.nih.gov/{pmid}/" target="_blank"
               class="paper-title" style="color:#1D1D1F;font-size:16px;font-weight:700;text-decoration:none;line-height:1.4;display:block;">
              {title}
            </a>
            <div style="color:#86868B;font-size:14px;margin-top:6px;">{author_str}</div>
            {"<div style='color:#007AFF;font-size:13px;margin-top:8px;'>" + reason_str + "</div>" if reason_str else ""}
          </td>
        </tr>"""

    return f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        @media (max-width: 480px) {{
          .digest-body {{ padding: 20px 12px !important; }}
          .digest-card {{ padding: 20px !important; }}
          .paper-title {{ font-size: 15px !important; }}
        }}
      </style>
    </head>
    <body style="margin:0;padding:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div class="digest-body" style="max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="text-align:center;margin-bottom:32px;">
          <svg width="36" height="36" viewBox="0 0 80 80" fill="none" style="margin:0 auto 8px;">
            <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#1D1D1F" stroke-width="1.5"/>
            <line x1="40" y1="40" x2="40" y2="4.5" stroke="#007AFF" stroke-width="1.2"/>
            <line x1="40" y1="40" x2="8.5" y2="58.5" stroke="#007AFF" stroke-width="1.2"/>
            <line x1="40" y1="40" x2="71.5" y2="58.5" stroke="#007AFF" stroke-width="1.2"/>
            <circle cx="40" cy="40" r="5" fill="#1D1D1F"/>
            <circle cx="40" cy="4" r="4" fill="none" stroke="#007AFF" stroke-width="1.8"/>
            <circle cx="8" cy="58" r="4" fill="none" stroke="#007AFF" stroke-width="1.8"/>
            <circle cx="72" cy="58" r="4" fill="none" stroke="#007AFF" stroke-width="1.8"/>
          </svg>
          <div style="font-size:24px;font-weight:700;color:#1D1D1F;">Uro Daily Pick</div>
          <div style="font-size:14px;color:#86868B;margin-top:4px;">{today_str}</div>
        </div>
        <div class="digest-card" style="background:#FFFFFF;border-radius:16px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
          <div style="font-size:15px;color:#48494B;margin-bottom:20px;">
            Hi {escape(name or "there")}, here are your latest top picks:
          </div>
          <table style="width:100%;border-collapse:collapse;">
            {rows}
          </table>
          <div style="text-align:center;margin-top:28px;">
            <a href="{escape(APP_URL, quote=True)}"
               style="display:inline-block;background:#007AFF;color:#FFFFFF;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">
              View All Picks
            </a>
          </div>
        </div>
        <div style="text-align:center;margin-top:24px;font-size:12px;color:#86868B;">
          You received this because you enabled email digests.<br>
          <a href="{escape(APP_URL + 'settings', quote=True)}">Manage frequency or turn off email digests</a>
        </div>
      </div>
    </body>
    </html>"""


def delivery_write(method, data, params=None):
    response = getattr(requests, method)(f"{SUPABASE_URL}/rest/v1/email_deliveries",
        headers={**supabase_headers(SUPABASE_KEY),
                 "Prefer": "resolution=ignore-duplicates,return=representation"},
        json=data, params=params, timeout=30)
    response.raise_for_status()
    return response.json() if response.content else []


def prepare_delivery(user, email, subject, html, now=None):
    now = now or datetime.now(KST)
    frequency = user.get("digest_frequency") or "daily"
    identity = {"user_id": user["id"], "delivery_date": str(now.date()), "frequency": frequency}
    filters = {k: f"eq.{v}" for k, v in identity.items() if k != "frequency"}
    rows = sb_get("email_deliveries", {**filters, "select": "*"})
    if not rows:
        delivery_write("post", {**identity, "payload": {"from": FROM_EMAIL, "to": [email], "subject": subject, "html": html}})
        rows = sb_get("email_deliveries", {**filters, "select": "*"})
    row = rows[0]
    if row["status"] == "sent":
        return None
    created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
    if now - created > timedelta(hours=23):
        raise ValueError("Uncertain delivery exceeds retry window; reconcile in Resend before retrying")
    if row["payload"]["to"] != [email]:
        raise ValueError("Recipient changed while delivery pending; reconcile the earlier delivery")
    return row, filters, f"digest/{user['id']}/{now.date()}/{row['frequency']}"


def send_email(payload, idempotency_key):
    response = requests.post("https://api.resend.com/emails", headers={
        "Authorization": f"Bearer {RESEND_API_KEY}", "Idempotency-Key": idempotency_key},
        json=payload, timeout=30)
    response.raise_for_status()
    return response.json()["id"]


def main():
    if not SUPABASE_URL or not SUPABASE_KEY or not RESEND_API_KEY or not FROM_EMAIL:
        raise SystemExit("ERROR: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY and verified FROM_EMAIL required")
    today = datetime.now(KST)
    users = get_digest_users(today)
    sent, failed = 0, 0
    for user in users:
        try:
            email = get_user_email(user["id"])
            if not email:
                continue
            recs = get_today_recs(user["id"], user.get("digest_frequency", "daily"))
            if not recs:
                continue
            prepared = prepare_delivery(user, email, f"Your Uro Daily Pick - {today:%B %d}", build_html(user.get("name"), recs), today)
            if prepared is None:
                continue
            row, filters, key = prepared
            provider_id = send_email(row["payload"], key)
            delivery_write("patch", {"status": "sent", "provider_id": provider_id,
                           "sent_at": datetime.now(KST).isoformat()}, filters)
            sent += 1
        except (requests.RequestException, ValueError, KeyError, IndexError):
            failed += 1
            print("Delivery failed; inspect the private pending-delivery ledger")
    print(f"Digests: {sent} sent, {failed} failed, {len(users)} eligible users")
    if failed:
        raise SystemExit(f"ERROR: {failed} email deliveries failed")


if __name__ == "__main__":
    main()
