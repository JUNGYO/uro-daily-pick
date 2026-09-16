"""Conservative metadata topic normalization; no inferred diagnoses or fuzzy matches."""
import re
import unicodedata

from common import strings


ALIASES = {
    "prostate cancer": "prostatic neoplasms",
    "prostate neoplasm": "prostatic neoplasms",
    "prostate neoplasms": "prostatic neoplasms",
    "bladder cancer": "urinary bladder neoplasms",
    "urinary bladder cancer": "urinary bladder neoplasms",
    "bladder neoplasms": "urinary bladder neoplasms",
    "renal cancer": "kidney neoplasms",
    "kidney cancer": "kidney neoplasms",
    "rcc": "renal cell carcinoma",
    "carcinoma, renal cell": "renal cell carcinoma",
    "bph": "prostatic hyperplasia",
    "benign prostatic hyperplasia": "prostatic hyperplasia",
    "ai": "artificial intelligence",
}

STOP = {
    "humans", "male", "female", "aged", "middle aged", "aged, 80 and over", "adult", "young adult",
    "adolescent", "child", "animals", "treatment outcome", "follow-up studies", "time factors", "prognosis",
    "risk factors", "retrospective studies", "prospective studies", "cohort studies", "prevalence", "incidence",
    "survival rate", "survival analysis", "proportional hazards models", "multivariate analysis", "logistic models",
    "predictive value of tests", "sensitivity and specificity", "reproducibility of results", "reference values",
    "risk assessment", "united states", "europe", "japan", "korea", "china", "journal article", "research support",
    "english abstract", "comparative study", "multicenter study", "randomized controlled trial", "evaluation study",
    "clinical trial", "practice guideline", "meta-analysis", "systematic review", "review", "case reports", "editorial",
    "letter", "comment",
}


def normalized_term(value):
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFKC", value).lower()
    text = re.sub("[\u2010-\u2015\u2212]", "-", text)
    return " ".join(text.split())


def topic_id(value):
    term = normalized_term(value)
    return ALIASES.get(term, term)


def paper_topics(paper):
    """A paper contributes once per canonical topic, across keywords and MeSH."""
    terms = strings(paper.get("keywords")) + strings(paper.get("mesh_terms"))
    normalized = {normalized_term(term) for term in terms}
    return {topic_id(term) for term in normalized if term not in STOP and 2 <= len(term) <= 100}
