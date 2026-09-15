"""Install a tested local release outside OneDrive. Does not read browser profiles."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import venv
from institution_entry import resolve_state_directory

ROOT = Path(__file__).resolve().parents[1]
FILES = ["evidence.py","institution_worker.py", "institution_entry.py", "browser_fulltext.cjs", "article_images.py", "catalog_policy.py", "fulltext.py", "common.py", "local_summary.py", "summarize_papers.py"]
PACKAGES = ["requests", "urllib3", "charset_normalizer", "idna", "certifi", "bs4", "soupsieve", "defusedxml", "pypdf", "typing_extensions.py"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--install-dir", type=Path, required=True)
    args = parser.parse_args()
    expected = (Path(os.environ["LOCALAPPDATA"]) / "UroDailyPick").resolve()
    if args.install_dir.resolve() != expected:
        parser.error("Install directory must be LOCALAPPDATA/UroDailyPick")
    dependency = ROOT / "frontend/node_modules/playwright-core"
    package = json.loads((dependency / "package.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256()
    for name in FILES:
        digest.update((ROOT / "scripts" / name).read_bytes())
    digest.update((ROOT / "scripts/requirements.txt").read_bytes())
    digest.update(package["version"].encode())
    release = expected / "releases" / digest.hexdigest()[:16]
    release.mkdir(parents=True, exist_ok=True)
    if not (release / "installed.json").exists():
        venv.EnvBuilder(with_pip=False).create(release / "python")
        destination = release / "python/Lib/site-packages"
        source = Path(sysconfig.get_paths()["purelib"])
        for name in PACKAGES:
            original = source / name
            if original.is_dir():
                shutil.copytree(original, destination / name, dirs_exist_ok=True)
            else:
                shutil.copy2(original, destination / name)
        # Preserve package licenses and metadata alongside the installed modules.
        for original in source.glob("*.dist-info"):
            shutil.copytree(original, destination / original.name, dirs_exist_ok=True)
        shutil.copy2(args.node, release / "node.exe")
        shutil.copytree(dependency, release / "node_modules/playwright-core", dirs_exist_ok=True)
        for name in FILES:
            shutil.copy2(ROOT / "scripts" / name, release / name)
        subprocess.run([str(release / "python/Scripts/python.exe"), "-c",
                        "import requests,bs4,defusedxml,pypdf,institution_worker"], cwd=release, check=True)
        subprocess.run([str(release / "node.exe"), "-e", "require('playwright-core')"], cwd=release, check=True)
        (release / "installed.json").write_text(json.dumps({"release":release.name,"playwright":package["version"]}), encoding="utf-8")
    state = resolve_state_directory(expected)
    result = subprocess.run([str(release / "python/Scripts/python.exe"), str(release / "institution_worker.py"),
        "--state-dir", str(state), "--enroll"], capture_output=True, text=True, check=True)
    enrollment = json.loads(result.stdout)
    print(json.dumps({"release":str(release),"state":str(state),**enrollment}))


if __name__ == "__main__":
    main()
