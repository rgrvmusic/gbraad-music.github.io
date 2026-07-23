# MIDI Controller Profiles

Controller profiles define how a MIDI device maps to the dual-deck application. The format is shared with the [device-controller](https://github.com/gbraad/device-controller) project.

## Device Index

Available devices are listed in `configs/devices.json`. Each entry points to a device definition file:

```json
{
  "devices": [
    {
      "file": "kaossdj.json",
      "manufacturer": "KORG",
      "name": "KaossDJ",
      "category": "DJ Controller"
    }
  ]
}
```

## Device Definition Format

### Top Level

```json
{
  "id": "device-id",         // Unique identifier
  "name": "Display Name",    // Human-readable name
  "manufacturer": "KORG",    // Manufacturer name
  "category": "DJ Controller", // Device category
  "description": "...",      // Optional description

  "deckConfig": {            // DJ-specific: deck configuration
    "count": 2,              // Number of decks
    "type": "audio",         // "audio" | "rfx" (future: WASM tracker)
    "midiBaseChannel": 0     // Base MIDI channel for deck 0
  },

  "sections": [ ... ]        // Control sections
}
```

### Sections

Controls are organized into sections. Sections can optionally be assigned to a deck:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Section display name |
| `deck` | number | Deck index (omit for global/master sections) |
| `midiChannel` | number | MIDI channel for all controls in this section (omit to use control-level or deckConfig.midiBaseChannel) |
| `color` | string | Hex color for deck accent |
| `controls[]` | array | Control definitions |

### Controls

Each control has a `type` that describes both the UI widget and the MIDI message format:

#### `knob` - Continuous control (MIDI CC)

```json
{
  "id": "eqHi",           // Logical identifier for app routing
  "type": "knob",         // Widget type
  "label": "EQ Hi",       // Display label
  "cc": 71,               // MIDI CC number
  "channel": 0,           // MIDI channel (optional, defaults to section.midiChannel or deckConfig.midiBaseChannel + deck)
  "min": 0,               // Minimum value
  "max": 127,             // Maximum value
  "default": 64,          // Default value
  "unit": "dB",           // Optional unit display
  "description": "..."    // Optional description
}
```

#### `pad` - Momentary trigger (MIDI Note)

```json
{
  "id": "play",           // Logical identifier
  "type": "pad",          // Momentary trigger
  "label": "Play",        // Display label
  "note": 37,             // MIDI note number (note-on triggers action)
  "channel": 0,           // MIDI channel (optional)
  "description": "..."    // Optional description
}
```

#### `select` - Multiple choice (MIDI CC)

```json
{
  "type": "select",
  "label": "Touch",
  "cc": 102,
  "options": [
    { "label": "Off", "value": 0 },
    { "label": "On",  "value": 127 }
  ],
  "default": 0
}
```

#### `xypad` - Two-axis pad (MIDI CC x 2)

```json
{
  "type": "xypad",
  "label": "FX Pad",
  "cc_x": 12,
  "cc_y": 13,
  "default_x": 64,
  "default_y": 64
}
```

### Control IDs (Application Routing)

The `id` field determines what the control does in the application:

| ID | Works On | Description |
|----|----------|-------------|
| `eqHi` | knob | High-frequency EQ (±12dB highshelf at 8kHz) |
| `eqMid` | knob | Mid-frequency EQ (±12dB peaking at 1kHz) |
| `eqLow` | knob | Low-frequency EQ (±12dB lowshelf at 200Hz) |
| `filter` | knob | Low-pass filter cutoff (20Hz-22kHz) |
| `fader` | knob | Channel volume (0-100%) |
| `play` | pad | Toggle play/pause |
| `cue` | pad | Cue preview |
| `sync` | pad | Toggle beat sync |
| `loop` | pad | Toggle loop |
| `crossfader` | knob | Master crossfader (in global section) |

## Creating a New Profile

1. Add an entry to `configs/devices.json`
2. Create `configs/your-device.json` (copy from `configs/template.json`)
3. Define sections and controls matching your device's MIDI layout
4. Reload the app and select your profile

## Compatibility

These JSON device definitions are compatible with the [device-controller](https://github.com/gbraad/device-controller) C/C++ plugin (used as a VST3/LV2 plugin). Fields unknown to the C loader (like `id`, `note`, `deckConfig`) are safely ignored, and fields unknown to the web app (like `sysex`) are also safely ignored.
