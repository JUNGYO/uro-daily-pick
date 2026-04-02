"""
Uro Daily Pick - KakaoTalk Daily Digest
Sends personalized paper recommendations via KakaoTalk "나에게 보내기" API.
For users who signed in with Kakao.
"""
import os
import json
from datetime import datetime

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vwdcqzcoovczmtzdyzbc.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
KAKAO_REST_KEY = os.environ.get("KAKAO_REST_KEY", "59877241d10a6e24fc473b71d168d869")
KAKAO_CLIENT_SECRET = os.environ.get("KAKAO_CLIENT_SECRET", "E8zudvrroHmLYH6k7Ilj4KdyOiGMYki6")


def sb_get(path, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    return requests.get(url, headers=headers, params=params, timeout=30).json()


def sb_patch(table, uid, data):
    url = f"{SUPABASE_URL}/rest/v1/{table}?id=eq.{uid}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
               "Content-Type": "application/json", "Prefer": "return=minimal"}
    return requests.patch(url, headers=headers, json=data, timeout=30)


def refresh_kakao_token(refresh_token):
    """Refresh Kakao access token using refresh token."""
    r = requests.post("https://kauth.kakao.com/oauth/token", data={
        "grant_type": "refresh_token",
        "client_id": KAKAO_REST_KEY,
        "client_secret": KAKAO_CLIENT_SECRET,
        "refresh_token": refresh_token,
    }, timeout=15)
    if r.status_code == 200:
        data = r.json()
        return data.get("access_token"), data.get("refresh_token", refresh_token)
    return None, None


def send_kakao_message(access_token, title, description, link_url):
    """Send KakaoTalk message to self (나에게 보내기)."""
    template = {
        "object_type": "feed",
        "content": {
            "title": title,
            "description": description,
            "image_url": "",
            "link": {"web_url": link_url, "mobile_web_url": link_url},
        },
        "buttons": [
            {"title": "View Papers", "link": {"web_url": link_url, "mobile_web_url": link_url}},
        ],
    }

    r = requests.post("https://kapi.kakao.com/v2/api/talk/memo/default/send",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/x-www-form-urlencoded"},
        data={"template_object": json.dumps(template, ensure_ascii=False)},
        timeout=15)

    return r.status_code == 200


def main():
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY required")
        return

    today = datetime.now().strftime("%Y-%m-%d")
    today_display = datetime.now().strftime("%B %d")
    print(f"=== Sending KakaoTalk digests for {today_display} ===")

    # Get Kakao users with tokens
    users = sb_get("profiles", {
        "select": "id,name,kakao_access_token,kakao_refresh_token,login_provider,email_digest",
        "login_provider": "eq.kakao",
        "kakao_refresh_token": "neq.",
    })

    print(f"Kakao users: {len(users)}")

    sent = 0
    for user in users:
        uid = user["id"]
        name = user.get("name", "")
        refresh_token = user.get("kakao_refresh_token", "")

        if not refresh_token:
            print(f"  [{name}] No refresh token, skipping")
            continue

        # Refresh access token
        access_token, new_refresh = refresh_kakao_token(refresh_token)
        if not access_token:
            print(f"  [{name}] Token refresh failed, skipping")
            continue

        # Update tokens in DB
        sb_patch("profiles", uid, {
            "kakao_access_token": access_token,
            "kakao_refresh_token": new_refresh,
        })

        # Get today's recommendations
        recs = sb_get("recommendations", {
            "select": "score,paper:papers(title,journal,pub_date,summary_ko,pmid)",
            "user_id": f"eq.{uid}",
            "rec_date": f"eq.{today}",
            "order": "score.desc",
            "limit": "5",
        })

        if not recs:
            print(f"  [{name}] No recommendations, skipping")
            continue

        # Build message
        lines = []
        for i, rec in enumerate(recs, 1):
            p = rec.get("paper", {})
            title = p.get("title", "")[:80]
            journal = p.get("journal", "")
            summary = p.get("summary_ko", "")
            if summary:
                lines.append(f"{i}. [{journal}] {title}\n{summary[:100]}")
            else:
                lines.append(f"{i}. [{journal}] {title}")

        msg_title = f"Uro Daily Pick - {today_display}"
        msg_desc = "\n\n".join(lines)
        link = "https://jungyo.github.io/uro-daily-pick/"

        if send_kakao_message(access_token, msg_title, msg_desc[:500], link):
            sent += 1
            print(f"  [{name}] KakaoTalk sent ({len(recs)} papers)")
        else:
            print(f"  [{name}] KakaoTalk send failed")

    print(f"Done. Sent {sent}/{len(users)} KakaoTalk messages.")


if __name__ == "__main__":
    main()
