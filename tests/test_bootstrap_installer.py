import base64
import hashlib
import http.server
import json
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bootstrap"))
import installer
from launcher import InstallerWindow


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    ranges = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.ranges.append(self.headers.get("Range"))
        super().do_GET()


def fake_environment(root, runtime, environment, app, wheels, payload, cancel, progress):
    """Stands in for uv: installs the downloaded wheels as .dist-info folders."""
    python = installer.environment_python(environment)
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_bytes(b"python")
    (environment / "pyvenv.cfg").write_text(f"version_info = {payload['python']}")
    site = environment / "Lib/site-packages"
    for wheel in payload["runtimes"][runtime]["wheels"]:
        name, version = installer.distribution_key(wheel["name"])
        if (site / f"{name}-{version}.dist-info").is_dir():
            continue
        assert (wheels / wheel["name"]).is_file(), wheel["name"]
        (site / f"{name}-{version}.dist-info").mkdir(parents=True)


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        numbers = cls.key.public_key().public_numbers()
        cls.public = {"n": format(numbers.n, "x"), "e": numbers.e}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.server_root = self.root / "server"
        self.server_root.mkdir()
        def handler(*args, **kwargs):
            return QuietHandler(*args, directory=str(self.server_root), **kwargs)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.destination = self.root / "installation"
        self.cancel = threading.Event()
        self.config = {"launcher_version": 2, "public_key": self.public, "manifest_url": self.base + "/manifest.json"}
        self.payload = {"schema": 2, "launcher_min": 2, "platform": installer.platform_id(), "version": "1.0", "python": "3.12.13",
                        "app": self.package("app", {"src/rs_studio/__init__.py": b"__version__ = '1.0'", "web/index.html": b"<html></html>",
                                                    "requirements/core.txt": b"numpy==1.26.4", "requirements/cuda.txt": b"torch @ cuda"}),
                        "ffmpeg": self.package("ffmpeg", {"ffmpeg.exe": b"ffmpeg", "avcodec.dll": b"codec"}),
                        "runtimes": {"core": self.runtime("core.txt", {"numpy-1.0-py3-none-any.whl": b"numpy" * 40, "torch-2.0-py3-none-any.whl": b"cpu torch" * 30}),
                                     "cuda": dict(self.runtime("cuda.txt", {"numpy-1.0-py3-none-any.whl": b"numpy" * 40, "torch-2.0+cu-py3-none-any.whl": b"cuda torch" * 90}), cuda_archs=[75, 86])}}
        self.envelope = self.sign(self.payload)
        (self.server_root / "manifest.json").write_text(json.dumps(self.envelope), encoding="utf-8")

    def package(self, name, files):
        archive = self.server_root / (name + ".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for filename, value in files.items():
                output.writestr(filename, value)
        return {"id": name, "url": self.base + "/" + name + ".zip", "bytes": archive.stat().st_size,
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "unpacked_bytes": sum(map(len, files.values())), "files": len(files)}

    def runtime(self, requirements, wheels):
        listed = []
        for name, data in wheels.items():
            (self.server_root / name).write_bytes(data)
            listed.append({"name": name, "url": self.base + "/" + name.replace("+", "%2B"), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
        return {"requirements": "requirements/" + requirements, "wheels": listed, "download_bytes": sum(len(data) for data in wheels.values())}

    def sign(self, payload):
        signature = self.key.sign(installer.canonical(payload), padding.PKCS1v15(), hashes.SHA256())
        return {"payload": payload, "signature": base64.b64encode(signature).decode()}

    def install(self, probe=lambda *args: None, runtime="core"):
        return installer.install(self.destination, self.envelope, self.config, self.cancel, lambda *args, **detail: None,
                                 runtime=runtime, allow_local=True, probe=probe, prepare=fake_environment)

    def test_window_fetches_manifest_but_does_not_open_before_install(self):
        window = InstallerWindow(self.config, self.destination, allow_local=True)
        with patch('launcher.launch') as open_app:
            window._perform()
            self.assertEqual(window.status()['state'], 'ready')
            open_app.assert_not_called()
            with patch('launcher.install_release', side_effect=installer.InstallError('missing DLL')):
                window._perform()
            self.assertEqual(window.status()['state'], 'error')
            open_app.assert_not_called()
            with patch('launcher.install_release', return_value=self.payload):
                window._perform()
            # Installed: setup asks about shortcuts and opening instead of starting the app.
            self.assertEqual(window.status()['state'], 'done')
            open_app.assert_not_called()

    def test_finish_creates_chosen_shortcuts_and_opens_only_on_request(self):
        window = InstallerWindow(self.config, self.destination, allow_local=True, relaunch=["--allow-local"])
        window._active = {"app_dir": "app", "version": "1.0"}
        for start_menu, desktop, open_app in ((True, False, False), (False, True, True)):
            window._set("done", "RS Studio is installed.")
            with patch("launcher.create_shortcut") as shortcut, patch("launcher.launch") as opened,                     patch("launcher.os.name", "nt"), patch.object(window, "_destroy") as closed:
                window._finish(start_menu, desktop, open_app)
            folders = [call.args[0] for call in shortcut.call_args_list]
            self.assertEqual(folders, ["Programs"] * start_menu + ["Desktop"] * desktop)
            self.assertEqual(shortcut.call_args.args[1][-4:], ["--allow-local", "--install-root", str(self.destination), "--launch"])
            self.assertEqual(opened.called, open_app)
            closed.assert_called_once()

    def test_setup_recognises_what_is_in_the_folder(self):
        window = InstallerWindow(self.config, self.destination, allow_local=True)
        window._inspect()
        self.assertEqual(window.status()["kind"], "install")
        self.destination.mkdir()
        (self.destination / "installer.lock").write_bytes(b"0")
        window._inspect()
        self.assertEqual(window.status()["kind"], "continue")
        self.install()
        with patch("launcher.fetch_manifest", side_effect=OSError("offline")):
            other = InstallerWindow(self.config, self.destination, allow_local=True)
            other._inspect()  # installed: Open works offline, Repair needs the release
        self.assertEqual(other.status()["kind"], "installed")
        self.assertEqual(other.status()["installed_version"], "1.0")
        foreign = self.root / "foreign"
        foreign.mkdir()
        (foreign / "notes.txt").write_text("x")
        window._destination = foreign
        window._inspect()
        self.assertEqual(window.status()["kind"], "occupied")

    def test_chosen_folder_follows_installer_conventions(self):
        import launcher
        empty, used = self.root / "empty", self.root / "Programs"
        empty.mkdir()
        used.mkdir()
        (used / "other.exe").write_bytes(b"x")
        self.assertEqual(launcher.install_target(empty), empty)
        self.assertEqual(launcher.install_target(self.root / "new"), self.root / "new")
        self.assertEqual(launcher.install_target(used), used / "RS Studio")
        self.install()
        self.assertEqual(launcher.install_target(self.destination), self.destination)

    def test_repair_rechecks_libraries(self):
        window = InstallerWindow(self.config, self.destination, allow_local=True)
        window._inspect()
        with patch("launcher.install_release", return_value=self.payload) as install, patch("threading.Thread"):
            window.repair()
            window._perform(True)
        self.assertTrue(install.call_args.kwargs["repair"])
        self.assertEqual(window.status()["message"], "RS Studio is repaired.")

    def test_window_ready_installation_starts_without_network(self):
        active = self.install()
        window = InstallerWindow(self.config, self.destination, fixed=True, allow_local=True)
        with patch('launcher.fetch_manifest', side_effect=AssertionError('offline')), patch('launcher.launch') as open_app:
            window._perform()
            open_app.assert_called_once_with(self.destination, active)

    def test_window_offers_cuda_with_check_result(self):
        window = InstallerWindow(self.config, self.destination, allow_local=True)
        with patch("launcher.cuda_check", return_value={"useful": True, "reason": "GPU found"}):
            window._perform()
        status = window.status()
        packages = self.payload["app"]["bytes"] + self.payload["ffmpeg"]["bytes"]
        self.assertEqual(status["core"]["download_bytes"], self.payload["runtimes"]["core"]["download_bytes"] + packages)
        self.assertEqual(status["cuda"]["download_bytes"], self.payload["runtimes"]["cuda"]["download_bytes"] + packages)
        self.assertTrue(status["cuda"]["useful"])
        with patch("launcher.install_release", return_value=self.payload) as install, patch("launcher.launch"), \
                patch("threading.Thread"):
            window.install(cuda=True)
            window._perform()
        self.assertEqual(install.call_args.kwargs["runtime"], "cuda")

    def test_cuda_environment_is_separate_and_remembered(self):
        core = self.install()
        cuda = self.install(runtime="cuda")
        self.assertNotEqual(core["environment"], cuda["environment"])
        self.assertEqual(Path(cuda["environment"]).name, "cuda")
        self.assertEqual(installer.installed_release(self.destination, self.config, allow_local=True), cuda)
        with self.assertRaises(installer.InstallError):
            self.install(runtime="rocm")

    def test_cuda_check_advises_without_blocking(self):
        runtime = {"cuda_archs": [50, 60, 61, 70, 75, 80, 86, 90]}
        def smi(output):
            return lambda: output
        def missing():
            raise FileNotFoundError("nvidia-smi")
        cases = [
            (missing, False, "No NVIDIA"),
            (smi("NVIDIA GeForce RTX 3070, 560.94, 8192, 8.6\n"), True, "3070 · 8 GB"),
            # sm_89 has no kernels of its own in the list but runs the sm_86 ones.
            (smi("NVIDIA GeForce RTX 4090, 560.94, 24564, 8.9\n"), True, "4090"),
            (smi("NVIDIA GeForce GTX 1050, 560.94, 2048, 6.1\n"), True, "low VRAM"),
            (smi("NVIDIA GeForce RTX 5080, 576.02, 16303, 12.0\n"), False, "not supported"),
            (smi("NVIDIA GeForce GTX 680, 472.12, 2048, 3.0\n"), False, "too old for CUDA"),
            (smi("NVIDIA GeForce RTX 3070, 516.94, 8192, 8.6\n"), False, "driver too old"),
            # The supported card wins over a faster unsupported one.
            (smi("NVIDIA GeForce RTX 5090, 576.02, 32607, 12.0\nNVIDIA GeForce RTX 3060, 576.02, 12288, 8.6\n"), True, "3060"),
        ]
        for query, useful, text in cases:
            with self.subTest(text=text):
                result = installer.cuda_check(runtime, query)
                self.assertEqual(result["useful"], useful)
                self.assertIn(text, result["reason"])
        self.assertFalse(installer.cuda_check(None)["useful"])

    def test_download_resumes_from_valid_range_response(self):
        data = (self.server_root / 'ffmpeg.zip').read_bytes()
        class RangeHandler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                start = int(self.headers['Range'].removeprefix('bytes=').removesuffix('-'))
                self.send_response(206)
                self.send_header('Content-Range', f'bytes {start}-{len(data)-1}/{len(data)}')
                self.send_header('Content-Length', str(len(data)-start))
                self.end_headers()
                self.wfile.write(data[start:])
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), RangeHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        package = dict(self.payload['ffmpeg'], url=f'http://127.0.0.1:{server.server_port}/ffmpeg.zip')
        target = self.root / 'range-cache' / 'ffmpeg.zip'
        target.parent.mkdir()
        target.with_name('ffmpeg.zip.part').write_bytes(data[:20])
        installer.download(package, target, self.cancel, lambda *args: None, allow_local=True)
        self.assertEqual(target.read_bytes(), data)

    def test_interrupted_install_keeps_finished_files_and_resumes_partial_ones(self):
        wheels = self.payload["runtimes"]["core"]["wheels"]
        downloads = self.destination / "downloads" / "wheels"
        downloads.mkdir(parents=True)
        # One wheel finished before the interruption, the other stopped halfway.
        (downloads / wheels[0]["name"]).write_bytes((self.server_root / wheels[0]["name"]).read_bytes())
        (downloads / (wheels[1]["name"] + ".part")).write_bytes((self.server_root / wheels[1]["name"]).read_bytes()[:100])
        QuietHandler.ranges.clear()
        reports = []
        installer.install(self.destination, self.envelope, self.config, self.cancel, lambda *args, **detail: reports.append((args, detail)),
                          allow_local=True, probe=lambda *args: None, prepare=fake_environment)
        # app + ffmpeg fetched whole, the finished wheel not at all, the partial one from byte 100.
        self.assertEqual(sorted(QuietHandler.ranges, key=str), sorted([None, None, "bytes=100-"], key=str))
        downloading = [(args, detail) for args, detail in reports if args[0] == "Downloading"]
        self.assertTrue(all("file" in detail and "speed" in detail for _, detail in downloading))
        self.assertEqual(downloading[-1][0][1], downloading[-1][0][2])  # ends at 100 %
        # Installed and verified: downloads are no longer needed.
        self.assertFalse((self.destination / "downloads").exists())

    def test_existing_installation_is_reused_without_downloading(self):
        self.install()
        (self.destination / "current.json").unlink()  # e.g. setup started again
        QuietHandler.ranges.clear()
        self.install()
        self.assertEqual(QuietHandler.ranges, [])
        self.assertIsNotNone(installer.installed_release(self.destination, self.config, allow_local=True))

    def test_only_missing_libraries_are_downloaded(self):
        active = self.install()
        environment = Path(active["environment"])
        shutil.rmtree(next((environment / "Lib/site-packages").glob("torch-*.dist-info")))
        (environment / "rs-studio-environment.json").unlink()
        QuietHandler.ranges.clear()
        fetched = []
        installer.install(self.destination, self.envelope, self.config, self.cancel,
                          lambda stage, done, total, **detail: fetched.append(detail.get("file")) if stage == "Downloading" else None,
                          allow_local=True, probe=lambda *args: None, prepare=fake_environment)
        self.assertEqual(set(fetched), {"torch-2.0-py3-none-any.whl"})

    def test_new_release_downloads_only_changed_libraries(self):
        self.install()
        self.payload["runtimes"]["core"] = self.runtime("core.txt", {"numpy-1.0-py3-none-any.whl": b"numpy" * 40,
                                                                     "torch-2.1-py3-none-any.whl": b"new torch" * 30})
        self.envelope = self.sign(self.payload)
        fetched = []
        installer.install(self.destination, self.envelope, self.config, self.cancel,
                          lambda stage, done, total, **detail: fetched.append(detail.get("file")) if stage == "Downloading" else None,
                          allow_local=True, probe=lambda *args: None, prepare=fake_environment)
        self.assertEqual(set(fetched), {"torch-2.1-py3-none-any.whl"})

    def test_failed_check_rebuilds_libraries_next_time(self):
        active = self.install()
        (self.destination / "current.json").unlink()
        with self.assertRaises(installer.InstallError):
            self.install(probe=lambda *args: (_ for _ in ()).throw(installer.InstallError("DLL load failed")))
        self.assertEqual(len(installer.missing_wheels(Path(active["environment"]), self.payload, "core")), 2)

    def test_damaged_finished_download_is_fetched_again(self):
        wheel = self.payload["runtimes"]["core"]["wheels"][0]
        target = self.destination / "downloads" / "wheels" / wheel["name"]
        target.parent.mkdir(parents=True)
        target.write_bytes(b"x" * wheel["bytes"])
        self.install()
        self.assertIsNotNone(installer.installed_release(self.destination, self.config, allow_local=True))

    def test_signature_is_required_and_tampering_is_rejected(self):
        envelope = installer.fetch_manifest(self.config, allow_local=True)
        self.assertEqual(envelope, self.envelope)
        changed = json.loads(json.dumps(envelope))
        changed["payload"]["runtimes"]["core"]["requirements"] = "requirements/cuda.txt"
        with self.assertRaises(installer.InstallError):
            installer.validate_manifest(changed, self.config, allow_local=True)
        self.assertFalse((self.destination / "current.json").exists())

    def test_complete_install_opens_gate_and_survives_offline(self):
        probes = []
        active = self.install(probe=lambda *args: probes.append(args))
        self.assertEqual(len(probes), 1)
        with patch.object(installer, "fetch_manifest", side_effect=AssertionError("Must not fetch when ready")):
            self.assertEqual(installer.installed_release(self.destination, self.config, allow_local=True), active)
        self.assertFalse(list((self.destination / "downloads").glob("*.zip")))
        ffmpeg = Path(active["ffmpeg_dir"])  # the environment stays; only ffmpeg is fetched again
        (ffmpeg / "avcodec.dll").unlink()
        self.assertIsNone(installer.installed_release(self.destination, self.config, allow_local=True))
        self.install()
        self.assertTrue((ffmpeg / "avcodec.dll").exists())

    def test_malformed_receipt_returns_to_setup(self):
        active = self.install()
        app = Path(active["app_dir"])
        (app / 'installed.json').write_text(json.dumps({'sha256': self.payload['app']['sha256'], 'inventory': []}))
        self.assertIsNone(installer.installed_release(self.destination, self.config, allow_local=True))

    def test_failed_probe_never_activates_release(self):
        def fail(*args):
            raise installer.InstallError("A DLL could not load")
        with self.assertRaisesRegex(installer.InstallError, "DLL"):
            self.install(probe=fail)
        self.assertFalse((self.destination / "current.json").exists())
        self.assertIsNone(installer.installed_release(self.destination, self.config, allow_local=True))
        self.install()
        self.assertIsNotNone(installer.installed_release(self.destination, self.config, allow_local=True))

    def test_failed_replacement_keeps_previous_active_release(self):
        self.install()
        original = (self.destination / "current.json").read_bytes()
        self.payload["app"] = self.package("app2", {"src/rs_studio/__init__.py": b"new", "web/index.html": b"new",
                                                    "requirements/core.txt": b"numpy==2", "requirements/cuda.txt": b"torch"})
        self.envelope = self.sign(self.payload)
        with self.assertRaises(installer.InstallError):
            self.install(probe=lambda *args: (_ for _ in ()).throw(installer.InstallError("failure")))
        self.assertEqual((self.destination / "current.json").read_bytes(), original)

    def test_download_resume_when_server_ignores_range(self):
        package = self.payload["ffmpeg"]
        target = self.root / "cache" / "ffmpeg.zip"
        target.parent.mkdir()
        target.with_name("ffmpeg.zip.part").write_bytes((self.server_root / "ffmpeg.zip").read_bytes()[:20])
        QuietHandler.ranges.clear()
        installer.download(package, target, self.cancel, lambda *args: None, allow_local=True)
        self.assertIn("bytes=20-", QuietHandler.ranges)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), package["sha256"])

    def test_checksum_failure_and_cancellation_never_activate(self):
        archive = self.server_root / "ffmpeg.zip"
        content = bytearray(archive.read_bytes())
        content[5] ^= 1
        archive.write_bytes(content)
        with self.assertRaisesRegex(installer.InstallError, "checksum"):
            self.install()
        self.assertFalse((self.destination / "current.json").exists())
        self.cancel.set()
        with self.assertRaises(installer.Cancelled):
            self.install()

    def test_uv_failure_and_cancel_are_reported(self):
        with patch.object(installer, "uv_executable", return_value=Path(sys.executable)):
            with self.assertRaisesRegex(installer.InstallError, "Installing libraries failed"):
                installer.run_uv(["-c", "import sys; print('error: no matching wheel'); sys.exit(2)"], self.root, self.cancel)
            self.cancel.set()
            with self.assertRaises(installer.Cancelled):
                installer.run_uv(["-c", "import time; time.sleep(30)"], self.root, self.cancel)

    def test_unsafe_archive_paths_links_and_duplicates_rejected(self):
        for name in ("../outside", "/absolute", "C:/outside", "a\\b", "a/../b", "CON", "a./b", "a//b", "a/b:stream"):
            with self.subTest(name=name), self.assertRaises(installer.InstallError):
                installer.archive_path(name)
        for names, link in [(["same", "SAME"], False), (["link"], True), (["installed.json"], False)]:
            archive = self.server_root / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for name in names:
                    info = zipfile.ZipInfo(name)
                    if link:
                        info.create_system = 3
                        info.external_attr = 0o120777 << 16
                    output.writestr(info, b"x")
            package = {"unpacked_bytes": len(names), "files": len(names)}
            destination = self.root / ("extract-" + str(len(names)) + str(link) + names[0])
            destination.mkdir()
            with self.assertRaises(installer.InstallError):
                installer.extract(archive, destination, package, self.cancel, lambda *args: None)

    def test_https_and_version_compatibility_required(self):
        with self.assertRaises(installer.InstallError):
            installer.fetch_manifest(self.config)
        for url in ("file:///tmp/a", "http://example.com/a", "https://user:pass@example.com/a"):
            with self.subTest(url=url), self.assertRaises(installer.InstallError):
                installer.checked_url(url, allow_local=True)
        with self.assertRaisesRegex(installer.InstallError, "newer RS Studio installer"):
            installer.validate_manifest(self.envelope, dict(self.config, launcher_version=1), allow_local=True)
        self.payload["runtimes"]["core"]["requirements"] = "../outside.txt"
        with self.assertRaises(installer.InstallError):
            installer.validate_manifest(self.sign(self.payload), self.config, allow_local=True)

    def test_concurrent_installation_is_rejected(self):
        with installer.installation_lock(self.destination):
            with self.assertRaisesRegex(installer.InstallError, "already running"):
                with installer.installation_lock(self.destination):
                    pass


if __name__ == "__main__":
    unittest.main()
