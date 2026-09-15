"""Preserve article figures beside local originals; never publish image bytes to the DB."""
from datetime import datetime, timezone
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import ssl
import shutil
import time
from urllib.parse import urljoin, urlsplit, quote, unquote
from urllib.request import Request, build_opener, HTTPSHandler
import zipfile

from bs4 import BeautifulSoup
from defusedxml import ElementTree as ET
from fulltext import NoRedirect

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_PACKAGE_BYTES = 100 * 1024 * 1024
MIN_FREE_BYTES = 1024 * 1024 * 1024
MANIFEST_VERSION = 2
IMAGE_HOSTS = {'ars.els-cdn.com', 'media.springernature.com', 'static-content.springer-cdn.com',
    'link.springer.com', 'www.nature.com', 'nature.com', 'onlinelibrary.wiley.com',
    'pmc.ncbi.nlm.nih.gov', 'cdn.ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov',
    'www.ebi.ac.uk', 'europepmc.org', 'jamanetwork.com', 'www.bmj.com', 'www.sciencedirect.com',
    'pmc-oa-opendata.s3.amazonaws.com'}


def allowed_image_url(url):
    try:
        u = urlsplit(url)
        return (u.scheme == 'https' and not u.username and not u.password and u.port in (None, 443)
                and (u.hostname in IMAGE_HOSTS or (u.hostname or '').endswith('.onlinelibrary.wiley.com')))
    except ValueError:
        return False


def image_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if data.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if data[:6] in (b'GIF87a', b'GIF89a'): return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP': return 'image/webp'
    if data[:4] in (b'II*\x00', b'MM\x00*'): return 'image/tiff'
    if data[:2] == b'BM': return 'image/bmp'
    raise ValueError('Not a supported raster image')


def atomic_write(path, data):
    temporary = path.with_name(path.name + '.pending')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    # Windows indexers/antivirus can briefly hold a completed file open.
    for attempt in range(5):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 4: raise
            time.sleep(.2 * (attempt + 1))


def fetch_bytes(url, maximum=MAX_IMAGE_BYTES, timeout=20):
    if not allowed_image_url(url): raise ValueError('Image host is not supported')
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    req = Request(url, headers={'User-Agent':'UroDailyPick/1.0', 'Accept':'image/*,application/zip'})
    with opener.open(req, timeout=timeout) as response:
        data = response.read(maximum + 1)
    if not data or len(data) > maximum: raise ValueError('Image/package size limit')
    return data


def html_figures(content, source_url):
    soup = BeautifulSoup(content, 'html.parser')
    figures = []
    containers = soup.select('figure, .fig, .figure, .fig-section')
    # Do not count the same figure through nested publisher containers.
    containers = [f for f in containers if not any(parent in containers for parent in f.parents)]
    for figure in containers:
        images = figure.select('img')
        if not images: continue  # Springer uses <figure> for tables as well.
        caption = figure.select_one('.figure__caption-text') or figure.select_one('.caption, .fig-caption, figcaption')
        label = figure.select_one('.figure__title, .label, .fig-label')
        for img in images:
            urls = []
            parent = img.find_parent('a')
            candidates = [img.get('data-lg-src'), img.get('data-original'), img.get('data-src')]
            if parent and re.search(r'\.(png|jpe?g|gif|webp|tiff?|bmp)(?:[?#]|$)', parent.get('href',''), re.I):
                candidates.insert(0, parent.get('href'))
            for source in figure.select('source[srcset]'):
                candidates.extend(part.strip().split()[0] for part in source['srcset'].split(',') if part.strip())
            if img.get('srcset'):
                candidates.extend(part.strip().split()[0] for part in img['srcset'].split(',') if part.strip())
            candidates.append(img.get('src'))
            for value in candidates:
                if not value: continue
                url = urljoin(source_url, value)
                if allowed_image_url(url) and url not in urls: urls.append(url)
            figures.append({'label': label.get_text(' ',strip=True)[:120] if label else f'Figure {len(figures)+1}',
                'caption': caption.get_text(' ',strip=True)[:12000] if caption else img.get('alt','')[:12000],
                'urls': urls})
    return figures


def xml_figures(content):
    root = ET.fromstring(content)
    local = lambda e: e.tag.rsplit('}',1)[-1] if isinstance(e.tag,str) else ''
    figures = []
    for figure in root.iter():
        if local(figure) != 'fig': continue
        label = next((' '.join(n.itertext()) for n in figure if local(n)=='label'), f'Figure {len(figures)+1}')
        caption = next((' '.join(n.itertext()) for n in figure if local(n)=='caption'), '')
        for image in figure.iter():
            if local(image) != 'graphic': continue
            ref = image.get('{http://www.w3.org/1999/xlink}href') or image.get('href') or ''
            figures.append({'label':label[:120], 'caption':caption[:12000], 'ref':ref})
    return figures


