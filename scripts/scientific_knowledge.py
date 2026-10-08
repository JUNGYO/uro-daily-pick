"""Source-bound scientific records for the shared corpus, independent of reader summaries.

Verbatim evidence and extraction history stay local. Only short structured fields,
derived results, bibliographic identifiers and source locators are published.
"""
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from xml.etree import ElementTree as ET

RECIPE = "scientific-v1"
FACT_FIELDS = ("design", "population", "intervention", "comparator", "sample_size",
               "follow_up", "outcome", "limitation")
MEASURES = ("HR", "RR", "OR", "MD", "SMD", "AUC", "sensitivity", "specificity",
            "proportion", "rate", "other")
PROMPT = """
Also extract science.facts (at most 5) and science.results (at most 3).
These describe THIS article, never a cited study. Empty arrays are valid.
Facts: field is design/population/intervention/comparator/sample_size/follow_up/outcome/limitation.
Value is a short exact English phrase from its evidence quote (max 160 characters).
Use distinct facts for distinct cohorts, arms or follow-up times. Do not collapse them.
Results: only this article's explicitly reported numerical results. Copy outcome, population,
comparison, timepoint and unit as short EXACT source phrases; use null when not stated.
Measure is HR/RR/OR/MD/SMD/AUC/sensitivity/specificity/proportion/rate/other.
Estimate and CI values are numeric strings exactly as printed, without percent signs or commas.
CI low/high/level must all be null when no confidence interval is explicitly reported.
Do not turn ranges or IQRs into confidence intervals. Never compute missing statistics.
Adjustment is adjusted/unadjusted/not_reported; do not infer it. Include context in the quote.
Evidence is 1..3 exact source quotes, 12..500 characters each, with their numbered location.
Every phrase and number must occur in those QUOTES, not merely elsewhere in the fragment.
Do not infer study independence, certainty, contradictions or a clinical recommendation.
"""


def schema(blocks):
    evidence = {"type": "array", "minItems": 1, "maxItems": 3, "items": {
        "type": "object", "additionalProperties": False, "required": ["location", "quote"],
        "properties": {"location": {"type": "string", "enum": [b["id"] for b in blocks]},
                       "quote": {"type": "string", "minLength": 12, "maxLength": 500}}}}
    optional = lambda maximum: {"type": ["string", "null"], "maxLength": maximum}
    fields = {k: optional(120) for k in ("outcome", "population", "comparison", "timepoint", "unit")}
    fields.update({k: optional(24) for k in ("estimate", "ci_low", "ci_high", "ci_level")})
    fields.update({"measure": {"type": "string", "enum": list(MEASURES)},
                   "adjustment": {"type": "string", "enum": ["adjusted", "unadjusted", "not_reported"]},
                   "evidence": evidence})
    fields["estimate"] = {"type": "string", "maxLength": 24}
    return {"type": "object", "additionalProperties": False, "required": ["facts", "results"], "properties": {
        "facts": {"type": "array", "maxItems": 5, "items": {"type": "object", "additionalProperties": False,
            "required": ["field", "value", "evidence"], "properties": {"field": {"type": "string", "enum": list(FACT_FIELDS)},
            "value": {"type": "string", "minLength": 2, "maxLength": 160}, "evidence": evidence}}},
        "results": {"type": "array", "maxItems": 3, "items": {"type": "object", "additionalProperties": False,
            "required": list(fields), "properties": fields}}}}


def quoted(evidence, blocks):
    from knowledge import evidence_text
    evidence_text(evidence, blocks)
    if any(len(e['quote']) > 500 for e in evidence):
        raise ValueError("Scientific quotation too long")
    return " ".join(e['quote'] for e in evidence)


def phrase(value, source, maximum=160):
    if value is None:
        return
    from knowledge import canonical, string
    if not string(value, 1, maximum) or re.search(r"[\uac00-\ud7af]", value):
        raise ValueError("Invalid scientific phrase")
    term = canonical(value)
    pattern = (r"(?<!\w)" if term[0].isalnum() else '') + re.escape(term) + (r"(?!\w)" if term[-1].isalnum() else '')
    if not re.search(pattern, canonical(source)):
        raise ValueError("Scientific phrase absent from quoted evidence")


def numeric(value, source):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"-?(?:\d{1,12})(?:\.\d{1,10})?", value):
        raise ValueError("Invalid result number")
    if not re.search(r"(?<![\d.])" + re.escape(value) + r"(?![\d.])", source.replace(',', '')):
        raise ValueError("Result number absent from quoted evidence")
    return Decimal(value)


