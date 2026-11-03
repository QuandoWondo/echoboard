# Echo Board

A Launchpad soundboard for Discord and game voice chat, **100% offline**. Press a pad, and the sound plays through your mic so everyone in chat hears it. You hear it in your headphones too.

Runs on **Windows** and **Mac** (same code, built on each machine).

---

## 1. One-time setup

**Easiest:** use the installer (`Echo-Board-Setup-x.y.z.exe` on Windows, `.dmg` on Mac). It includes everything: the app, the free AI voices and the VB-CABLE virtual microphone. Nothing else to download.

**Running from source instead:** install Node.js (LTS) from https://nodejs.org, then follow step 2. When updating from an earlier version, run `npm install` again.

**Virtual audio cable** (the "fake mic" Discord listens to): Echo Board installs one for you. On first launch it offers **Set up voice chat**. You can also open it any time by clicking **No virtual cable** at the top, or from Settings → Send to → **Install…**. It installs the free **VB-CABLE** by VB-Audio (included in the installer):

- **Windows:** click **Yes** to allow changes, click **Install** on the VB-Audio driver prompt, then restart your PC.
- **Mac:** enter your password. No restart needed.

Then in Discord (and in games), set the voice **Input Device** to **CABLE Output** (Windows) or **VB-Cable** (Mac).

VB-CABLE is made by VB-Audio (https://vb-cable.com). VB-CABLE is a donationware, all participations are welcome. BlackHole and VoiceMeeter also work. Pick them under Settings → Send to.

## 2. Run from source / build the installers

Open a terminal in this folder:

```
npm install
npm start
```

## 3. Build the installers

- **Windows:** `npm run dist:win` (or double-click `build-windows.bat`) → `dist/Echo-Board-Setup-x.y.z.exe`
- **Mac:** `npm run dist:mac` → `dist/Echo-Board-x.y.z-arm64.dmg`
- **Both, in the cloud:** push to GitHub and the included workflow builds both on GitHub's free machines (Actions tab → latest run → Artifacts).

The build step downloads the voices and VB-CABLE once (about 110 MB) and packs them into the installer, so users never download anything. The installer adds an **Echo Board** icon to the desktop and Start menu and opens the app.

Unsigned builds: on Windows, SmartScreen says "Windows protected your PC" → **More info → Run anyway** (once). On Mac, **right-click the app → Open → Open** the first time.

---

## Using it

- **Assign a sound:** click a pad, then **Choose sound…**, or drag an audio file onto a pad. Files are copied into the app's own library, so moving the original won't break anything.
- **Formats:** mp3, wav, ogg, flac, m4a/aac, opus.
- **Rearrange:** drag a pad onto another spot to move it. If that spot already has a sound, they swap. Hold **Ctrl** (Windows) or **Option** (Mac) while dropping to copy instead. Launchpad buttons stay with their grid position, so the sound you move follows its new spot on the Launchpad too.
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

- **Free AI voices** (default): 28 natural US and UK voices from Kokoro, an open-source AI voice model that runs on your own computer. No account, no API key, no cost. Built into the installer and works offline. (When running from source, it downloads about 90 MB the first time.)
- **Built-in voices**: free and offline (macOS voices on Mac, Windows voices on PC). Tip: on Mac, add better free voices in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices (pick an "Enhanced" or "Premium" voice), then restart Echo Board.

**Save to pad** keeps the current line (or the last one spoken) as a sound on the selected pad, so you can fire it from the Launchpad.

### Pages and profiles

- **8 pages** of 64 pads per profile. Switch with the tabs above the grid, **PageUp/PageDown**, or the Launchpad's **top row** (buttons 1–8 = pages 1–8). Double-click a tab to rename it. Drag a pad onto a tab to move it to that page.
- **Profiles** are whole layouts (all 8 pages). Use the profile button next to the logo to create, duplicate, rename, switch or delete them — e.g. one per game.

### Voice changer

Click **Voice** in the top bar: Deep, Demon, Chipmunk, Robot, Radio, Megaphone, Cave, Echo, Alien, Underwater, with an intensity slider and "hear myself". Only your voice is changed; sounds stay clean. Toggle it from the Launchpad (right column) or a keyboard shortcut.

### Buttons & shortcuts

Settings → **Buttons & shortcuts** sets Launchpad buttons and global keyboard shortcuts for: save replay, voice effect on/off, next effect, previous/next page, stop all. Defaults use the Launchpad's right-hand round buttons (top: replay, effect on/off, next effect; bottom: stop all). Any pad can also get a keyboard shortcut (pad editor → **Set shortcut**); shortcuts work even while a game is focused. Plain letters need Ctrl/Alt/Shift so normal typing isn't affected.

### Auto push-to-talk

If you use push-to-talk in Discord: Settings → **Auto push-to-talk**, pick your PTT key (or mouse button 4/5). Echo Board holds that one key while a sound or voice plays and lets go 0.3 s after. (Mac asks for Accessibility permission the first time.)

### Instant replay

Settings → **Instant replay** (off by default). When on, the last 15/30/60 seconds are kept **in memory only** — on Windows that's everything you hear (friends + your sounds), on Mac your sounds — plus your own voice if you choose. Press **Save replay** (top bar, Launchpad, or shortcut) and the clip lands on an empty pad. Nothing is written to disk until you save, and the buffer is discarded when you turn it off or close the app.

### Trim, even volumes, video clips

- **Trim:** the pad editor shows a waveform; drag the white edges to cut the start/end.
- **Even out sound volumes** (Settings, on by default): quiet clips are boosted and loud ones softened so everything plays at a similar level.
- **From video…** in the pad editor: open a video (MP4/WebM/MOV, e.g. a gaming recording), set start and end (up to 60 s), and save the audio to the pad.

### Ducking & extra output

- **Ducking:** lower your mic while a sound plays, and/or lower sounds while you talk.
- **Extra output:** also send sounds (and optionally your voice) to a second device, e.g. for OBS.

### Privacy

Echo Board is **offline-only**: it is blocked from connecting to the internet at all (no accounts, telemetry, updates or cloud). The free AI voices and the VB-CABLE installer ship inside the installer. Settings → Privacy → **Check network block** confirms it. Links you click (e.g. vb-cable.com) open in your own browser.

### Launchpad

Launchpad X, Mini MK3 and Pro MK3 are detected automatically and switched into Programmer mode. The on-screen grid matches the hardware (row A = top), and pad lights follow your colors. When you close the app, the Launchpad goes back to its normal mode.

Older Launchpads (Mini MK2, S, MK1) and any other MIDI controller work too. Select a pad, click **Learn button**, then press the button you want. Pad lights may not match on older models.

### Discord tips

- Turn **off Krisp / Noise Suppression** in Discord (Voice & Video). It treats music and sound effects as noise and will mute them.
- Use **push-to-talk** or a low input sensitivity so clips aren't cut by voice activity detection.
- Friends hear your mic + sounds mixed. Adjust **Mic volume** and **Soundboard volume** in Settings.

### Troubleshooting

- **"No virtual cable"**: click it to install VB-CABLE, or pick your cable in Settings → Send to. On Windows, restart after installing.
- **"Mic is the cable!"**: your mic is set to CABLE Output / VB-Cable / BlackHole, which loops back on itself. Pick your real mic.
- **No controller**: plug in the Launchpad (it's picked up live), or pick it in Settings.
- **Mac, no mic**: System Settings → Privacy & Security → Microphone → enable Echo Board.

Settings and pad layouts are saved automatically.
