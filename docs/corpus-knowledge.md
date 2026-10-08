# Original-derived corpus knowledge

The corpus knowledge worker reads acquired original bodies, never reader summaries,
user notes or private research projects. It uses the existing model and global
inference admission; it does not install a model, increase model concurrency or open
a network listener. Python performs ingestion, checkpoints, validation and publication.

## Storage and publication

The existing original archive remains unchanged. The separate `knowledge` sibling
directory contains a WAL SQLite database with sources, version-bound fragments,
concepts, findings, memberships and an exact-revision outbox. Original quotations
used for validation stay here. Never place this database in OneDrive or commit it.

Only concept metadata and derived wiki paragraphs with original hashes/locators go
to the service. `publish_knowledge` verifies the enrolled worker token, acquisition
receipt, current paper title, source hash and integrity state. The private tables have
RLS and no direct reader access. Reader RPCs require a confirmed service account;
all enrolled readers share this corpus, without sharing their personal project data.
Source changes, deletion and integrity changes invalidate dependent pages atomically.
The reader hides stale prose and retains navigation to current connected papers.

Each original is processed in bounded fragments. Per-fragment checkpoints survive
interruption; failures use bounded backoff. Source changes clear derived membership
and trigger regeneration. The separate scheduled phase reconciles the whole acquired
catalog, alternating recent and waiting work. It does not require topic selection.

## Semantics and limits

Concepts require whole-term source matches; arbitrary substrings such as `ai` within
`Affairs` cannot establish an alias. Findings distinguish own results, methods and
cited background. Validation checks quotes, locations, numbers and publication shape;
these checks do not prove semantic correctness or establish clinical validity.

Wiki prose is synthesized from at most 24 source-bound findings with a maximum of
three per paper. The page describes that selection honestly; all concept memberships
remain browsable. At most 256 concepts per unusually long document are published;
all extracted fragments remain local. The graph's edges count shared papers, not
citations, independent trials, agreement, efficacy or evidence strength. The visible
graph is bounded to 30 concepts/90 edges; the concept search can browse beyond it.

No embeddings or additional graph database are required for this release. Exact
canonical names share an ID, while uncertain synonyms remain separate. Deterministic
label propagation groups the highest-coverage 750 concepts using up to 20,000
shared-paper edges with at least two papers. These bounded, versioned groups help
exploration; their labels come from their most-covered concept. They do not establish
clinical agreement. Similarity resolution and online question answering need separate
quality evaluation.

## Operations

`knowledge_worker.py --state-dir <archive> --max-seconds 3300` runs the normal loop.
`--scan-only` reconciles one bounded catalog page without inference or publication.
The worker uses one of the existing global four slots per model call and yields
between calls. Research keeps its existing exclusive admission priority.

The institution controller launches this phase separately and logs to `knowledge.log`.
Inspect local `sources.state`, `fragments`, `concepts.dirty`, `publications.pending`
and `meta.heartbeat` to distinguish discovery, extraction, page generation and cloud
publication. A cloud outage retains the outbox; a stopped local host leaves previously
published wiki/search/map readable. Original reading still depends on the existing
authenticated original service. No full-corpus completion or throughput promise is
implied by deploying this pipeline.
