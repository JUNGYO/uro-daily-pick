# Uro Daily Pick — Development Progress

## Project Overview
- **Service**: Personalized urology paper recommendation for urologist professors
- **URL**: https://jungyo.github.io/uro-daily-pick/
- **Repo**: https://github.com/JUNGYO/uro-daily-pick
- **Started**: 2026-03-31
- **Last Updated**: 2026-04-03

---

## Architecture

```
GitHub Pages (free)           <- React static build
       |
Supabase (free tier)
  |- Auth                     <- Kakao + Email login
  |- PostgreSQL               <- All data
  |- RLS                      <- Row-level security
       |
GitHub Actions (free)
  |- daily-fetch.yml          <- 06:00 KST: PubMed collection
  |- daily-recommend.yml      <- 06:15 KST: classify + summarize + recommend
  |- daily-email.yml          <- 06:30 KST: email digest
  |- manual-run.yml           <- Manual trigger with task selector
```

## Tech Stack
- **Frontend**: React 18 + Vite + Tailwind CSS + D3.js
- **Backend**: Supabase (PostgreSQL + Auth + RLS + Edge Functions)
- **AI**: Gemini 2.5 Pro (Korean paper summaries, ~$3/month)
- **Email**: Resend (free tier, 3000/month)
- **Auth**: Supabase Auth (Kakao OAuth + Email/Password)
- **CI/CD**: GitHub Actions (cron + deploy)
- **Hosting**: GitHub Pages (free)

## Monthly Cost
| Item | Cost |
|------|------|
| Gemini 2.5 Pro (summaries) | ~$3 |
| Everything else | $0 |
| **Total** | **~$3/month** |

---

## Features Implemented

### Core
- [x] Daily personalized recommendations (5 papers/day)
- [x] 30 major urology + oncology + top-tier journal collection
- [x] Korean AI summaries (Gemini 2.5 Pro, 3-sentence)
- [x] Like/Skip feedback -> recommendation learning
- [x] DOI direct link (Full Text button)
- [x] Study type classification (MeSH + PubType + text patterns)
- [x] Study type badges in UI (RCT, Basic Research, Biomarker, etc.)

