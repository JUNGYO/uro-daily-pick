"""Durable local completion, independent of the service synchronization loop."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from catalog_policy import AUTOMATIC_START_DATE
from evidence import BASE_FIELDS, validate_metadata
from local_summary import MODEL_LABEL, summary_payload, validate_cached_summary
from summarize_papers import validate_summary


def _text(value, minimum, maximum):
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or "\x00" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeError:
        return False
    return True


def validate_publication_payload(kind, values):
    """Only bounded derived fields may enter the durable cloud outbox."""
    keys = {"p_pmid", "p_doi", "p_title", "p_source"}
    if kind == "summary":
        keys.add("p_summary")
    if kind not in {"original", "summary"} or not isinstance(values, dict) or set(values) != keys:
        raise ValueError("Only acquisition and derived summary metadata may be queued")
    if (not isinstance(values["p_pmid"], str) or not re.fullmatch(r"\d{1,12}", values["p_pmid"])
            or not _text(values["p_title"], 1, 10000)
            or values["p_doi"] is not None and not _text(values["p_doi"], 0, 1000)):
        raise ValueError("Invalid publication identity")
    source = values["p_source"]
    source_keys = {"content_hash", "characters", "section_count", "source_url"}
    if kind == "original":
        source_keys.add("summary_source_hash")
    if not isinstance(source, dict) or set(source) != source_keys:
        raise ValueError("Only source metadata may be queued")
    for name in ("content_hash", "summary_source_hash"):
        if name in source and not re.fullmatch(r"[0-9a-f]{64}", str(source[name])):
            raise ValueError("Invalid source hash")
    if (type(source["characters"]) is not int or not 2000 <= source["characters"] <= 600000
            or type(source["section_count"]) is not int or not 2 <= source["section_count"] <= 1000
            or not _text(source["source_url"], 1, 1000)):
        raise ValueError("Incomplete acquisition metadata")
    url = urlsplit(source["source_url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Invalid source URL")
    if kind == "original":
        return
    summary = values["p_summary"]
    summary_keys = {"summary_ko", "structured_data", "clinical_relevance", "qa_data", "summary_model",
                    "summary_source_hash", "evidence", "research_details"}
    if not isinstance(summary, dict) or set(summary) != summary_keys:
        raise ValueError("Only validated derived summary fields may be queued")
    if (not isinstance(summary["structured_data"], dict) or set(summary["structured_data"]) != set(BASE_FIELDS)
            or not isinstance(summary["qa_data"], list)
            or any(not isinstance(item, dict) or set(item) != {"q", "a"} for item in summary["qa_data"])
            or not re.fullmatch(r"spark/[a-zA-Z0-9:._/-]{1,80}", str(summary["summary_model"]))
            or not re.fullmatch(r"[0-9a-f]{64}", str(summary["summary_source_hash"]))):
        raise ValueError("Invalid derived summary metadata")
    validate_summary(json.dumps({"summary_ko": summary["summary_ko"], "structured": summary["structured_data"],
        "qa": summary["qa_data"], "clinical_relevance": summary["clinical_relevance"]}, ensure_ascii=False))
    validate_metadata(summary["evidence"], summary["research_details"])
    if summary["evidence"]["content_hash"] != source["content_hash"]:
        raise ValueError("Summary evidence does not match the original")


class LocalService:
    """Local reader phases never require a cloud credential or a network request.

    The separate sync phase owns every cloud write. A completed local summary is
    ready for local work while its outbox event can remain unsynchronized.
    """
    publication_is_local = True
    summary_deadline = None

    def __init__(self, directory, cloud=None, *, catalog=None):
        self.directory = Path(directory)
        if catalog is None:
            from local_catalog import LocalCatalog
            catalog = LocalCatalog(self.directory)
        self.catalog = catalog
        self.cloud = cloud  # Optional reference for callers; never used by local phases.

    def close(self):
        self.catalog.close()

    def status(self, state, pmid=None, status=None):
        if state not in {"running", "idle", "error"}:
            raise ValueError("Invalid local worker state")
        if pmid is not None and not re.fullmatch(r"\d{1,12}", str(pmid)):
            raise ValueError("Invalid local worker PMID")
        if status is not None and status not in {"ready", "access_required", "challenge", "unsupported", "parse_failed", "retryable_error"}:
            raise ValueError("Invalid local worker status")
        self.catalog.set_meta("worker_status", {"state": state, "pmid": pmid, "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat()})

    def candidates(self, pmid=None, include_summary=False):
        rows = self.catalog.get_papers([pmid]) if pmid else self.catalog.worker_candidates(include_summary=False)
        originals = {path.stem for folder in ("documents", "cloud-archive")
                     for path in (self.directory / folder).glob("*.json")
                     if re.fullmatch(r"\d{1,12}", path.stem)}
        selected = []
        for paper in rows:
            identity = str(paper["pmid"])
            if not pmid and (paper.get("pub_date") or "") < AUTOMATIC_START_DATE:
                continue
            local_original = identity in originals
            if include_summary:
                if not local_original:
                    continue
                lines = [line for line in str(paper.get("summary_ko") or "").splitlines() if line.strip()]
                ready = (paper.get("fulltext_available") is True and paper.get("summary_basis") == "fulltext"
                    and paper.get("summary_model") == MODEL_LABEL and bool(paper.get("summarized_at"))
                    and bool(re.fullmatch(r"[0-9a-f]{64}", str(paper.get("summary_source_hash") or "")))
                    and len(lines) == 3 and bool(paper.get("structured_data")) and bool(paper.get("qa_data"))
                    and (not paper.get("acquired_source_hash")
                         or paper["acquired_source_hash"] == paper["summary_source_hash"]))
                if ready and not pmid:
                    continue
            elif local_original and paper.get("fulltext_available") is True:
                continue
            selected.append(paper)
        selected.sort(key=lambda paper: paper.get("pub_date") or "", reverse=True)
        return selected

    def automatic_figure_pmids(self, pmids):
        return {str(row["pmid"]) for row in self.catalog.get_papers(pmids)
                if (row.get("pub_date") or "") >= AUTOMATIC_START_DATE}

    def register_original(self, paper, document):
        body = document["content_text"]
        if hashlib.sha256(body.encode()).hexdigest() != document["content_hash"]:
            raise ValueError("Original hash mismatch")
        values = {"p_pmid": str(paper["pmid"]), "p_doi": paper.get("doi"), "p_title": paper["title"],
            "p_source": {"content_hash": document["content_hash"], "characters": len(body),
                "section_count": len(document["sections"]), "source_url": document["source_url"],
                "summary_source_hash": hashlib.sha256(("fulltext\n" + paper["title"] + "\n" + body).encode()).hexdigest()}}
        validate_publication_payload("original", values)
        return self.catalog.enqueue("original", values)

    def rpc(self, name, **values):
        if name != "publish_institution_summary":
            raise ValueError("Local phases only stage derived summaries")
        validate_publication_payload("summary", values)
        # Recheck the canonical local body at the persistence boundary. An outbox
        # entry must never convert a stale or merely well-shaped cache into ready.
        from institution_worker import cached_paper_matches, verify_cached_body
        paper = {"pmid": values["p_pmid"], "doi": values["p_doi"], "title": values["p_title"]}
        document = None
        for folder in ("documents", "cloud-archive"):
            path = self.directory / folder / (paper["pmid"] + ".json")
            if path.is_file():
                saved = json.loads(path.read_text(encoding="utf-8"))
                if cached_paper_matches(saved["paper"] if folder == "cloud-archive" else saved, paper):
                    document = verify_cached_body(saved["document"])
                    break
        if document is None:
            raise ValueError("A matching local original is required")
        summary = validate_cached_summary(values["p_summary"], paper, document)
        expected = summary_payload(paper, document, summary)
        if expected != values:
            raise ValueError("Summary source metadata does not match the local original")
        self.register_original(paper, document)
        return self.catalog.enqueue("summary", expected)
