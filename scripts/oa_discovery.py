"""Bounded Europe PMC metadata discovery; no originals or cache are stored here.

The search API supports EXT_ID combined with SRC:MED and returns OA metadata in
its lite result type. Only the OA subset is downloadable as fullTextXML:
https://europepmc.org/RestfulWebService
https://europepmc.org/help

An unavailable result describes this provider at the time of discovery. Callers
must expire it; it is not proof that no authorized copy exists elsewhere.
Malformed, incomplete or failed responses never produce negative observations.
"""
import json
import re
import time
from urllib.parse import urlencode


MAX_DISCOVERY_BATCH = 50
MAX_DISCOVERY_BYTES = 2 * 1024 * 1024
API_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"
_PMID = re.compile(r"[1-9][0-9]{0,11}")
_PMCID = re.compile(r"PMC[1-9][0-9]{0,11}")


class OADiscoveryError(ValueError):
    """Invalid/incomplete metadata: retry later, never cache an OA absence."""


def _pmid(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("PMID must be an ASCII positive integer")
    result = str(value)
    if not _PMID.fullmatch(result):
        raise ValueError("PMID must be an ASCII positive integer of at most 12 digits")
    return result


def _check_deadline(deadline):
    if deadline is not None and not deadline > time.monotonic():
        raise TimeoutError("OA discovery budget expired")


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise OADiscoveryError("Duplicate metadata field")
        result[key] = value
    return result


def _downloader(download):
    if download is None:
        # Reuse verified TLS, no redirects, bounded reads and the source gate.
        from fulltext import download as default_download
        return default_download
    return download


def discover_oa_batch(pmids, *, deadline=None, request_gate=None, download=None):
    """Return availability keyed by PMID after one complete metadata response.

    Accept at most 50 input IDs, deduplicated while preserving order. An
    ``available`` entry includes ``pmcid`` and a canonical ``source_url``;
    ``unavailable`` includes ``reason`` (``not_open_access`` or ``not_indexed``).
    Transport/source-gate exceptions propagate unchanged so the caller can apply
    provider cooldowns. OADiscoveryError means no observation is usable.
    """
    if isinstance(pmids, (str, bytes)):
        raise ValueError("Supply a batch of PMIDs, not a single string")
    requested = {}
    for count, value in enumerate(pmids, 1):
        if count > MAX_DISCOVERY_BATCH:
            raise ValueError("OA discovery batch exceeds 50 PMIDs")
        requested[_pmid(value)] = None
    if not requested:
        return {}
    _check_deadline(deadline)
    query = "(" + " OR ".join(f"EXT_ID:{pmid}" for pmid in requested) + ") AND SRC:MED"
    params = urlencode({"query": query, "format": "json", "resultType": "lite",
                        "pageSize": MAX_DISCOVERY_BATCH, "cursorMark": "*"})
    raw = _downloader(download)(f"{API_BASE}/search?{params}",
                                deadline=deadline, request_gate=request_gate)
    _check_deadline(deadline)
    if not isinstance(raw, (bytes, str)) or len(raw) > MAX_DISCOVERY_BYTES:
        raise OADiscoveryError("Invalid or oversized discovery response")
    try:
        result = json.loads(raw, object_pairs_hook=_strict_object)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise OADiscoveryError("Malformed discovery response") from exc
    if not isinstance(result, dict):
        raise OADiscoveryError("Discovery response must be an object")
    count = result.get("hitCount")
    listing = result.get("resultList")
    records = listing.get("result") if isinstance(listing, dict) else None
    if (type(count) is not int or not isinstance(records, list)
            or count != len(records) or not 0 <= count <= len(requested)):
        raise OADiscoveryError("Discovery response is incomplete or has an invalid count")

    # Build all observations only in memory; a single invalid record aborts the
    # whole response rather than turning omitted records into false negatives.
    found = {}
    for record in records:
        if not isinstance(record, dict):
            raise OADiscoveryError("Invalid discovery record")
        pmid = record.get("id")
        if (not isinstance(pmid, str) or pmid not in requested
                or pmid in found or record.get("source") != "MED"):
            raise OADiscoveryError("Unexpected, duplicate or mismatched discovery identity")
        oa = record.get("isOpenAccess")
        if oa not in ("Y", "N"):
            raise OADiscoveryError("Missing or invalid open-access status")
        if oa == "Y":
            pmcid = record.get("pmcid")
            if not isinstance(pmcid, str) or not _PMCID.fullmatch(pmcid):
                raise OADiscoveryError("Open-access record has no valid PMCID")
            found[pmid] = {"status": "available", "pmcid": pmcid,
                           "source_url": f"{API_BASE}/{pmcid}/fullTextXML"}
        else:
            found[pmid] = {"status": "unavailable", "reason": "not_open_access"}
    _check_deadline(deadline)
    return {pmid: found.get(pmid, {"status": "unavailable", "reason": "not_indexed"})
            for pmid in requested}


def fetch_discovered_oa(pmid, discovery, *, deadline=None, request_gate=None, download=None):
    """Fetch an available canonical XML URL without repeating metadata search.

    The caller must still parse and validate article identity/body, exactly as
    for fetch_oa. Availability metadata is not acquisition success.
    """
    pmid = _pmid(pmid)
    record = discovery.get(pmid) if isinstance(discovery, dict) else None
    if not isinstance(record, dict):
        raise OADiscoveryError("PMID has no discovery observation")
    if record.get("status") == "unavailable":
        if record.get("reason") not in ("not_open_access", "not_indexed"):
            raise OADiscoveryError("Invalid unavailability observation")
        from fulltext import FulltextUnavailable
        raise FulltextUnavailable("No Europe PMC open-access full text in this discovery result")
    pmcid = record.get("pmcid")
    if (record.get("status") != "available" or not isinstance(pmcid, str)
            or not _PMCID.fullmatch(pmcid)):
        raise OADiscoveryError("Invalid available discovery observation")
    url = f"{API_BASE}/{pmcid}/fullTextXML"
    if record.get("source_url") != url:
        raise OADiscoveryError("Discovery URL does not match the canonical Europe PMC endpoint")
    _check_deadline(deadline)
    content = _downloader(download)(url, deadline=deadline, request_gate=request_gate)
    _check_deadline(deadline)
    return content, url
