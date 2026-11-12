/**
 * app.js — VoiceScribe Renderer Entry Point
 *
 * Manages:
 *  - UI state machine (idle → loading → ready → recording → paused → transcribing → done)
 *  - Microphone capture via Web Audio API
 *  - Waveform level meter animation
 *  - Communication with transcription.worker.js
 *  - Transcript display, copy, save, clear
 *  - Language switching
 */

'use strict';

// ============================================================
// DOM References
// ============================================================
const elTitlebarStatus   = document.getElementById('titlebar-status');
const elModelIndicator   = document.getElementById('model-indicator');
const elModelName        = document.getElementById('model-name');
const elModelDetail      = document.getElementById('model-detail');
const elModelActions     = document.getElementById('model-actions');
const elBtnClearCache    = document.getElementById('btn-clear-cache');
const elDownloadWrap     = document.getElementById('download-progress-wrap');
const elDownloadLabel    = document.getElementById('download-label');
const elProgressFill     = document.getElementById('progress-bar-fill');
const elProgressPct      = document.getElementById('progress-pct');

const elLangBtns         = document.querySelectorAll('.lang-btn');
const elBtnRecord        = document.getElementById('btn-record');
const elBtnPause         = document.getElementById('btn-pause');
const elBtnStop          = document.getElementById('btn-stop');
const elRecordIcon       = document.getElementById('record-icon');
const elStateLabel       = document.getElementById('state-label');

const elWaveform         = document.getElementById('waveform');
const elVisualizerRing   = document.getElementById('visualizer-ring');
const elRecordingTime    = document.getElementById('recording-time');
const elWordCount        = document.getElementById('word-count');

const elTranscriptArea   = document.getElementById('transcript-textarea');
const elTranscriptOverlay = document.getElementById('transcript-overlay');
const elOverlayLabel     = document.getElementById('overlay-label');
const elBtnCopy          = document.getElementById('btn-copy');
const elBtnSave          = document.getElementById('btn-save');
const elBtnClear         = document.getElementById('btn-clear');

const elAutoCopy         = document.getElementById('auto-copy-toggle');
const elAppendMode       = document.getElementById('append-mode-toggle');

const elToast            = document.getElementById('toast');

// ============================================================
// State
// ============================================================
const STATE = {
  IDLE:         'idle',
  STARTING:     'starting',
  ERROR:        'error',
  LOADING:      'loading',
  READY:        'ready',
  RECORDING:    'recording',
  PAUSED:       'paused',
  TRANSCRIBING: 'transcribing',
};

let appState       = STATE.IDLE;
let currentLang    = 'en';
let worker         = null;
let mediaRecorder  = null;
let audioChunks    = [];
let audioStream    = null;
let audioContext   = null;
let analyserNode   = null;
let animFrameId    = null;
let timerInterval  = null;
let recordSeconds  = 0;
let modelReady = false;
let backend = '';
let requestSerial = 0;
let activeRequest = null;
let recordingGeneration = 0;
let recordingLanguage = 'en';
let retryOperation = 'load';
let forceWasm = false;

// Build waveform bars
const NUM_BARS = 36;
for (let i = 0; i < NUM_BARS; i++) {
  const bar = document.createElement('div');
  bar.className = 'wave-bar';
  elWaveform.appendChild(bar);
}
const waveBars = Array.from(elWaveform.querySelectorAll('.wave-bar'));