def pmc_image_urls(pmcid, pmid):
    """Use the current PMC public media service (legacy FTP packages were retired).

    Discover available versions instead of assuming version 1; select published
    media only after its metadata matches the stored article's PMID.
    """
    base = 'https://pmc-oa-opendata.s3.amazonaws.com/'
    raw = fetch_bytes(base + f'?list-type=2&prefix={pmcid}.&delimiter=/', 1024*1024, 12)
    root = ET.fromstring(raw)
    prefixes = [n.text for n in root.iter() if n.tag.endswith('}Prefix') and n.text
                and re.fullmatch(pmcid + r'\.[1-9][0-9]*/', n.text)]
    choices = []
    for prefix in prefixes[:10]:
        try:
            meta = json.loads(fetch_bytes(base + prefix + prefix[:-1] + '.json', 1024*1024, 12))
            if str(meta.get('pmid')) != pmid or str(meta.get('is_manuscript','')).lower() in ('yes','true'): continue
            urls = []
            for value in meta.get('media_urls',[]):
                if not isinstance(value,str): continue
                value = value.replace('s3://pmc-oa-opendata/',base,1)
                if value.startswith(base+prefix) and allowed_image_url(value): urls.append(value)
            if urls: choices.append(urls)
        except (OSError,ValueError): continue
    # Ambiguous published versions need an explicit source match; do not mix them.
    return choices[0] if len(choices)==1 else []


def save_image(folder, data):
    if not 12 <= len(data) <= MAX_IMAGE_BYTES: raise ValueError('Invalid image size')
    kind = image_type(data)
    digest = hashlib.sha256(data).hexdigest()
    folder.mkdir(exist_ok=True)
    path = folder / digest
    if shutil.disk_usage(folder).free < MIN_FREE_BYTES + len(data):
        raise OSError('Insufficient free space for figure storage')
    if not path.exists(): atomic_write(path, data)
    elif hashlib.sha256(path.read_bytes()).hexdigest() != digest: atomic_write(path, data)
    return {'asset_id':digest, 'content_type':kind, 'bytes':len(data), 'status':'ready'}


