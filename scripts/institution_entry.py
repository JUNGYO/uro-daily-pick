"""Run independent acquisition and Spark queues with one existing scheduled task."""
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sqlite3
import sys
import time

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


def main():
    import msvcrt
    release = Path(__file__).resolve().parent
    state = release.parent.parent / "state"
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
    processes = []
    logs = []
    started = time.monotonic()
    try:
        print(f"\n{datetime.now(timezone.utc).isoformat()} Z8 acquisition and summary queues started", flush=True)
        with sqlite3.connect(state / "queue.sqlite3", timeout=20) as database:
            database.execute("PRAGMA journal_mode=WAL")
        from institution_worker import Service
        service = Service(state)
        service.status("running")
        for phase in ("collect", "summarize"):
            output = (state / (phase + ".log")).open("a", encoding="utf-8", buffering=1)
            logs.append(output)
            output.write(f"\n{datetime.now(timezone.utc).isoformat()} {phase} started\n")
            process = subprocess.Popen([sys.executable, "-u", str(release / "institution_worker.py"),
                "--state-dir", str(state), "--node", str(release / "node.exe"),
                "--phase", phase, "--max-seconds", "3300"], cwd=release,
                stdout=output, stderr=output, stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            processes.append((phase, process))
        results = []
        for phase, process in processes:
            try:
                code = process.wait(timeout=max(1, 3480 - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                stop_child(process)
                code = process.returncode
                print(f"{phase}: stalled child stopped; committed documents are retained", flush=True)
            results.append(code)
            print(f"{datetime.now(timezone.utc).isoformat()} {phase} finished: {code}", flush=True)
        service.status("error" if any(results) else "idle")
        if any(results):
            raise SystemExit(1)
    finally:
        for _, process in processes:
            if process.poll() is None:
                stop_child(process)
        for output in logs:
            output.close()
        lock.close()


if __name__ == "__main__":
    main()