// ============================================================
// Worker Initialization
// ============================================================
function initWorker() {
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
  activeRequest = null;
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
  if (type === 'load-error' && event.data.retryBackend === 'wasm' && !forceWasm) {
    forceWasm = true;
    try { initWorker(); loadModel(); }
    catch (error) { fail('Cannot restart CPU engine: ' + error.message); }
    return;
  }
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
    modelReady = false;
    if (operation === 'transcribe' || operation === 'load') {
      worker?.terminate();
      worker = null;
    }
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
  requestWorker('load', { forceWasm });
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

// ============================================================
// UI State Machine
// ============================================================
function setState(newState) {
  appState = newState;

  // Update buttons
  const isReady       = newState === STATE.READY;
  const isRecording   = newState === STATE.RECORDING;
  const isPaused      = newState === STATE.PAUSED;
  const isTranscribing = newState === STATE.TRANSCRIBING;
  const isLoading     = newState === STATE.LOADING;

  elBtnRecord.disabled = !modelReady || !(isReady || isRecording || isPaused);
  const canConfigure = isReady || newState === STATE.ERROR;
  elLangBtns.forEach(btn => { btn.disabled = !canConfigure; });
  elModelActions.style.display = canConfigure ? 'flex' : 'none';
  elBtnClearCache.disabled = !canConfigure;
  elBtnPause.disabled  = !isRecording;
  elBtnStop.disabled   = !(isRecording || isPaused);

  // Record button appearance
  elBtnRecord.classList.toggle('recording', isRecording);
  elBtnRecord.classList.toggle('paused', isPaused);

  // Waveform ring
  elVisualizerRing.classList.toggle('recording', isRecording);

  // Waveform idle animation
  elWaveform.classList.toggle('idle', isReady || appState === STATE.IDLE || appState === STATE.LOADING);

  // State label
  const labels = {
    [STATE.IDLE]:         'Initializing…',
    [STATE.STARTING]:     'Waiting for microphone...',
    [STATE.ERROR]:        'An error occurred. Use Retry.',
    [STATE.LOADING]:      'Loading model, please wait…',
    [STATE.READY]:        'Click the mic to start recording',
    [STATE.RECORDING]:    '● Recording  —  click pause or stop when done',
    [STATE.PAUSED]:       '⏸ Paused  —  click mic to resume or stop to transcribe',
    [STATE.TRANSCRIBING]: 'Transcribing audio, please wait…',
  };
  elStateLabel.textContent = labels[newState] || '';
  elTitlebarStatus.textContent = newState.charAt(0).toUpperCase() + newState.slice(1);

  // Transcript overlay
  if (isTranscribing) {
    elTranscriptOverlay.style.display = 'flex';
    elOverlayLabel.textContent = 'Transcribing audio…';
  } else {
    elTranscriptOverlay.style.display = 'none';
  }

  // Timer
  if (isRecording) {
    startTimer();
  } else {
    stopTimer();
  }
}

// ============================================================
// Model State (sidebar indicator)
// ============================================================
function setModelState(status, detail) {
  elModelIndicator.className = 'model-status-indicator';
  if (status === 'loading') elModelIndicator.classList.add('loading');
  else if (status === 'ready') elModelIndicator.classList.add('ready');
  else if (status === 'error') elModelIndicator.classList.add('error');

  elModelName.textContent   = 'whisper-base';
  elModelDetail.textContent = detail || '';
}

// ============================================================
// Language Selection
// ============================================================
function selectLanguage(lang) {
  if (![STATE.READY, STATE.ERROR].includes(appState) || !['en', 'bn'].includes(lang)) return;
  currentLang = lang;
  elLangBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.lang === lang));
}

elLangBtns.forEach(btn => {
  btn.addEventListener('click', () => selectLanguage(btn.dataset.lang));
});

// ============================================================
// Microphone & Recording
// ============================================================
function cleanupRecording() {
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

// ============================================================
// Waveform Visualizer
// ============================================================
function startWaveformAnimation() {
  if (!analyserNode) return;
  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(dataArray);

    // Map frequency bins to bars
    const step = Math.floor(dataArray.length / NUM_BARS);
    waveBars.forEach((bar, i) => {
      const value = dataArray[i * step] || 0;
      const heightPx = Math.max(4, (value / 255) * 72);
      bar.style.height = heightPx + 'px';
      bar.classList.toggle('active', value > 20);
    });
  }
  draw();
}

function stopWaveformAnimation() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  // Reset bars to idle height
  waveBars.forEach(bar => {
    bar.style.height = '4px';
    bar.classList.remove('active');
  });
}

function resumeWaveform() {
  startWaveformAnimation();
}

