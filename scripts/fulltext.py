"""Z8 worker: import authorized local PDF/HTML/XML or download authorized API XML.

Institution-network browser collection is handled by institution_worker.py.
Use --publish to persist a successfully parsed document to the private service table.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import ssl
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPSHandler, HTTPRedirectHandler
from urllib.error import HTTPError

import requests
from common import supabase_headers
from bs4 import BeautifulSoup
from defusedxml import ElementTree as ET
from pypdf import PdfReader

MAX_BYTES = 20 * 1024 * 1024
MAX_CHARS = 600_000


class FulltextUnavailable(ValueError):
    """The provider has no open-access document for this PMID."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward publisher credentials to another location.


def download(url, headers=None):
    # Windows uses its institution trust store. TLS verification remains enabled.
    request = Request(url, headers={"User-Agent": "UroDailyPick/1.0", "Accept": "application/xml, application/json", **(headers or {})})
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    with opener.open(request, timeout=45) as response:
        content = response.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ValueError("Document exceeds 20 MB")
    return content


def fetch_oa(pmid):
    query = urlencode({"query": f"EXT_ID:{pmid} AND SRC:MED", "format": "json"})
    result = json.loads(download(f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?{query}"))
    papers = result.get("resultList", {}).get("result", [])
    paper = next((p for p in papers if str(p.get("id")) == pmid and p.get("isOpenAccess") == "Y"), None)
    pmcid = paper.get("pmcid", "") if paper else ""
    if not re.fullmatch(r"PMC\d+", pmcid):
        raise FulltextUnavailable("No Europe PMC open-access full text; import your authorized local download")
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
    return download(url), url


def fetch_elsevier(pmid):
    key = os.environ.get("ELSEVIER_API_KEY")
    if not key:
        raise ValueError("ELSEVIER_API_KEY is required for the Elsevier provider")
    url = f"https://api.elsevier.com/content/article/pubmed_id/{pmid}?view=FULL"
    headers = {"X-ELS-APIKey": key, "Accept": "text/xml"}
    if os.environ.get("ELSEVIER_INST_TOKEN"):
        headers["X-ELS-Insttoken"] = os.environ["ELSEVIER_INST_TOKEN"]
    return download(url, headers), url


def parse_document(content):
    if not content or len(content) > MAX_BYTES:
        raise ValueError("Empty or oversized document")
    sections, license_text = [], None
    if content.startswith(b"%PDF-"):
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            raise ValueError("Encrypted PDF; provide an accessible document")
        if len(reader.pages) > 300:
            raise ValueError("PDF exceeds 300 pages")
        for index, page in enumerate(reader.pages, 1):
            sections.append({"title": f"Page {index}", "text": page.extract_text() or ""})
        kind = "pdf"
    else:
        # XML needs a real article body; abstracts and API metadata are not full text.
        try:
            root = ET.fromstring(content)
        except (ET.ParseError, ValueError):
            root = None
        if root is not None:
            local = lambda element: element.tag.rsplit("}", 1)[-1] if isinstance(element.tag, str) else ""
            body = next((node for node in root.iter() if local(node) == "body"), None)
            # XHTML <body> alone is not an article XML body.
            if local(root) not in ("article", "full-text-retrieval-response"):
                body = None
            elif body is None and not (local(root)=="article" and any(local(node) in {"h1","h2","h3"} for node in root.iter())):
                raise ValueError("Article XML contains metadata or abstract only")
            if body is not None:
                for child in body:
                    title = next((" ".join(n.itertext()).strip() for n in child if local(n) in ("title", "section-title")), "Body")
                    text = " ".join(" ".join(child.itertext()).split())
                    if text:
                        sections.append({"title": title, "text": text})
                license_text = next((" ".join(n.itertext()).strip() for n in root.iter() if local(n) == "license"), None)
        if sections:
            kind = "xml"
        else:
            soup = BeautifulSoup(content, "html.parser")
            for node in soup.select("script, style, nav, header, footer, form, aside"):
                node.decompose()
            body = next((soup.select_one(selector) for selector in
                ("#body", ".article-section__full", ".article__body", ".c-article-body", ".article-full-text", ".article-body", "article", "main")
                if soup.select_one(selector) is not None), None)
            if body is None:
                raise ValueError("No article body (login/challenge/metadata response)")
            title, paragraphs = "Body", []
            for node in body.select("h1, h2, h3, p, table, div.para, div.section-paragraph, div.u-margin-s-bottom[id]"):
                if node.find_parent("table"):
                    continue
                if node.find_parent("div", class_=["para", "section-paragraph"]):
                    continue
                if node.find_parent(lambda parent: parent.name == "div" and parent.get("id")
                        and "u-margin-s-bottom" in parent.get("class", [])):
                    continue
                if node.name.startswith("h"):
                    if paragraphs:
                        sections.append({"title": title, "text": "\n".join(paragraphs)})
                    title, paragraphs = node.get_text(" ", strip=True), []
                else:
                    paragraphs.append(node.get_text(" ", strip=True))
            if paragraphs:
                sections.append({"title": title, "text": "\n".join(paragraphs)})
            kind = "html"
    text = "\n\n".join(f"{s['title']}\n{s['text']}" for s in sections if s["text"].strip())
    if len(text) < 500:
        raise ValueError("Insufficient article text; scanned PDFs need OCR before import")
    if len(text) > MAX_CHARS:
        raise ValueError("Extracted document too large")
    if re.search(r"(verify you are human|enable javascript and cookies|checking your browser|access denied)", text[:2000], re.I):
        raise ValueError("Access challenge is not article text")
    return {"content_text": text, "sections": sections, "license": license_text,
            "content_hash": hashlib.sha256(text.encode()).hexdigest(), "source": kind}


def publish(pmid, parsed, source_url, source):
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY required for --publish")
    headers = {**supabase_headers(key)}
    response = requests.get(f"{url}/rest/v1/papers", headers=headers,
                            params={"pmid": f"eq.{pmid}", "select": "id"}, timeout=30)
    response.raise_for_status()
    papers = response.json()
    if len(papers) != 1:
        raise ValueError("PMID must already exist in the paper catalog")
    response = requests.post(f"{url}/rest/v1/rpc/store_paper_fulltext", headers=headers,
        json={"p_paper_id": papers[0]["id"], "p_document": {**parsed, "source_url": source_url, "source": source}}, timeout=45)
    response.raise_for_status()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pmid", required=True)
    parser.add_argument("--input", type=Path, help="Authorized PDF, article HTML, or JATS XML")
    parser.add_argument("--provider", choices=["oa", "elsevier"], default="oa", help="Download provider when --input is omitted")
    parser.add_argument("--publish", action="store_true", help="Store parsed text privately in Supabase")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{1,12}", args.pmid):
        parser.error("PMID must be numeric")
    try:
        if args.input:
            if args.input.stat().st_size > MAX_BYTES:
                raise ValueError("Document exceeds 20 MB")
            content, source_url = args.input.read_bytes(), None
        elif args.provider == "elsevier":
            content, source_url = fetch_elsevier(args.pmid)
        else:
            content, source_url = fetch_oa(args.pmid)
        parsed = parse_document(content)
        source = f"local_{parsed['source']}" if args.input else "elsevier_api" if args.provider == "elsevier" else "europe_pmc_oa"
        if args.publish:
            publish(args.pmid, parsed, source_url, source)
        print(json.dumps({"pmid": args.pmid, "source": source, "characters": len(parsed["content_text"]),
                          "sections": len(parsed["sections"]), "published": args.publish}))
    except HTTPError as error:
        raise SystemExit(f"Full-text download returned HTTP {error.code}. Check provider access or quota. No document was published.") from None
    except (ValueError, OSError, requests.RequestException) as error:
        # Do not overwrite a previously valid document after a failed fetch or parse.
        raise SystemExit(f"Full-text import failed: {type(error).__name__}. No document was published.") from None


if __name__ == "__main__":
    main()
