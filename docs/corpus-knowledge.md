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

Concept metadata, derived wiki paragraphs, compact scientific records and bibliographic
identifiers with original hashes/locators go to the service. `publish_knowledge` verifies the enrolled worker token, acquisition
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
all extracted fragments remain local. The concept graph's edges count shared papers,
not independent trials, agreement, efficacy or evidence strength. A separate citation
view links only identified DOI/PMID references between displayed papers; absence of
an edge is not evidence of no citation. Atlas queries return at most 24 nodes and 90
concept edges. The canvas shows 16 nodes on desktop and 6 on small screens to keep
labels readable; its accessible list exposes all returned nodes. Search and the
concept directory reach beyond this bounded overview.

No embeddings or additional graph database are required for this release. Exact
canonical names share an ID, while uncertain synonyms remain separate. Deterministic
label propagation groups the highest-coverage 750 concepts using up to 20,000
shared-paper edges with at least two papers. These bounded, versioned groups help
exploration; their labels come from their most-covered concept. They do not establish
clinical agreement. Similarity resolution and online question answering need separate
quality evaluation.

## Scientific records and bibliographic coverage

`scientific-v1` extracts study context and numerical results in the same source-fragment
call as concepts/findings. Context fields cover design, population, intervention,
comparator, sample size, follow-up, outcomes and limitations. Multiple cohorts and
timepoints remain separate records. Results carry measure, estimate, CI limits/level,
reported unit, population, comparison, timepoint and adjustment status. Exact phrases
and values must occur in the cited quotations. Unsupported candidates are omitted
and counted. CI ordering, ratio positivity and proportion scales are checked; no
missing number, effect, unit, comparator, bias rating or certainty rating is inferred.
These are machine source checks, not human review or a validated evidence appraisal.

PubMed metadata is fetched using only the public PMID and cached locally for 30 days.
Online, journal and history dates retain their type, precision and original range text.
An existing catalog date without source precision stays `unknown`. DOI, PMCID,
authors (including group authors), journal, volume/issue/pages, ISSNs, publication
types, MeSH IDs, registered trial identifiers, related notices and identified cited
references are retained when supplied. Original-parser references supplement explicit
PMID/DOI identifiers without uploading reference prose. A missing NLM response uses
catalog metadata and a bounded background retry; it cannot block source extraction.

Exact source term matches to supplied MeSH descriptors provide standard identifiers.
Uncertain synonyms stay separate. Registry-based links distinguish registered trials
from mentions, and are labeled candidate related reports. They do not automatically
merge studies or count independent participants. Abstract-only bibliography records
never become full-text knowledge records.

Detailed quotations, all fragments, candidates and versioned scientific history stay
in the local knowledge directory. `publish_scientific_knowledge` accepts at most 160
context fields and 80 results per paper, with coverage totals identifying truncation;
the full extraction remains local. It validates the enrolled worker and current original
receipt, fixed field sets, numeric shapes and locator bounds. Private science/reference/
registry tables use RLS, no direct reader grants and cascading original invalidation.
`knowledge_atlas` and `knowledge_paper` require the existing confirmed-reader guard.

Insights opens directly into the English Research Atlas. Selecting a concept opens
its narrative alongside the graph; year/journal/catalog study-type filters constrain
counts, graph membership, timeline and paper list together. The timeline uses catalog
publication year; the research record exposes online/print dates and precision.
Counts describe the indexed subset, not all acquired originals or all catalog papers.
Private activity remains at `?view=activity`, and earlier activity-filter URLs still work.
Daily three-line summaries, project review records and original reading are unchanged.

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
