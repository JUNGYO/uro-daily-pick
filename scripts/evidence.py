"""Deterministic text locations. Original strings remain in the local archive."""
import hashlib
import json
import re
from decimal import Decimal

DETAIL_FIELDS = ('intervention','comparator','follow_up','outcome','limitations')
BASE_FIELDS = ('study_design','sample_size','key_finding','population')

_GROUP_SEPARATORS = ',\u00a0\u2009\u202f'
_NUMBER = re.compile(r'(?<![\d.])([+\-\u2212]?)((?:\d+|\.\d+)(?:[.,\u00a0\u2009\u202f]\d+)*)(?!\d)')
_SCIENTIFIC = re.compile(
    r'(?<![\d.])(?:[+\-\u2212]?(?:\d+(?:\.\d+)?|\.\d+)\s*[eE]\s*[+\-\u2212]?\d+'
    r'|(?:[+\-\u2212]?(?:\d+(?:\.\d+)?|\.\d+)\s*[x\u00d7]\s*)?10'
    r'(?:\s*\^\s*\{?\s*[+\-\u2212]?\d+\s*\}?|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+))')
_NUMBER_WORDS = ('zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty')


def numeric_values(text, *, source=False):
    """Exact values only: no rounding, tolerances, or unit conversion.

    Claims with unsupported notation must be regenerated. Such source tokens
    cannot supply evidence for an unrelated integer or decimal. Source-only
    number-word expansion preserves the existing zero-through-twenty rule.
    """
    if source:
        for number, word in enumerate(_NUMBER_WORDS):
            text = re.sub(r'\b'+word+r'\b', str(number), text, flags=re.I)
    if _SCIENTIFIC.search(text):
        if not source:
            raise ValueError('Unsupported scientific notation in numeric claim')
        text = _SCIENTIFIC.sub(lambda match: ' ' * len(match.group()), text)
    values = set()
    for match in _NUMBER.finditer(text):
        sign, number = match.groups()
        # An ASCII hyphen directly between numbers denotes a range, not unary minus.
        if sign == '-' and match.start() and text[match.start()-1].isdecimal():
            sign = ''
        integer, dot, fraction = number.partition('.')
        separators = set(integer).intersection(_GROUP_SEPARATORS)
        valid = not dot or bool(fraction) and fraction.isdecimal()
        if separators:
            separator = next(iter(separators))
            valid = valid and len(separators) == 1 and bool(re.fullmatch(
                r'\d{1,3}(?:'+re.escape(separator)+r'\d{3})+', integer))
            integer = integer.replace(separator, '')
        if not valid:
            if source:
                continue
            raise ValueError('Invalid numeric grouping in claim')
        values.add(Decimal(sign.replace('\u2212', '-') + (integer or '0') + (dot + fraction if dot else '')))
    return values


def source_blocks(text):
    blocks=[]
    # Bound long publisher paragraphs while preserving exact character offsets.
    for match in re.finditer(r'[^\n]+', text):
        for start in range(match.start(),match.end(),1400):
            value=text[start:min(start+1400,match.end())]
            kind='table' if re.match(r'\s*Table\s+\d',value,re.I) else 'figure' if re.match(r'\s*(?:Fig(?:ure)?[.]?)\s+\d',value,re.I) else 'p'
            blocks.append({'id':f'{kind}-{start:07d}','start':start,'end':start+len(value),'text':value})
    return blocks


def numbered_source(blocks, start=0, end=None):
    return '\n'.join('['+b['id']+'] '+b['text'] for b in blocks if b['end']>start and (end is None or b['start']<end))


def validate_evidence(data,summary,body):
    claims=data.get('evidence')
    details=data.get('research_details')
    if not isinstance(details,dict) or set(details)!=set(DETAIL_FIELDS) or any(not isinstance(v,str) or not 1<=len(v)<=1500 for v in details.values()):
        raise ValueError('Missing research details')
    blocks={b['id']:b['text'] for b in source_blocks(body)}
    expected={**{f'summary_{i+1}':v for i,v in enumerate(summary['summary_ko'].splitlines())},
              **summary['structured_data'],**details,
              **{f'qa_{i+1}':q['a'] for i,q in enumerate(summary['qa_data'])}}
    if not isinstance(claims,dict) or set(claims)!=set(expected):
        raise ValueError('Each claim needs source locations')
    for key,statement in expected.items():
        refs=claims[key]
        missing=statement.strip().lower() in ('not reported','보고되지 않음','해당 없음')
        if not isinstance(refs,list) or len(refs)>8 or (not refs and not missing) or any(not isinstance(ref,str) or ref not in blocks for ref in refs):
            raise ValueError('Invalid source location for '+key)
        if len(refs)!=len(set(refs)):
            raise ValueError('Duplicate source location')
        # Numeric evidence must be present at the cited location, not only somewhere in the article.
        cited=' '.join(blocks[ref] for ref in refs)
        if not numeric_values(statement).issubset(numeric_values(cited, source=True)):
            raise ValueError('Number absent from cited source for '+key)
    return {'evidence':{'version':1,'content_hash':hashlib.sha256(body.encode()).hexdigest(),'claims':claims},'research_details':details}


def validate_metadata(evidence,details):
    if not isinstance(evidence,dict) or set(evidence)!={'version','content_hash','claims'} or evidence['version']!=1 or not re.fullmatch(r'[0-9a-f]{64}',str(evidence['content_hash'])):
        raise ValueError('Invalid evidence metadata')
    if not isinstance(details,dict) or set(details)!=set(DETAIL_FIELDS) or any(not isinstance(v,str) or len(v)>1500 for v in details.values()):
        raise ValueError('Invalid derived details')
    if not isinstance(evidence['claims'],dict) or len(evidence['claims'])>15 or len(json.dumps(evidence))>16000:
        raise ValueError('Invalid claim metadata')
    for key,refs in evidence['claims'].items():
        if key not in (*BASE_FIELDS,*DETAIL_FIELDS,'summary_1','summary_2','summary_3','qa_1','qa_2','qa_3') or not isinstance(refs,list) or len(refs)>8 or any(not isinstance(r,str) or not re.fullmatch(r'(p|table|figure)-[0-9]{7}',r) for r in refs):
            raise ValueError('Only location identifiers may be published')
