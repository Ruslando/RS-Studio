import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from rs_studio import audio_runtime


class AudioRuntimeTests(unittest.TestCase):
    def test_source_ffmpeg_is_found_outside_project_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "vendor/ffmpeg"
            directory.mkdir(parents=True)
            (directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).touch()
            with patch.object(audio_runtime, "__file__", str(root / "src/rs_studio/audio_runtime.py")), patch.object(sys, "frozen", False, create=True), patch.dict(os.environ, {"PATH": "system-path"}), patch.object(audio_runtime, "_DLL_DIRECTORIES", {}), patch.object(os, "add_dll_directory", create=True) as register:
                self.assertEqual(audio_runtime.prepare_ffmpeg(), directory.resolve())
                audio_runtime.prepare_ffmpeg()
                self.assertEqual(os.environ["PATH"].split(os.pathsep).count(str(directory.resolve())), 1)
                register.assert_called_once_with(str(directory.resolve()))

    def test_frozen_ffmpeg_comes_from_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "ffmpeg"
            directory.mkdir()
            (directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).touch()
            with patch.object(sys, "frozen", True, create=True), patch.object(sys, "_MEIPASS", tmp, create=True), patch.dict(os.environ, {"PATH": "system-path"}), patch.object(audio_runtime, "_DLL_DIRECTORIES", {}), patch.object(os, "add_dll_directory", create=True):
                self.assertEqual(audio_runtime.prepare_ffmpeg(), directory.resolve())
                self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(directory.resolve()))

    def test_missing_staged_ffmpeg_preserves_system_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(audio_runtime, "__file__", str(Path(tmp) / "src/rs_studio/audio_runtime.py")), patch.object(sys, "frozen", False, create=True), patch.dict(os.environ, {"PATH": "system-path"}):
                self.assertIsNone(audio_runtime.prepare_ffmpeg())
                self.assertEqual(os.environ["PATH"], "system-path")


    def test_demucs_cli_error_keeps_decoding_cause(self):
        from rs_studio import pipeline

        demucs = types.ModuleType("demucs")
        separate = types.ModuleType("demucs.separate")
        demucs.separate = separate

        def fail(args):
            print("When trying to load using ffmpeg: FFmpeg is not installed.")
            print("[end of libtorchcodec loading traceback]")
            raise SystemExit(1)

        separate.main = fail
        with (
            patch.dict(sys.modules, {"demucs": demucs, "demucs.separate": separate}),
            patch.object(pipeline, "_select_device", return_value="cpu"),
            patch.object(pipeline, "_release_torch_memory") as release,
        ):
            stems, warning = pipeline.separate_stems(Path("song.wav"), Path("unused"))
        self.assertEqual(stems, {})
        self.assertIn("FFmpeg is not installed", warning)
        self.assertIn("exit code 1", warning)
        release.assert_called_once_with("cpu")


if __name__ == "__main__":
    unittest.main()
