"""Refresh existing citation notices in bounded, oldest-checked-first batches."""
import os
import time
from common import get_json,patch_fields,supabase_headers
from fetch_papers import fetch_details

FIELDS=('volume','issue','pages','publication_types','integrity_status','related_notices','integrity_checked_at')
SEVERITY={'current':0,'corrected':1,'concern':2,'retracted':3}


def merge_integrity(existing, incoming):
    """Incomplete index responses must not silently erase a known notice."""
    merged=dict(incoming)
    links=list(existing.get('related_notices') or [])
    for link in incoming.get('related_notices') or []:
        if link not in links: links.append(link)
    merged['related_notices']=links
    merged['integrity_status']=max((existing.get('integrity_status') or 'current',incoming.get('integrity_status') or 'current'),key=lambda status:SEVERITY[status])
    return merged


def main():
    url=os.environ['SUPABASE_URL'].rstrip('/')+'/rest/v1/papers'
    headers=supabase_headers(os.environ['SUPABASE_SERVICE_KEY'])
    rows=get_json(url,headers=headers,params={'select':'pmid,integrity_status,related_notices','pub_date':'gte.2000-01-01','order':'integrity_checked_at.asc.nullsfirst,id.asc','limit':400})
    existing={row['pmid']:row for row in rows}
    checked=0
    for start in range(0,len(rows),100):
        papers=fetch_details([r['pmid'] for r in rows[start:start+100]])
        for paper in papers:
            patch_fields(url,headers={**headers,'Prefer':'return=minimal'},params={'pmid':'eq.'+paper['pmid']},data=merge_integrity(existing.get(paper['pmid'],{}),{k:paper[k] for k in FIELDS}))
            # A newly indexed notice can identify a catalog original outside this batch.
            for notice in paper['related_notices']:
                status={'RetractionOf':'retracted','ErratumFor':'corrected','ExpressionOfConcernFor':'concern'}.get(notice['relation'])
                if status:
                    original=get_json(url,headers=headers,params={'select':'related_notices,integrity_status','pmid':'eq.'+notice['pmid'],'limit':1})
                    if original:
                        link={'pmid':paper['pmid'],'relation':{'retracted':'RetractionIn','corrected':'ErratumIn','concern':'ExpressionOfConcernIn'}[status]}
                        patch_fields(url,headers={**headers,'Prefer':'return=minimal'},params={'pmid':'eq.'+notice['pmid']},data=merge_integrity(original[0],{'related_notices':[link],'integrity_status':status}))
            checked+=1
        time.sleep(.4)
    print(f'Checked integrity metadata for {checked} existing citations')


if __name__=='__main__':main()
