# Multilingual three line summaries and Q&A

Status: proposed design. This change does not generate translations or add a language switch. Both the three-line summary and every Q&A question and answer are in scope. Korean and English are the proposed first languages; additional languages should use the same storage and validation contract.

## Current contract

The collector keeps verified originals locally. The summary worker publishes `summary_ko`, `qa_data`, structured study information and evidence through the guarded `publish_institution_summary` RPC. The source hash, model and generation time identify the result. Reader components currently display the Korean summary and its Q&A directly. Existing fields and Korean availability must remain compatible during migration.

## Reader experience

A content-language preference controls the summary and Q&A together across Today, paper details and saved reading. It is separate from interface language and the existing English knowledge atlas. A paper-level switch temporarily overrides the preference, with the displayed language explicitly labeled and the content container using the corresponding `lang` attribute.

Switch only when a complete summary and Q&A bundle for the current source revision is ready. If English is missing, show “English translation is not ready” and an explicitly labeled Korean bundle. Never label a Korean fallback as English or mix an English summary with Korean answers. Changing language must preserve the selected paper, reading position, saved state and evidence links.

## Storage and publication

Add a versioned translation relation rather than adding one column for each language. Each immutable bundle records the paper, BCP 47 language code, original content hash, base summary revision, translation recipe version, model, generation time, review state and publication state. Its content contains exactly three summary items and the complete question/answer set. Stable claim and question IDs connect translations to the same evidence blocks; IDs must not depend on array position or translated text.

A base revision must cover the summary, Q&A and their evidence mapping. The current original hash alone cannot distinguish two regenerated summaries from the same original. Replacing any base content invalidates translations derived from its old revision. Publication checks both the original receipt and current base revision, then switches the entire bundle atomically. Failed or incomplete translations never replace a ready bundle.

Use a unique job identity consisting of paper, language, source hash, base revision and recipe version. Preserve attempt history and use leases, bounded retries and an outbox acknowledgement to make retries idempotent. Direct reader writes remain denied. Read RPCs require approved membership and expose only current published bundles. Keep raw source text and translation diagnostics on the existing local processing path.

## Generation and quality

Generate a language from the current verified claims, existing summary/Q&A and their supporting original excerpts. Do not chain translations through multiple target languages. The model must preserve population, intervention, comparator, uncertainty, negation, numbers, units and the distinction between association and causation. Q&A may translate wording but must not add new questions, claims or unsupported answers.

Validate bundle completeness, exactly three summary items, stable claim/question IDs, current source and base revision, and evidence references before publication. Numeric checks should normalize locale formatting and verify values against the relevant claim, rather than accepting any number found somewhere in the paper. Automated checks do not establish clinical or semantic correctness; a bilingual review set is needed before enabling each language.

## Throughput and rollout

1. Add the storage/read contract and import existing Korean output as the compatible default. Keep the current recommendation readiness rule based on the Korean result.
2. Prepare English bundles for a bounded sample, then current recommendations and explicitly requested papers. Reuse the existing inference admission limit and give current research and Korean summaries priority. Do not translate the full archive eagerly or generate synchronously on a page request.
3. Enable the shared summary/Q&A switch after bilingual review and accessibility checks. Measure complete-bundle coverage, queue wait, generation time, failure rate, stale revision rejection and effect on the existing summary queue.
4. Expand languages after each language passes its own terminology and meaning review. Translation cache keys and offline downloads include account, language and base revision. Digest language support is a separate later change; existing delivery remains Korean until explicitly implemented.

Acceptance must cover missing translations, stale source/base revisions, delayed replies after switching papers or accounts, account approval boundaries, retries, offline fallback, numbers and units, negation, evidence navigation, and mobile screen readers. Rollback disables the switch and translated publication while retaining the working Korean output and stored revision history.
