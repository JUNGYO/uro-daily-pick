# Z8 collection and Spark summaries

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

The existing controller starts independent `collect`, `summarize` and `figures`
subprocesses. The figure queue scans all retained originals, including legacy
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
