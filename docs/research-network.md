# Research network: counting and interpretation

The atlas opens with a **whole-catalog literature landscape**. It counts every
current catalog paper, including records without acquired or indexed originals.
It is not a systematic-review evidence grade, a causal graph or a complete citation
index. The separate Extracted concepts view describes only indexed originals.

## Whole-catalog landscape

The subject-by-publication-year table aggregates catalog MeSH labels. Every paper
in the year/journal scope contributes, with no paper/node limit. Subject rows are
ordered by paper count and paginated in groups of 20; all subjects remain reachable
through pagination/search. Changing the page never changes aggregate counts.
Five-year periods and individual-year views conserve counts, including a separate
unknown-year column. Rows overlap because papers can have multiple MeSH subjects.

Labels use trimmed, lowercase exact strings. The explicit exclusion list consists
only of human/animal, sex and age check tags (see `literature_subjects` in the
landscape migration). It does not guess acronym meanings, map keywords through
clinical aliases, or invent thematic clusters. Papers with no usable labels retain
a No subject metadata row. Missing MeSH coverage and unknown dates are counted.
MeSH subjects, publication volume and catalog growth do not establish scientific
quality, independent-study counts, field-wide trends or clinical progress. Recent
years and collection coverage can be incomplete.

Selecting a subject reveals its exact paper membership. Paper lists use catalog-ID
keyset pagination, with newest catalog records first; list ordering is explicitly
distinct from publication-year counting. Original-derived concept pages remain
available through Extracted concepts and existing concept deep links.

Citation flows aggregate every identified directed link from the selected subject's
indexed papers by citing year and referenced year. Reference data from matching-hash
metadata and scientific records are unioned. Repeated PMID/DOI identifiers resolving
to one catalog target count once per citing paper. The interface reports indexed
papers, reference metadata coverage and unknown target years separately. Reference
targets can predate the filter, lack catalog metadata, or have a retraction status;
none is converted to an invented date, title or zero reference count. Year-pair rows
and evidence lists are paginated without truncating totals. Selecting a year pair
shows the actual citing/reference paper pairs and source links.

### Query and deployment contract

`knowledge_landscape` reads a narrow private metadata projection, rather than
scanning the wide papers heap on each request. Catalog insert/update triggers keep
it current; deletion cascades. No originals, summaries, private projects or notes
are copied. Both private tables have RLS and no direct reader grants. The RPC
requires a confirmed account **and** approved membership, with empty search path,
an eight-second timeout and no anonymous EXECUTE. Refresh is every five minutes
while visible or on demand, retaining the existing account/race/error protections.

After applying the migration, an operator runs
`SELECT app_private.backfill_literature_metadata(1000)` in bounded transactions
until `ready` is true, then analyzes the projection. This operator-only initializer
uses a durable keyset checkpoint and locks source rows against concurrent metadata
updates. New catalog writes are maintained throughout initialization. Until it
finishes, the RPC returns `ready:false`, never partial whole-catalog counts. Before
web deployment, verify authenticated overview/citation queries and response time
on the real initialized corpus. Local synthetic performance is not a production SLA.
The production service preflight requires the new RPC and a service-role-only
readiness check; incomplete initialization blocks deployment. No collector, inference,
publisher quota or original-archive change is part of this feature.

## Entity identity

Source-linked model annotations remain immutable. A separate resolver matches
their labels against the official annual NLM MeSH descriptor XML. Matching uses
Unicode normalization, case folding, whitespace and typographic hyphen
normalization. It does not use fuzzy matching, model-proposed aliases or guessed
acronym expansion.

Short forms are **not** expanded from a unique dictionary entry. For example,
PCA can denote prostate cancer, principal component analysis or passive cutaneous
anaphylaxis. The resolver requires an explicit `long form (short form)` or
`short form (long form)` definition in each original's main text. It uses conservative
backwards character alignment; missing or conflicting definitions remain unresolved
and their memberships are isolated by paper. Definitions in the reference section
are excluded. This rule is not a claim of complete linguistic disambiguation.
Source hashes and definition offsets/checksums remain attached to each resolution.
Source-defined expansions then use the same exact MeSH lookup as full terms.
Identical normalized long-form labels are combined across model-assigned roles,
while more specific phrases remain distinct. No clinical relationships are invented.

