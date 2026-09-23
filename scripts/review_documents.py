"""Bibliography imports and reproducible exports. Pure Python; no remote calls."""
from __future__ import annotations
import csv
import hashlib
import html
import io
import json
import re
import zipfile
from pathlib import Path

MAX_IMPORT_BYTES=8_000_000
MAX_RECORDS=50_000
BIB_FIELDS={"title","authors","journal","year","date","doi","pmid","volume","issue","pages","abstract","url","zotero_key","report_type"}


def text(value):
    return re.sub(r"\s+"," ",str(value or "")).strip()


def bibliography(row):
    result={k:text(v) for k,v in row.items() if k in BIB_FIELDS and k!="authors" and v is not None}
    result["authors"]=[text(a) for a in row.get("authors",[]) if text(a)]
    if not result.get("title") or len(result["title"])>2000: raise ValueError("A report title is required (maximum 2000 characters).")
    if result.get("doi"):
        result["doi"]=re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi\s*:\s*)","",result["doi"],flags=re.I).lower()
        if not re.fullmatch(r"10\.[0-9]{4,9}/\S+",result["doi"]): raise ValueError("Invalid DOI")
    if result.get("pmid") and not re.fullmatch(r"[0-9]{1,10}",result["pmid"]): raise ValueError("Invalid PMID")
    if any(len(v)>16000 for v in result.values() if isinstance(v,str)) or len(result["authors"])>300: raise ValueError("Bibliography field too large")
    return result


def _tagged(raw,mode):
    groups=[]; current={}; key=None
    pattern=re.compile(r"^([A-Z0-9]{2})  - ?(.*)$" if mode=="ris" else r"^([A-Z0-9]{2,4})\s*-\s?(.*)$")
    for line in raw.splitlines():
        m=pattern.match(line)
        if m:
            tag,value=m.groups()
            if (mode=="ris" and tag=="TY" or mode=="nbib" and tag=="PMID") and current:
                groups.append(current);current={}
            if tag=="ER":
                if current: groups.append(current)
                current={};key=None;continue
            current.setdefault(tag,[]).append(value);key=tag
        elif line.strip() and key:
            current[key][-1]+=" "+line.strip()
        elif not line.strip() and current and mode=="nbib":
            groups.append(current);current={};key=None
    if current: groups.append(current)
    rows=[]
    for g in groups:
        first=lambda *keys:next((g[k][0] for k in keys if g.get(k)),"")
        doi=first("DO") if mode=="ris" else next((re.sub(r"\s*\[doi\]$","",v) for v in g.get("AID",[]) if v.endswith("[doi]")),"")
        rows.append({"title":first("TI","T1"),"authors":g.get("AU",g.get("A1",[])) if mode=="ris" else g.get("FAU",g.get("AU",[])),
                     "journal":first("JO","JF","T2") if mode=="ris" else first("JT","TA"),"year":first("PY","Y1")[:4] if mode=="ris" else first("DP")[:4],
                     "date":first("DA"),"doi":doi,"pmid":first("PMID") if mode=="nbib" else first("AN") if first("AN").isdigit() else "",
                     "volume":first("VL","VI"),"issue":first("IS","IP"),"pages":first("SP","PG"),"abstract":first("AB","N2"),"url":first("UR"),"report_type":first("TY","PT")})
    return rows


