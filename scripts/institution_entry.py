"""Windowless Task Scheduler entry point; logs contain status counts only."""
from datetime import datetime, timezone
from pathlib import Path
import sys

release = Path(__file__).resolve().parent
state = release.parent.parent / "state"
state.mkdir(exist_ok=True)
sys.stdout = (state / "worker.log").open("a", encoding="utf-8", buffering=1)
sys.stderr = sys.stdout
print(f"\n{datetime.now(timezone.utc).isoformat()} Z8 institution worker started", flush=True)
sys.argv = [str(release / "institution_worker.py"), "--state-dir", str(state), "--node", str(release / "node.exe")]
from institution_worker import main
main()
print(f"{datetime.now(timezone.utc).isoformat()} Z8 institution worker finished", flush=True)