// ============================================================
// Timer
// ============================================================
function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (appState === STATE.RECORDING) {
      recordSeconds++;
      elRecordingTime.textContent = formatTime(recordSeconds);
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function formatTime(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ============================================================
// Transcription Result
// ============================================================
function onTranscriptionResult(text) {
  setState(STATE.READY);
  elTranscriptOverlay.style.display = 'none';

  if (!text || text.trim() === '') {
    showToast('No speech detected. Try speaking louder.', 'info');
    return;
  }

  const appendMode = elAppendMode.checked;
  if (appendMode && elTranscriptArea.value.trim() !== '') {
    elTranscriptArea.value += '\n\n' + text.trim();
  } else {
    elTranscriptArea.value = text.trim();
  }

  // Update word count
  updateWordCount();

  // Auto-copy if enabled
  if (elAutoCopy.checked) {
    copyToClipboard(false);
  }

  showToast('Transcription complete!', 'success');
}

function updateWordCount() {
  const text = elTranscriptArea.value.trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  elWordCount.textContent = words;
}

elTranscriptArea.addEventListener('input', updateWordCount);

// ============================================================
// Button Handlers — Recording Controls
// ============================================================
elBtnRecord.addEventListener('click', () => {
  if (appState === STATE.READY) {
    startRecording();
  } else if (appState === STATE.RECORDING) {
    // Clicking mic again → pause (ergonomic toggle)
    pauseRecording();
  } else if (appState === STATE.PAUSED) {
    startRecording(); // resume
  }
});

elBtnPause.addEventListener('click', pauseRecording);
elBtnStop.addEventListener('click', stopRecording);

// ============================================================
// Button Handlers — Transcript Actions
// ============================================================
elBtnCopy.addEventListener('click', () => copyToClipboard(true));

function copyToClipboard(showFeedback) {
  const text = elTranscriptArea.value;
  if (!text.trim()) {
    if (showFeedback) showToast('Nothing to copy', 'info');
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    if (showFeedback) showToast('Copied to clipboard!', 'success');
  }).catch(err => {
    showToast('Copy failed: ' + err.message, 'error');
  });
}

elBtnSave.addEventListener('click', async () => {
  const text = elTranscriptArea.value;
  if (!text.trim()) {
    showToast('Nothing to save', 'info');
    return;
  }

  const date = new Date();
  const suggestedName = `transcript_${date.toISOString().slice(0,10)}_${date.getHours()}h${date.getMinutes()}m.txt`;

  let result;
  try { result = await window.electronAPI.saveFile(text, suggestedName); }
  catch (error) { showToast('Save failed: ' + error.message, 'error'); return; }
  if (result.success) {
    showToast(`Saved: ${result.filePath.split('\\').pop()}`, 'success');
  } else if (!result.canceled) {
    showToast('Save failed: ' + result.error, 'error');
  }
});

elBtnClear.addEventListener('click', () => {
  if (!elTranscriptArea.value.trim()) return;
  elTranscriptArea.value = '';
  updateWordCount();
  recordSeconds = 0;
  elRecordingTime.textContent = '00:00';
  showToast('Transcript cleared', 'info');
});

// ============================================================
// Menu shortcut: Ctrl+S
// ============================================================
if (window.electronAPI && window.electronAPI.onMenuSave) {
  window.electronAPI.onMenuSave(() => {
    elBtnSave.click();
  });
}

// ============================================================
// Toast Notification
// ============================================================
let toastTimeout;
function showToast(message, type = 'info') {
  elToast.textContent = message;
  elToast.className   = `toast ${type} show`;

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    elToast.classList.remove('show');
  }, 3200);
}

// ============================================================
// Bootstrap
// ============================================================
function bootstrap() {
  try { initWorker(); loadModel(); }
  catch (error) { fail('Cannot start AI worker: ' + error.message); }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target === elTranscriptArea) return; // don't intercept textarea input

    // Space → toggle record/pause
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (appState === STATE.READY || appState === STATE.PAUSED) elBtnRecord.click();
      else if (appState === STATE.RECORDING) elBtnPause.click();
    }
    // Enter → stop
    if (e.code === 'Enter' && (appState === STATE.RECORDING || appState === STATE.PAUSED)) {
      e.preventDefault();
      elBtnStop.click();
    }
  });

  console.log('[VoiceScribe] App initialized');
}

bootstrap();