def _bibtex(raw):
    rows=[]; i=0
    while True:
        match=re.search(r"@([a-zA-Z]+)\s*([{(])",raw[i:])
        if not match: break
        typ=match.group(1).lower(); start=i+match.end(); closing='}' if match.group(2)=='{' else ')'; depth=1; quoted=False; escaped=False; end=start
        for end in range(start,len(raw)):
            c=raw[end]
            if escaped: escaped=False;continue
            if c=='\\': escaped=True;continue
            if c=='"' and depth==1: quoted=not quoted
            if not quoted:
                if c==match.group(2): depth+=1
                elif c==closing:
                    depth-=1
                    if depth==0: break
        if depth: raise ValueError("Unclosed BibTeX entry")
        body=raw[start:end];i=end+1
        if typ in {'comment','preamble'}:continue
        if typ=='string':raise ValueError("Expand BibTeX string macros before importing, or use RIS/CSL-JSON.")
        if ',' not in body: raise ValueError("Invalid BibTeX entry")
        _,body=body.split(',',1); fields={};pos=0
        while pos<len(body):
            m=re.match(r"\s*,?\s*([\w-]+)\s*=\s*",body[pos:])
            if not m:
                if body[pos:].strip().strip(','): raise ValueError("Unsupported BibTeX field")
                break
            field=m.group(1).lower();pos+=m.end();begin=pos
            if pos>=len(body):raise ValueError("Missing BibTeX value")
            opener=body[pos];level=0
            if opener in '{"':
                pos+=1;begin=pos;level=1;esc=False
                while pos<len(body):
                    char=body[pos]
                    if esc:esc=False;pos+=1;continue
                    if char=='\\':esc=True;pos+=1;continue
                    if opener=='{' and char=='{':level+=1
                    if char==('}' if opener=='{' else '"'):
                        level-=1
                        if level==0:break
                    pos+=1
                if level:raise ValueError("Unclosed BibTeX value")
                value=body[begin:pos];pos+=1
            else:
                endval=body.find(',',pos);endval=len(body) if endval<0 else endval
                value=body[pos:endval].strip();pos=endval
                if not value.isdigit():raise ValueError("Expand BibTeX macros before importing.")
            if body[pos:].lstrip().startswith('#'):raise ValueError("Expand concatenated BibTeX values before importing.")
            fields[field]=value.replace('{','').replace('}','')
        rows.append({"title":fields.get('title'),"authors":re.split(r'\s+and\s+',fields.get('author','')),"journal":fields.get('journal'),"year":fields.get('year'),
                     "doi":fields.get('doi'),"pmid":fields.get('pmid'),"volume":fields.get('volume'),"issue":fields.get('number'),"pages":fields.get('pages'),"abstract":fields.get('abstract'),"url":fields.get('url'),"report_type":typ})
    return rows


def parse_import(raw,format_name,mapping=None):
    if not isinstance(raw,str) or len(raw.encode('utf-8'))>MAX_IMPORT_BYTES: raise ValueError("Import file exceeds 8 MB")
    raw=raw.lstrip('\ufeff')
    if format_name in {'ris','nbib'}:rows=_tagged(raw,format_name)
    elif format_name=='bibtex':rows=_bibtex(raw)
    elif format_name=='csl-json':
        content=json.loads(raw)
        if not isinstance(content,list):raise ValueError("CSL-JSON must contain a list")
        rows=[]
        for r in content:
            parts=(r.get('issued') or {}).get('date-parts') or [[]]
            rows.append({'title':r.get('title'),'authors':[a.get('literal') or ' '.join(filter(None,[a.get('family'),a.get('given')])) for a in r.get('author',[])],
                         'journal':r.get('container-title'),'year':parts[0][0] if parts[0] else '', 'doi':r.get('DOI'),'pmid':r.get('PMID'),
                         'volume':r.get('volume'),'issue':r.get('issue'),'pages':r.get('page'),'abstract':r.get('abstract'),'url':r.get('URL'),'zotero_key':r.get('id'),'report_type':r.get('type')})
    elif format_name=='csv':
        reader=csv.DictReader(io.StringIO(raw));columns=reader.fieldnames or []
        if not columns or len(columns)>100 or len(set(columns))!=len(columns) or any(not c or len(c)>300 for c in columns):raise ValueError('Invalid CSV header')
        if not mapping:
            count=sum(1 for _ in reader)
            if not 1<=count<=MAX_RECORDS:raise ValueError('Import must contain 1 to 50,000 records')
            return {'items':[],'errors':[],'source_count':count,'columns':columns,'mapping_required':True,'format':'csv','file_hash':hashlib.sha256(raw.encode('utf-8')).hexdigest()}
        if not isinstance(mapping,dict) or 'title' not in mapping or set(mapping)-BIB_FIELDS:raise ValueError("CSV column mapping including title is required")
        if any(not isinstance(c,str) or c not in columns for c in mapping.values()):raise ValueError('Mapped CSV column does not exist')
        rows=[]
        for r in reader:
            item={k:r.get(col,'') for k,col in mapping.items()}
            item['authors']=[a.strip() for a in item.get('authors','').split(';') if a.strip()];rows.append(item)
    else:raise ValueError("Unsupported import format")
    if not rows or len(rows)>MAX_RECORDS:raise ValueError("Import must contain 1 to 50,000 records")
    cleaned=[];errors=[]
    for i,row in enumerate(rows):
        try:cleaned.append({'source_record_id':str(i+1),'bibliography':bibliography(row)})
        except (ValueError,TypeError,KeyError) as e:errors.append({'record':i+1,'error':str(e)})
    return {'items':cleaned,'errors':errors,'source_count':len(rows),'file_hash':hashlib.sha256(raw.encode('utf-8')).hexdigest(),'format':format_name}


