from enum import Enum
from types import SimpleNamespace
import unittest

from rs_studio.desktop import _configure_qt_permissions


class Feature(Enum):
    MediaAudioCapture = 2
    MediaVideoCapture = 3
    MediaAudioVideoCapture = 4
    ClipboardReadWrite = 8
    Geolocation = 1


class PermissionPolicy(Enum):
    PermissionGrantedByUser = 1
    PermissionDeniedByUser = 2


class WebAttribute(Enum):
    JavascriptCanAccessClipboard = 3
    JavascriptCanPaste = 28


class Settings:
    WebAttribute = WebAttribute

    def __init__(self):
        self.attributes = {}

    def setAttribute(self, attribute, value):
        self.attributes[attribute] = value


class Signal:
    def __init__(self):
        self.handlers = []

    def connect(self, handler):
        self.handlers.append(handler)

    def disconnect(self, handler):
        self.handlers.remove(handler)

    def emit(self, *args):
        for handler in self.handlers:
            handler(*args)


class Page:
    Feature = Feature
    PermissionPolicy = PermissionPolicy

    def __init__(self):
        self.featurePermissionRequested = Signal()
        self.featurePermissionRequested.connect(self.onFeaturePermissionRequested)
        self.decisions = []
        self._settings = Settings()

    def settings(self):
        return self._settings

    def onFeaturePermissionRequested(self, origin, feature):
        # The installed pywebview callback passes an int to PyQt6.
        self.setFeaturePermission(origin, feature, 2)

    def setFeaturePermission(self, origin, feature, policy):
        if not isinstance(policy, PermissionPolicy):
            raise TypeError("PermissionPolicy enum required")
        self.decisions.append((origin, feature, policy))


class DesktopPermissionTests(unittest.TestCase):
    def test_clipboard_request_uses_typed_denial_instead_of_crashing(self):
        page = Page()
        window = SimpleNamespace(native=SimpleNamespace(webview=SimpleNamespace(page=lambda: page)))
        with self.assertRaises(TypeError):
            page.featurePermissionRequested.emit("http://127.0.0.1:8000", Feature.ClipboardReadWrite)
        _configure_qt_permissions(window)
        page.featurePermissionRequested.emit("http://127.0.0.1:8000", Feature.ClipboardReadWrite)
        self.assertEqual(page.decisions[-1][2], PermissionPolicy.PermissionDeniedByUser)
        self.assertEqual(len(page.featurePermissionRequested.handlers), 1)
        self.assertEqual(page.settings().attributes, {WebAttribute.JavascriptCanAccessClipboard: True})

    def test_media_permissions_are_preserved_and_other_permissions_stay_denied(self):
        page = Page()
        window = SimpleNamespace(native=SimpleNamespace(webview=SimpleNamespace(page=lambda: page)))
        _configure_qt_permissions(window)
        _configure_qt_permissions(window)
        for feature in Feature:
            page.featurePermissionRequested.emit("http://127.0.0.1:8000", feature)
        self.assertEqual([decision[2] for decision in page.decisions], [
            PermissionPolicy.PermissionGrantedByUser,
            PermissionPolicy.PermissionGrantedByUser,
            PermissionPolicy.PermissionGrantedByUser,
            PermissionPolicy.PermissionDeniedByUser,
            PermissionPolicy.PermissionDeniedByUser,
        ])

    def test_other_desktop_backends_need_no_qt_import(self):
        _configure_qt_permissions(SimpleNamespace(native=SimpleNamespace(browser=object())))


if __name__ == "__main__":
    unittest.main()
