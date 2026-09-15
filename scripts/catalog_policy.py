"""Publication-date policy for automatic literature processing."""
from datetime import date, datetime, timedelta, timezone

AUTOMATIC_START_DATE = '2000-01-01'
RECENT_YEARS = 5
PUBMED_DATE_RANGE = '2000:3000[dp]'


def automatic_paper(paper):
    try:
        return date.fromisoformat(str(paper.get('pub_date') or '')[:10]) >= date(2000, 1, 1)
    except ValueError:
        return False


def recent_paper(paper, today=None):
    today = today or datetime.now(timezone(timedelta(hours=9))).date()
    try:
        cutoff = today.replace(year=today.year - RECENT_YEARS)
    except ValueError:
        cutoff = today.replace(year=today.year - RECENT_YEARS, day=28)
    try:
        return date.fromisoformat(str(paper.get('pub_date') or '')[:10]) >= cutoff
    except ValueError:
        return False
