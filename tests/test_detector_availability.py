import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rs_studio import models, pipeline


class DetectorAvailabilityTests(unittest.TestCase):
    def test_separator_labels_describe_their_intended_role(self):
        with (
            patch("rs_studio.roformer.available", return_value=False),
            patch("rs_studio.roformer.instruments", return_value=[]),
        ):
            separators = pipeline.list_separators()

        self.assertEqual(
            {separator["id"]: separator["label"] for separator in separators},
            {
                "demucs": "Demucs (6-stem model)",
                "roformer": "BS-RoFormer (6-stem model)",
            },
        )

    def test_missing_detector_remains_in_catalog_as_unavailable(self):
        catalog = {
            "ready": {"label": "Ready", "fn": object()},
            "missing": {"label": "Missing", "fn": object(), "ready": lambda: False},
        }
        with patch.object(pipeline, "DETECTORS", catalog):
            detectors = pipeline.list_detectors()

        self.assertEqual(
            detectors,
            [
                {"id": "ready", "label": "Ready", "available": True},
                {"id": "missing", "label": "Missing", "available": False,
                 "reason": "Missing model files"},
            ],
        )

    def test_download_and_removal_immediately_update_picker_availability(self):
        with tempfile.TemporaryDirectory() as tmp:
            weights, config = Path(tmp) / "model.ckpt", Path(tmp) / "model.yaml"
            catalog = [{"id": "roformer", "label": "RoFormer", "kind": "Stem separation",
                        "files": [weights, config]}]
            with (
                patch.object(models, "_catalog", return_value=catalog),
                patch("rs_studio.roformer.checkpoint_path", return_value=weights),
                patch("rs_studio.roformer.config_path", return_value=config),
                patch("rs_studio.roformer.instruments", return_value=["bass"]),
            ):
                def entry():
                    return next(row for row in pipeline.list_separators() if row["id"] == "roformer")

                self.assertEqual(entry()["reason"], "Not downloaded")
                self.assertFalse(entry()["available"])
                weights.write_bytes(b"weights")
                self.assertEqual(entry()["reason"], "Missing model files")
                config.write_bytes(b"config")
                self.assertTrue(entry()["available"])
                self.assertEqual(entry()["reason"], "")
                models.remove("roformer")
                self.assertFalse(entry()["available"])
                self.assertEqual(entry()["reason"], "Not downloaded")

    def test_partial_download_and_missing_detector_file_have_specific_reasons(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "piano.pth"
            catalog = [{"id": "piano", "files": [path]}]
            with patch.object(models, "_catalog", return_value=catalog), patch.object(pipeline, "piano_checkpoint_path", return_value=path):
                def entry():
                    return next(row for row in pipeline.list_detectors() if row["id"] == "piano")

                self.assertEqual(entry()["reason"], "Not downloaded")
                path.with_name(path.name + ".part").write_bytes(b"partial")
                self.assertEqual(entry()["reason"], "Missing model files")
                path.write_bytes(b"complete")
                self.assertTrue(entry()["available"])

    def test_model_modes_match_the_configured_inference_backends(self):
        rows = {row["id"]: row for row in models.status()}
        self.assertEqual(rows["basic_pitch"]["modes"], ["cpu"])
        for model in ("demucs", "roformer", "piano", "mt3", "torchcrepe"):
            self.assertEqual(rows[model]["modes"], ["cpu", "cuda"])


if __name__ == "__main__":
    unittest.main()
