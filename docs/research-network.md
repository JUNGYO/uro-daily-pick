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

Nodes are the most frequent concepts (or newest papers in citation mode), with
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

Current original hashes, publication status and the existing confirmed-reader
guard constrain the index. Bibliographic filters are applied before aggregation.
Publication-year charts count indexed papers; they are not population-level
publication trends. Selection, extraction and full-text availability introduce
coverage bias. The atlas must not be described as clinically validated.

## Sources

- [NLM MeSH XML elements](https://www.nlm.nih.gov/mesh/xml_data_elements.html)
- [Official MeSH downloads](https://www.nlm.nih.gov/databases/download/mesh.html)
- [VOSviewer visual encodings](https://app.vosviewer.com/docs/user-interface/main-panel/)

The implementation uses its own layout, not VOSviewer's clustering or inference.
