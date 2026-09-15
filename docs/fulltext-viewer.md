# Original article viewer

The application displays article text and locally preserved figures. Supabase keeps
summaries and necessary metadata only. The viewer never sends originals to Supabase.

The deployment variable `FULLTEXT_ORIGIN` supplies one trusted HTTPS API origin to
the frontend. It must not contain a path, credentials, or a query string. The
browser sends its current Supabase access token in an Authorization header; tokens
are never placed in links. An email typed into a request does not confer access.

`scripts/fulltext_viewer.py` binds only to `127.0.0.1:18451`. It exposes a minimal
health response, `GET /v1/fulltext/{numeric_pmid}`, and the corresponding
`/images/{sha256}` route. Every article and image request verifies
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

Stage `viewer_account_rights.ps1` beside the installer. It grants only the dedicated
viewer account the batch-logon right required by its scheduled task. Existing deny
policies are checked and left intact; no administrator membership is granted. The
installer verifies local health before reporting successful installation, rather
than treating task registration as proof that the server started.

Only after local authorization tests and the installed identity checks pass should
an HTTPS proxy expose this loopback service. Tailscale Funnel is one supported
transport: readers need no Tailscale account or client. The endpoint is publicly
reachable, so application authorization is mandatory. No device sharing, subnet
routes, SSH, file-directory publication, or other service ports are needed.

Availability depends on Z8 and its internet connection. Offline, missing-document,
expired-login and denied-account states have separate UI messages. Reading on a
second device requires an ordinary application login. The reader has body and
figure tabs, captions, an enlarged view and image download. Images load with the
same authenticated request as the body; temporary blob URLs are revoked on logout
or navigation. This is a text-and-figure reader, not a PDF layout reproduction.

Figures live beside the originals in `documents/{pmid}.images/{sha256}` with a
`{pmid}.images.json` manifest linked to the body hash. Only raster images listed
in that article's manifest are served. Bytes and MIME signatures are verified;
source URLs and local paths are not returned. Files are capped at 20 MiB each.
Missing images do not hide the body or invalidate its summary. Saved figures are
shown while other figures are still being collected.

For an existing installation, stage the updated viewer as a new release and run
`update_fulltext_viewer.ps1` as administrator with the existing install root,
release path and Python path. It preserves the account, password, triggers,
settings and network configuration. Password-logon tasks require a password to
change actions, so the updater backs up and replaces only the script already named
by the registered task. It checks the installed hash and tests article/image read
access and denied private-directory access under the existing reader identity at
startup. Failure restores the script and config backup; success requires local
health and an unchanged task definition.

Validation uses synthetic articles: `python -m unittest discover -s tests`, frontend
unit tests, and `tests/e2e/fulltext.spec.js` for mobile access, image retry,
enlargement/download, logout, keyboard navigation and denial.
