# Independent local acquisition and summary queues

The institution task runs one collector and one Spark summary process concurrently.
An article waiting for a model response no longer prevents the next original from
being acquired. The collector does not require Spark to be online. The summary
process reads only existing local documents and never opens publisher pages.

`institution_entry.py` retains the existing controller lock and starts the two
roles with separate locks. The existing scheduled task, Python runtime, browser
profile and Spark endpoint are reused. There is still only one literature-summary
request at a time; the model, research services and SSH configuration are unchanged.
The controller reports its overall result after both child processes finish.

Acquisition favors papers without cached originals. Its retry ledger is separate
from summary failures, and imports existing publisher cooldowns. Both ledgers use
the local SQLite database in WAL mode. Completed originals are hash-verified and
committed on Z8 before summary work. Only summaries and source metadata are posted
to Supabase; no original bodies or evidence fragments are uploaded there.

Each paper has a 420-second budget within the current run, including a 15-second
publication reserve. Yielding one paper does not stop the remaining queue. Long
articles save intermediate evidence and drafts locally, keyed by their source hash
and validation version, and resume after a time-budget interruption. Changed
inputs invalidate those checkpoints. Invalid claims are repaired against bounded
excerpts of the original; accepted claims are retained and the complete result is
validated again before publication. Numeric values must still match their cited
passages. Neither validation failures nor expired budgets count as completed work.
Publisher page and table navigation also has a bounded article deadline. The
controller has a final watchdog for its own child process trees, leaving committed
documents intact and finishing before the existing scheduled task's time limit.

Operational logs are `worker.log`, `collect.log`, and `summarize.log` under the
existing local state directory. The hourly task retries subsequent work with no
article-count cap; automatic processing starts at 2000-01-01. Publisher access failures remain
explicit failures, and summary validation is not relaxed to increase throughput.

Storage is independent of the runtime release. A local `storage.json` in the
installation root selects an absolute `state_dir` outside OneDrive. The scheduled
controller and future release installers use the same setting. An invalid or
missing configured destination fails instead of silently collecting elsewhere.
Existing installations without this file retain their original local state path.
When changing disks, stop the literature task, copy and hash-verify its state,
verify the SQLite checkpoint, then update this setting and the viewer's state path
before restarting. Keep the source copy until the destination is verified.

Candidate enumeration pages by the indexed article ID, then orders the completed
list by publication date locally. This avoids increasingly expensive offset scans
as the catalog grows. Automatic processing starts at publication date 2000-01-01, with no article-count limit.

Summary enumeration selects registered originals. Papers without a valid body
summary precede model-version refreshes; within each group, unattempted and older
attempts precede recent failures. Repeated failures for the same source and reason
back off for 15 minutes, 1 hour, 6 hours, then 24 hours. Success or a changed source
resets that history. A per-paper budget yield preserves progress for a later turn.
Logs distinguish first summaries from refreshed summaries, because refreshing an
existing valid summary does not increase the service's completed-paper count.
Final caches are revalidated against the original before reuse. A definite
publication rejection quarantines the final and draft checkpoints, preserving the
original and fragment notes, so an invalid payload is not replayed indefinitely.