def collect_images(directory, pmid, record, browser=None, deadline=None):
    """Resume one local article. A missing image cannot invalidate its body or summary."""
    if not re.fullmatch(r'[1-9][0-9]{0,11}', pmid): raise ValueError('Invalid PMID')
    spool = Path(directory) / 'documents'
    source_hash = record['document']['content_hash']
    manifest_path = spool / (pmid + '.images.json')
    folder = spool / (pmid + '.images')
    previous = {}
    if manifest_path.exists():
        try: previous = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (ValueError,OSError): pass
    if previous.get('version') == MANIFEST_VERSION and previous.get('content_hash') == source_hash:
        if previous.get('status') == 'complete' or previous.get('retry_after',0) > time.time(): return previous
    source_url = record['document'].get('source_url','')
    html, xml = spool/(pmid+'.html'), spool/(pmid+'.xml')
    is_xml = xml.exists()
    if is_xml: figures = xml_figures(xml.read_bytes())
    elif html.exists(): figures = html_figures(html.read_bytes(), source_url)
    else:
        # Legacy cloud archives have no retained HTML. Fetch only through ordinary
        # institution access, preserving the existing validated body and summary.
        if browser is None: raise ValueError('Source markup is not yet available')
        paper = record.get('paper') or record
        recovered = browser.read({'pmid':pmid,'doi':paper.get('doi','')}, budget_ms=90000)
        if recovered.get('status') != 'downloaded': raise ValueError('Source markup unavailable')
        source_url = recovered['url']
        atomic_write(html, recovered['html'].encode())
        figures = html_figures(recovered['html'], source_url)
    manifest = {'version':MANIFEST_VERSION,'content_hash':source_hash,'source_url':source_url,'status':'partial',
        'checked_at':datetime.now(timezone.utc).isoformat(),'figures':[], 'retry_after':0}
    package = None
    package_attempted = False
    cloud_urls = None
    saved = {item.get('key'):item for item in previous.get('figures',[]) if isinstance(item,dict)}
    try:
        for index, figure in enumerate(figures):
            key = f'figure-{index+1}'
            item = {'key':key,'label':figure['label'],'caption':figure['caption'],'status':'pending'}
            old = saved.get(key)
            if previous.get('content_hash') == source_hash and old and old.get('status') == 'ready':
                asset = old.get('asset_id','')
                if (re.fullmatch('[0-9a-f]{64}',asset) and (folder/asset).is_file()
                        and (folder/asset).stat().st_size <= MAX_IMAGE_BYTES
                        and hashlib.sha256((folder/asset).read_bytes()).hexdigest() == asset):
                    item.update({k:old[k] for k in ('asset_id','content_type','bytes','status')})
                    manifest['figures'].append(item); continue
            try:
                if deadline and time.monotonic() >= deadline: raise TimeoutError('Article image budget')
                data = None
                if is_xml:
                    match = re.search(r'/(PMC\d+)/fullTextXML',source_url)
                    if not match: raise ValueError('No image package identifier')
                    if cloud_urls is None:
                        try: cloud_urls = pmc_image_urls(match[1],pmid)
                        except (OSError,ValueError): cloud_urls = []
                    ref = Path(figure['ref']).name
                    for url in cloud_urls:
                        name=Path(unquote(urlsplit(url).path)).name
                        if name != ref and Path(name).stem != Path(ref).stem: continue
                        try:
                            candidate=fetch_bytes(url,timeout=12)
                            image_type(candidate);data=candidate;break
                        except (OSError,ValueError): continue
                    if data is None and not package_attempted:
                        package_attempted = True
                        raw = fetch_bytes(f'https://www.ebi.ac.uk/europepmc/webservices/rest/{match[1]}/supplementaryFiles',MAX_PACKAGE_BYTES,20)
                        package = zipfile.ZipFile(io.BytesIO(raw))
                    if data is None and package is not None:
                        options = [m for m in package.infolist() if Path(m.filename).name == ref or Path(m.filename).stem == Path(ref).stem]
                        for member in sorted(options,key=lambda m:m.file_size,reverse=True):
                            if not 12 <= member.file_size <= MAX_IMAGE_BYTES: continue
                            candidate = package.read(member)
                            try: image_type(candidate)
                            except ValueError: continue
                            data=candidate; break
                else:
                    for url in figure['urls']:
                        if deadline and time.monotonic() >= deadline: break
                        try:
                            candidate=fetch_bytes(url,timeout=12)
                            image_type(candidate); data=candidate; break
                        except (OSError,ValueError):
                            if browser is not None:
                                result=browser.image(url,budget_ms=20000)
                                if result.get('status')=='downloaded':
                                    candidate=base64.b64decode(result['data'],validate=True)
                                    image_type(candidate); data=candidate; break
                if data is None: raise ValueError('Image unavailable')
                item.update(save_image(folder,data))
            except (OSError,ValueError,KeyError,zipfile.BadZipFile):
                item['status']='pending'; manifest['status']='partial'
            manifest['figures'].append(item)
            manifest['status']='partial'
            manifest['retry_after'] = time.time()+3600
            atomic_write(manifest_path,json.dumps(manifest,ensure_ascii=False).encode())
        manifest['status']='complete' if all(f['status']=='ready' for f in manifest['figures']) else 'partial'
        manifest['retry_after']=0 if manifest['status']=='complete' else time.time()+3600
        atomic_write(manifest_path,json.dumps(manifest,ensure_ascii=False).encode())
        return manifest
    finally:
        if package: package.close()


def run_image_queue(directory, node, seconds):
    import msvcrt
    from institution_worker import Browser
    directory=Path(directory)
    lock=(directory/'figures.lock').open('a+b')
    if not lock.tell(): lock.write(b'0');lock.flush()
    lock.seek(0)
    try: msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError: lock.close();return
    deadline=time.monotonic()+seconds
    browser=None
    attempted=set()
    try:
        for root in (directory/'documents',directory/'cloud-archive'):
            for path in sorted(root.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True):
                if time.monotonic()>=deadline: return
                if not path.stem.isdigit() or path.stem in attempted: continue
                attempted.add(path.stem)
                try:
                    record=json.loads(path.read_text(encoding='utf-8'))
                    manifest=directory/'documents'/(path.stem+'.images.json')
                    if manifest.exists():
                        old=json.loads(manifest.read_text(encoding='utf-8'))
                        if old.get('version')==MANIFEST_VERSION and old.get('content_hash')==record['document']['content_hash'] and (old.get('status')=='complete' or old.get('retry_after',0)>time.time()):continue
                    if browser is None: browser=Browser(node,directory,profile='figure-browser-profile')
                    result=collect_images(directory,path.stem,record,browser, min(deadline,time.monotonic()+120))
                    ready=sum(f['status']=='ready' for f in result['figures'])
                    print(f"PMID {path.stem}: figures {ready}/{len(result['figures'])} stored",flush=True)
                except (OSError,ValueError,KeyError):
                    print(f'PMID {path.stem}: figure collection deferred',flush=True)
    finally:
        if browser: browser.close()
        lock.close()
