import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from rs_studio import processing, server


class OperationRouteTests(unittest.TestCase):
    def test_cancel_endpoint_and_invalid_id(self):
        operation_id = "e" * 32
        value = asyncio.run(server.api_operation_cancel(operation_id))
        self.assertEqual(value["state"], "cancelled")
        with self.assertRaises(HTTPException) as error:
            asyncio.run(server.api_operation_cancel("invalid"))
        self.assertEqual(error.exception.status_code, 400)

    def test_detection_cancellation_is_not_server_failure(self):
        with patch.object(server, "_read_manifest", return_value={}), patch.object(server, "_find_stem", return_value={"audio_rel": "mix.wav"}), patch.object(server, "_project_file_or_404", return_value=Path("mix.wav")), patch.object(server.pipeline, "list_detectors", return_value=[{"id": "basic_pitch", "label": "Basic Pitch"}]), patch.object(processing, "run", side_effect=processing.OperationCancelled("Operation cancelled")):
            response = server.api_detect({"job": "job", "stem": "mix", "model": "basic_pitch"})
        self.assertEqual(response.status_code, 409)
        self.assertTrue(json.loads(response.body)["cancelled"])

    def test_separation_cancellation_does_not_append_stem(self):
        with patch.object(server, "_draft_manifest", return_value={"stems": [{"id": "mix"}]}), patch.object(server, "_job_dir", return_value=Path("job")), patch.object(server, "_project_input", return_value=Path("mix.wav")), patch.object(server.pipeline, "list_separators", return_value=[{"id": "demucs"}]), patch.object(processing, "run", side_effect=processing.OperationCancelled("Operation cancelled")), patch.object(server, "_append_processed_stem") as append:
            response = server.api_project_stem_separate("job", {"backend": "demucs", "part": "guitar"})
        self.assertEqual(response.status_code, 409)
        append.assert_not_called()


if __name__ == "__main__":
    unittest.main()
