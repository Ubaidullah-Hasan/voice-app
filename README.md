# 🎙️ VoiceScribe — Offline Speech-to-Text for Windows

A professional-grade, **fully offline** Speech-to-Text desktop application for Windows 10/11.
Powered by **OpenAI Whisper** (via ONNX Runtime Web) running entirely on your device.

**Supports English 🇬🇧 and Bengali 🇧🇩 — no internet needed after first model download.**

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔒 **100% Local** | All inference runs on-device. No API calls, no data leaves your PC |
| 🎤 **Live Recording** | Start / Pause / Stop with a single mic button |
| 📊 **Waveform Meter** | Real-time animated audio level visualizer |
| 🌐 **English + Bengali** | Switch languages instantly; Whisper handles both natively |
| ✏️ **Editable Output** | Scrollable, fully editable transcript text box |
| 📋 **Copy to Clipboard** | One click to copy the full transcript |
| 💾 **Save as .txt** | Save transcript to any location with native file dialog |
| ⚡ **WebGPU Acceleration** | Auto-uses GPU (if available) for 5–10× faster transcription |
| 📦 **Windows Installer** | Ships as a native `.exe` NSIS installer |

---

## 🔧 Prerequisites

Before you start, make sure you have the following installed:

### 1. Node.js (v18 or higher — LTS recommended)
Download from [nodejs.org](https://nodejs.org/). Verify with:
```bash
node --version  # should show v18.x.x or higher
npm --version
```

### 2. Git (optional, for cloning)
Download from [git-scm.com](https://git-scm.com/).

### 3. Internet Connection (first run only)
The app downloads the Whisper model (~290 MB for whisper-base) on first launch
and caches it in `%APPDATA%\VoiceScribe\`. After that, it works fully offline.

> **No C++ build tools required!** This project uses `@huggingface/transformers` with
> ONNX Runtime Web (WebAssembly), which is pure JavaScript — zero native compilation.

---

## 📁 Project Structure

```
voice-scribe/
├── package.json                  # Project config & dependencies
├── .npmrc                        # Node module resolution config
├── README.md                     # This file
├── assets/
│   └── icon.png                  # Application icon
└── src/
    ├── main/
    │   ├── main.js               # Electron main process (window, menus, IPC)
    │   └── preload.js            # Secure context bridge (IPC to renderer)
    └── renderer/
        ├── index.html            # App shell (semantic HTML5)
        ├── index.css             # Premium dark design system
        ├── app.js                # UI logic, audio recording, state machine
        └── transcription.worker.js  # Web Worker: Whisper ML inference
```

---

## 🚀 Quick Start (Development Mode)

### Step 1 — Clone or Download the Project
```bash
# If using git:
git clone <your-repo-url> voice-scribe
cd voice-scribe

# Or just navigate to the project folder:
cd "C:\Users\hp\Desktop\voice project"
```

### Step 2 — Install Dependencies
```bash
npm install
```
This installs Electron, `@huggingface/transformers`, and `electron-builder`.
No native compilation is required — should complete in under 2 minutes.

### Step 3 — Run in Development Mode
```bash
npm run dev
```
Electron will launch the app. On first run, it will download the Whisper model
(~290 MB). Progress is shown in the sidebar. Subsequent runs load from cache instantly.

---

## 🏗️ Building the Windows Installer

To produce a distributable `.exe` installer:

```bash
npm run build
```

This runs `electron-builder` and produces:
```
dist/
└── VoiceScribe-Setup-1.0.0.exe    # NSIS Windows installer (~400 MB)
```

> **Note:** The model is NOT bundled in the installer (keeps it lean). Users download
> the model on first launch. To change this, see "Advanced: Bundling the Model" below.

### Build Requirements
- Windows 10/11 (builds are Windows-only with the current config)
- Node.js 18+
- `npm install` completed successfully

---

## 🧠 Model Information

| Property | Value |
|---|---|
| **Model** | `onnx-community/whisper-base` |
| **Size** | ~290 MB (encoder: fp32, decoder: int4 quantized) |
| **Languages** | 99 languages incl. English & Bengali |
| **Cache Location** | `%APPDATA%\VoiceScribe\` (managed by browser Cache API) |
| **Source** | [HuggingFace Hub](https://huggingface.co/onnx-community/whisper-base) |

### How the Model is Loaded
1. On first launch, the app downloads ONNX model shards from HuggingFace CDN.
2. Files are cached by the browser's Cache API (persistent across app restarts).
3. All subsequent launches load from cache — no internet needed.
4. Model runs in a Web Worker (off the main thread) — UI stays responsive.

### Advanced: Bundling the Model (Optional)
If you want a fully offline installer (no internet required at all):
1. Download model files manually from [HuggingFace](https://huggingface.co/onnx-community/whisper-base/tree/main)
2. Place them in `assets/models/whisper-base/`
3. In `transcription.worker.js`, set `env.localModelPath = './models/'`
4. Add the models folder to `extraResources` in `package.json`

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Space` | Start recording / Pause |
| `Enter` | Stop recording & transcribe |
| `Ctrl+S` | Save transcript to file |

---

## 🔊 Usage Guide

1. **Select Language** — Click "English" or "বাংলা" in the left sidebar
2. **Wait for Model** — Green dot = model ready (only needed once)
3. **Click the Mic** — Large gradient button to start recording
4. **Speak** — Waveform bars animate to show audio level
5. **Stop** — Click the stop button (⏹) or press `Enter`
6. **Read Transcript** — Text appears in the right panel
7. **Copy / Save** — Use the buttons in the top-right of the transcript panel

---

## 🐛 Troubleshooting

### App won't start
- Ensure Node.js 18+ is installed
- Run `npm install` again
- Check for errors: `npm run dev 2>&1`

### Model download fails
- Check internet connection
- Try again (download resumes from where it left off)
- Check firewall isn't blocking `huggingface.co`

### Microphone not working
- Grant microphone permission in Windows Settings → Privacy → Microphone
- Check that the correct input device is set as default in Windows Sound Settings

### Bengali transcription accuracy
- Whisper-base has good but not perfect Bengali accuracy
- Speak clearly and at a moderate pace
- Standard/formal Bengali (Shuddhô Bangla) transcribes better than heavy dialects
- For better accuracy, upgrade to `whisper-small` by changing `MODEL_ID` in
  `src/renderer/transcription.worker.js` (~970 MB model download)

### Slow transcription
- First transcription after launch may be slower (model warm-up)
- If no GPU is detected, WASM/CPU is used (~30s for 1min audio on average CPU)
- For faster results on modern GPUs, ensure Windows GPU drivers are up to date
  (WebGPU is auto-detected)

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 🙏 Credits

- [OpenAI Whisper](https://github.com/openai/whisper) — The ASR model
- [Transformers.js](https://github.com/huggingface/transformers.js) — ONNX Runtime Web inference
- [Electron](https://www.electronjs.org/) — Desktop app framework
- [HuggingFace](https://huggingface.co/) — Model hosting & ONNX conversions
