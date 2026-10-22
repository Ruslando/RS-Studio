import multiprocessing
import os
import time
import unittest
from unittest.mock import patch

from rs_studio import desktop


def _long_job():
    if os.name != "nt":
        os.setsid()  # like processing._worker: its own session, so Ctrl+C never reaches it
    time.sleep(60)


class ExitNowTests(unittest.TestCase):
    def test_exit_stops_audio_workers_before_leaving(self):
        child = multiprocessing.get_context("spawn").Process(target=_long_job)
        child.start()
        time.sleep(0.5)  # let it reach setsid
        with patch.object(desktop.os, "_exit", side_effect=SystemExit) as leave:
            with self.assertRaises(SystemExit):
                desktop._exit_now()
        leave.assert_called_once_with(0)
        child.join(5)
        self.assertFalse(child.is_alive())


if __name__ == "__main__":
    unittest.main()
