import json
import sys
import types
import unittest
from unittest.mock import Mock, patch

from rs_studio import server


class VersionVariantTests(unittest.TestCase):
    def test_variant_describes_build_independently_of_gpu_access(self):
        for cuda, available, variant in [(None, False, "CPU"), ("12.6", True, "CUDA"),
                                          ("12.6", False, "CUDA")]:
            with self.subTest(cuda=cuda, available=available):
                torch = types.SimpleNamespace(version=types.SimpleNamespace(cuda=cuda),
                                              cuda=types.SimpleNamespace(is_available=Mock(return_value=available)))
                with patch.dict(sys.modules, {"torch": torch}):
                    data = json.loads(server.api_version().body)
                self.assertEqual(data["variant"], variant)
                self.assertEqual(data["cuda_available"], available)
                self.assertEqual(data["version"], server.__version__)
