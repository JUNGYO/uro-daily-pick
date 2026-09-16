"""Repair individual derived claims against bounded excerpts of the local original."""
import copy
import json
import re

from evidence import BASE_FIELDS, DETAIL_FIELDS, numeric_values, source_blocks
from summarize_papers import validate_summary

MISSING = ('not reported', '보고되지 않음', '해당 없음')


def claim_texts(data):
    summary = validate_summary(json.dumps(data, ensure_ascii=False))
    details = data.get('research_details')
    if not isinstance(details, dict) or set(details) != set(DETAIL_FIELDS):
        raise ValueError('Missing research details')
    if any(not isinstance(v, str) or not 1 <= len(v) <= 1500 or '\x00' in v
           or any(0xd800 <= ord(c) <= 0xdfff for c in v) for v in details.values()):
        raise ValueError('Invalid research details')
    return {**{f'summary_{i+1}': line for i, line in enumerate(summary['summary_ko'].splitlines())},
            **summary['structured_data'], **details,
            **{f'qa_{i+1}': item['a'] for i, item in enumerate(summary['qa_data'])}}


def claim_issues(data, body):
    """Collect all failing locations/values, without assigning replacement evidence."""
    claims = claim_texts(data)
    blocks = {block['id']: block['text'] for block in source_blocks(body)}
    evidence = data.get('evidence')
    if not isinstance(evidence, dict):
        evidence = {}
    issues = {}
    for key, statement in claims.items():
        refs = evidence.get(key)
        reasons = []
        missing = statement.strip().lower() in MISSING and not key.startswith('summary_')
        if (not isinstance(refs, list) or len(refs) > 8 or (not refs and not missing)
                or any(not isinstance(ref, str) or ref not in blocks for ref in refs)):
            reasons.append('Use relevant source IDs from the supplied original excerpts.')
        elif len(refs) != len(set(refs)):
            reasons.append('Remove duplicate source IDs.')
        else:
            try:
                if not numeric_values(statement).issubset(numeric_values(' '.join(blocks[r] for r in refs), source=True)):
                    reasons.append('A numeric value is absent from the cited passages; verify the statement and its citations.')
            except ValueError:
                reasons.append('Use an exact, supported numeric representation from the original.')
        if key.startswith('summary_') and (not re.search(r'[가-힣]', statement) or len(statement) > 220):
            reasons.append('Write one Korean sentence, at most 220 characters, retaining the supported finding.')
        if key.startswith('qa_'):
            question = data['qa'][int(key[3:])-1]['q']
            try:
                if not numeric_values(question).issubset(numeric_values(body, source=True)):
                    reasons.append('The question contains a number unsupported by the original; correct the question too.')
            except ValueError:
                reasons.append('The question contains an unsupported numeric representation.')
        if reasons:
            issues[key] = ' '.join(reasons)
    if set(evidence) - set(claims):
        raise ValueError('Unexpected evidence claims')
    return issues


def _feedback_numbers(values):
    """Bound feedback without rounding or truncating individual numeric values."""
    result = []
    omitted = 0
    for value in sorted(values):
        text = '0' if value == 0 else format(value, 'f')
        if '.' in text:
            text = text.rstrip('0').rstrip('.')
        if len(result) >= 12 or len(text) > 80:
            omitted += 1
        else:
            result.append(text)
    return result, omitted


def numeric_repair_feedback(data, issues, body):
    """Describe failed numeric checks; never choose new citations or infer totals."""
    statements = claim_texts(data)
    blocks = {block['id']: block['text'] for block in source_blocks(body)}
    evidence = data.get('evidence') if isinstance(data.get('evidence'), dict) else {}
    try:
        body_values = numeric_values(body, source=True)
    except ValueError:
        return {key: {'numeric_check': 'source_format_unsupported'} for key in issues}
    feedback = {}
    for key in issues:
        if key not in statements:
            raise ValueError('Unknown numeric feedback claim')
        refs = evidence.get(key)
        cited = ' '.join(blocks[ref] for ref in refs
                         if isinstance(ref, str) and ref in blocks) if isinstance(refs, list) else ''
        try:
            values = numeric_values(statements[key])
            cited_values = numeric_values(cited, source=True)
        except ValueError:
            feedback[key] = {'numeric_check': 'unsupported_numeric_notation',
                             'guidance': 'Use exact supported notation; do not round or invent a replacement value.'}
            continue
        absent = values - cited_values
        sets = {'absent_from_cited': absent,
                'present_elsewhere_in_body': absent & body_values,
                'absent_from_body': absent - body_values}
        if key.startswith('qa_'):
            try:
                question = data['qa'][int(key[3:]) - 1]['q']
                sets['question_absent_from_body'] = numeric_values(question) - body_values
            except ValueError:
                feedback[key] = {'numeric_check': 'unsupported_question_notation'}
                continue
        row = {}
        omitted = 0
        for name, numbers in sets.items():
            row[name], excluded = _feedback_numbers(numbers)
            omitted += excluded
        if omitted:
            row['omitted_value_count'] = omitted
        if absent or sets.get('question_absent_from_body'):
            row['guidance'] = ('Values listed as present elsewhere need a passage supporting the same study, population, '
                               'outcome and time point; a numeric match alone is insufficient. Values listed as absent '
                               'must be corrected against the original, not calculated or concatenated. '
                               'Do not replace a supported finding with Not reported to bypass validation.')
            if key == 'sample_size':
                row['sample_size_guidance'] = ('When no total is explicitly stated, report the explicitly stated group '
                                               'counts with their group labels. Never add group counts or concatenate '
                                               'adjacent table values to create a total.')
        feedback[key] = row
    return feedback


