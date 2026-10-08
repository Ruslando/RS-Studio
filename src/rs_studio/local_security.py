"""Request guards for the loopback-only desktop HTTP server."""
from __future__ import annotations

from urllib.parse import urlsplit

from starlette.responses import JSONResponse

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _authority(value: str, scheme: str) -> tuple[str, int]:
    parsed = urlsplit("//" + value)
    if (parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment
            or parsed.hostname not in _LOOPBACK_HOSTS):
        raise ValueError("Expected a loopback host")
    return parsed.hostname, parsed.port or (443 if scheme == "https" else 80)


class LocalRequestMiddleware:
    """Reject DNS rebinding and browser requests from another origin.

    Host must name a loopback address. Browser Origin and Fetch Metadata, when
    present, must identify this same origin. Clients without browser headers
    (for example a local CLI) remain supported. This is not authentication for
    a network service: serve() only accepts loopback bind addresses.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {}
        for name, value in scope.get("headers", []):
            if name in {b"host", b"origin", b"sec-fetch-site"}:
                if name in headers:
                    await JSONResponse({"detail": "Duplicate request headers"},
                                       status_code=403)(scope, receive, send)
                    return
                headers[name] = value.decode("latin-1")
        try:
            scheme = scope.get("scheme", "http")
            host = _authority(headers.get(b"host", ""), scheme)
            origin = headers.get(b"origin")
            if origin is not None:
                parsed = urlsplit(origin)
                if (parsed.scheme != scheme or parsed.path or parsed.query
                        or parsed.fragment or _authority(parsed.netloc, parsed.scheme) != host):
                    raise ValueError("Origin does not match this app")
            if headers.get(b"sec-fetch-site", "none") not in {"none", "same-origin"}:
                raise ValueError("Cross-origin browser request")
        except (ValueError, UnicodeError):
            await JSONResponse({"detail": "Only same-origin local requests are allowed"},
                               status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)
