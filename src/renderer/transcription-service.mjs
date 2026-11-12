export function errorCategory(error) {
  const message = String(error?.message || error);
  if (/404|not found|ENOENT/i.test(message)) return 'not_found';
  if (/memory|allocate|OOM/i.test(message)) return 'memory';
  if (/fetch|network|download/i.test(message)) return 'network';
  if (/wasm|WebAssembly/i.test(message)) return 'wasm';
  if (/gpu|adapter|device/i.test(message)) return 'gpu';
  return 'unknown';
}

// Model lifecycle is independent of the UI and can be tested without downloading weights.
export function createTranscriptionService({ pipeline, caches, getGPUAdapter, postMessage }) {
  let model = null;
  let backend = null;
  let busy = false;
  async function dispose() {
    if (model) {
      await model.dispose();
      model = null;
      backend = null;
    }
  }
  async function handle(request) {
    const { type, requestId, language = 'en', audioData, forceWasm = false } = request;
    const send = response => postMessage({ ...response, requestId, operation: type });
    if (busy) {
      send({ type: 'error', category: 'busy', message: 'Another operation is in progress.' });
      return;
    }
    busy = true;
    try {
      if (type === 'load') {
        if (!model) {
          const options = {
            dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
            progress_callback: info => send({
              type: 'load-progress', progress: info.progress || 0,
              label: info.file ? `Loading ${info.file.split('/').pop()}` : 'Loading model',
            }),
          };
          let adapter = null;
          try { if (!forceWasm) adapter = await getGPUAdapter(); } catch { /* Use WASM. */ }
          backend = adapter ? 'webgpu' : 'wasm';
          try {
            model = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
              ...options, device: backend,
            });
          } catch (error) {
            if (backend !== 'webgpu' || !['gpu', 'unknown'].includes(errorCategory(error))) throw error;
            // Transformers.js retains failed ONNX initialization promises. A fresh worker
            // is necessary to retry WASM safely and release any partial GPU sessions.
            send({ type: 'load-error', category: 'gpu-fallback', retryBackend: 'wasm', message: error.message });
            return;
          }
        }
        send({ type: 'load-done', backend });
      } else if (type === 'transcribe') {
        if (!model) throw new Error('Model not loaded. Retry loading the model.');
        if (!['en', 'bn'].includes(language)) throw new Error('Unsupported language.');
        const result = await model(audioData, {
          language: language === 'bn' ? 'bengali' : 'english', task: 'transcribe',
          return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
        });
        const text = Array.isArray(result) ? result.map(item => item.text).join(' ')
          : typeof result === 'string' ? result : result?.text || '';
        send({ type: 'result', text: text.trim() });
      } else if (type === 'clear-cache') {
        await dispose();
        if (!caches) throw new Error('Browser model cache is unavailable.');
        await caches.delete('transformers-cache');
        send({ type: 'cache-cleared' });
      } else {
        throw new Error('Unsupported worker operation: ' + type);
      }
    } catch (error) {
      send({ type: type === 'load' ? 'load-error' : 'error',
        category: errorCategory(error), message: error.message || String(error), stack: error.stack });
    } finally { busy = false; }
  }
  return { handle };
}