def repair_context(data, issues, body, max_characters=24000):
    """Retrieve excerpts for model review, never infer a citation solely from a number."""
    blocks = source_blocks(body)
    positions = {b['id']: i for i, b in enumerate(blocks)}
    claims = claim_texts(data)
    ranked = {}
    evidence = data.get('evidence') if isinstance(data.get('evidence'), dict) else {}
    for key in issues:
        statement = claims[key]
        try:
            numbers = numeric_values(statement)
        except ValueError:
            numbers = set()
        words = set(re.findall(r'[a-z]{4,}', statement.lower())) - {'reported', 'patients', 'study'}
        refs = evidence.get(key)
        has_reference = False
        for ref in refs if isinstance(refs, list) else []:
            if not isinstance(ref, str):
                continue
            if ref in positions:
                has_reference = True
                position = positions[ref]
                ranked[position] = max(ranked.get(position, 0), 100)
                for neighbor in (position-1, position+1):
                    if 0 <= neighbor < len(blocks):
                        ranked[neighbor] = max(ranked.get(neighbor, 0), 25)
        candidates = []
        for i, block in enumerate(blocks):
            values = numeric_values(block['text'], source=True)
            score = 10 * len(numbers & values) + 2 * len(words & set(re.findall(r'[a-z]{4,}', block['text'].lower())))
            if numbers and numbers.issubset(values):
                score += 30
            if score:
                candidates.append((score, i))
        for score, i in sorted(candidates, reverse=True)[:4]:
            ranked[i] = max(ranked.get(i, 0), score)
        if not has_reference and not candidates:
            # Korean qualitative claims may have no English retrieval terms.
            # Include opening and conclusion context for that claim, even when
            # another failed claim has already populated the numeric matches.
            for i in list(range(min(6, len(blocks)))) + list(range(max(0, len(blocks)-6), len(blocks))):
                ranked[i] = max(ranked.get(i, 0), 20)
    # A malformed/missing reference with no numbers still gets article context.
    if not ranked:
        ranked = {i: 1 for i in range(min(12, len(blocks)))}
    chosen = []
    size = 0
    for i in sorted(ranked, key=lambda i: (-ranked[i], i)):
        block = blocks[i]
        if size + len(block['text']) + 30 > max_characters:
            continue
        chosen.append(block)
        size += len(block['text']) + 30
    return sorted(chosen, key=lambda block: block['start'])


def repair_schema(keys, source_ids):
    properties = {}
    for key in keys:
        fields = {'sources': {'type': 'array', 'maxItems': 8,
                              'items': {'$ref': '#/$defs/source_id'}}}
        if key.startswith('qa_'):
            fields.update({name: {'type': 'string', 'minLength': 1, 'maxLength': 2000} for name in ('q', 'a')})
        else:
            fields['text'] = {'type': 'string', 'minLength': 1,
                              'maxLength': 220 if key.startswith('summary_') else 1500}
        if key.startswith('summary_'):
            fields['sources']['minItems'] = 1
        properties[key] = {'type': 'object', 'required': list(fields), 'properties': fields, 'additionalProperties': False}
    return {'type': 'object', 'required': list(keys), 'properties': properties,
            'additionalProperties': False, '$defs': {'source_id': {'type': 'string', 'enum': source_ids}}}


def apply_repairs(data, patch, keys, source_ids):
    """Only the requested fields may change; acceptance still requires full validation."""
    if not isinstance(patch, dict) or set(patch) != set(keys):
        raise ValueError('Repair must contain exactly the failed claims')
    result = copy.deepcopy(data)
    if not isinstance(result.get('evidence'), dict):
        result['evidence'] = {}
    lines = [line.strip() for line in result['summary_ko'].splitlines() if line.strip()]
    for key, change in patch.items():
        expected = {'q', 'a', 'sources'} if key.startswith('qa_') else {'text', 'sources'}
        if not isinstance(change, dict) or set(change) != expected:
            raise ValueError('Invalid claim repair shape')
        refs = change['sources']
        if (not isinstance(refs, list) or len(refs) > 8 or any(not isinstance(ref, str) or ref not in source_ids for ref in refs)
                or len(set(refs)) != len(refs)):
            raise ValueError('Repair uses unknown or duplicate source IDs')
        if any(not isinstance(change[name], str) or not change[name].strip() for name in expected - {'sources'}):
            raise ValueError('Empty repaired claim')
        if key.startswith('summary_'):
            if '\n' in change['text'] or '\r' in change['text'] or not refs:
                raise ValueError('A repaired summary needs one sentence and source references')
            lines[int(key[8:])-1] = change['text']
        elif key.startswith('qa_'):
            result['qa'][int(key[3:])-1] = {name: change[name] for name in ('q', 'a')}
        elif key in BASE_FIELDS:
            result['structured'][key] = change['text']
        elif key in DETAIL_FIELDS:
            result['research_details'][key] = change['text']
        else:
            raise ValueError('Unknown repair field')
        result['evidence'][key] = refs
    result['summary_ko'] = '\n'.join(lines)
    claim_texts(result)  # Preserve the publication shape before checkpointing.
    return result
