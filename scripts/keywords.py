"""Literal, Unicode-aware keyword matching shared by recommendation signals."""
import re
from functools import lru_cache


@lru_cache(maxsize=512)
def keyword_pattern(term):
    parts = term.strip().split()
    if not parts:
        return None
    literal = r"\s+".join(re.escape(part) for part in parts)
    return re.compile(r"(?<!\w)" + literal + r"(?!\w)", re.IGNORECASE)


def keyword_count(text, term):
    pattern = keyword_pattern(term)
    return len(pattern.findall(text or "")) if pattern else 0


def keyword_matches(text, term):
    pattern = keyword_pattern(term)
    return bool(pattern and pattern.search(text or ""))
