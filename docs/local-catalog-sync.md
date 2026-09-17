# Local collection and service synchronization

Citation collection, original acquisition and inference run independently of cloud storage capacity. The existing local controller starts `catalog`, `sync`, `collect`, `summarize`, `figures` and the existing literature `research` phase. It uses the configured archive directory outside synchronized folders and the existing inference endpoint.

`catalog.sqlite3` holds citation metadata, PubMed search checkpoints, source-bound completion state and a durable outbox. Original documents and figures remain in their existing archive. The historical 2000-onward registry scan and overlapping daily entry/modification-date scans share PMID identity. A local disk reserve pauses discovery safely; a cloud capacity limit only pauses new service registrations.

The sync phase incrementally mirrors existing service citations, then sends bounded citation batches before acquisition receipts and summaries. It uses the existing enrolled worker identity, with no service-role key installed on the workstation. The database accepts only citation fields; original content is rejected. Existing user notes, reading history and source-bound summary validation remain in place.

Acknowledgements apply to the exact local revision sent. Interrupted uploads are replayable without duplicate PMIDs. Invalid individual records remain local and are deferred without blocking valid records. Summaries wait for their current citation and original receipt; source changes invalidate stale publication work. A server-rejected summary re-enters local validation and inference.

The administrator view distinguishes local citations, citations synchronized to the service, and pending revisions. Original and summary stages already in the service keep their existing counts. Local counters are independently reported with timestamps and stale-state handling. Locally stored, unsynchronized papers are not represented as available in service search.

GitHub's daily workflow checks sync health and continues classification, recommendation and configured digest work. Its hourly catalog workflow is a read-only health check. Neither workflow performs the normal citation collection anymore. The old catalog command remains available for tests and explicit maintenance; its historic cloud checkpoints are preserved.

The health check reads a dedicated synchronization report, without scanning the citation or acquisition tables. Both the report and its last successful synchronization cycle must be recent. Missing reports, stale successful cycles, offline states and API failures remain failures; reaching the storage budget is a warning, because locally committed work stays queued. A successful cycle can legitimately acknowledge no new records and is not evidence that the entire queue has been published. Local failure diagnostics identify the stage, category and time without logging credentials or source content.

Local capacity does not expand cloud capacity. Publishing the entire retained catalog still requires adequate service storage. No paid subscription or storage limit is changed by this implementation.
