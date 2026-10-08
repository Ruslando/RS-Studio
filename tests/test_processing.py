import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from rs_studio import processing


def successful_job(value):
    processing.report("Measured work", 1, 2, "cpu")
    return value


def staged_job(job_dir, *, work_dir):
    audio = work_dir / "playback_guitar.opus"
    audio.write_bytes(b"complete")
    (work_dir / "spectrogram_guitar.png").write_bytes(b"image")
    return SimpleNamespace(audio_path=audio), None


def slow_staged_job(job_dir, *, work_dir):
    (work_dir / "playback_guitar.opus").write_bytes(b"partial")
    processing.report("Busy")
    time.sleep(60)  # deliberately no cooperative cancellation checkpoint
    return staged_job(job_dir, work_dir=work_dir)


def broken_job():
    raise ValueError("model failed")


class ProcessingTests(unittest.TestCase):
    def setUp(self):
        with processing._states_lock:
            processing._states.clear()
            processing._cancel_events.clear()
            processing._reservations.clear()

    def wait_for(self, operation_id, field, value):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if processing.status(operation_id).get(field) == value:
                return
            time.sleep(0.02)
        self.fail(str(processing.status(operation_id)))

    def test_success_and_completed_cancel(self):
        operation_id = "1" * 32
        self.assertEqual(processing.run(operation_id, successful_job, 42), 42)
        self.assertEqual(processing.cancel(operation_id)["state"], "done")

    def test_cancel_before_processing_post(self):
        operation_id = "2" * 32
        processing.cancel(operation_id)
        with self.assertRaises(processing.OperationCancelled):
            processing.run(operation_id, successful_job, 42)
        self.assertEqual(processing.status(operation_id)["state"], "cancelled")

    def test_cancel_stops_native_work_and_keeps_existing_stem(self):
        operation_id = "3" * 32
        with tempfile.TemporaryDirectory() as tmp, ThreadPoolExecutor() as pool:
            output = Path(tmp)
            existing = output / "playback_guitar.opus"
            existing.write_bytes(b"original")
            future = pool.submit(processing.run, operation_id, slow_staged_job, output, output_dir=output)
            self.wait_for(operation_id, "stage", "Busy")
            processing.cancel(operation_id)
            with self.assertRaises(processing.OperationCancelled):
                future.result(timeout=10)
            self.assertEqual(existing.read_bytes(), b"original")
            self.assertEqual(list(output.glob(".operation-*")), [])
            self.assertEqual(processing.status(operation_id)["state"], "cancelled")
            self.assertEqual(processing.run("4" * 32, successful_job, 7), 7)

    def test_queued_cancel_does_not_start_worker(self):
        operation_id = "5" * 32
        processing._work_lock.acquire()
        try:
            with ThreadPoolExecutor() as pool:
                future = pool.submit(processing.run, operation_id, successful_job, 7)
                self.wait_for(operation_id, "state", "queued")
                processing.cancel(operation_id)
                with self.assertRaises(processing.OperationCancelled):
                    future.result(timeout=5)
        finally:
            processing._work_lock.release()

    def test_success_publishes_staged_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            view, warning = processing.run("6" * 32, staged_job, output, output_dir=output)
            self.assertEqual(view.audio_path, output / "playback_guitar.opus")
            self.assertEqual(view.audio_path.read_bytes(), b"complete")
            self.assertTrue((output / "spectrogram_guitar.png").is_file())
            self.assertEqual(list(output.glob(".operation-*")), [])

    def test_worker_error_and_invalid_id(self):
        with self.assertRaisesRegex(RuntimeError, "model failed"):
            processing.run("7" * 32, broken_job)
        self.assertEqual(processing.status("7" * 32)["state"], "error")
        with self.assertRaises(ValueError):
            processing.cancel("invalid")


if __name__ == "__main__":
    unittest.main()
