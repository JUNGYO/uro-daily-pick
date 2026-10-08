"""Restartable corpus extraction and publication using the existing Spark service."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from evidence import source_blocks, numbered_source
from knowledge import (VERSION, PAGE_VERSION, KnowledgeStore, encode, digest, now, PROMPT, WIKI_PROMPT,
                       concept_schema, wiki_schema, validate_fragment, accepted_fragment, validate_page)
from research_extraction import _chunk_blocks
from local_summary import chat, ensure_server, literature_inference_scope, SummaryBudgetExpired
import scientific_knowledge as scientific


def scientific_fragment(value, blocks):
    if not isinstance(value, dict) or set(value) != {'concepts','findings','science'}:
        raise ValueError('Missing scientific extraction')
    core = accepted_fragment({k:value[k] for k in ('concepts','findings')}, blocks)
    core['science'], core['science_rejected'] = scientific.accepted(value['science'], blocks)
    return core


def load_original(state, paper):
    from institution_worker import cached_paper_matches, verify_cached_body
    for directory in ("documents", "cloud-archive"):
        path = state / directory / (str(paper["pmid"]) + ".json")
        if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
            continue
        path.resolve().relative_to(state.resolve())
        saved = json.loads(path.read_text(encoding="utf-8-sig"))
        if cached_paper_matches(saved.get("paper", saved), paper):
            document = verify_cached_body(saved["document"])
            if not 2000 <= len(document['content_text']) <= 600000:
                raise ValueError('Incomplete or oversized original')
            return document
    raise ValueError("Matching original unavailable")


def scan_catalog(store, state, limit=300):
    """Read-only incremental reconciliation; no long catalog transaction/file scan."""
    cursor = store.meta("scan_cursor", "")
    with sqlite3.connect((state / "catalog.sqlite3").as_uri() + "?mode=ro", uri=True, timeout=10) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("""SELECT pmid,citation,remote_state FROM catalog_papers WHERE pmid>?
          AND coalesce(json_extract(local_state,'$.local_original'),0)=1
          ORDER BY pmid LIMIT ?""", (cursor, limit)).fetchall()
    for row in rows:
        paper = json.loads(row["citation"])
        remote = json.loads(row["remote_state"])
        paper["integrity_status"] = remote.get("integrity_status", paper.get("integrity_status", "current"))
        paper["pmid"] = row["pmid"]
        if (paper.get("pub_date") or "") < "2000-01-01":
            continue
        try:
            doc = load_original(state, paper)
            if paper.get("integrity_status", "current") != "current":
                store.withdraw(paper["pmid"])
                continue
            store.observe(paper, doc)
        except (OSError, ValueError, TypeError, KeyError):
            # Retain files. Subsequent reconciliation retries failed reads.
            continue
    store.set_meta("scan_cursor", rows[-1]["pmid"] if len(rows) == limit else "")
    if len(rows) < limit:
        store.set_meta("last_scan", now())
    return len(rows)


def ask(system, content, schema, validate, state, deadline, *, cache_directory=None):
    from local_summary import MODEL, _checkpoint
    cache_dir = cache_directory or state.parent / 'knowledge' / 'candidates'
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / (digest([VERSION, MODEL, system, content, schema]) + '.json')
    error = ""
    try:
        saved = json.loads(cache.read_text(encoding='utf-8'))
        return validate(json.loads(saved['response']))
    except OSError:
        pass
    except (ValueError,KeyError,TypeError) as failure:
        error = " Cached output failed validation: " + str(failure)[:150] + ". Cite the exact blocks for both result AND context; omit unsupported details."
    for _ in range(2):
        # One shared slot per call, within the same GLOBAL four-slot admission.
        # Yield between calls; research's existing exclusive gate still wins.
        with literature_inference_scope(state):
            raw = chat(system + error, content, schema, deadline=deadline)
        _checkpoint(cache, {'version': VERSION, 'model': MODEL, 'response': raw})
        try:
            return validate(json.loads(raw))
        except (ValueError, TypeError, KeyError) as failure:
            print(encode({"event": "knowledge_validation_retry", "reason": str(failure)[:120]}), flush=True)
            error = " Previous output failed validation: " + str(failure)[:150] + ". Cite the exact blocks for both result AND context; omit unsupported details. Use exact source quotes/IDs and the exact schema."
    raise ValueError("Knowledge output failed validation")


def extract_step(store, state, deadline):
    # Alternate oldest waiting work and latest publications; repeated new arrivals
    # cannot permanently starve the historical corpus.
    turn = store.meta("turn", 0)
    order = "updated_at,pmid" if turn % 2 else "json_extract(paper,'$.pub_date') DESC,pmid"
    # New catalog pages arrive during inference. Finish a current-revision
    # checkpoint before starting yet another paper; otherwise the recent lane
    # continually leaves partially processed papers behind as discovery advances.
    row = store.db.execute(f"""SELECT s.* FROM sources s
        WHERE state IN ('pending','error') AND retry_at<=?
        ORDER BY EXISTS(SELECT 1 FROM fragments f WHERE f.pmid=s.pmid
          AND f.fingerprint=s.fingerprint) DESC,{order} LIMIT 1""", (time.time(),)).fetchone()
    if row is None:
        return False
    store.set_meta("turn", turn + 1)
    paper = json.loads(row["paper"])
    try:
        document = load_original(state, paper)
        if document["content_hash"] != row["content_hash"]:
            store.observe(paper, document)
            return True
        chunks = _chunk_blocks(source_blocks(document["content_text"]), maximum=14000)
        cached = {r["ordinal"]: json.loads(r["value"]) for r in store.db.execute(
            "SELECT ordinal,value FROM fragments WHERE pmid=? AND fingerprint=?", (row["pmid"], row["fingerprint"]))}
        for ordinal, blocks in enumerate(chunks):
            block_map = {b["id"]: b["text"] for b in blocks}
            if ordinal in cached:
                validate_fragment({k:cached[ordinal][k] for k in ('concepts','findings')}, block_map)
                if 'science' in cached[ordinal]:
                    scientific.validate(cached[ordinal]['science'], block_map)
                continue
            contract = concept_schema(blocks)
            contract['required'].append('science'); contract['properties']['science'] = scientific.schema(blocks)
            value = ask(PROMPT + scientific.PROMPT, encode({"title": paper["title"], "source": numbered_source(blocks)}),
                contract, lambda x: scientific_fragment(x, block_map), state, deadline, cache_directory=store.directory/'candidates')
            with store.db:
                store.db.execute("INSERT OR REPLACE INTO fragments VALUES (?,?,?,?)", (row["pmid"], row["fingerprint"], ordinal, encode(value)))
                # Continue this paper next time, without holding admission across calls.
                store.db.execute("UPDATE sources SET state='pending',attempts=0,retry_at=0 WHERE pmid=?", (row["pmid"],))
            cached[ordinal] = value
            break
        if len(cached) == len(chunks):
            fresh = load_original(state, paper)
            if fresh["content_hash"] != row["content_hash"]:
                store.observe(paper, fresh)
            else:
                fragments = [cached[i] for i in range(len(chunks))]
                science = None
                if all('science' in f for f in fragments):
                    bib = scientific.bibliography(paper, store.directory)
                    science = scientific.publication(row, fragments, bib, fresh)
                store.complete(row, fragments, science=science)
        return True
    except SummaryBudgetExpired:
        # A bounded document step is shorter than the whole worker run. Keep
        # fragment checkpoints and let another document use the remaining run.
        with store.db:
            store.db.execute("UPDATE sources SET state='pending',attempts=attempts+1,retry_at=? WHERE pmid=? AND fingerprint=?",
                (time.time()+min(86400, 120 * 2**min(row['attempts'],9)), row['pmid'], row['fingerprint']))
        print(encode({'event':'extraction_deferred','pmid':row['pmid']}), flush=True)
        return False
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        with store.db:
            store.db.execute("UPDATE sources SET state='error',attempts=attempts+1,retry_at=? WHERE pmid=?",
                (time.time() + min(86400, 120 * 2**min(row["attempts"], 9)), row["pmid"]))
        # No article, response or credentials in logs.
        print(encode({"event": "extraction_retry", "pmid": row["pmid"]}), flush=True)
        return False


def page_step(store, state, deadline):
    row = store.db.execute("""SELECT c.* FROM concepts c WHERE dirty=1 ORDER BY dirty_since,
        (SELECT count(*) FROM memberships m WHERE m.concept_id=c.id) DESC,id LIMIT 1""").fetchone()
    if row is None:
        return False
    inputs = store.page_inputs(row["id"])
    try:
        if inputs:
            wire_inputs = [{**f, 'id':str(i+1)} for i,f in enumerate(inputs)]
            public_input = [{**{k: f[k] for k in ("id", "title", "text", "context", "basis")},
                "source_excerpts": [e["quote"] for e in f["evidence"]]} for f in wire_inputs]
            paragraphs = ask(WIKI_PROMPT, encode({"concept": row["label"], "findings": public_input}),
                wiki_schema(wire_inputs), lambda x: validate_page(x, wire_inputs), state, deadline, cache_directory=store.directory/'candidates')
        else:
            paragraphs = []
        with store.db:
            store.stage("page", row["id"], {"id": row["id"], "version": PAGE_VERSION, "paragraphs": paragraphs})
            store.db.execute("UPDATE concepts SET dirty=0 WHERE id=?", (row["id"],))
        return True
    except SummaryBudgetExpired:
        # The previous published page remains readable; other pages and
        # documents must still progress during this scheduled run.
        with store.db:
            store.db.execute("UPDATE concepts SET dirty=2 WHERE id=?", (row['id'],))
        return False
    except (ValueError, KeyError, TypeError, RuntimeError):
        # Failed pages go to the back of the retry order. The next scheduled run
        # restores them, while other pages can still be built now.
        with store.db:
            store.db.execute("UPDATE concepts SET dirty=2 WHERE id=?", (row["id"],))
        return False


def refresh_bibliography(store):
    # One metadata-only refresh per ten minutes; failed enrichment never discards
    # extraction. Existing NLM cache prevents redundant calls after restarts.
    rows = store.db.execute("""SELECT p.*,s.paper,s.fingerprint FROM publications p JOIN sources s ON s.pmid=p.id
        LEFT JOIN bibliography_refresh b ON b.pmid=p.id
        WHERE p.kind='science' AND s.state='done' AND coalesce(b.next_at,0)<=? ORDER BY
        coalesce(json_extract(p.payload,'$.bibliography.fetched_at'),'') LIMIT 1""", (time.time(),)).fetchall()
    for row in rows:
        value = json.loads(row['payload'])
        bib = scientific.bibliography(json.loads(row['paper']),store.directory)
        with store.db:
            store.db.execute('INSERT OR REPLACE INTO bibliography_refresh VALUES (?,?)',
                (row['id'],time.time()+(86400 if bib['source']=='PubMed' else 3600)))
        if bib == value['bibliography']:
            continue
        # Retain reference identifiers extracted from the immutable original.
        extra = [r for r in value['bibliography']['references'] if r['source_id'].startswith('original-ref-')]
        bib['references'] = (bib['references']+extra)[:500]
        value['bibliography'] = bib
        with store.db:
            revision = store.stage('science',row['id'],value)
            store.db.execute('INSERT OR IGNORE INTO scientific_history VALUES (?,?,?,?,?)',
                (row['id'],row['fingerprint'],revision,encode(value),now()))


def sync_step(store, service, deadline):
    service.sync_deadline = deadline
    for row in store.db.execute("""SELECT * FROM publications WHERE pending=1 AND retry_at<=?
      ORDER BY CASE kind WHEN 'source' THEN 0 WHEN 'terms' THEN 1 WHEN 'bibliography' THEN 2 WHEN 'science' THEN 3 WHEN 'page' THEN 4 ELSE 5 END,id LIMIT 10""", (time.time(),)).fetchall():
        payload = json.loads(row["payload"])
        try:
            args = {"p_worker_id": service.config["id"], "p_token": service.token,
                "p_revision": row["revision"], "p_payload": payload}
            if row['kind'] != 'science':
                args['p_kind'] = row['kind']
            result = service.request("rpc/" + ('publish_scientific_knowledge' if row['kind']=='science' else 'publish_knowledge'), args)
            if result != {"id": row["id"], "revision": row["revision"]}:
                raise ValueError("Publication revision not acknowledged")
            store.acknowledge(row["kind"], row["id"], row["revision"])
        except (RuntimeError, ValueError, TimeoutError):
            with store.db:
                store.db.execute("UPDATE publications SET retry_at=? WHERE kind=? AND id=? AND revision=?",
                    (time.time()+120, row["kind"], row["id"], row["revision"]))


def refresh_network_bibliography(store, limit=2):
    # Citation coverage is metadata work; it must not wait for scientific LLM
    # extraction to finish. The published original's exact identity is retained.
    store.db.execute('CREATE TABLE IF NOT EXISTS network_bibliography(pmid TEXT PRIMARY KEY,content_hash TEXT NOT NULL,next_at REAL NOT NULL)')
    rows=store.db.execute("""SELECT s.paper,p.payload FROM publications p JOIN sources s ON s.pmid=p.id
        LEFT JOIN network_bibliography b ON b.pmid=p.id
        WHERE p.kind='source' AND (b.pmid IS NULL OR b.content_hash<>json_extract(p.payload,'$.content_hash') OR b.next_at<=?)
        ORDER BY coalesce(b.next_at,0),p.id LIMIT ?""",(time.time(),limit)).fetchall()
    for row in rows:
        paper=json.loads(row['paper']);source=json.loads(row['payload'])
        bib=scientific.bibliography(paper,store.directory)
        with store.db:
            store.db.execute('INSERT OR REPLACE INTO network_bibliography VALUES (?,?,?)',
                (paper['pmid'],source['content_hash'],time.time()+(86400 if bib['source']=='PubMed' else 3600)))
            if bib['source']=='PubMed':
                store.stage('bibliography',paper['pmid'],{'version':VERSION,'pmid':paper['pmid'],
                    'title':source['title'],'content_hash':source['content_hash'],'source':'PubMed',
                    'fetched_at':bib['fetched_at'],'references':bib['references']})
        time.sleep(0.4)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--knowledge-dir", type=Path)
    parser.add_argument("--max-seconds", type=int, default=3300)
    parser.add_argument("--scan-only", action="store_true")
    args = parser.parse_args()
    state = args.state_dir.resolve(strict=True)
    target = (args.knowledge_dir or state.parent / "knowledge").resolve()
    if target == state or state in target.parents or any(x.lower().startswith("onedrive") for x in target.parts):
        parser.error("Knowledge data must use a separate local directory outside the archive and OneDrive")
    store = KnowledgeStore(target)
    # An OS file lock prevents overlapping scheduled/manual workers.
    from inference_slots import _try_lock, _unlock
    lock = (target / "worker.lock").open("a+b")
    if not _try_lock(lock):
        store.close(); lock.close(); return
    deadline = time.monotonic() + max(5, min(args.max_seconds, 86400))
    terminology = None
    try:
        store.prepare_pages()
        if args.scan_only:
            count = scan_catalog(store, state)
            print(encode({"scanned": count}), flush=True)
            return
        from institution_worker import Service
        service = Service(state)
        from knowledge_terms import ensure_index, reconcile_terms
        terminology = ensure_index(target)
        last_scan = last_sync = last_groups = 0
        iteration = 0
        while deadline - time.monotonic() > 45:
            if time.monotonic() - last_scan > 30:
                scan_catalog(store, state); last_scan = time.monotonic()
            if time.monotonic() - last_sync > 15:
                reconcile_terms(store,terminology)
                refresh_network_bibliography(store)
                sync_step(store, service, deadline-5); last_sync = time.monotonic()
            if time.monotonic() - last_groups > 600:
                store.build_groups(); last_groups = time.monotonic()
                refresh_bibliography(store)
            store.set_meta("heartbeat", {"at": now(), "state": "running"})
            try:
                ensure_server()
            except (OSError, ValueError, RuntimeError):
                store.set_meta("heartbeat", {"at": now(), "state": "inference_unavailable"})
                time.sleep(min(15, max(0, deadline-time.monotonic())))
                continue
            # Finish previously published pages under a changed prose recipe first.
            upgrading = store.db.execute("""SELECT 1 FROM concepts c JOIN publications p ON p.id=c.id
                WHERE p.kind='page' AND c.dirty=1 AND json_extract(p.payload,'$.version')<>? LIMIT 1""", (PAGE_VERSION,)).fetchone()
            if upgrading or iteration % 3 == 2:
                page_step(store, state, min(deadline-15, time.monotonic()+450))
            else:
                extract_step(store, state, min(deadline-15, time.monotonic()+450))
            iteration += 1
            time.sleep(min(3, max(0, deadline-time.monotonic())))
        sync_step(store, service, deadline)
    except SummaryBudgetExpired:
        pass
    finally:
        if terminology is not None:
            terminology.close()
        store.set_meta("heartbeat", {"at": now(), "state": "idle"})
        _unlock(lock); lock.close(); store.close()


if __name__ == "__main__":
    main()
