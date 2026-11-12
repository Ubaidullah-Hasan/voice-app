const fs = require('node:fs');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s);
let p = JSON.parse(read('package.json'));
p.scripts['build:worker'] = 'node scripts/build-worker.cjs';
p.scripts.predev = 'npm run build:worker';
p.scripts.prebuild = 'npm run build:worker';
p.scripts['prebuild:dir'] = 'npm run build:worker';
p.scripts.test = 'node --test tests/*.test.mjs';
p.build.files = ['src/**/*', 'assets/**/*', 'runtime/**/*', 'package.json'];
p.build.icon = 'assets/icon.ico';
p.build.win.icon = 'assets/icon.ico';
for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) p.build.nsis[key] = 'assets/icon.ico';
p.build.copyright = 'Copyright © 2026 VoiceScribe';
write('package.json', JSON.stringify(p, null, 2) + '\n');
let html = read('src/renderer/index.html');
html = html.replace(/  <!-- Google Fonts: Inter -->[\s\S]*?(?=  <link rel="stylesheet")/, '');
write('src/renderer/index.html', html);
let css = read('src/renderer/index.css').replace("'Inter', system-ui, -apple-system, sans-serif", "system-ui, 'Segoe UI', sans-serif").replace("'JetBrains Mono', 'Courier New', monospace", "'Cascadia Mono', Consolas, monospace");
css += '\nbutton:disabled { cursor: not-allowed; opacity: 0.45; }\n';
write('src/renderer/index.css', css);
let main = read('src/main/main.js');
main = main.replace('Menu, shell, protocol, net', 'Menu, protocol');
main = main.replace("const { pathToFileURL } = require('url');", "const { resolveAppPath } = require('./protocol-path.cjs');");
main = main.replace('      bypassCSP: true,\n', '');
// CSP is attached directly to every app response, including the module worker.
const start = main.indexOf('  // Set CSP headers');
const end = main.indexOf("  mainWindow.on('closed'", start);
main = main.slice(0, start) + main.slice(end);
main = main.replace("label: 'Open Model Cache Folder'", "label: 'Model Cache Info'");
main = main.replace(/            const cacheDir =[\s\S]*?            shell.openPath\(cacheDir\);/, `            dialog.showMessageBox(mainWindow, {
              type: 'info', title: 'Model Cache Info', message: 'Models are stored in the browser-managed cache.',
              detail: 'The transformers-cache belongs to this app profile. Use Clear cache in the sidebar to remove downloaded models. Internet is required to download them again.',
            });`);
main = main.replace("  mainWindow.loadURL('app://root/src/renderer/index.html');", `  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== 'app://root/src/renderer/index.html') event.preventDefault();
  });
  mainWindow.loadURL('app://root/src/renderer/index.html');`);
const protoStart = main.indexOf("      const url = new URL(request.url);");
const protoEnd = main.indexOf('    } catch (err) {', protoStart);
main = main.slice(0, protoStart) + `      const absolutePath = resolveAppPath(app.getAppPath(), request.url);
      const contentType = MIME_TYPES[path.extname(absolutePath).toLowerCase()];
      if (!contentType) return new Response('Unsupported asset', { status: 404 });
      const content = await fs.promises.readFile(absolutePath);
      return new Response(content, { status: 200, headers: {
        'Content-Type': contentType,
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      } });
` + main.slice(protoEnd);
write('src/main/main.js', main);
write('.gitignore', read('.gitignore') + '\nruntime/\nsrc/renderer/transcription.worker.bundle.js\n');

