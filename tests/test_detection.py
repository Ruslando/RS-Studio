"""The default note detector and the audio analysis, run for real on a bass line whose notes are known."""
import tempfile
import unittest
from pathlib import Path

from rs_studio import pipeline, tutorial

# One note a beat: (onset in seconds, MIDI pitch).
PLAYED = [(tutorial.LEAD_IN + i * tutorial.BEAT, pitch) for i, pitch in enumerate(tutorial.PHRASE * tutorial.REPEATS)]


class DetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.folder = Path(folder.name)
        cls.audio = tutorial.write_audio(cls.folder)["bass"]

    def test_basic_pitch_finds_every_played_note(self):
        notes, warning = pipeline.detect(self.audio, "basic_pitch")
        self.assertIsNone(warning)
        missed = [(onset, pitch) for onset, pitch in PLAYED
                  if not any(note["pitch"] == pitch and abs(note["start"] - onset) < 0.1 for note in notes)]
        self.assertEqual(missed, [], "each note is found at its pitch, where it was played")
        # A polyphonic model also hears overtones; none of them is a note that was never played.
        played = {pitch % 12 for _, pitch in PLAYED}
        self.assertEqual({note["pitch"] % 12 for note in notes} - played, set())
        self.assertTrue(all(0 <= note["start"] < note["end"] <= 17.5 for note in notes))

    def test_detecting_a_stretch_returns_notes_in_song_time(self):
        notes, warning = pipeline.detect(self.audio, "basic_pitch", start=4.0, end=8.0)
        self.assertIsNone(warning)
        self.assertTrue(notes)
        self.assertTrue(all(3.9 <= note["start"] and note["end"] <= 8.1 for note in notes), notes)
        inside = [(onset, pitch) for onset, pitch in PLAYED if 4.2 <= onset <= 7.3]
        for onset, pitch in inside:
            self.assertTrue(any(note["pitch"] == pitch and abs(note["start"] - onset) < 0.1 for note in notes), (onset, pitch))
        self.assertEqual(pipeline.detect(self.audio, "basic_pitch", start=8.0, end=8.0), ([], None))
        self.assertEqual(pipeline.detect(self.audio, "no such model")[0], [])

    def test_analysis_reads_length_and_tempo_and_draws_the_spectrogram(self):
        image = self.folder / "spectrogram.png"
        found = pipeline.compute_spectrogram(self.audio, image, with_tempo=True)
        self.assertAlmostEqual(found["duration"], 17.35, places=1)
        self.assertAlmostEqual(found["tempo"], tutorial.BPM, delta=tutorial.BPM * 0.05)
        self.assertLess(found["midi_low"], min(tutorial.PHRASE))
        self.assertGreater(found["midi_high"], max(tutorial.PHRASE))
        self.assertEqual(image.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(found["height"], found["midi_high"] - found["midi_low"] + 1, "one row per semitone")
        self.assertGreater(found["width"], 100)


if __name__ == "__main__":
    unittest.main()
