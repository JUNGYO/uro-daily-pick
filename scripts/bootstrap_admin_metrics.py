"""Initialize compact administrative metrics with durable, bounded transactions."""
import os
import re
import time

import requests

from common import supabase_headers


class BootstrapError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def bootstrap_batch(url, key, limit):
    for attempt in range(4):
        response = None
        category, code = "unknown", None
        try:
            response = requests.post(
                f"{url}/rest/v1/rpc/bootstrap_admin_catalog_metrics",
                headers=supabase_headers(key), json={"p_limit": limit}, timeout=(10, 30),
            )
            if response.status_code >= 400:
                category = f"HTTP {response.status_code}"
                if response.status_code not in (408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524):
                    raise BootstrapError(f"Metrics initialization rejected ({category})")
                try:
                    error = response.json()
                except ValueError:
                    error = None
                candidate = error.get("code") if isinstance(error, dict) else None
                if isinstance(candidate, str) and re.fullmatch(r"[0-9A-Z]{5}|PGRST[0-9]{3}", candidate):
                    code = candidate
            else:
                result = response.json()
                if (not isinstance(result, dict)
                        or type(result.get("complete")) is not bool
                        or any(type(result.get(k)) is not int for k in ("processed", "cursor", "high_water_id"))
                        or not 0 <= result["processed"] <= limit
                        or not 0 <= result["cursor"] <= result["high_water_id"]
                        or (result["complete"] and result["cursor"] != result["high_water_id"])
                        or (not result["complete"] and result["processed"] == 0)):
                    raise BootstrapError("Invalid metrics initialization acknowledgement")
                return result
        except requests.Timeout:
            category = "timeout"
        except requests.RequestException:
            category = "transport error"
        except ValueError:
            raise BootstrapError("Invalid metrics initialization acknowledgement") from None
        finally:
            if response is not None:
                response.close()
        if attempt == 3 or (code in {"57014", "40P01"} and attempt >= 1):
            detail = category + (f" code {code}" if code else "")
            raise BootstrapError(f"Metrics initialization failed ({detail})", code) from None
        time.sleep(min(2 ** (attempt + 1), 8))


def initialize(url, key, *, batch_size=200, max_seconds=1800):
    """Apply a cooperative budget between bounded transaction attempts."""
    deadline = time.monotonic() + max_seconds
    cursor, high_water = None, None
    while time.monotonic() < deadline:
        try:
            result = bootstrap_batch(url, key, batch_size)
        except BootstrapError as error:
            if error.code not in {"57014", "40P01"} or batch_size == 1:
                raise
            batch_size = max(1, batch_size // 2)
            print(f"Metrics transaction {error.code}; reduced batch size to {batch_size}", flush=True)
            continue
        if (high_water is not None and result["high_water_id"] != high_water
                or cursor is not None and (result["cursor"] < cursor
                    or not result["complete"] and result["cursor"] == cursor)):
            raise BootstrapError("Metrics initialization checkpoint changed unexpectedly")
        cursor, high_water = result["cursor"], result["high_water_id"]
        print(f"Metrics checkpoint {cursor}/{high_water}; {result['processed']} records acknowledged", flush=True)
        if result["complete"]:
            print("Administrative metrics initialization complete.", flush=True)
            return True
    print("Initialization time budget reached; committed progress is preserved for the next run.", flush=True)
    return False


def main():
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY required")
    try:
        batch = int(os.environ.get("ADMIN_METRICS_BATCH_SIZE", "200"))
        seconds = int(os.environ.get("ADMIN_METRICS_MAX_SECONDS", "1800"))
        if not 1 <= batch <= 500 or not 30 <= seconds <= 1800:
            raise ValueError
    except ValueError:
        raise SystemExit("Invalid initialization batch size or time budget") from None
    if not initialize(url, key, batch_size=batch, max_seconds=seconds):
        raise SystemExit("Administrative metrics initialization remains incomplete; rerun to resume.")


if __name__ == "__main__":
    main()
