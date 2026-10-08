"""Rocksmith 2014 CDLC (.psarc) export.

Compiles the editor's tab spec straight into a playable PC CDLC — arrangement
SNG, manifests, aggregate graph, xblock, album art, soundbanks — with the
external WAV -> .wem step handled by Wwise on Windows or oggenc + wav2wem on
Linux. The Linux route is experimental until checked in Rocksmith 2014.

Binary formats transcribed from the MIT-licensed Rocksmith2014.NET sources
(iminashi/Rocksmith2014.NET); res/ carries its flat-model files, Wwise project
templates and default tones. See docs/rocksmith-format-reference.md.
"""
