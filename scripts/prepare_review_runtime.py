"""Prepare a versioned Python CPU runtime, reusing installed NumPy/SciPy.

Does not register/start tasks, read credentials, configure networking, install
models, download packages, or change the existing collection environment.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import venv

FILES=['review_service.py','review_analysis.py','review_documents.py','review_figures.py','requirements-analysis.txt']


def prepare(destination):
    root=Path(destination).resolve()
    if sys.platform!='win32' or root!=Path('D:/UroDailyPick/review').resolve():raise ValueError('Use the dedicated D drive review runtime')
    source=Path(__file__).resolve().parent
    digest=hashlib.sha256()
    for file in FILES:digest.update(file.encode());digest.update((source/file).read_bytes())
    distributions=[importlib.metadata.distribution(name) for name in ('numpy','scipy')]
    if [d.version for d in distributions]!=['1.26.4','1.14.1']:raise ValueError('Expected tested NumPy/SciPy runtime')
    for d in distributions:digest.update((d.metadata['Name']+d.version).encode())
    release=root/'releases'/digest.hexdigest()[:16]
    runtime=root/'python-numpy126-scipy114'
    if not (runtime/'ready.json').is_file():
        venv.EnvBuilder(with_pip=False).create(runtime)
        target=runtime/'Lib/site-packages'
        for dist in distributions:
            for entry in dist.files or []:
                if entry.parts[0]=='..':continue
                original=Path(dist.locate_file(entry));output=target/entry
                if original.is_file():output.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(original,output)
        subprocess.run([str(runtime/'Scripts/python.exe'),'-I','-c','import numpy,scipy;assert numpy.__version__=="1.26.4";assert scipy.__version__=="1.14.1"'],check=True)
        (runtime/'ready.json').write_text(json.dumps({'numpy':'1.26.4','scipy':'1.14.1'}))
    release.mkdir(parents=True,exist_ok=True)
    manifest={}
    for file in FILES:
        data=(source/file).read_bytes();destination_file=release/file
        if destination_file.exists() and destination_file.read_bytes()!=data:raise ValueError('Existing immutable release differs')
        destination_file.write_bytes(data);manifest[file]=hashlib.sha256(data).hexdigest()
    (release/'manifest.json').write_text(json.dumps(manifest,indent=2))
    return {'release':str(release),'python':str(runtime/'Scripts/python.exe'),'source_hashes':manifest}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--destination',required=True);args=parser.parse_args()
    print(json.dumps(prepare(args.destination)))