let app = read('src/renderer/app.js');
app = app.replace("  IDLE:         'idle',", "  IDLE:         'idle',\n  STARTING:     'starting',\n  ERROR:        'error',");
app = app.replace('let recordSeconds  = 0;', `let recordSeconds  = 0;
let modelReady = false;
let backend = '';
let requestSerial = 0;
let activeRequest = null;
let recordingGeneration = 0;
let recordingLanguage = 'en';
let retryOperation = 'load';`);
const workerStart = app.indexOf('function initWorker()');
const workerEnd = app.indexOf('// ============================================================\n// UI State Machine', workerStart);
app = app.slice(0, workerStart) + `function initWorker() {
  worker?.terminate();
  modelReady = false;
  activeRequest = null;
  const instance = new Worker(new URL('./transcription.worker.bundle.js', import.meta.url), { type: 'module' });
  worker = instance;
  instance.addEventListener('message', event => {
    if (worker === instance && event.data.requestId === activeRequest) onWorkerMessage(event);
  });
  const crashed = event => {
    if (worker !== instance) return;
    instance.terminate();
    worker = null;
    activeRequest = null;
    modelReady = false;
    retryOperation = 'load';
    fail('AI worker failed: ' + (event.message || 'Restart the AI engine using Retry.'));
  };
  instance.addEventListener('error', crashed);
  instance.addEventListener('messageerror', crashed);
}

function requestWorker(type, data = {}, transfer = []) {
  activeRequest = ++requestSerial;
  try { worker.postMessage({ type, requestId: activeRequest, ...data }, transfer); }
  catch (error) {
    modelReady = false;
    worker?.terminate();
    worker = null;
    fail('AI request failed: ' + error.message);
  }
}

function fail(message) {
  recordingGeneration++;
  cleanupRecording();
  elDownloadWrap.style.display = 'none';
  setState(STATE.ERROR);
  elStateLabel.textContent = message;
  if (!modelReady) setModelState('error', message);
  showToast(message, 'error');
  showRetryOption();
}

function onWorkerMessage(event) {
  const { type, label, progress, text, message, operation } = event.data;
  if (type === 'load-progress') {
    elDownloadWrap.style.display = 'block';
    elDownloadLabel.textContent = label;
    const pct = Math.min(100, Math.max(0, progress || 0));
    elProgressFill.style.width = pct + '%';
    elProgressPct.textContent = Math.round(pct) + '%';
    return;
  }
  activeRequest = null;
  elDownloadWrap.style.display = 'none';
  if (type === 'load-done') {
    modelReady = true;
    backend = event.data.backend;
    document.getElementById('retry-model-btn')?.remove();
    setModelState('ready', backend === 'webgpu' ? 'Ready · WebGPU' : 'Ready · CPU / WASM');
    setState(STATE.READY);
  } else if (type === 'result') {
    onTranscriptionResult(text);
  } else if (type === 'cache-cleared') {
    retryOperation = 'load';
    loadModel();
  } else if (type === 'load-error' || type === 'error') {
    retryOperation = operation === 'clear-cache' ? 'clear-cache' : 'load';
    if (operation !== 'transcribe') modelReady = false;
    console.error('[AI error]', event.data.category, message, event.data.stack);
    fail((operation === 'clear-cache' ? 'Cache clear failed: ' : operation === 'transcribe' ? 'Transcription failed: ' : 'Model load failed: ') + message);
  }
}

function showRetryOption() {
  if (document.getElementById('retry-model-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'retry-model-btn';
  btn.className = 'action-btn';
  btn.textContent = 'Retry';
  btn.addEventListener('click', retryLoadModel);
  elDownloadWrap.after(btn);
}

function loadModel() {
  modelReady = false;
  setModelState('loading', 'Loading model...');
  setState(STATE.LOADING);
  requestWorker('load');
}

function retryLoadModel() {
  if (![STATE.ERROR, STATE.IDLE].includes(appState)) return;
  document.getElementById('retry-model-btn')?.remove();
  if (modelReady) { setState(STATE.READY); return; }
  try { if (!worker) initWorker(); }
  catch (error) { fail('Cannot start AI worker: ' + error.message); return; }
  if (retryOperation === 'clear-cache') clearCache();
  else loadModel();
}

function clearCache() {
  modelReady = false;
  retryOperation = 'clear-cache';
  setState(STATE.LOADING);
  setModelState('loading', 'Clearing cache...');
  requestWorker('clear-cache');
}
elBtnClearCache.addEventListener('click', () => {
  if (![STATE.READY, STATE.ERROR].includes(appState)) return;
  document.getElementById('retry-model-btn')?.remove();
  try { if (!worker) initWorker(); clearCache(); }
  catch (error) { fail('Cannot clear cache: ' + error.message); }
});

` + app.slice(workerEnd);
app = app.replace('  elBtnRecord.disabled = isLoading || isTranscribing;', `  elBtnRecord.disabled = !modelReady || !(isReady || isRecording || isPaused);
  const canConfigure = isReady || newState === STATE.ERROR;
  elLangBtns.forEach(btn => { btn.disabled = !canConfigure; });
  elModelActions.style.display = canConfigure ? 'flex' : 'none';
  elBtnClearCache.disabled = !canConfigure;`);
