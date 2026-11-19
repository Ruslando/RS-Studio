"""The setup's app package (tools/package-bootstrap.py)."""
import hashlib
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_bootstrap", ROOT / "tools/package-bootstrap.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

WHEEL = "madmom-0.17.dev0-cp312-cp312-win_amd64.whl"


class LocalWheelTests(unittest.TestCase):
    def test_a_wheel_locked_by_path_is_shipped_and_pinned_by_name(self):
        digest = hashlib.sha256((ROOT / "wheels" / WHEEL).read_bytes()).hexdigest()
        # As uv export writes it: a path the install would resolve from its working folder.
        exported = (f"./wheels/{WHEEL} ; python_full_version >= '3.12' and sys_platform == 'win32' \\\n"
                    f"    --hash=sha256:{digest}\n    # via rs-studio\nmido==1.3.3 \\\n    --hash=sha256:{'0' * 64}\n")
        requirements, shipped = package.local_wheels(exported)
        self.assertEqual(shipped, {f"wheels/{WHEEL}": ROOT / "wheels" / WHEEL})
        self.assertTrue(requirements.startswith(
            f"madmom==0.17.dev0 ; python_full_version >= '3.12' and sys_platform == 'win32' \\\n    --hash=sha256:{digest}\n"))
        self.assertNotIn("./wheels", requirements)
        self.assertIn("mido==1.3.3", requirements, "other requirements stay as they are")

    def test_a_wheel_that_does_not_match_the_lock_is_refused(self):
        exported = f"./wheels/{WHEEL} \\\n    --hash=sha256:{'0' * 64}\n"
        with self.assertRaisesRegex(RuntimeError, "does not match uv.lock"):
            package.local_wheels(exported)


if __name__ == "__main__":
    unittest.main()
