"""Source-bound reading structure, separate from immutable evidence locations."""
import hashlib
import re

VERSION = 1
KINDS = {'heading', 'paragraph', 'table', 'figure'}
CITATION_VERSION = 1


def validate_citations(layout, text):
    """Validate optional source annotations without inferring citations from numbers."""
    if 'citation_version' not in layout:
        return
    if layout['citation_version'] != CITATION_VERSION:
        raise ValueError('Invalid citation version')
    citations, references = layout.get('citations'), layout.get('references')
    if (not isinstance(citations, list) or len(citations) > 10000
            or not isinstance(references, list) or len(references) > 3000):
        raise ValueError('Invalid reference inventory')
    ids = set()
    for ref in references:
        if (not isinstance(ref, dict) or not isinstance(ref.get('id'), str)
                or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', ref['id']) or ref['id'] in ids
                or not isinstance(ref.get('text'), str) or not 1 <= len(ref['text']) <= 12000):
            raise ValueError('Invalid source reference')
        ids.add(ref['id'])
    cursor = 0
    for cite in citations:
        if (not isinstance(cite, dict) or not _span(cite, cursor, len(text))
                or cite['end'] <= cite['start'] or cite.get('text') != text[cite['start']:cite['end']]
                or not isinstance(cite.get('targets'), list) or not 1 <= len(cite['targets']) <= 100
                or any(not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', key)
                       for key in cite['targets'])):
            raise ValueError('Invalid source citation')
        cursor = cite['end']


def _span(value, minimum, maximum):
    return (type(value.get('start')) is int and type(value.get('end')) is int
            and minimum <= value['start'] <= value['end'] <= maximum)


def validate_layout(layout, text, content_hash):
    if (not isinstance(layout, dict) or layout.get('version') != VERSION
            or layout.get('content_hash') != content_hash
            or hashlib.sha256(text.encode()).hexdigest() != content_hash
            or not isinstance(layout.get('blocks'), list) or len(layout['blocks']) > 20000):
        raise ValueError('Invalid reading layout identity')
    cursor = 0
    for block in layout['blocks']:
        if (not isinstance(block, dict) or block.get('kind') not in KINDS
                or not _span(block, cursor, len(text)) or block['end'] == block['start']
                or text[cursor:block['start']].strip()):
            raise ValueError('Reading layout loses or overlaps source text')
        if block['kind'] == 'table' and block.get('rows'):
            cell_cursor = block['start']
            for row in block['rows']:
                if not isinstance(row, list) or not row:
                    raise ValueError('Invalid source table row')
                for cell in row:
                    if (not isinstance(cell, dict) or not _span(cell, cell_cursor, block['end'])
                            or text[cell_cursor:cell['start']].strip()
                            or type(cell.get('header')) is not bool
                            or any(type(cell.get(key)) is not int or not 1 <= cell[key] <= 1000
                                   for key in ('rowspan', 'colspan'))):
                        raise ValueError('Reading table loses or overlaps source cells')
                    cell_cursor = cell['end']
            if text[cell_cursor:block['end']].strip():
                raise ValueError('Reading table loses trailing source text')
        cursor = block['end']
    if text[cursor:].strip():
        raise ValueError('Reading layout loses source tail')
    validate_citations(layout, text)
    return layout


def _table_rows(unit, start):
    rows, cursor = [], 0
    text = unit['text']
    for row in unit.get('rows', []):
        cells = []
        for cell in row:
            value = cell['text']
            found = text.find(value, cursor)
            if found < 0 or text[cursor:found].strip():
                return None
            cells.append({'start': start + found, 'end': start + found + len(value),
                          'header': bool(cell.get('header')),
                          'rowspan': cell.get('rowspan', 1), 'colspan': cell.get('colspan', 1)})
            cursor = found + len(value)
        if cells:
            rows.append(cells)
    return rows if rows and not text[cursor:].strip() else None


def build_layout(text, sections, section_units, *, references=None):
    """Preserve every source character while recording publisher block boundaries.

    Existing content/hash stay unchanged so summaries and cited positions survive.
    Missing structure stays plain text; it is never guessed from clinical prose.
    """
    blocks, citations = [], []
    position = 0
    for section, units in zip(sections, section_units, strict=True):
        if not section['text'].strip():
            continue
        if position:
            position += 2  # The canonical section separator is two newlines.
        title = section['title']
        if title:
            blocks.append({'kind': 'heading', 'start': position, 'end': position + len(title)})
        position += len(title) + 1
        source = section['text']
        cursor = 0
        for unit in units:
            if not unit['text'].strip():
                continue
            found = source.find(unit['text'], cursor)
            if found < 0:
                raise ValueError('Publisher structure does not match extracted source')
            if source[cursor:found].strip():
                blocks.append({'kind': 'paragraph', 'start': position + cursor, 'end': position + found})
            block = {'kind': unit['kind'], 'start': position + found,
                     'end': position + found + len(unit['text'])}
            if unit['kind'] == 'table':
                rows = _table_rows(unit, block['start'])
                if rows:
                    block['rows'] = rows
            blocks.append(block)
            for cite in unit.get('citations', []):
                citations.append({**cite, 'start': block['start'] + cite['start'],
                                  'end': block['start'] + cite['end']})
            cursor = found + len(unit['text'])
        if source[cursor:].strip():
            blocks.append({'kind': 'paragraph', 'start': position + cursor, 'end': position + len(source)})
        position += len(source)
    result = {'version': VERSION, 'content_hash': hashlib.sha256(text.encode()).hexdigest(), 'blocks': blocks}
    if references is not None:
        used = {key for cite in citations for key in cite['targets']}
        result.update(citation_version=CITATION_VERSION, citations=citations,
                      references=[r for r in references if r['id'] in used])
    return validate_layout(result, text, result['content_hash'])
