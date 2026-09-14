import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from institution_entry import resolve_state_directory


class LocalStorageTests(unittest.TestCase):
    def test_existing_installation_retains_its_default_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.assertEqual(resolve_state_directory(root), root / "state")

    def test_all_releases_use_the_configured_existing_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            data = root / "separate-disk" / "state"
            data.mkdir(parents=True)
            (root / "storage.json").write_text(json.dumps({"state_dir": str(data)}))
            self.assertEqual(resolve_state_directory(root), data)

    def test_bad_storage_choice_never_falls_back_to_the_system_drive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            synced = root / "OneDrive" / "state"
            synced.mkdir(parents=True)
            for selected in ["relative/state", str(root / "unmounted"), str(synced), "", None]:
                with self.subTest(selected=selected):
                    (root / "storage.json").write_text(json.dumps({"state_dir": selected}))
                    with self.assertRaises((ValueError, OSError)):
                        resolve_state_directory(root)


if __name__ == "__main__":
    unittest.main()
