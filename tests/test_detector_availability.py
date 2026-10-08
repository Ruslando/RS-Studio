import unittest
from unittest.mock import patch

from rs_studio import pipeline


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

    def test_detector_labels_describe_their_intended_role(self):
        self.assertEqual(
            {detector_id: entry["label"] for detector_id, entry in pipeline.DETECTORS.items()},
            {
                "basic_pitch": "Basic Pitch (polyphonic model)",
                "mt3": "MR-MT3 (multi-instrument model)",
                "torchcrepe": "torchcrepe (bass / melody model)",
                "piano": "Piano Transcription (piano model)",
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
                {"id": "missing", "label": "Missing", "available": False},
            ],
        )


if __name__ == "__main__":
    unittest.main()