### Personalization (5-factor hybrid scoring)
- [x] Content matching (keyword in title > abstract, occurrence count)
- [x] Behavioral learning (liked paper authors/keywords/journals)
- [x] Collaborative filtering (similar users' likes, activates at 50+ users)
- [x] Temporal decay (exponential, 365-day half-life, 7-day bonus)
- [x] Study type preference boost (1.25x)
- [x] Preferred journal fuzzy matching
- [x] Dwell time tracking (idle detection, 30s pause, 5min cap)
- [x] Editorial/letter/erratum filtering
- [x] Abstract occurrence scoring (title > 3+ mentions > 1-2 mentions)

### User Management
- [x] Email signup/login
- [x] Kakao OAuth login
- [x] Password reset via email
- [x] Password change (email users)
- [x] Account deletion
- [x] Kakao account linking (Connect Kakao in Settings)
- [x] Onboarding (keyword input + suggested tags)

### Daily Digest
- [x] Email digest via Resend (06:30 KST daily)
- [x] KakaoTalk digest (implemented but disabled — pending channel verification)
- [x] Digest channel selection (Email / KakaoTalk / both / off)
- [x] All dates use KST (UTC+9)

### UI/UX
- [x] Apple HIG-inspired light theme (#F5F5F7 bg, #007AFF accent)
- [x] List + Detail layout (email app style)
- [x] Mobile responsive (list-only on mobile, tap for full detail)
- [x] Korean summary in mobile list (no click needed)
- [x] Past recommendations navigation (date picker: <- Today ->)
- [x] Share button (Web Share API / clipboard)
- [x] Copy citation button (AMA format)
- [x] CIPHER Lab logo (SVG hexagon)
- [x] Favicon
- [x] Landing page for non-logged-in users
- [x] 404.html for SPA routing on GitHub Pages
- [x] Auth loading timeout (5s fallback)
- [x] Keyboard shortcuts (J/K navigate, L like, D skip)

### Insights Page
- [x] Activity Rings (Read / Liked / Streak) — Apple Health style
- [x] Personalized insight text ("Your reading is centered on X and Y")
- [x] Reading Activity heatmap (GitHub 잔디 style, 26 weeks)
  - Day labels (Mon, Wed, Fri)
  - Month labels (Oct, Nov, Dec...)
  - Hover for details
- [x] Research Topics treemap (CSS flex colored blocks)
- [x] Study Type distribution (bar chart)

### Collections
- [x] "Liked Papers" auto-collection (like = save)
- [x] View saved papers

### Settings
- [x] Research Keywords (tag input)
- [x] Preferred Journals (tag input)
- [x] Preferred Study Types (toggle buttons)
- [x] Digest channel preference (Email / KakaoTalk)
- [x] Kakao Connect/Disconnect
- [x] Account management (email, password, delete)

### Automation (GitHub Actions)
- [x] Daily PubMed fetch (06:00 KST) — 30 journals
- [x] Daily classify + summarize + recommend (06:15 KST)
- [x] Daily email digest (06:30 KST)
- [x] Manual run workflow (fetch / summarize / recommend / digest / all)

---

## Data

### Paper Collection (30 Journals)

**Urology (16)**: European Urology, Journal of Urology, BJU International, Urology, World Journal of Urology, Nature Reviews Urology, EU Focus, EU Oncology, Prostate Cancer Prostatic Diseases, Neurourology Urodynamics, Journal of Endourology, International Journal of Urology, Urologic Oncology, The Prostate, Scandinavian Journal of Urology, Asian Journal of Urology

**Oncology (8, urology-filtered)**: JCO, Lancet Oncology, JAMA Oncology, Annals of Oncology, Clinical Cancer Research, Cancer Research, Cancer, European Journal of Cancer

**General (6, urology-filtered)**: NEJM, Lancet, JAMA, BMJ, Nature Medicine, JAMA Network Open

### Database (Supabase PostgreSQL)
- `papers` — PubMed papers with search_vector (tsvector), study_type, summary_ko
- `profiles` — User profiles with keywords, journals, study types, digest prefs
- `feedbacks` — Like/dislike/save per user-paper
- `read_history` — Dwell time tracking
- `recommendations` — Daily Top-5 cache per user
- `collections` + `collection_papers` — Paper folders
- `alerts` — Keyword/author/journal alerts

### Credentials
- **Supabase URL**: https://vwdcqzcoovczmtzdyzbc.supabase.co
- **Kakao App ID**: 1421003
- **GitHub Secrets**: SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY, RESEND_API_KEY, KAKAO_REST_KEY, KAKAO_CLIENT_SECRET

---

## Known Issues
- Browser cache/session can cause loading freeze (5s timeout fallback)
- KakaoTalk message links go to root domain (need channel business verification)
- KakaoTalk digest disabled pending Kakao channel verification
- `mesh_terms` stored as JSON string in some papers (handled with try/parse)

## Next Steps
1. **Recommendation quality** — Beyond keyword matching, understand research context
2. **Network effects** — Activate collaborative filtering when 50+ users
3. **Abstract structuring** — Parse into Background/Methods/Results/Conclusion
4. **Paper notes** — User annotations on liked papers
5. **Kakao channel** — Complete business verification for channel messages
6. **User acquisition** — Share with Korean urology professors

---

## Commit History Highlights
| Date | Key Changes |
|------|-------------|
| Mar 31 | Initial project: Supabase + GitHub Pages + FastAPI prototype |
| Mar 31 | Apple HIG redesign, list+detail layout |
| Mar 31 | Study type classification, onboarding flow |
| Mar 31 | User management (password reset, account delete) |
| Apr 01 | Journal-based collection (30 major journals) |
| Apr 01 | Korean AI summaries (Gemini 2.5 Pro) |
| Apr 01 | Top 5 recs, landing page, favicon |
| Apr 01 | Mobile responsive, study type badges |
| Apr 02 | Kakao OAuth login |
| Apr 02 | Email + KakaoTalk digest |
| Apr 02 | Instant recommendations on first visit |
| Apr 02 | Dwell time tracking with idle detection |
| Apr 02 | KST timezone fix for all scripts |
| Apr 03 | Insights page (rings, heatmap, treemap) |
| Apr 03 | Share + copy citation buttons |
| Apr 03 | Past recommendations date navigation |
| Apr 03 | Code review cleanup (security, build fixes) |