def validate(value, blocks):
    if not isinstance(value, dict) or set(value) != {'facts', 'results'}:
        raise ValueError("Invalid scientific extraction")
    if not isinstance(value['facts'], list) or len(value['facts']) > 5 or not isinstance(value['results'], list) or len(value['results']) > 3:
        raise ValueError("Scientific extraction exceeds limits")
    for f in value['facts']:
        if not isinstance(f, dict) or set(f) != {'field', 'value', 'evidence'} or f['field'] not in FACT_FIELDS:
            raise ValueError("Invalid study field")
        phrase(f['value'], quoted(f['evidence'], blocks))
    keys = {'measure','estimate','ci_low','ci_high','ci_level','outcome','population','comparison','timepoint','unit','adjustment','evidence'}
    for r in value['results']:
        if not isinstance(r, dict) or set(r) != keys or r['measure'] not in MEASURES or r['adjustment'] not in ('adjusted','unadjusted','not_reported'):
            raise ValueError("Invalid numerical result")
        source = quoted(r['evidence'], blocks)
        for k in ('outcome','population','comparison','timepoint','unit'):
            phrase(r[k], source, 120)
        estimate = numeric(r['estimate'], source)
        if estimate is None:
            raise ValueError("Missing estimate")
        ci = [numeric(r[k], source) for k in ('ci_low','ci_high','ci_level')]
        if any(v is not None for v in ci):
            if any(v is None for v in ci) or not ci[0] <= estimate <= ci[1] or not 0 < ci[2] < 100:
                raise ValueError("Inconsistent confidence interval")
            if not re.search(r"\bCI\b|confidence", source, re.I):
                raise ValueError("No explicit confidence interval")
        if r['measure'] in ('HR','RR','OR'):
            names = {'HR': 'hazard ratio', 'RR': 'risk ratio|relative risk', 'OR': 'odds ratio'}
            if estimate <= 0 or (ci[0] is not None and ci[0] <= 0):
                raise ValueError("Ratio must be positive")
            if not re.search(r'\b(?:' + r['measure'] + '|' + names[r['measure']] + r')\b', source, re.I):
                raise ValueError("Ratio type absent from evidence")
        if r['measure'] == 'AUC' and not 0 <= estimate <= 1:
            raise ValueError("AUC outside unit interval")
        if r['measure'] in ('sensitivity','specificity','proportion') and not 0 <= estimate <= (100 if r['unit'] == '%' else 1):
            raise ValueError("Proportion requires its stated scale")
        if r['adjustment'] != 'not_reported' and not re.search(r'\b' + r['adjustment'] + r'\b', source, re.I):
            raise ValueError("Adjustment absent from evidence")
    return value


def accepted(value, blocks):
    """Reject individual unsupported candidates; keep explicit rejected counts locally."""
    if not isinstance(value, dict) or set(value) != {'facts','results'} or any(not isinstance(value[k],list) for k in value):
        raise ValueError('Invalid scientific extraction')
    result = {'facts': [], 'results': []}
    rejected = 0
    for key, maximum in [('facts',5), ('results',3)]:
        if len(value[key]) > maximum:
            raise ValueError('Scientific extraction exceeds limits')
        for item in value[key]:
            try:
                validate({'facts': [item] if key == 'facts' else [], 'results': [item] if key == 'results' else []}, blocks)
                result[key].append(item)
            except (ValueError, TypeError, KeyError, InvalidOperation):
                rejected += 1
    return result, rejected


def date_record(node, kind):
    if node is None:
        return None
    parts = {key: (node.findtext(key) or '').strip() for key in ('Year','Month','Day','MedlineDate')}
    raw = ' '.join(v for v in parts.values() if v)
    year = parts['Year']
    if not year.isdigit():
        match = re.search(r'\b(\d{4})\b', parts['MedlineDate'])
        year = match[1] if match else ''
    month = parts['Month']
    months = dict(zip('jan feb mar apr may jun jul aug sep oct nov dec'.split(), range(1,13)))
    month = str(months.get(month.lower()[:3], month))
    try:
        # Preserve precision; never present an invented January 1 as an exact date.
        y = int(year)
        if not 1 <= y <= 9999:
            return None
        precision = 'year'
        formatted = f'{y:04d}'
        if month.isdigit() and 1 <= int(month) <= 12:
            formatted += f'-{int(month):02d}'; precision = 'month'
            if parts['Day'].isdigit():
                formatted = date(y, int(month), int(parts['Day'])).isoformat(); precision = 'day'
        if parts['MedlineDate']:
            precision = 'range'  # The original season/range is retained, never collapsed to a day.
        return {'kind': kind, 'date': formatted, 'precision': precision, 'raw': raw[:120]}
    except ValueError:
        return {'kind': kind, 'date': year, 'precision': 'year', 'raw': raw[:120]} if year.isdigit() else None


