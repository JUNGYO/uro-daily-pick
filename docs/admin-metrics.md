# Administrative processing metrics

Migrations 031 and 032 separate dashboard aggregates from the large citation
table. The private metrics table contains each paper's identifier, publication
date, journal, fetch timestamp and three derived flags. It contains no abstract,
summary text, original document or image.

Paper and acquisition-receipt changes maintain these values transactionally.
Classification-only changes do not touch them, and unchanged metadata does not
rewrite them. Administrative counts are exact aggregates over this compact table.
Worker status uses its own small admin-authorized RPC. Existing dashboard layout
and administrator authorization remain unchanged.

Apply both migrations before deploying the web update. Then run the manual
**Initialize administrative metrics** workflow once. It uses the existing service
credential to commit bounded pages, retaining a durable checkpoint. It is safe to
resume after interruption and becomes a no-op after completion. Confirmed database
timeouts or deadlocks reduce the transaction size; unknown failures remain visible.
It does not send emails, classify papers, acquire originals or invoke a model.
The 30-minute runtime budget is cooperative: an in-flight bounded retry sequence
may finish after it expires. The workflow also has a 35-minute outer timeout.

Until initialization completes, service counts are unavailable rather than zero
or partial totals. The latest collection-worker report remains independently
visible. After initialization the dashboard displays the metric calculation time
separately from the request-check time. Future acquisitions and summaries update
the compact table automatically; another full initialization is not required.

The storage admission guard is unchanged. Database size includes the small metrics
table and its indexes; no subscription or quota change accompanies this repair.
