# Original article viewer

The application can display extracted article text stored on Z8. Supabase keeps
summaries and necessary metadata only. The viewer never sends originals to Supabase.

The deployment variable `FULLTEXT_ORIGIN` supplies one trusted HTTPS API origin to
the frontend. It must not contain a path, credentials, or a query string. The
browser sends its current Supabase access token in an Authorization header; tokens
are never placed in links. An email typed into a request does not confer access.

`scripts/fulltext_viewer.py` binds only to `127.0.0.1:18451`. It exposes a minimal
health response and `GET /v1/fulltext/{numeric_pmid}`. Each article request verifies
the session with Supabase Auth, and requires both the configured confirmed email
and immutable user ID. The service returns hash-verified plain text from the two
configured archive directories. It does not serve files by path or forward requests
to other services. Responses are not cached; publisher HTML is never executed.

Install outside synced directories with the existing Python 3.12 runtime. A local
`config.json` contains `state_dir`, `supabase_url`, `public_key` (publishable only),
`owner_email`, `owner_id`, `origin`, `port`, and `protected_paths`. Keep machine paths
and account IDs out of the public repository. `install_fulltext_viewer.ps1` creates
a separate non-administrator identity and a dedicated startup task. Archive access
is read-only. Explicit denies for the new identity protect private workspaces;
existing users' permissions are preserved. It does not update the collection or
Spark tasks. Inspect an existing viewer identity before rerunning an installation.

Only after local authorization tests and the installed identity checks pass should
an HTTPS proxy expose this loopback service. Tailscale Funnel is one supported
transport: readers need no Tailscale account or client. The endpoint is publicly
reachable, so application authorization is mandatory. No device sharing, subnet
routes, SSH, file-directory publication, or other service ports are needed.

Availability depends on Z8 and its internet connection. Offline, missing-document,
expired-login and denied-account states have separate UI messages. Reading on a
second device requires an ordinary application login. Figures and publisher page
layout remain available through the publisher link; the local viewer currently
shows extracted body text rather than claiming to reproduce a PDF.

Validation uses synthetic articles: `python -m unittest discover -s tests`, frontend
unit tests, and `tests/e2e/fulltext.spec.js` for mobile access, logout, retry and denial.
