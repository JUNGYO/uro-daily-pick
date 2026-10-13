# Research network: counting and interpretation

The atlas is an exploratory view of the **indexed full-text corpus**. It is not
a systematic-review evidence grade, a causal graph or a complete citation index.
The corpus coverage, current filters and displayed subset are shown together.

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

The default **Connections** view fits the selected graph into the viewport, so
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
Publication-year charts count indexed papers; they are not population-level
publication trends. Selection, extraction and full-text availability introduce
coverage bias. The atlas must not be described as clinically validated.

## Connected research workflow

The existing Concepts, Connections and Publication timeline designs form one
navigation flow. Switching to Citations carries the selected concept or pair as
a source-paper scope. Returning to Concepts restores that selection. Year bars
count the selected indexed papers, not unrelated papers from the whole corpus.
Knowledge narratives remain corpus-wide and are labeled separately from the
filtered reading list.

Today, paper details and knowledge pages offer citation entry points. A library
map uses the signed-in reader's tab and memo/tag search; a project map includes
all catalog-linked collection papers and review reports, independently of the
workspace's visible page. The database verifies project ownership or accepted
membership before returning scope data. Catalog-linked but unindexed papers and
unlinked project records remain explicitly counted; they are not fabricated
knowledge nodes. A deliberately selected catalog paper can remain a seed even
before its original is indexed.

An unscoped citation entry asks for a topic, paper or literature filter instead
of automatically presenting an arbitrary initial graph. The 30/60/100 control
limits map rendering only. The separate reading list pages through all identified
connections, with References and Cited by kept distinct. Selecting a paper beyond
the displayed map brings it into focus. Reference targets may be outside the
workspace; only the citing source papers are scope-limited. Unlinked papers have
their own list and are not evidence of no citations.

Paper links carry a durable return URL, including filters, scope, focus, citation
direction, reading-list page and layout choice. Existing paper actions save,
annotate and add the paper to a project; returning restores the research context.
There is no new inferred evidence, model, original download, or bulk acquisition
in this navigation flow.

Deploy `20261013020723_integrated_research_navigation.sql` before this frontend.
The service-only `research_navigation_contract` marker is required by deployment
preflight; anonymous and reader roles cannot execute it. The network RPC retains
its confirmed/approved-reader check, empty search path and eight-second timeout.

## Sources

- [NLM MeSH XML elements](https://www.nlm.nih.gov/mesh/xml_data_elements.html)
- [Official MeSH downloads](https://www.nlm.nih.gov/databases/download/mesh.html)
- [Schwartz and Hearst: explicit abbreviation definition extraction](https://pubmed.ncbi.nlm.nih.gov/12603049/)
- [VOSviewer visual encodings](https://app.vosviewer.com/docs/user-interface/main-panel/)

The implementation uses its own layout, not VOSviewer's clustering or inference.
