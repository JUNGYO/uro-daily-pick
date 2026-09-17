"""Small, shared data contracts used by batch jobs (no side effects on import)."""
import json
import time

import requests


def supabase_headers(key):
    """Opaque API keys belong only in apikey; legacy JWTs also support Bearer."""
    headers = {"apikey": key}
    if not key.startswith("sb_"):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def get_json(url, *, headers, params=None, attempts=4):
    """Retry transient read failures without logging credentials or response bodies."""
    for attempt in range(attempts):
        response = None
        category, status = "unknown", None
        try:
            response = requests.get(url, headers={**headers, "Connection": "close"},
                                    params=params, timeout=(10, 45))
            response.raise_for_status()
            return response.json()
        except requests.HTTPError:
            if response is None or response.status_code not in (408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524):
                raise
            category, status = "http", response.status_code
        except requests.Timeout:
            category = "timeout"
        except requests.ConnectionError:
            category = "connection"
        except ValueError:
            category = "invalid_json"
        finally:
            if response is not None:
                response.close()
        if attempt + 1 == attempts:
            detail = category + (f" HTTP {status}" if status is not None else "")
            raise requests.RequestException(f"Database read failed after {attempts} attempts ({detail})") from None
        time.sleep(min(2 ** (attempt + 1), 8))


def patch_fields(url, *, headers, params, data, attempts=4):
    """Retry an idempotent field assignment with the exact same payload.

    A gateway can fail after the database committed. Never regenerate a model
    response or use this helper for increments, inserts, or email delivery.
    """
    for attempt in range(attempts):
        response = None
        try:
            response = requests.patch(url, headers={**headers, "Connection": "close"},
                                      params=params, json=data, timeout=(10, 45))
            response.raise_for_status()
            return response
        except requests.HTTPError:
            if response is None or response.status_code not in (408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524):
                raise
        except (requests.ConnectionError, requests.Timeout):
            pass
        finally:
            if response is not None:
                response.close()
        if attempt + 1 == attempts:
            raise requests.RequestException(f"Database write failed after {attempts} attempts") from None
        time.sleep(min(2 ** (attempt + 1), 8))


def json_value(value, fallback):
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        return parsed if isinstance(parsed, type(fallback)) else fallback
    except (TypeError, ValueError):
        return fallback


def strings(value):
    return [s for s in json_value(value, []) if isinstance(s, str) and s.strip()]


def paginate(get, path, params, size=500):
    """Offset pagination for a stable ordered, read-only query. Never silently truncate."""
    result = []
    while True:
        page = get(path, {**params, "limit": str(size), "offset": str(len(result))})
        if not isinstance(page, list):
            raise ValueError(f"Expected rows from {path}")
        result.extend(page)
        if len(page) < size:
            return result
