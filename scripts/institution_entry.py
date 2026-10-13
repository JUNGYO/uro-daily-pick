"""Run local catalog, acquisition, inference and cloud sync independently."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import sys
import time
from acquisition_quota import AcquisitionDeferred, KST, Quota

def resolve_state_directory(install_root):
    """Use the durable local storage choice for every scheduled release."""
    install_root = Path(install_root).resolve()
    config_path = install_root / "storage.json"
    if not config_path.exists():
        return install_root / "state"
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    selected = config.get("state_dir")
    if not isinstance(selected, str) or not selected:
        raise ValueError("Storage configuration needs state_dir")
    state = Path(selected)
    if not state.is_absolute():
        raise ValueError("Storage must be an absolute local path")
    state = state.resolve(strict=True)
    if not state.is_dir() or str(state).startswith(("\\\\", "//")) or any(part.lower().startswith("onedrive") for part in state.parts):
        raise ValueError("Storage must be a local directory outside OneDrive")
    return state


def stop_child(process):
    if process.poll() is not None:
        return
    # Only the exact subprocess started by this controller and its browser children.
    if os.name == "nt":
        subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        process.terminate()
    process.wait(timeout=15)


def figure_budget(state, started, collection_day):
    """Only the remainder of this collection run/day is available for figures."""
    quota = Quota(state / "acquisition-policy.json")
    quota.active()
    status = quota.status()
    now = quota.now().astimezone(KST)
    if status['day'] != collection_day or now.date().isoformat() != collection_day:
        raise AcquisitionDeferred('originals_first_new_day')
    if not any(publisher['remaining'] > 0 for publisher in status['publishers'].values()):
        raise AcquisitionDeferred('quota_daily_limit')
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    # Keep time for graceful exit before the existing 58-minute child deadline.
    seconds = int(min(3300, 3480 - (time.monotonic() - started) - 15,
                      (midnight - now).total_seconds() - 15))
    if seconds < 10:
        raise AcquisitionDeferred('originals_first_no_time')
    return seconds


def run_phases(release, state):
    """Run inference/sync independently, with collection preceding figures."""
    processes, logs = [], []
    started = time.monotonic()
    collection_day = None

    def launch(phase, seconds=3300):
        output = (state / (phase + '.log')).open('a', encoding='utf-8', buffering=1)
        logs.append(output)
        output.write(f'\n{datetime.now(timezone.utc).isoformat()} {phase} started\n')
        if phase == 'knowledge':
            command = [sys.executable, '-u', str(release / 'knowledge_worker.py'),
                       '--state-dir', str(state), '--max-seconds', str(seconds)]
        elif phase in {'catalog', 'sync'}:
            script = 'local_catalog_worker.py' if phase == 'catalog' else 'catalog_sync.py'
            command = [sys.executable, '-u', str(release / script),
                       '--state-dir', str(state), '--max-seconds', '3560' if phase == 'sync' else str(seconds)]
        else:
            command = [sys.executable, '-u', str(release / 'institution_worker.py'),
                       '--state-dir', str(state), '--node', str(release / 'node.exe'),
                       '--phase', phase, '--max-seconds', str(seconds)]
        process = subprocess.Popen(command, cwd=release,
            stdout=output, stderr=output, stdin=subprocess.DEVNULL,
            env={**os.environ, 'URO_ACQUISITION_POLICY': str(state / 'acquisition-policy.json')},
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        pair = (phase, process)
        processes.append(pair)
        return pair

    try:
        # Start every independent lane immediately; figures must not race the
        # acquisition lane for the same publisher's daily reservations.
        for phase in ('catalog', 'sync', 'collect', 'summarize', 'research', 'knowledge'):
            if phase == 'collect':
                try:
                    quota = Quota(state / 'acquisition-policy.json')
                    quota.active()
                    collection_day = quota.status()['day']
                except AcquisitionDeferred as error:
                    print(f'collect: deferred, {error.reason}', flush=True)
                    continue
            launch(phase)
        pending = sorted(processes, key=lambda pair: pair[0] != 'collect')
        results = []
        while pending:
            phase, process = pending.pop(0)
            timed_out = False
            try:
                limit = 3590 if phase == 'sync' else 3480
                code = process.wait(timeout=max(1, limit - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                timed_out = True
                stop_child(process)
                code = process.returncode or 1
                print(f'{phase}: stalled child stopped; committed documents are retained', flush=True)
            results.append(code)
            print(f'{datetime.now(timezone.utc).isoformat()} {phase} finished: {code}', flush=True)
            if phase == 'collect':
                if code or timed_out:
                    print('figures: deferred, originals_first_collection_failed', flush=True)
                    continue
                try:
                    seconds = figure_budget(state, started, collection_day)
                except AcquisitionDeferred as error:
                    print(f'figures: deferred, {error.reason}', flush=True)
                    continue
                print(f'figures: originals phase finished; remaining window {seconds}s', flush=True)
                # Wait for figures before the longer sync lane, so a hung figure
                # child is stopped at the existing acquisition deadline.
                pending.insert(0, launch('figures', seconds))
        return results
    finally:
        for _, process in processes:
            if process.poll() is None:
                stop_child(process)
        for output in logs:
            output.close()


def main():
    import msvcrt
    release = Path(__file__).resolve().parent
    state = resolve_state_directory(release.parent.parent)
    state.mkdir(exist_ok=True)
    sys.stdout = (state / "worker.log").open("a", encoding="utf-8", buffering=1)
    sys.stderr = sys.stdout
    lock = (state / "worker.lock").open("a+b")
    if os.fstat(lock.fileno()).st_size == 0:
        lock.write(b"0"); lock.flush()
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        print("An institution worker is already running", flush=True)
        lock.close()
        return
    try:
        print(f"\n{datetime.now(timezone.utc).isoformat()} Z8 acquisition and summary queues started", flush=True)
        database = sqlite3.connect(state / "queue.sqlite3", timeout=20)
        try:
            database.execute("PRAGMA journal_mode=WAL")
        finally:
            database.close()
        results = run_phases(release, state)
        from local_catalog import LocalCatalog
        with LocalCatalog(state) as catalog:
            catalog.set_meta("controller_status", {"state": "error" if any(results) else "idle",
                "updated_at": datetime.now(timezone.utc).isoformat()})
        if any(results):
            raise SystemExit(1)
    finally:
        lock.close()


if __name__ == "__main__":
    main()
