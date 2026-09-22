"""Rebuild source-bound reading layouts from existing local originals; no downloads.

The original JSON, source hash, summaries and evidence remain unchanged. A verified
sidecar is written atomically when a cached source reproduces the existing text
exactly. Otherwise, only verified stored section/paragraph boundaries are used;
unavailable publisher table structure is never invented.
"""
import argparse
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import time
import uuid

from document_layout import build_layout, validate_layout
from fulltext import parse_document, MAX_BYTES


def rebuild(path, *, apply=False):
    if path.is_symlink() or path.resolve() != path:
        return 'unsafe_path'
    before = path.read_bytes()
    record = json.loads(before)
    doc = record['document']
    text, digest = doc['content_text'], doc['content_hash']
    if hashlib.sha256(text.encode()).hexdigest() != digest:
        return 'source_hash_mismatch'
    sidecar = path.with_suffix('.layout.json')
    if sidecar.is_symlink():
        return 'unsafe_path'
    try:
        current = doc.get('reading_layout') or json.loads(sidecar.read_bytes())
        validate_layout(current, text, digest)
        return 'already_verified'
    except (OSError, ValueError, TypeError, KeyError):
        pass
    layout, source_found = None, False
    for ext in ('.xml', '.html', '.pdf'):
        source = path.with_suffix(ext)
        if not source.is_file():
            continue
        source_found = True
        if source.is_symlink() or source.resolve() != source or source.stat().st_size > MAX_BYTES:
            return 'unsafe_source'
        try:
            parsed = parse_document(source.read_bytes())
        except ValueError:
            continue
        if parsed['content_hash'] == digest and parsed['content_text'] == text:
            layout = validate_layout(parsed['reading_layout'], text, digest)
            break
    stored_sections = layout is None
    if stored_sections:
        sections = doc.get('sections', [])
        canonical = '\n\n'.join(s['title']+'\n'+s['text'] for s in sections if s['text'].strip())
        if not sections or canonical != text:
            return 'source_version_differs' if source_found else 'source_unavailable'
        units = [[{'kind':'paragraph','text':line} for line in s['text'].splitlines() if line.strip()]
                 for s in sections]
        layout = build_layout(text, sections, units)
        layout['structure_source'] = 'stored_sections'
    if not apply:
        return 'verified_dry_run'
    if path.read_bytes() != before:
        return 'source_changed'
    temporary = sidecar.with_suffix('.json.' + uuid.uuid4().hex + '.pending')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(layout, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        validate_layout(json.loads(temporary.read_bytes()), text, digest)
        # Even if the source changes immediately afterwards, the viewer rejects
        # this sidecar by its source hash rather than displaying stale structure.
        os.replace(temporary, sidecar)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass  # A uniquely named, incomplete sidecar is never served.
    return 'restored_stored_sections' if stored_sections else 'restored'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--pmid', action='append', default=[])
    parser.add_argument('--workers', type=int, choices=range(1,9), default=1)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    root = args.state_dir.resolve(strict=True) / 'documents'
    if root.is_symlink() or root.resolve(strict=True) != root:
        raise SystemExit('Archive must be a real directory')
    files = sorted(p for p in root.glob('*.json') if p.stem.isdecimal()
                   and (not args.pmid or p.stem in args.pmid))
    if args.limit:
        files = files[:args.limit]
    counts, pending = Counter(), []
    start, last = time.monotonic(), time.monotonic()
    def checkpoint():
        report = {'apply':args.apply,'files_at_start':len(files),'processed':sum(counts.values()),
                  'seconds':round(time.monotonic()-start,2),'counts':dict(counts),'pending':pending}
        args.report.write_text(json.dumps(report,indent=2),encoding='utf-8')
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        # Submit bounded windows, rather than queueing the entire archive in memory.
        for offset in range(0, len(files), args.workers * 4):
            futures = [pool.submit(rebuild_result, str(path), args.apply)
                       for path in files[offset:offset+args.workers*4]]
            for future in futures:
                item = future.result()
                counts[item['status']] += 1
                if item['status'] not in ('restored','restored_stored_sections','already_verified','verified_dry_run'):
                    pending.append(item)
            if time.monotonic()-last >= 20:
                checkpoint()
                print(json.dumps({'processed':sum(counts.values()), 'total':len(files), 'counts':dict(counts)}), flush=True)
                last = time.monotonic()
    report = {'apply':args.apply,'files_at_start':len(files),'processed':sum(counts.values()),
              'seconds':round(time.monotonic()-start,2),'counts':dict(counts),'pending':pending}
    args.report.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='pending'}),flush=True)


def rebuild_result(filename, apply):
    for attempt in range(3):
        try:
            return {'pmid':Path(filename).stem,'status':rebuild(Path(filename), apply=apply)}
        except (OSError, ValueError, TypeError, KeyError) as error:
            # Windows scanners can briefly lock new files. Retry within a bound;
            # never change ACLs or weaken source validation to force a write.
            if isinstance(error, PermissionError) and attempt < 2:
                time.sleep(0.25 * (attempt + 1))
                continue
            return {'pmid':Path(filename).stem,'status':'validation_failed','category':type(error).__name__,
                    'reason':str(error) if isinstance(error, ValueError) else 'Local source unavailable'}


if __name__=='__main__': main()
