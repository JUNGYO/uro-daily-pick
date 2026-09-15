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

Model calls share a deadline for the current run. Long articles save intermediate
evidence locally, keyed by their source hash, and resume at the next unfinished
fragment after a time-budget interruption. A changed source invalidates that cache.
Publisher page and table navigation also has a bounded article deadline. The
controller has a final watchdog for its own child process trees, leaving committed
documents intact and finishing before the existing scheduled task's time limit.

Operational logs are `worker.log`, `collect.log`, and `summarize.log` under the
existing local state directory. The hourly task retries subsequent work; it has
no article-count cap or publication-date cutoff. Publisher access failures remain
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
as the all-time catalog grows, without imposing a date or article-count limit.
