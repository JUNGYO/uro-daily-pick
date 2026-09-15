# Original acquisition

The scheduled Python controller runs acquisition, summarization, figure retrieval,
and project extraction independently. Acquisition does not call an inference model.

The acquisition phase has separate queues:

- Up to three workers retrieve and parse open-access API documents.
- One browser worker handles supported institution-accessible article pages in the
  existing browser profile. Waiting for a publisher page does not occupy an API worker.
- Only the coordinator writes original files, records retries in SQLite, and sends
  acquisition receipts to the service. Receipts contain hashes and bibliographic
  metadata, never the article body.

Requests to each API source start at least one second apart. Browser navigation
uses the same minimum interval per publisher group. A 403, 429, or explicit access
challenge pauses further requests to that source. Browser publisher pauses are
retained in the local state directory across scheduled runs. No session rotation
or alternative network address is used to retry a blocked publisher.

ScienceDirect website retrieval is disabled, including DOI redirects and browser
image requests to its associated hosts. Known Elsevier DOI routes are rejected
before opening a page. Open-access copies remain eligible; the official Elsevier
article API is used only when its API credentials are already configured.

Repeated transient errors for the same paper and reason use a 15-minute, 1-hour,
6-hour, then 24-hour delay. Success clears that failure streak. Access-required
and unsupported papers retain the existing seven-day delay; challenges retain
the one-day delay. A deferred paper is not counted as an acquired original.

Acquisition stops submitting work at its time budget and saves completed results
before closing. Downloads have bounded response sizes and deadlines. The local
collection lock prevents overlapping collectors; summaries consume verified
local originals through their separate queue. Neither acquisition nor parsing
relaxes title, DOI, body completeness, table, or content-hash validation.
