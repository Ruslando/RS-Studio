"""Stable IDs for export warnings, with text based on ASD-STE100.

WarningMessage remains a string for existing export headers and CLI callers.
The live check also exposes its ID and help as structured data.
"""

# Technical names (Rocksmith, tuning offset, phrase, and tone preset) retain
# their product meanings. Use short sentences and direct instructions.
MESSAGES = {
    'tuning-octave': ('Tuning offset {offset:+d} changed to {reduced:+d}',
            "The export changes this string's tuning by whole octaves. Check the layer tuning if this change is not intended."),
    'bass-reference': ('Low bass tuning uses a lower tuning reference',
            'The export raises the string tuning offsets by one octave and halves the tuning reference. This helps Rocksmith detect low bass notes without changing their pitches.'),
    'tone-unknown': ('Tone switch skipped: unknown preset {preset}',
            'The export skips this tone switch because it cannot find its preset. Select another preset for the switch.'),
    'tone-outside-song': ('Tone switch skipped at {time:.3f}s',
            'The export skips this tone switch because it is outside the song. Move the switch between the start and end of the song.'),
    'section-unknown': ('Section type changed to riff: {name}',
            'The export uses Riff for this unsupported section type. Select a supported type in the section marker.'),
    'section-snapped': ('Section moved to a measure boundary: {name}',
            'This section marker is between bar starts. The export places the section at the nearest bar start (the first beat of a measure). Notes and audio stay in place. Move the marker to a bar start to avoid this adjustment.'),
    'section-collision': ('Only the last section at {time:.3f}s is exported',
            'Multiple section markers use the same exported measure boundary. Only the last one is used. Move the markers to different measure boundaries.'),
    'phrase-snapped': ('Phrase boundary moved from {time:.3f}s',
            'The export moves this phrase boundary to the nearest beat. Place the boundary on a beat to keep its position.'),
    'multiple-lanes': ('Only one layer is exported: {name}',
            'The export has no arrangement selection and uses only this layer. Select an arrangement for each required layer in Rocksmith export.'),
    'metadata-characters': ('Characters removed from {field}: {characters}',
            'Rocksmith cannot show these characters. Replace them or enter a Latin spelling for this field.'),
    'japanese-characters': ('Characters removed from Japanese {field}: {characters}',
            'The Rocksmith font cannot show these characters in the Japanese field. Replace them with supported characters.'),
    'difficulty-reduced': ('{arrangement}: fewer difficulty levels in {phrases}',
            'These phrases have fewer difficulty levels than at the previous export. Saved progress from earlier versions may no longer match these levels.'),
}


class WarningMessage(str):
    def __new__(cls, id: str, title: str, help: str, time: float | None = None, target: str | None = None):
        message = super().__new__(cls, title)
        message.id = id
        message.help = help
        message.time = time
        message.target = target
        return message

    def as_issue(self, lead: float = 0) -> dict:
        return {'id': self.id, 'title': str(self), 'help': self.help, 'tone': 'warning',
                'time': None if self.time is None else self.time - lead,
                **({'target': self.target} if self.target else {})}


def warning(kind: str, *, at: float | None = None, target: str | None = None, **values) -> WarningMessage:
    title, help = MESSAGES[kind]
    return WarningMessage(f'export.{kind}', title.format(**values), help, at, target)


class ExportError(ValueError):
    """A compilation failure with an ID independent of its explanation."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.id = f'export.{kind}'
