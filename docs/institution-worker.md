# Z8 collection and Spark summaries

## Daily acquisition limit

Scheduled collection and figure acquisition require `acquisition-policy.json`
in the selected local state directory. Missing or invalid policy/ledger blocks
downloads. Other phases can continue. Example policy:

```json
{"version":1,"timezone":"Asia/Seoul","starts_at":"2026-10-13T00:00:00+09:00","daily_limit":30,"manual_reserve":0}
```

Initialize once with `python acquisition_quota.py --policy <path> initialize`.
The adjacent `acquisition-quota.sqlite3` ledger is shared by API, browser and
figure workers. Back it up with the state directory; never delete it to recover
capacity. Initialization refuses an existing ledger. Quota records stay local.

The limit is at most 30 downloaded responses or unresolved reservations per
publisher per Korean calendar day. Each request reserves capacity before
transport. Confirmed HTTP/transport failures release only that request's
reservation, once, on its original day. Browser redirects do not retain a charge;
the destination is reserved separately. Completed downloads still count if
subsequent parsing fails. Crashes, uncertain outcomes and legacy aggregate usage
are not refunded. HTTP 401/403/429 also pause the publisher across workers, so
releasing a failed reservation does not authorize another blocked request. Full-text,
linked-table and figure requests consume the same budget, so fewer than 30
complete papers may be acquired. Concurrent workers and restarts share an atomic
ledger. Chromium intercepts redirect destinations before transport. Publisher
domain aliases are grouped; known DOI prefixes add a conservative charge when
the actual destination differs. Repository content without a recognized
publisher is deferred. Metadata discovery and existing local reading, summaries
and knowledge processing do not consume download capacity. Existing publisher
access blocks, licensing checks and request pacing still apply; a quota is not
permission to automate a source.

Use `python acquisition_quota.py --policy <path> status` to inspect today's
counts. Manual downloads in another browser cannot be detected. Before making
them, reserve capacity with `python acquisition_quota.py --policy <path> manual
--publishers <group> --count <n>`; the command refuses excess capacity. Supported
groups are `springer-nature`, `wiley`, `elsevier`, `jama`, `bmj`, and
`wolters-kluwer`. Alternatively, `manual_reserve` keeps that many daily slots
outside automatic collection. Set `paused` to `true` to stop new source requests.
Do not raise `daily_limit` above the institution's allowance; values above 30
are rejected. Review source-specific authorization separately.

Z8 collects full articles through the hospital network and stores originals outside OneDrive. The existing Spark API at http://127.0.0.1:18000/v1, model nvidia/Qwen3.8-27B-NVFP4, generates three-line Korean summaries. Only summaries, structured findings, QA and provenance metadata reach Supabase. Abstracts never substitute for missing bodies.

The client checks the existing model and sends its own paper messages directly, one inference request at a time. It does not install models, start servers, change the SSH tunnel or submit tasks to another application. Spark outages preserve pending documents for retry; model API fallback is not automatic.

Collection first tries licensed Europe PMC full text, then ordinary headed Chrome with a dedicated minimized profile. Supported structures include ScienceDirect, Springer/Nature, Wiley, JAMA and BMJ. Access depends on institution subscriptions. The browser waits for body sections, includes linked Springer tables, checks title/DOI and rejects incomplete bodies.

## Install

Apply migrations through 011. Run scripts/install_institution_worker.py with --node pointing to an existing Node executable and --install-dir pointing to %LOCALAPPDATA%/UroDailyPick. It copies the tested environment into a versioned release without downloading models or packages.

Register its returned worker UUID and token hash in app_private.institution_workers through the authenticated DB administration console. The generated token is encrypted with Windows DPAPI and never printed. No service-role or Gemini key is installed. Four narrow RPCs update status, publish summaries, export legacy bodies, and acknowledge verified local archives. Migration 011 removes raw publication and rejects new cloud body storage.

Run scripts/register_institution_task.ps1 -ReleasePath <installed-release-path>. Task UroDailyPick-Institution-Fulltext runs hourly and on login while the Windows user is signed in. Codex need not remain open. Installation preserves old releases, source files, model files and other tasks. A lock prevents overlap.

## Recovery

Each run works for up to 55 minutes with no paper-count cap. Parsed articles are saved before inference; validated summaries before publication. Retries reuse checkpoints and publish idempotently. One invalid summary does not stop later papers. Transient errors retry after 15 minutes, challenges after one day, and unavailable/unsupported articles after seven days. Spark/DB outages fail visibly while retaining pending files.

Summaries require exactly three Korean lines, structured fields and numeric values present in the source. Large articles are synthesized from fragments. This is automated validation, not clinical review. Title/source changes invalidate provenance; recommendations require valid full-text summaries.

Initial runs migrate legacy bodies: flush each complete JSON record to state/cloud-archive, read it back, verify text/source hashes, then acknowledge the exact current DB body. Only after verification does the DB remove that body and retain metadata; existing summaries remain available. Back up Z8 state under the owner's storage policy: it is the authoritative original store.

Logs: %LOCALAPPDATA%/UroDailyPick/state/worker.log (status, PMID and counts). Originals, parsed files and retry state stay in this private directory. Get-ScheduledTaskInfo -TaskName UroDailyPick-Institution-Fulltext reports task errors; the admin page shows storage counts and heartbeat. Disable this task to pause; set its database enabled field false to revoke access.

The worker now includes every catalog paper with a missing/stale summary or a model other than the configured Qwen. There is no publication/import date filter. It reuses hash-verified originals from state/cloud-archive when replacing older Gemini summaries. Cached originals are prioritized; existing summaries remain visible until a validated replacement is published. Historical metadata collection runs independently through catalog-backfill.yml, with migration 012 providing durable progress and administrator counts.

## Figure preservation

The controller starts collection, summaries, knowledge and synchronization
independently. Figure supplementation starts only after the original collection
phase exits successfully, using the same remaining publisher quota. Its time
budget is limited to the remainder of the existing hourly run (normally about
three minutes after a full 55-minute collection phase). A failed or timed-out
collection, exhausted quota, insufficient time, a new pause, or a change of the
Korean calendar day defers figures until a later collection run. It never resets
the daily count. Only confirmed individual transport failures release their own
reservation. This gives new originals the first opportunity to use
the daily quota; access and validation failures can still prevent acquisition.

The figure queue scans all retained originals, including legacy
archives, without a date filter or model requests. Publisher HTML supplies figure
captions and high-resolution image links. JATS figures use the current official
[PMC media dataset](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/) with article identity
checks and Europe PMC's supplementary-file API as a fallback. The browser reuses
the existing installed Chrome runtime with a separate profile so collection and
figure downloads do not lock each other out.

Image bytes and manifests stay under the configured local state directory outside
OneDrive; no image bytes or original bodies are published to Supabase. A partial
download is checkpointed per figure and retried after one hour. Existing complete
manifests skip downloads. Each image is limited to 20 MiB; writes preserve at least
1 GiB free space. `figures.log` records progress without article text or credentials.
Missing access is left pending, and does not block collection or summarization.
