# Echo Chamber

A Launchpad soundboard for Discord and game voice chat. Press a pad, and the sound plays through your mic so everyone in chat hears it. You hear it in your headphones too.

Runs on **Windows** and **Mac** (same code, built on each machine).

---

## 1. One-time setup

**Install Node.js (LTS)** from https://nodejs.org if you don't have it.

> Updating from an earlier version? Run `npm install` again. The free AI voices add a new package.

**Install a virtual audio cable.** This is the "fake mic" that Discord listens to.

| | Install | Echo Chamber "Send to" | Discord / game Input Device |
|---|---|---|---|
| Windows | VB-Audio Virtual Cable: https://vb-audio.com/Cable/ (restart after) | **CABLE Input** | **CABLE Output** |
| Mac | BlackHole 2ch: https://existential.audio/blackhole/ | **BlackHole 2ch** | **BlackHole 2ch** |

## 2. Run it

Open a terminal in this folder:

```
npm install
npm start
```

## 3. Build an installer (optional)

Build on the machine you want the installer for:

- **Windows:** `npm run dist:win` → `dist/` gets an installer **and** a portable `.exe`
- **Mac:** `npm run dist:mac` → `dist/Echo Chamber-x.x.x.dmg`

The Mac build isn't code-signed, so the first time you open it: **right-click the app → Open → Open**. Allow microphone access when macOS asks.

---

## Using it

- **Assign a sound:** click a pad, then **Choose sound…**, or drag an audio file onto a pad. Files are copied into the app's own library, so moving the original won't break anything.
- **Formats:** mp3, wav, ogg, flac, m4a/aac, opus.
- **Pad modes:**
  - **One-shot**: press again to restart
  - **Toggle**: press again to stop
  - **Hold**: plays while held
  - **Loop**: loops until pressed again
- **Cut off other sounds:** when this pad plays, everything else stops.
- **Colors** show on screen and on the Launchpad. Playing pads pulse.
- **Stop everything:**
  - **Esc** in the app
  - **Ctrl+Shift+K** / **Cmd+Shift+K** from anywhere, even mid-game
  - **Stop all** button
  - a Launchpad button you assign under Settings → Stop-all button

### Text to speech

Type in the box under the pads and press **Enter** (Shift+Enter for a new line). The voice plays into voice chat just like a pad.

- **Free AI voices** (default): 28 natural US and UK voices from Kokoro, an open-source AI voice model that runs on your own computer. No account, no API key, no cost. The first time you use it, it downloads about 90 MB (progress shows in the box). After that it works offline.
- **Built-in voices**: free and offline (macOS voices on Mac, Windows voices on PC). Tip: on Mac, add better free voices in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices (pick an "Enhanced" or "Premium" voice), then restart Echo Chamber.
- **OpenAI voices** (optional, paid): AI voices, plus a **Voice style** line (e.g. "hyped sports announcer"). Needs an OpenAI API key.
- **ElevenLabs voices** (optional, paid): AI voices, including any you've cloned. Needs an ElevenLabs API key.

Paste API keys in **Settings → AI voices**. They're stored encrypted on your computer and only sent to that service. AI voices are billed to your account per character, so repeating a line from the chips below the box replays it without generating (or paying for) it again.

**Save to pad** keeps the current line (or the last one spoken) as a sound on the selected pad, so you can fire it from the Launchpad.

### Launchpad

Launchpad X, Mini MK3 and Pro MK3 are detected automatically and switched into Programmer mode. The on-screen grid matches the hardware (row A = top), and pad lights follow your colors. When you close the app, the Launchpad goes back to its normal mode.

Older Launchpads (Mini MK2, S, MK1) and any other MIDI controller work too. Select a pad, click **Learn button**, then press the button you want. Pad lights may not match on older models.

### Discord tips

- Turn **off Krisp / Noise Suppression** in Discord (Voice & Video). It treats music and sound effects as noise and will mute them.
- Use **push-to-talk** or a low input sensitivity so clips aren't cut by voice activity detection.
- Friends hear your mic + sounds mixed. Adjust **Mic volume** and **Soundboard volume** in Settings.

### Troubleshooting

- **"No virtual cable"**: the cable isn't installed, or isn't selected in Settings → Send to.
- **"Mic is the cable!"**: your mic is set to CABLE Output / BlackHole, which loops back on itself. Pick your real mic.
- **No controller**: plug in the Launchpad (it's picked up live), or pick it in Settings.
- **Mac, no mic**: System Settings → Privacy & Security → Microphone → enable Echo Chamber.

Settings and pad layouts are saved automatically.
