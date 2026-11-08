from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from rs_studio.desktop import _configure_qt_downloads


class Signal:
    def __init__(self, handler):
        self.handlers = [handler]

    def disconnect(self, handler):
        self.handlers.remove(handler)

    def connect(self, handler):
        self.handlers.append(handler)

    def emit(self, download):
        for handler in self.handlers:
            handler(download)


class DesktopDownloadTests(unittest.TestCase):
    def setUp(self):
        self.previous = Mock(side_effect=AttributeError("setPath"))
        self.signal = Signal(self.previous)
        profile = SimpleNamespace(downloadRequested=self.signal)
        self.native = SimpleNamespace(
            webview=SimpleNamespace(page=lambda: SimpleNamespace(profile=lambda: profile)),
            on_download_requested=self.previous,
            localization={"global.saveFile": "Save file"},
        )
        self.window = SimpleNamespace(native=self.native)
        self.dialog = Mock(return_value=("/tmp/Artist_Song_v2_p.psarc", ""))
        self.qt_patch = patch.dict("sys.modules", {
            "qtpy.QtWidgets": SimpleNamespace(
                QFileDialog=SimpleNamespace(getSaveFileName=self.dialog)),
        })
        self.qt_patch.start()
        self.addCleanup(self.qt_patch.stop)

    def download(self, qt6=True):
        setters = ["setDownloadDirectory", "setDownloadFileName"] if qt6 else ["setPath"]
        download = Mock(spec=["suggestedFileName", "downloadFileName", "accept", "cancel", *setters])
        download.suggestedFileName.return_value = "Artist_Song_v2_p.psarc"
        return download

    def test_qt6_blob_download_keeps_filename_and_accepts_selected_path(self):
        _configure_qt_downloads(self.window)
        _configure_qt_downloads(self.window)
        download = self.download()
        self.signal.emit(download)
        self.dialog.assert_called_once_with(
            self.native, "Save file", "Artist_Song_v2_p.psarc", "All files (*)")
        download.setDownloadDirectory.assert_called_once_with("/tmp")
        download.setDownloadFileName.assert_called_once_with("Artist_Song_v2_p.psarc")
        download.accept.assert_called_once_with()
        download.cancel.assert_not_called()
        self.previous.assert_not_called()
        self.assertEqual(len(self.signal.handlers), 1)

    def test_cancel_does_not_accept_or_change_destination(self):
        self.dialog.return_value = ("", "")
        _configure_qt_downloads(self.window)
        download = self.download()
        self.signal.emit(download)
        download.cancel.assert_called_once_with()
        download.accept.assert_not_called()
        download.setDownloadDirectory.assert_not_called()

    def test_save_failure_is_logged_and_cancelled_without_escaping_callback(self):
        _configure_qt_downloads(self.window)
        download = self.download()
        download.setDownloadFileName.side_effect = OSError("Could not set destination")
        with self.assertLogs("rs_studio.desktop", level="ERROR"):
            self.signal.emit(download)
        download.cancel.assert_called_once_with()
        download.accept.assert_not_called()

    def test_qt5_combined_path_setter_is_supported(self):
        _configure_qt_downloads(self.window)
        download = self.download(qt6=False)
        self.signal.emit(download)
        download.setPath.assert_called_once_with("/tmp/Artist_Song_v2_p.psarc")
        download.accept.assert_called_once_with()

    def test_other_backends_need_no_qt_import(self):
        _configure_qt_downloads(SimpleNamespace(native=SimpleNamespace(browser=object())))


if __name__ == "__main__":
    unittest.main()
