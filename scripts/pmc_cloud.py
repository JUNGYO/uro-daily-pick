"""Version-bound PMC Article Datasets downloads through its public HTTPS service.

Layout and licenses: https://pmc-oa-opendata.s3.amazonaws.com/README.txt
Original bytes remain with the caller. No publisher navigation or credentials.
"""
import hashlib
import json
import re
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from defusedxml import ElementTree as ET
from fulltext import FulltextUnavailable, download as default_download

BASE = "https://pmc-oa-opendata.s3.amazonaws.com/"
LICENSES = {"CC0", "CC BY", "CC BY-SA", "CC BY-ND", "CC BY-NC",
            "CC BY-NC-SA", "CC BY-NC-ND"}


def _object_url(value, prefix):
    if not isinstance(value, str):
        raise ValueError("Missing PMC object URL")
    value = value.replace("s3://pmc-oa-opendata/", BASE, 1)
    url = urlsplit(value)
    if (not value.startswith(BASE + prefix) or url.fragment or url.username or url.password
            or "/" in url.path[len("/" + prefix):] or "%" in url.path
            or ".." in url.path):
        raise ValueError("PMC object must belong to the selected article version")
    hashes = parse_qs(url.query)
    if (set(hashes) != {"md5"} or len(hashes["md5"]) != 1
            or not re.fullmatch(r"[0-9a-f]{32}", hashes["md5"][0])):
        raise ValueError("PMC object checksum missing or malformed")
    return value, hashes["md5"][0]


def fetch_pmc_cloud(paper, pmcid, *, deadline=None, request_gate=None, download=None):
    """Find an available version, validate identity/license/hash, return JATS and provenance."""
    pmid = str(paper["pmid"])
    if not re.fullmatch(r"[1-9][0-9]{0,11}", pmid) or not re.fullmatch(r"PMC[1-9][0-9]{0,11}", pmcid or ""):
        raise ValueError("Invalid PMC article identity")
    fetch = download or default_download
    def read(url, maximum=2*1024*1024):
        raw = fetch(url, deadline=deadline, request_gate=request_gate)
        if not isinstance(raw, bytes) or len(raw) > maximum:
            raise ValueError("Invalid or oversized PMC response")
        return raw
    raw = read(BASE + "?" + urlencode({"list-type": 2, "prefix": pmcid + ".",
                                      "delimiter": "/", "max-keys": 20}))
    root = ET.fromstring(raw)
    ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
    if root.tag != ns + "ListBucketResult" or root.findtext(ns + "IsTruncated") != "false":
        raise ValueError("Incomplete PMC version listing")
    prefixes = [node.findtext(ns + "Prefix") for node in root.findall(ns + "CommonPrefixes")]
    if len(prefixes) > 10 or any(not re.fullmatch(pmcid + r"\.[1-9][0-9]{0,5}/", p or "") for p in prefixes):
        raise ValueError("Invalid PMC version prefix")
    for prefix in sorted(set(prefixes), key=lambda p: int(p.split(".")[1][:-1]), reverse=True):
        metadata = json.loads(read(BASE + prefix + prefix[:-1] + ".json"))
        version = int(prefix.split(".")[1][:-1])
        if (not isinstance(metadata, dict) or metadata.get("pmcid") != pmcid
                or type(metadata.get("version")) is not int or metadata["version"] != version
                or str(metadata.get("pmid")) != pmid):
            raise ValueError("PMC metadata identity mismatch")
        doi = str(paper.get("doi") or "").strip().lower()
        if doi and str(metadata.get("doi") or "").strip().lower() != doi:
            raise ValueError("PMC DOI mismatch")
        license_code = metadata.get("license_code")
        if license_code not in LICENSES and not (license_code == "TDM" and metadata.get("is_manuscript") is True):
            continue
        url, digest = _object_url(metadata.get("xml_url"), prefix)
        if urlsplit(url).path != "/" + prefix + prefix[:-1] + ".xml":
            raise ValueError("Unexpected PMC XML filename")
        content = read(url, 20*1024*1024)
        if hashlib.md5(content, usedforsecurity=False).hexdigest() != digest:
            raise ValueError("PMC original checksum mismatch")
        article = ET.fromstring(content)
        local = lambda node: node.tag.rsplit("}", 1)[-1] if isinstance(node.tag, str) else ""
        if local(article) != "article":
            raise ValueError("PMC XML is not an article")
        # Bind the article's own front matter, never cited-reference IDs.
        front = next((n for n in article if local(n) == "front"), None)
        ids = [n for n in front.iter() if local(n) == "article-id"] if front is not None else []
        if {n.text for n in ids if n.get("pub-id-type") == "pmid"} != {pmid}:
            raise ValueError("PMC XML PMID mismatch")
        xml_dois = {str(n.text or "").strip().lower() for n in ids if n.get("pub-id-type") == "doi"}
        if doi and xml_dois != {doi}:
            raise ValueError("PMC XML DOI mismatch")
        media = metadata.get("media_urls", [])
        if not isinstance(media, list) or len(media) > 500:
            raise ValueError("Invalid PMC media manifest")
        media = [_object_url(value, prefix)[0] for value in media]
        source = urlsplit(url)
        provenance = {"provider": "pmc_cloud", "pmid": pmid, "pmcid": pmcid, "version": version,
                      "is_manuscript": metadata.get("is_manuscript") is True,
                      "license": license_code, "xml_md5": digest, "media_urls": media}
        return content, urlunsplit(source._replace(query="")), provenance
    raise FulltextUnavailable("No reusable PMC dataset version is currently available")


def document_media(document, pmid):
    """Use only the exact stored source version for figures, including manuscripts."""
    repository = document.get("repository")
    if not isinstance(repository, dict) or repository.get("provider") != "pmc_cloud":
        return None
    pmcid, version = repository.get("pmcid"), repository.get("version")
    if (repository.get("pmid") != pmid or not re.fullmatch(r"PMC[1-9][0-9]{0,11}", pmcid or "")
            or type(version) is not int or not 1 <= version <= 999999):
        raise ValueError("Invalid stored PMC media identity")
    prefix = f"{pmcid}.{version}/"
    if document.get("source_url") != BASE + prefix + prefix[:-1] + ".xml":
        raise ValueError("Stored PMC media version differs from original")
    media = repository.get("media_urls", [])
    if not isinstance(media, list) or len(media) > 500:
        raise ValueError("Invalid stored PMC media list")
    return [_object_url(value, prefix)[0] for value in media]
