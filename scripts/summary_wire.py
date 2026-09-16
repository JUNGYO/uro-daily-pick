"""Request-local integer citation aliases; persisted evidence keeps canonical IDs.

Aliases are assigned once from an original's ordered blocks. Repair excerpts use
the same map, with a narrower allowed-ID set. This module does not validate facts:
decode first, then run the existing complete summary/evidence validators.
"""
import copy
import re

_SOURCE_ID = re.compile(r'(?:p|table|figure)-[0-9]{7}')
_MARKER = re.compile(r'\[((?:p|table|figure)-[0-9]{7})\]')


class SourceAliases:
    def __init__(self, blocks):
        if not isinstance(blocks, (list, tuple)) or not blocks:
            raise ValueError('Source aliases require original blocks')
        ids = []
        for block in blocks:
            source_id = block.get('id') if isinstance(block, dict) else None
            if not isinstance(source_id, str) or not _SOURCE_ID.fullmatch(source_id):
                raise ValueError('Invalid canonical source ID')
            if not isinstance(block.get('text'), str):
                raise ValueError('Source block text is missing')
            ids.append(source_id)
        if len(set(ids)) != len(ids):
            raise ValueError('Duplicate canonical source ID')
        self.ids = tuple(ids)
        self._aliases = {source_id: i + 1 for i, source_id in enumerate(self.ids)}
        self._texts = {block['id']: block['text'] for block in blocks}

    def _allowed(self, allowed_ids):
        if allowed_ids is None:
            return self.ids
        if (not isinstance(allowed_ids, (list, tuple))
                or any(not isinstance(value, str) or value not in self._aliases for value in allowed_ids)
                or len(set(allowed_ids)) != len(allowed_ids)):
            raise ValueError('Invalid allowed source IDs')
        return tuple(allowed_ids)

    def encode_refs(self, refs, allowed_ids=None):
        allowed = set(self._allowed(allowed_ids))
        if (not isinstance(refs, list) or len(refs) > 8
                or any(not isinstance(ref, str) or ref not in allowed for ref in refs)
                or len(set(refs)) != len(refs)):
            raise ValueError('Invalid canonical citation list')
        return [self._aliases[ref] for ref in refs]

    def _decode_refs(self, refs, allowed_ids):
        allowed = {self._aliases[source_id] for source_id in self._allowed(allowed_ids)}
        # bool is an int subclass: exact type prevents True from becoming source 1.
        if (not isinstance(refs, list) or len(refs) > 8
                or any(type(ref) is not int or ref not in allowed for ref in refs)
                or len(set(refs)) != len(refs)):
            raise ValueError('Unknown, duplicate, or noninteger source alias')
        return [self.ids[ref - 1] for ref in refs]

    def schema(self, schema, allowed_ids=None):
        allowed = self._allowed(allowed_ids)
        if not allowed:
            raise ValueError('An alias schema requires source excerpts')
        if (not isinstance(schema, dict) or not isinstance(schema.get('$defs'), dict)
                or not isinstance(schema['$defs'].get('source_id'), dict)):
            raise ValueError('Schema must define source_id')
        result = copy.deepcopy(schema)
        result['$defs']['source_id'] = {'type': 'integer',
                                        'enum': [self._aliases[source_id] for source_id in allowed]}
        return result

    def numbered(self, blocks):
        """Render trusted block labels while preserving every body character."""
        if not isinstance(blocks, (list, tuple)):
            raise ValueError('Expected source blocks')
        ids = [block.get('id') if isinstance(block, dict) else None for block in blocks]
        self._allowed(ids)
        if any(not isinstance(block.get('text'), str) for block in blocks):
            raise ValueError('Source block text is missing')
        if any(block['text'] != self._texts[block['id']] for block in blocks):
            raise ValueError('Source block differs from its alias snapshot')
        return '\n'.join('[' + str(self._aliases[block['id']]) + '] ' + block['text'] for block in blocks)

    def encode_markers(self, notes, allowed_ids=None):
        """Replace citation markers in derived notes only, never in original text.

        Notes stay canonical on disk. Unknown marker IDs fail instead of being
        silently omitted or converted to a fabricated alias.
        """
        if not isinstance(notes, str):
            raise ValueError('Expected derived notes text')
        allowed = set(self._allowed(allowed_ids))

        def replace(match):
            source_id = match[1]
            if source_id not in allowed:
                raise ValueError('Unknown source ID in derived notes')
            return '[' + str(self._aliases[source_id]) + ']'

        return _MARKER.sub(replace, notes)

    def decode_initial(self, data, allowed_ids=None):
        if not isinstance(data, dict) or not isinstance(data.get('evidence'), dict):
            raise ValueError('Initial response must contain evidence')
        result = copy.deepcopy(data)
        result['evidence'] = {key: self._decode_refs(refs, allowed_ids)
                              for key, refs in data['evidence'].items()}
        return result

    def decode_repairs(self, patch, allowed_ids=None):
        if not isinstance(patch, dict):
            raise ValueError('Repair response must be an object')
        result = copy.deepcopy(patch)
        for change in result.values():
            if not isinstance(change, dict) or 'sources' not in change:
                raise ValueError('Repair response must contain sources')
            change['sources'] = self._decode_refs(change['sources'], allowed_ids)
        return result