An exact, unambiguous match resolves to **ConceptUI**, rather than DescriptorUI:
different narrower concepts under one descriptor are not automatically merged.
Entry terms belonging to the same ConceptUI share an entity. Its category comes
from the complete set of tree roots associated with that concept. Multiple roots
remain multiple categories; absent or ambiguous matches remain unclassified.
The annual release and its SHA-256 are retained with each resolution.

Existing narrative pages retain their source terms and original paper scope.
The atlas combines their memberships under resolved entities, and can link to
several source-scoped narratives without rewriting or conflating their prose.

## Co-occurrence

Each paper contributes at most one membership to each resolved entity. An edge
counts distinct papers containing both extracted concepts. Jaccard overlap is
`shared / (source papers + target papers - shared)` within the selected corpus.
These counts refer to reports, not independent studies or participants. A single
paper can generate many pairs; those pairs are not independent observations.

Circle area is proportional to paper count, with one common size scale per view.
Line width is `1 + log2(shared papers)`. Color represents entity category.
A deterministic force layout uses Jaccard overlap to arrange concepts, followed
by collision-aware label placement. Coordinates are navigation aids, not measured
scientific distances. Selecting an edge reveals the actual shared papers and
marginal counts. Clinical association, effect, quality and consensus are not
inferred from co-occurrence.

Nodes are the most frequent concepts, with a selected concept's neighbors prioritized and
the selected endpoints retained. The user can display 30, 60 or 100 nodes, and
set the minimum shared-paper count. At most 500 co-occurrence edges are displayed.
The same nodes and links are available on desktop and mobile. Panning, zooming,
keyboard controls and the full node list support dense views. Label suppression
does not remove nodes. The JSON export is a snapshot of the **displayed graph**,
including filters and coverage; it is not an export of every source membership.

## Citations and missingness

Only explicit PMID or DOI reference identifiers create directed links, from the
citing paper to the cited paper. Reference metadata is retrieved independently
of LLM inference. Retrieval failure, metadata with no reference identifiers and
no links within a selected subset have different states. Neither missing links
nor an empty PubMed reference list imply that a paper has no citations.

Citation filters apply to the **citing indexed papers**. Their explicitly identified
reference targets are included even when older, outside the journal/year filters,
or without indexed/acquired full text. Exact catalog PMID/DOI matches supply titles;
otherwise the identifier remains visible without inventing metadata. Reference nodes
are distinguished from matching source nodes. Connected endpoints are prioritized
within the node limit, starting with selected endpoints and commonly referenced targets.
The reference counts describe this indexed source corpus, not global citation counts.
Arrows are derived only from actual reference identifiers, never inferred similarity.

For existing focused-paper deep links, the **Connections** view fits the selected graph into the viewport, so
both ends of each displayed citation are visible. Binary reference links attract
papers; disconnected components occupy separate regions allocated by paper count.
Those regions are navigation groups, not scientific clusters. A shared radius
scale preserves circle area proportional to `1 + scoped incoming citations`,
capped at 20. Position encodes neither date, similarity nor evidence strength.
Numbered nodes correspond to the full-title paper list; selecting a paper fits
its direct references and citing papers. Zoom enlarges both dimensions without
rearranging this map, and selecting a new paper resets the view.

**Publication timeline** retains the linear catalog publication-year axis and
separate unknown-year lane. Dense timelines can scroll; same-year papers are
never moved to invented dates. The JSON export records the active layout and
displayed selection. Both views use exactly the same supplied nodes and links.

Current original hashes, publication status and the existing confirmed-reader
guard constrain the index. Bibliographic filters are applied before aggregation.
The focused graph's publication-year charts count indexed papers; they are not population-level
publication trends. Selection, extraction and full-text availability introduce
coverage bias. The atlas must not be described as clinically validated.

## Sources

- [NLM MeSH XML elements](https://www.nlm.nih.gov/mesh/xml_data_elements.html)
- [Official MeSH downloads](https://www.nlm.nih.gov/databases/download/mesh.html)
- [Schwartz and Hearst: explicit abbreviation definition extraction](https://pubmed.ncbi.nlm.nih.gov/12603049/)
- [VOSviewer visual encodings](https://app.vosviewer.com/docs/user-interface/main-panel/)

The implementation uses its own layout, not VOSviewer's clustering or inference.
