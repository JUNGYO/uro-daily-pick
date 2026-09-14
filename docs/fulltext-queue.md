# Full-text processing

The daily 06:00 KST pipeline fetches new papers. The Full-text queue workflow also runs every two hours at minute 17 UTC and can be dispatched manually. All production pipelines share one concurrency group.

- `SUMMARY_BATCH_SIZE=0` processes every ready, changed full text within 45 minutes. Zero removes the paper-count cap; it does not disable processing. Each validated three-line summary is saved immediately. Unchanged source/model pairs skip model calls. Remaining work resumes on the next run.
- `FULLTEXT_BATCH_SIZE=0` scans the entire catalog within 15 minutes, including older papers and papers without an abstract. Unattempted papers take priority over retries. Ready bodies are preserved; unavailable OA documents are checked again after seven days.
- Positive batch sizes remain available for diagnostics. They are not the production default.
- A provider error does not prevent the queue worker from summarizing bodies already imported. Failed model requests are reported; successful summaries remain checkpointed.
- The queue never sends email. Imported bodies remain in private storage. Summary provenance must say `fulltext`; unavailable bodies never fall back to abstracts.

Europe PMC covers open-access articles. Subscription access on Z8 still requires an authorized local import or configured publisher API; the GitHub runner does not inherit the institution's browser/VPN session.

Manual Run → `repair-keywords` regenerates today's recommendations and repairs historical keyword explanations using literal whole-word matching. It preserves recommendation IDs, scores for historical dates, and feedback. Optimistic comparison protects rows changed concurrently. Frontend validation also removes stale keyword reasons, even when historical matched-term arrays are missing or use different casing.
