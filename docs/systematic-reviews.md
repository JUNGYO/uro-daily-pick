# Systematic reviews in research projects

The existing reading experience and research workspace are preserved. A project
can additionally organize a systematic review through protocol, searches,
screening, study linkage, extraction, assessments and reproducible analysis.
Searching the service is not presented as a complete systematic search.

## Connected literature workflow

Discovery and the personal library use the existing paper cards for selection,
with private saved state and project screening status beside each paper. The
selected project survives navigation between discovery, library and projects.
Adding a paper to a project also registers it for screening; it does not mark it
eligible or alter personal saved state. Existing project papers are reconciled
with explicitly incomplete historical provenance, not invented search dates.

The project document list includes imported external references. Catalog and
external references also remain available in the research writing workspace.
Existing notes, human screening decisions and frozen analyses are preserved.
Stage and report links return to the same review record after reading a paper.
Migration 041 uses existing membership checks, private capture triggers and
authenticated, bounded read functions. No additional public data access exists.

## Implementation

- Python handles RIS, NBIB, CSL-JSON, BibTeX and mapped CSV parsing, numerical
  analysis, SVG figures and ZIP/CSV/RIS/CSL exports.
- React supplies the existing application's authenticated interface. PostgreSQL
  stores project-scoped records, permissions, revisions, audit history and a
  durable analysis queue. Migrations 038 and 039 are additive.
- Search records retain query, scope, dates, original bibliographic records and
  completion status. Exact DOI/PMID matches link records to reports; conflicting
  identifiers remain separate. Manual duplicate decisions are reversible.
- Reports, studies and numerical observations are separate entities. A study may
  have several reports. Inclusion/exclusion decisions require appropriate stages
  and exclusion reasons. External references are not restricted by the public
  service's journal list or publication-date range.
- Missing numerical values remain null with a reason in drafts. They cannot be
  confirmed or silently treated as zero. Confirmation requires a current included
  report, a study link, source hash/location and explicit source comparison.
- Analysis freezes the current protocol, exact observation revisions, source
  versions, screening counts, search history and assessments. Subsequent edits
  do not rewrite completed runs; a stale-input warning prompts a new analysis.
- Exports include frozen data, source references, settings, numerical results,
  SVG figures, the exact Python engine and a SHA-256 manifest. Included RIS and
  CSL-JSON can be imported into Zotero; they are not live citation fields in a
  Word document or a direct Zotero account connection.

## Numerical profiles

| Profile | Supported input and method |
| --- | --- |
| Pairwise binary | Parallel RCT event counts; RR, OR or RD; REML |
| Pairwise continuous | Parallel RCT means/SD; MD or bias-corrected Hedges g; REML |
| Reported estimates | Compatible effect and SE; ratio measures explicitly on log scale |
| Sparse common effect | Mantel–Haenszel RR/OR/RD with an explicit common-effect justification; no automatic 0.5 correction |
| Diagnostic accuracy | Joint binomial bivariate logit-normal random effects, Laplace likelihood; convergence/boundary/Hessian checks |

Pairwise results include study estimates, 95% intervals, Q, I² and tau², with
Q-profile tau² intervals. The versioned rule uses HKSJ when k > 2 and tau² > 0,
otherwise Wald; small-k uncertainty is explicit. Prediction intervals require
at least five studies. Leave-one-out analyses are bounded to 3–100 studies.
Funnel plots are descriptive and do not automatically diagnose reporting bias.

Single-study inputs have no pooled result. Nonconvergent diagnostic fits do not
fall back to separate sensitivity/specificity pooling. Correlated cohorts,
shared groups, mixed designs and incompatible outcomes/timepoints/scales are
rejected. Raw cluster/crossover and observational arms are not accepted in the
RCT profiles; reported estimates must document design adjustment and covariates.
Network meta-analysis, HSROC/AUC, automatic conversions of missing SD, and
unvalidated covariance-aware synthesis are not offered.

## Review and privacy boundaries

Human and AI peer review are explicit **not-performed placeholders**. Source
confirmation is not peer review. No AI provider execution or provider-key form
is active in this release; unexpected API-key fields are rejected. Future
personal AI execution must use a key supplied for that execution only, without
database, browser storage, logs, queues, environment variables or fallback to
another user's key/model. Numerical analysis requires no personal API key.

The loopback import/export gateway uses the existing authenticated account and
checks project membership on every request. The restricted original viewer may
optionally host it on a separate loopback port; it receives neither an archive
path nor worker credentials. A separate bounded CPU worker uses the existing
enrollment to claim/finish jobs. It does not use the collection model or GPU.
The existing collector, archive and task configuration are not replaced.

## Validation and limits

`tests/generate_review_oracles.R` generates independent QA references using
metafor and lme4. Production calculation is Python/NumPy/SciPy and does not
require R. Tests compare effect sizes, variances, intervals, heterogeneity,
sparse-event estimates and a simulated bivariate diagnostic dataset.

Database tests cover project isolation, denied writes, immutable snapshots,
optimistic revisions, imports, missing data, source invalidation and job leases.
Browser scenarios cover mobile layouts, accessibility, transfer, selection and
reader permissions. These automated fixtures are not a prospective evaluation
of published meta-analyses or a human usability study, and do not validate AI
extraction, which remains inactive. A calculation-complete label does not mean
a review is methodologically complete or ready for publication.

## Deployment order

1. Run Python, database, frontend and browser checks on the proposed revision.
2. Apply migrations 038/039 and verify project access and worker-token checks.
3. Prepare the dedicated Python runtime with `prepare_review_runtime.py` and
   validate the exact source hashes; reuse the already installed scientific
   packages. Register `install_review_worker.ps1` only after inspecting the
   existing task identity.
4. Update the existing restricted viewer using its established updater and
   `-EnableReview`. Verify both health endpoints, read-only archive access and
   private-path denial. Route only the review path to its loopback gateway.
5. Publish the web application and verify a signed-in project flow. Existing
   published results and original access must remain available.