def pubmed_metadata(article, pmid):
    if (article.findtext('./MedlineCitation/PMID') or '').strip() != pmid:
        raise ValueError('Bibliographic identity mismatch')
    content = lambda node: ' '.join(''.join(node.itertext()).split()) if node is not None else ''
    dates = [date_record(article.find('.//JournalIssue/PubDate'), 'journal')]
    dates += [date_record(n, n.get('DateType','article').lower()) for n in article.findall('.//ArticleDate')]
    dates += [date_record(n, n.get('PubStatus','history').lower()) for n in article.findall('.//PubMedPubDate')]
    ids = {n.get('IdType'): (n.text or '').strip() for n in article.findall('./PubmedData/ArticleIdList/ArticleId')}
    mesh = [{'id': n.get('UI'), 'label': content(n)} for n in article.findall('.//MeshHeading/DescriptorName') if re.fullmatch(r'D\d+', n.get('UI',''))]
    registries = sorted({n.text.strip() for bank in article.findall('.//DataBank')
                        for n in bank.findall('./AccessionNumberList/AccessionNumber')
                        if n.text and re.fullmatch(r'(?:NCT\d{8}|ISRCTN\d{8})',n.text.strip(),re.I)})
    refs = []
    for i, ref in enumerate(article.findall('./PubmedData/ReferenceList//Reference')):
        identifiers = {n.get('IdType'): (n.text or '').strip() for n in ref.findall('./ArticleIdList/ArticleId')}
        if identifiers.get('pubmed','').isdigit() or identifiers.get('doi','').startswith('10.'):
            refs.append({'source_id': f'pubmed-ref-{i+1}', 'pmid': identifiers.get('pubmed') if identifiers.get('pubmed','').isdigit() else None,
                         'doi': identifiers.get('doi') if identifiers.get('doi','').startswith('10.') else None})
    result = {'source': 'PubMed', 'fetched_at': datetime.now(timezone.utc).isoformat(), 'pmid': pmid,
        'title': content(article.find('.//ArticleTitle')), 'doi': ids.get('doi') or None, 'pmcid': ids.get('pmc') or None,
        'journal': article.findtext('.//Journal/Title',''), 'volume': article.findtext('.//JournalIssue/Volume',''),
        'issue': article.findtext('.//JournalIssue/Issue',''), 'pages': article.findtext('.//Pagination/MedlinePgn',''),
        'authors': [content(n.find('CollectiveName')) or ' '.join(filter(None,[n.findtext('LastName'),n.findtext('ForeName')])) for n in article.findall('.//Author')],
        'issns': sorted({n.text for n in article.findall('.//ISSN') if n.text}), 'dates': [d for d in dates if d],
        'publication_types': [content(n) for n in article.findall('.//PublicationType')], 'mesh': mesh,
        'registry_ids': registries, 'references': refs[:500],
        'related_articles': [{'pmid': n.findtext('PMID'), 'relation': n.get('RefType','')} for n in article.findall('.//CommentsCorrections') if (n.findtext('PMID') or '').isdigit()]}
    return result


