"""Exact NLM MeSH concept resolution, kept separately from model annotations.

Uses the OS trust store without disabling TLS verification. The immutable annual
descriptor release is cached locally; ambiguous terms remain unresolved. A MeSH
concept (not a broader descriptor) is the entity identity. Raw extraction stays
unchanged and can always be re-resolved under a later vocabulary release.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
import unicodedata
import urllib.request
from urllib.error import URLError
import uuid
from xml.etree import ElementTree as ET

YEAR = '2026'
URL = 'https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/desc2026.gz'
ROOT_CATEGORIES = {'A':'anatomy','B':'organism','C':'condition','D':'substance',
    'E':'technique','F':'psychology','G':'biological_process','H':'discipline',
    'I':'social','J':'technology','K':'humanities','L':'information','M':'population',
    'N':'healthcare','V':'publication','Z':'geography'}


def key(value):
    value = unicodedata.normalize('NFKC', value).casefold()
    value = re.sub(r'[\u2010\u2011\u2012\u2013\u2212]', '-', value)
    return re.sub(r'\s+', ' ', value).strip()


def metadata_bytes(url, maximum=5_000_000, timeout=20):
    # Only public bibliographic endpoints, never arbitrary URLs from articles.
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in {'eutils.ncbi.nlm.nih.gov','nlmpubs.nlm.nih.gov'}:
        raise ValueError('Untrusted metadata endpoint')
    request = urllib.request.Request(url, headers={'User-Agent':'UroDailyPick/1.0 (bibliographic metadata)'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        final = urlsplit(response.url)
        if final.scheme != 'https' or final.hostname != parsed.hostname:
            raise ValueError('Unexpected metadata redirect')
        data = response.read(maximum+1)
        if len(data)>maximum:
            raise ValueError('Oversized metadata response')
        return data


def build_index(xml_stream, destination, checksum, year=YEAR):
    """Build a private, atomic lookup database without expanding XML entities."""
    from defusedxml.ElementTree import iterparse
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.building')
    db = sqlite3.connect(temporary)
    try:
        db.executescript('CREATE TABLE terms(term TEXT NOT NULL,concept TEXT NOT NULL,label TEXT NOT NULL,descriptor TEXT NOT NULL,roots TEXT NOT NULL,PRIMARY KEY(term,concept,descriptor)); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);')
        count=0
        events=iterparse(xml_stream,events=('start','end'))
        _,root=next(events)
        if root.tag!='DescriptorRecordSet':
            raise ValueError('Not a MeSH descriptor release')
        for event, record in events:
            if event!='end' or record.tag!='DescriptorRecord':
                continue
            descriptor=record.findtext('DescriptorUI','')
            if not re.fullmatch(r'D\d{6,9}',descriptor):
                raise ValueError('Invalid descriptor identity')
            roots=sorted({x.text[0] for x in record.findall('./TreeNumberList/TreeNumber') if x.text and x.text[0] in ROOT_CATEGORIES})
            for concept in record.findall('./ConceptList/Concept'):
                identity=concept.findtext('ConceptUI','')
                label=concept.findtext('./ConceptName/String','').strip()
                if not re.fullmatch(r'M\d{6,9}',identity) or not label or len(label)>500:
                    raise ValueError('Invalid MeSH concept')
                terms={label,*[x.text for x in concept.findall('./TermList/Term/String') if x.text]}
                for term in terms:
                    if len(term)<=500:
                        db.execute('INSERT OR IGNORE INTO terms VALUES (?,?,?,?,?)',(key(term),identity,label,descriptor,json.dumps(roots)))
            count+=1
            root.clear()
        if not count:
            raise ValueError('Empty MeSH release')
        db.execute('CREATE INDEX concept_lookup ON terms(concept)')
        db.executemany('INSERT INTO meta VALUES (?,?)',[('year',year),('sha256',checksum),('descriptors',str(count)),('schema','1')])
        db.commit()
        if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
            raise ValueError('MeSH index verification failed')
        db.close()
        with temporary.open('r+b') as handle:
            os.fsync(handle.fileno())
        os.replace(temporary,destination)
    finally:
        db.close()
        if temporary.exists():
            # Only this function's uniquely named incomplete file, never a source.
            temporary.unlink()


class MeshIndex:
    def __init__(self, path):
        self.db=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)
        self.db.row_factory=sqlite3.Row
        self.meta=dict(self.db.execute('SELECT key,value FROM meta'))
        if self.meta.get('schema')!='1' or not re.fullmatch(r'[0-9a-f]{64}',self.meta.get('sha256','')):
            self.db.close();raise ValueError('Invalid terminology index')

    def close(self):
        self.db.close()

    def resolve(self, label):
        rows=self.db.execute('SELECT * FROM terms WHERE term=? ORDER BY concept,descriptor',(key(label),)).fetchall()
        identities={r['concept'] for r in rows}
        base={'matched_label':label,'vocabulary':'MeSH','year':self.meta['year'],'checksum':self.meta['sha256']}
        if len(identities)!=1:
            return {**base,'status':'ambiguous' if identities else 'unmapped','entity_id':None,'label':label,'category':'unclassified','descriptor_ids':[],'concept_ui':None}
        identity=rows[0]['concept']
        # The same concept may occur under more than one descriptor. Resolve its
        # complete category set, independent of which entry term matched it.
        rows=self.db.execute('SELECT DISTINCT concept,label,descriptor,roots FROM terms WHERE concept=? ORDER BY descriptor,label',(identity,)).fetchall()
        roots=sorted({r for row in rows for r in json.loads(row['roots'])})
        category=ROOT_CATEGORIES[roots[0]] if len(roots)==1 else 'multiple' if roots else 'unclassified'
        return {**base,'status':'exact','entity_id':hashlib.md5(('MeSH:'+identity).encode()).hexdigest()[:24],
            'label':rows[0]['label'],'category':category,'descriptor_ids':sorted({r['descriptor'] for r in rows}), 'concept_ui':identity}


def ensure_index(directory, *, download=True):
    directory=Path(directory)/'terminology'
    path=directory/('mesh-'+YEAR+'.sqlite3')
    if path.is_file():
        return MeshIndex(path)
    if not download:
        return None
    directory.mkdir(parents=True,exist_ok=True)
    retry=directory/'retry.json'
    try:
        if json.loads(retry.read_text())['after']>time.time():
            return None
    except (OSError,ValueError,KeyError,TypeError):
        pass
    if shutil.disk_usage(directory).free<512*1024**2:
        return None
    try:
        archive=directory/('desc'+YEAR+'.gz')
        if not archive.exists():
            # Read the announced object length in bounded chunks. Some proxies
            # keep large responses open after the complete object is received.
            headers={'User-Agent':'UroDailyPick/1.0 (bibliographic metadata)'}
            with urllib.request.urlopen(urllib.request.Request(URL,headers=headers,method='HEAD'),timeout=30) as response:
                if response.url!=URL: raise ValueError('Unexpected terminology redirect')
                expected=int(response.headers.get('Content-Length','0'))
            if not 0<expected<=32*1024**2: raise ValueError('Invalid terminology size')
            temporary=archive.with_name(archive.name+'.'+uuid.uuid4().hex+'.download')
            try:
                with urllib.request.urlopen(urllib.request.Request(URL,headers=headers),timeout=30) as response, temporary.open('wb') as out:
                    if response.url!=URL: raise ValueError('Unexpected terminology redirect')
                    received=0
                    while received<expected:
                        block=response.read1(min(65536,expected-received))
                        if not block: raise ValueError('Incomplete terminology release')
                        out.write(block);received+=len(block)
                    out.flush();os.fsync(out.fileno())
                os.replace(temporary,archive)
            finally:
                if temporary.exists(): temporary.unlink()
        checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
        # Gzip decoding is streamed into the XML parser; no archive extraction.
        with gzip.open(archive,'rb') as stream:
            build_index(stream,path,checksum)
        return MeshIndex(path)
    except (OSError,ValueError,URLError,ET.ParseError):
        from local_summary import _checkpoint
        _checkpoint(retry,{'after':time.time()+3600})
        return None


def reconcile_terms(store, index, limit=100):
    """Publish small durable batches; never mutate the original model extraction."""
    if index is None:
        return 0
    from knowledge import digest, encode, VERSION
    store.db.execute('CREATE TABLE IF NOT EXISTS term_resolutions(concept_id TEXT PRIMARY KEY,revision TEXT NOT NULL)')
    changed=[]
    for row in store.db.execute('SELECT id,label FROM concepts WHERE EXISTS(SELECT 1 FROM memberships m WHERE m.concept_id=concepts.id) ORDER BY id'):
        value={'concept_id':row['id'],**index.resolve(row['label'])}
        revision=digest(value)
        old=store.db.execute('SELECT revision FROM term_resolutions WHERE concept_id=?',(row['id'],)).fetchone()
        if not old or old[0]!=revision:
            changed.append((value,revision))
            if len(changed)>=limit:
                break
    if changed:
        with store.db:
            identity=changed[0][0]['concept_id']
            store.stage('terms',identity,{'id':identity,'version':VERSION,'items':[x[0] for x in changed]})
            store.db.executemany('INSERT OR REPLACE INTO term_resolutions VALUES (?,?)',[(v['concept_id'],r) for v,r in changed])
    return len(changed)
