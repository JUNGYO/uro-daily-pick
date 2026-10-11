# Multilingual three line summaries and Q&A

Status: proposed design. This change does not generate translations or add a language switch. Each user chooses their own content language. Both the three-line summary and every Q&A question and answer follow that user's choice. The design covers Korean, English and Japanese, with additional languages using the same storage and validation contract. There is no administrator-controlled language change for all readers.

## Current contract

The collector keeps verified originals locally. The summary worker publishes `summary_ko`, `qa_data`, structured study information and evidence through the guarded `publish_institution_summary` RPC. The source hash, model and generation time identify the result. Reader components currently display the Korean summary and its Q&A directly. Existing fields and Korean availability must remain compatible during migration.

## Reader experience

A private `profiles.content_language` preference belongs to the authenticated user and controls that user's summary and Q&A across Today, paper details and saved reading. User A choosing Korean sees Korean summaries, questions and answers; user B choosing Japanese sees Japanese content for the same paper at the same time. Neither setting affects the other reader. New users choose their preference during onboarding, and each user can change it later in Settings. Validate the selected language against supported language codes and restrict preference updates to the account owner.

Content language is separate from interface language and the existing English knowledge atlas. Persist the preference across devices. The displayed content has an explicit language label and the corresponding `lang` attribute. Changing the preference refreshes only that user's view and future content requests; it does not rewrite the paper or switch every account.

Resolve the complete summary and Q&A bundle for the user's selected language and the current source revision. If Japanese is missing, show a Japanese-content preparation state and offer an explicit “View in Korean” action. Do not silently show Korean as the result of choosing Japanese. The temporary fallback does not change the saved language preference. Never label a Korean fallback as Japanese or mix languages within one bundle. Changing language must preserve the selected paper, reading position, saved state and evidence links.

## Storage and publication

Add a versioned translation relation rather than adding one column for each language. Each immutable bundle records the paper, BCP 47 language code, original content hash, base summary revision, translation recipe version, model, generation time, review state and publication state. Its content contains exactly three summary items and the complete question/answer set. Stable claim and question IDs connect translations to the same evidence blocks; IDs must not depend on array position or translated text.

A base revision must cover the summary, Q&A and their evidence mapping. The current original hash alone cannot distinguish two regenerated summaries from the same original. Replacing any base content invalidates translations derived from its old revision. Publication checks both the original receipt and current base revision, then switches the entire bundle atomically. Failed or incomplete translations never replace a ready bundle.

Read RPCs resolve the requesting user's language preference and return the requested language, actual displayed language and availability state. The complete bundle cache is shared by paper and language to avoid translating the same paper separately for every user. Shared cached content does not imply shared language settings: only the owner's private preference selects which bundle they receive. Concurrent Korean and Japanese requests remain independent.

Use a unique job identity consisting of paper, language, source hash, base revision and recipe version. Preserve attempt history and use leases, bounded retries and an outbox acknowledgement to make retries idempotent. Direct reader writes to generated bundles remain denied. Read RPCs require approved membership and expose only current published bundles. Keep raw source text and translation diagnostics on the existing local processing path.

## Generation and quality

Generate a language from the current verified claims, existing summary/Q&A and their supporting original excerpts. Do not chain translations through multiple target languages. The model must preserve population, intervention, comparator, uncertainty, negation, numbers, units and the distinction between association and causation. Q&A may translate wording but must not add new questions, claims or unsupported answers.

Validate bundle completeness, exactly three summary items, stable claim/question IDs, current source and base revision, and evidence references before publication. Numeric checks should normalize locale formatting and verify values against the relevant claim, rather than accepting any number found somewhere in the paper. Automated checks do not establish clinical or semantic correctness; a bilingual review set is needed before enabling each language.

## Throughput and rollout

1. Add the storage/read contract and import existing Korean output as the compatible default. Keep the current recommendation readiness rule based on the Korean result.
2. Prepare English and Japanese bundles for bounded review samples, then use each user's preference to queue the required language for that user's recommendations and requested papers. Deduplicate overlapping requests across users. Reuse the existing inference admission limit and preserve current research and base-summary priority. Do not translate the full archive into every language eagerly or generate synchronously on a page request.
3. Enable individual language preferences after the relevant language review and accessibility checks. The preference applies to that user's three-line summary and Q&A together. Measure complete-bundle coverage by language, queue wait, generation time, failure rate, stale revision rejection and effect on the existing summary queue.
4. Expand languages after each language passes its own terminology and meaning review. Translation cache keys and offline downloads include account, language and base revision. Digest language support is a separate later change; existing delivery remains Korean until explicitly implemented.

Acceptance must prove that two users can read the same paper in Korean and Japanese concurrently, that changing one user's setting leaves the other unchanged, and that the preference persists across sessions and devices. Also cover missing translations with an explicit fallback action, stale source/base revisions, delayed replies after switching papers, languages or accounts, account approval boundaries, retries, offline fallback, numbers and units, negation, evidence navigation, and mobile screen readers. Rollback disables translated publication and clearly reports unavailable preferred-language content while retaining the working Korean output, private preferences and stored revision history.