app = app.replace("    [STATE.IDLE]:         'Initializing…',", "    [STATE.IDLE]:         'Initializing…',\n    [STATE.STARTING]:     'Waiting for microphone...',\n    [STATE.ERROR]:        'An error occurred. Use Retry.',");
app = app.replace('  } else if (!isPaused) {\n    stopTimer();', '  } else {\n    stopTimer();');
const langStart = app.indexOf('function selectLanguage(lang)');
const langEnd = app.indexOf('elLangBtns.forEach(btn => {\n  btn.addEventListener', langStart);
app = app.slice(0, langStart) + `function selectLanguage(lang) {
  if (![STATE.READY, STATE.ERROR].includes(appState) || !['en', 'bn'].includes(lang)) return;
  currentLang = lang;
  elLangBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.lang === lang));
}

` + app.slice(langEnd);
const recStart = app.indexOf('async function startRecording()');
const recEnd = app.indexOf('// ============================================================\n// Waveform Visualizer', recStart);
app = app.slice(0, recStart) + `function cleanupRecording() {
  stopTimer();
  stopWaveformAnimation();
  if (mediaRecorder) {
    mediaRecorder.onstop = null;
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onerror = null;
    if (mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch {} }
    mediaRecorder = null;
  }
  audioStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  audioStream = null;
  const context = audioContext;
  audioContext = null;
  analyserNode = null;
  if (context && context.state !== 'closed') void context.close().catch(console.error);
  audioChunks = [];
}

async function startRecording() {
  if (appState === STATE.PAUSED) {
    try { mediaRecorder.resume(); setState(STATE.RECORDING); resumeWaveform(); }
    catch (error) { fail('Cannot resume recording: ' + error.message); }
    return;
  }
  if (appState !== STATE.READY || !modelReady) return;
  const generation = ++recordingGeneration;
  recordingLanguage = currentLang;
  setState(STATE.STARTING);
  recordSeconds = 0;
  elRecordingTime.textContent = '00:00';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, sampleRate: { ideal: 16000 },
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } });
    if (generation !== recordingGeneration) { stream.getTracks().forEach(t => t.stop()); return; }
    audioStream = stream;
    stream.getTracks().forEach(track => { track.onended = () => {
      if (generation === recordingGeneration) fail('Microphone disconnected. Check your input device and retry.');
    }; });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.7;
    source.connect(analyserNode);
    const mimeType = getSupportedMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mediaRecorder = recorder;
    const chunks = [];
    recorder.ondataavailable = event => {
      if (generation === recordingGeneration && event.data?.size) chunks.push(event.data);
    };
    recorder.onerror = event => {
      if (generation === recordingGeneration) fail('Recorder failed: ' + (event.error?.message || 'Unknown audio error'));
    };
    recorder.onstop = () => {
      if (generation === recordingGeneration && appState === STATE.TRANSCRIBING) {
        void onRecordingStop(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), generation, recordingLanguage);
      }
    };
    recorder.start(250);
    setState(STATE.RECORDING);
    startWaveformAnimation();
  } catch (error) {
    if (generation === recordingGeneration) fail('Microphone/recording failed: ' + error.message);
  }
}

function pauseRecording() {
  if (appState !== STATE.RECORDING) return;
  try { mediaRecorder.pause(); setState(STATE.PAUSED); stopWaveformAnimation(); }
  catch (error) { fail('Cannot pause recording: ' + error.message); }
}

function stopRecording() {
  if (![STATE.RECORDING, STATE.PAUSED].includes(appState)) return;
  setState(STATE.TRANSCRIBING);
  stopWaveformAnimation();
  try {
    mediaRecorder.stop();
    audioStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    audioStream = null;
    const context = audioContext;
    audioContext = null;
    analyserNode = null;
    if (context) void context.close().catch(console.error);
  } catch (error) { fail('Cannot stop recording: ' + error.message); }
}

function getSupportedMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type)) || '';
}

async function onRecordingStop(blob, generation, language) {
  let decodeContext;
  try {
    const buffer = await blob.arrayBuffer();
    if (generation !== recordingGeneration) return;
    decodeContext = new AudioContext({ sampleRate: 16000 });
    const audio = await decodeContext.decodeAudioData(buffer);
    if (generation !== recordingGeneration) return;
    const pcm = new Float32Array(audio.getChannelData(0));
    if (audio.sampleRate !== 16000) throw new Error('Audio must be decoded at 16 kHz.');
    if (!pcm.length) throw new Error('The recording is empty.');
    requestWorker('transcribe', { audioData: pcm, language }, [pcm.buffer]);
  } catch (error) {
    if (generation === recordingGeneration) fail('Audio processing failed: ' + error.message);
  } finally {
    if (decodeContext && decodeContext.state !== 'closed') await decodeContext.close().catch(console.error);
    if (generation === recordingGeneration) cleanupRecording();
  }
}

window.addEventListener('beforeunload', () => {
  recordingGeneration++;
  cleanupRecording();
  worker?.terminate();
});

` + app.slice(recEnd);
app = app.replace('  initWorker();\n\n  // Set default language and trigger model load\n  setState(STATE.LOADING);\n  setModelState(\'loading\', \'Downloading…\');\n  worker.postMessage({ type: \'load\', language: currentLang });', "  try { initWorker(); loadModel(); }\n  catch (error) { fail('Cannot start AI worker: ' + error.message); }");
// Native dialog/IPC failures must be recoverable too.
app = app.replace('  const result = await window.electronAPI.saveFile(text, suggestedName);', `  let result;
  try { result = await window.electronAPI.saveFile(text, suggestedName); }
  catch (error) { showToast('Save failed: ' + error.message, 'error'); return; }`);
write('src/renderer/app.js', app);
