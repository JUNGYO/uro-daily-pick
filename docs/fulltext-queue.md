# Full-text queue

The daily 06:00 KST pipeline fetches and classifies catalog metadata. Z8 collects missing full articles and uses existing Spark to generate three-line Korean summaries. Original files stay on Z8; only summaries and necessary metadata reach Supabase. See [institution-worker.md](institution-worker.md).

GitHub's Full-text queue runs at minutes 7 and 37 each hour. It reads worker health and aggregate counts, then refreshes recommendations from valid full-text summaries. It does not download bodies, call a model or send email. Production workflows share a concurrency group; GitHub scheduling can be delayed.

Inaccessible articles and invalid summaries remain queued without failing completed work. A heartbeat older than two hours or worker execution error produces a warning. A missing worker, no first connection or more than 24 hours without contact fails the health check. Saved summaries remain usable during outages.

Z8 processes multiple papers for up to 55 minutes per run, with no paper-count cap. Collection, inference and publication have durable checkpoints. Recommendations require available full text, full-text provenance and three summary lines; no abstract fallback is used. Daily and manual cloud workflows use the same storage boundary.

Run 34794475661 failed because its legacy import step counted one failure among 463 attempts as a job failure. It still imported 71 articles, saved 71 summaries and refreshed recommendations. The old logs omitted the failing PMID/error class, so the exact provider error cannot be established. The replacement workflow uses the durable Z8 queue and reports collection, Spark and publication status separately.

Manual Run's check-fulltext-queue checks health and refreshes recommendations; recommend-only refreshes recommendations directly. repair-keywords also repairs historical explanations with whole-word matching, preserving historical IDs, scores and feedback. Optimistic comparison protects concurrent changes; frontend validation removes stale keyword reasons.

All-time expansion: `catalog-backfill.yml` runs hourly at minute 17, resuming metadata checkpoints for all configured journals without a date cutoff. `catalog_backfill.py` partitions PubMed IDs when a search exceeds the retrieval ceiling. Older articles without abstracts remain eligible once their body summary is ready. Existing Gemini summaries also enter the Qwen worker queue; the old summary is retained until a validated replacement is published. See [catalog-audit.md](catalog-audit.md) for findings and scope.
