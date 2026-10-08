from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rs-studio",
        description="Transcription and charting tool for Rocksmith 2014",
    )
    sub = parser.add_subparsers(dest="command")

    p_serve = sub.add_parser("serve", help="Run the web UI + analysis backend.")
    p_serve.add_argument("--host", choices=["127.0.0.1", "localhost", "::1"], default="127.0.0.1",
                         help="Loopback address for the local desktop server.")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.add_argument(
        "--reload", action="store_true",
        help="Auto-restart the server when source code changes (development).",
    )

    # Same server, in a native window instead of a browser tab. Worth having as a
    # command and not only as the packaged build's entry point: a window can ask
    # its own question before it closes, and a browser tab can only ever show the
    # browser's "leave site?" prompt.
    sub.add_parser("app", help="Run the desktop window (server + native window).")

    p_an = sub.add_parser("analyze", help="Analyze one file and write notes JSON.")
    p_an.add_argument("audio", help="Path to a song or already-separated stem.")
    p_an.add_argument("--output", default="outputs", help="Directory for generated files.")
    p_an.add_argument(
        "--no-separate", action="store_true",
        help="Skip stem separation; analyze the file as-is.",
    )
    p_an.add_argument(
        "--separator", choices=["demucs", "roformer"], default="demucs",
        help="Stem separation backend (default: demucs).",
    )
    return parser


def _run_analyze(args: argparse.Namespace) -> None:
    from . import pipeline

    in_path = Path(args.audio)
    if not in_path.exists():
        raise SystemExit(f"No such file: {in_path}")

    job_dir = Path(args.output)
    result = pipeline.analyze(
        in_path, job_dir, separate=not args.no_separate, separator=args.separator,
    )

    print(f"Separated: {result.separated} ({result.separator})   "
          f"Duration: {result.duration:.1f}s   Tempo: {result.tempo}   Offset: {result.offset}")
    print(f"Stems ({len(result.stems)}):")
    for v in result.stems:
        print(f"  · {v.id:<7} {v.spectrogram['image']}  ({v.audio_path.name})")
    for w in result.warnings:
        print(f"  ! {w}")


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "serve":
        from . import server

        print(f"Serving on http://{args.host}:{args.port}")
        server.serve(host=args.host, port=args.port, reload=args.reload)
    elif args.command == "app":
        from . import desktop

        desktop.launch()
    elif args.command == "analyze":
        _run_analyze(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
