# Incremental citation classification

Daily classification uses the title, abstract, MeSH and publication types already
stored with each citation. It does not download originals or call a model. Source
metadata continues to be refreshed by the existing catalog collectors.

Migration 030 must be applied before deploying the updated classifier. Deployment
preflight checks both new RPCs. The RPCs are restricted to `service_role`; existing
reader permissions are unchanged.

The classifier reads up to 100 pending citations in ascending ID order, classifies
them and saves at most 25 per transaction. It records progress after each saved
chunk, then reads the next page. An indexed completion version is
independent of the result: `other` is a valid completed classification. The normal
scope remains publications from 2000 onward. Existing records receive one initial
classification pass; migration itself does not rewrite their classification.

Each batch carries a fingerprint of its source metadata. A concurrent source
change prevents an outdated result from being applied and leaves that citation
pending. Changed source metadata resets completion; unchanged metadata replay
preserves the completed classification. Classification version 1 is deterministic
for its input. Changing that algorithm requires a new version and corresponding
migration, including fingerprint and completion-preservation rules.

The default processing budget is 600 seconds, configurable with
`CLASSIFICATION_MAX_SECONDS` (1–3600). This limits time, not the total literature
scope. Saved batches remain complete and unfinished work is selected on the next
normal run. Transport failures still fail the job; they are not reported as normal
budget exhaustion.

Confirmed statement timeouts (`57014`) and deadlocks (`40P01`) cause the failed
write chunk to be divided after a bounded retry. The reduced chunk size remains
in effect for the rest of that run. Each request retains its original source
fingerprints, so an uncertain committed result can be replayed safely. A failed
single-record write still fails the job; no unacknowledged work is counted as
complete. The time budget is checked before each chunk, including split chunks.

`RECLASSIFY_ALL=true` explicitly walks all date-eligible citations, including
completed records. If its time budget is reached, the log prints the last saved
`CLASSIFICATION_AFTER_ID` for resuming that explicit pass. Normal runs always start
with the earliest pending citation and do not accept a manual resume cursor.

Validation covers completed `other` records, source changes and stale saves,
permission boundaries, page-by-page commits, retries after uncertain commits,
invalid acknowledgements, and MeSH-only classifications during ingestion.