def bibliography(paper, directory, *, fetch=True):
    """Cache NLM metadata separately. This endpoint receives only a public PMID."""
    import requests
    from local_summary import _checkpoint
    pmid = str(paper['pmid'])
    if not re.fullmatch(r'\d{1,12}', pmid):
        raise ValueError('Invalid PMID')
    target = directory / 'bibliography' / (pmid + '.json')
    try:
        saved = json.loads(target.read_text(encoding='utf-8'))
        age = datetime.now(timezone.utc) - datetime.fromisoformat(saved['fetched_at'])
        if saved['pmid'] == pmid and age.days < 30:
            return saved
    except (OSError, ValueError, KeyError):
        pass
    if fetch:
        try:
            response = requests.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
                params={'db':'pubmed','id':pmid,'retmode':'xml','tool':'uro_daily_pick'},timeout=20)
            response.raise_for_status()
            if len(response.content) > 5_000_000:
                raise ValueError('Oversized metadata response')
            root = ET.fromstring(response.content)
            articles = root.findall('./PubmedArticle')
            if len(articles) != 1:
                raise ValueError('Incomplete metadata response')
            value = pubmed_metadata(articles[0], pmid)
            # Match the current title, not just a reused or mismatched cached document.
            from knowledge import canonical
            if canonical(value['title']).rstrip('.') != canonical(paper['title']).rstrip('.'):
                raise ValueError('Bibliographic title changed')
            target.parent.mkdir(parents=True,exist_ok=True)
            _checkpoint(target,value)
            return value
        except (requests.RequestException, OSError, ValueError, ET.ParseError):
            pass
    return {**{k:paper.get(k) for k in ('pmid','title','doi','journal','volume','issue','pages')}, 'authors':paper.get('authors') or [],
        'source':'catalog','fetched_at':None,'pmcid':None,'issns':[],
        'dates':[{'kind':'catalog','date':paper.get('pub_date'),'precision':'unknown','raw':paper.get('pub_date')}],
        'publication_types':paper.get('publication_types') or paper.get('pub_types') or [],
        'mesh':[],'registry_ids':[],'references':[],'related_articles':paper.get('related_notices',[])}


def publication(row, fragments, bib, document):
    from knowledge import digest, now, canonical
    from local_summary import MODEL
    facts, results = {}, {}
    for fragment in fragments:
        science = fragment.get('science', {'facts':[], 'results':[]})
        for key, destination in [('facts',facts), ('results',results)]:
            for item in science[key]:
                clean = {k:v for k,v in item.items() if k != 'evidence'}
                clean['locations'] = sorted({e['location'] for e in item['evidence']})
                clean['id'] = digest(clean)[:24]
                destination[clean['id']] = clean
    # Exact source-backed registry strings are candidate links, never proof of study independence.
    body = document['content_text']
    references_start = re.search(r'(?im)^\s*(?:references|bibliography)\s*$',body)
    main = body[:references_start.start()] if references_start else body
    # Prefer trial registrations explicitly supplied by PubMed. Text mentions may be prior studies.
    mentions = sorted(set(re.findall(r'\b(?:NCT\d{8}|ISRCTN\d{8})\b',main,re.I)))[:100]
    # References already identified by the original parser can supplement NLM's
    # list, but only explicit DOI / PMID strings become graph edges.
    bib = {**bib, 'references':list(bib['references'])}
    known = {(r.get('pmid'),r.get('doi')) for r in bib['references']}
    for ref in (document.get('reading_layout') or {}).get('references',[]):
        text = ref.get('text','')
        doi = re.search(r'\b10\.\d{4,9}/[^\s<>"\]]+',text,re.I)
        pmid = re.search(r'\bPMID\s*:?\s*(\d{1,12})\b',text,re.I)
        record = {'source_id':'original-ref-'+str(ref.get('id',''))[:60],
                  'doi':doi[0].rstrip('.,;)') if doi else None,'pmid':pmid[1] if pmid else None}
        pair = (record['pmid'],record['doi'])
        if any(pair) and pair not in known and len(bib['references'])<500:
            known.add(pair);bib['references'].append(record)
    terms = []
    for fragment in fragments:
        for c in fragment['concepts']:
            from knowledge import concept_id
            for mesh in bib['mesh']:
                if canonical(mesh['label']) in [canonical(x) for x in [c['label'],*c['aliases']]]:
                    terms.append({'concept_id':concept_id(c['kind'],c['label']),'system':'MeSH','id':mesh['id'],'label':mesh['label']})
    return {'version':RECIPE,'pmid':row['pmid'],'title':json.loads(row['paper'])['title'],
        'content_hash':row['content_hash'],'bibliography':bib,
        'facts':list(facts.values())[:160],'results':list(results.values())[:80],
        'terminology':list({(t['concept_id'],t['id']):t for t in terms}.values())[:256],
        'registry_mentions':mentions,
        'provenance':{'model':MODEL,'recipe':RECIPE,'extracted_at':now(),'validation':'source_checked','review_status':'unreviewed',
                      'chunks':len(fragments),'rejected_candidates':sum(f.get('science_rejected',0) for f in fragments)},
        'coverage':{'facts_total':len(facts),'results_total':len(results),'facts_published':min(160,len(facts)),'results_published':min(80,len(results))}}