def ris(reports):
    def line(k,v): return f'{k}  - {text(v)}'
    chunks=[]
    for r in reports:
        b=r.get('bibliography',r)
        rows=['TY  - JOUR',line('ID',r.get('id','')),line('TI',b.get('title'))]+[line('AU',a) for a in b.get('authors',[])]
        for tag,key in [('JO','journal'),('PY','year'),('DO','doi'),('AN','pmid'),('VL','volume'),('IS','issue'),('SP','pages'),('UR','url')]:
            if b.get(key):rows.append(line(tag,b[key]))
        chunks.append('\r\n'.join(rows+['ER  -']))
    return '\r\n\r\n'.join(chunks)


def csl(reports):
    result=[]
    for r in reports:
        b=r.get('bibliography',r); item={'id':b.get('zotero_key') or r.get('id',''),'type':'article-journal','title':b.get('title'),'author':[{'literal':a} for a in b.get('authors',[])],
            'container-title':b.get('journal'),'DOI':b.get('doi'),'PMID':b.get('pmid'),'URL':b.get('url'),'volume':b.get('volume'),'issue':b.get('issue'),'page':b.get('pages')}
        if re.fullmatch(r'\d{4}',str(b.get('year',''))):item['issued']={'date-parts':[[int(b['year'])]]}
        result.append(item)
    return result


def csv_text(rows):
    out=io.StringIO();writer=csv.writer(out)
    for row in rows:
        writer.writerow([("'"+v) if isinstance(v,str) and re.match(r'^\s*[=+@-]|^[\t\r]',v) else str(v) if v is not None else '' for v in row])
    return '\ufeff'+out.getvalue()


def reproducible_archive(run, reports=(), counts=None, engine_source=None):
    # Explicit allowlist keeps credentials, access tokens and runtime leases out.
    frozen={k:run[k] for k in ('id','project_id','protocol_version','input_manifest','input_hash','config','status','result','created_at','completed_at') if k in run}
    if not frozen.get('input_manifest'):raise ValueError('A frozen analysis manifest is required')
    result=frozen.get('result') or {}; obs=frozen['input_manifest'].get('observations',[])
    code=engine_source if engine_source is not None else Path(__file__).with_name('review_analysis.py').read_bytes()
    if hashlib.sha256(code).hexdigest()!=result.get('engine',{}).get('code_sha256'):raise ValueError('Exact analysis engine source required')
    from review_figures import forest,prisma,funnel
    screening=frozen['input_manifest'].get('screening',{})
    encode=lambda x:json.dumps(x,ensure_ascii=False,indent=2,allow_nan=False).encode('utf-8')
    files={'run.json':encode(frozen),'analysis-input.json':encode({'input':frozen['input_manifest'],'config':frozen['config'],'input_hash':frozen['input_hash']}),
           'protocol.json':encode(frozen['input_manifest'].get('protocol')),'result.json':encode(result),'references.ris':ris(reports).encode('utf-8'),
           'references.csl.json':encode(csl(reports)),'screening-counts.json':encode(screening),
           'search-history.json':encode(frozen['input_manifest'].get('search_history',[])),
           'assessments.json':encode(frozen['input_manifest'].get('assessments',[])),
           'selection-flow.svg':prisma(screening).encode('utf-8'),
           'observations.csv':csv_text([['id','study','kind','outcome','timepoint','comparison','values','source_hash','locator']]+[[r['id'],r.get('study_label',r['study_id']),r['kind'],r['context'].get('outcome'),r['context'].get('timepoint'),r['context'].get('comparison'),json.dumps(r['values']),r['evidence'].get('source_hash'),r['evidence'].get('locator')] for r in obs]).encode('utf-8'),
           'review_analysis.py':code,
           'requirements.txt':Path(__file__).with_name('requirements-analysis.txt').read_bytes(),
           'README.txt':b'Reproduce: python review_analysis.py < analysis-input.json > reproduced-result.json\nReview status: human/AI peer review not performed. Source values were confirmed by the data-entry user.\nCompare unrounded estimates within the documented numerical tolerances. Raw originals and API keys are excluded.\n'}
    plot=forest(result)
    if plot:files['forest.svg']=plot.encode('utf-8')
    funnel_plot=funnel(result)
    if funnel_plot:files['funnel.svg']=funnel_plot.encode('utf-8')
    files['sensitivity.csv']=csv_text([['omitted_observation','estimate','ci_lower','ci_upper','tau2']]+[[r['omitted_id'],r['estimate'],*r['ci'],r['tau2']] for r in result.get('sensitivity',[])]).encode('utf-8')
    files['manifest.json']=encode({'schema_version':1,'input_hash':frozen['input_hash'],'files':{k:{'sha256':hashlib.sha256(v).hexdigest(),'bytes':len(v)} for k,v in files.items()}})
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for name,data in files.items():z.writestr(name,data)
    return out.getvalue()
