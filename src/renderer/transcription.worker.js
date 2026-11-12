import { pipeline, env } from '../../node_modules/@huggingface/transformers/dist/transformers.web.js';
import { createTranscriptionService } from './transcription-service.mjs';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, self.navigator.hardwareConcurrency || 1)) : 1;
env.backends.onnx.wasm.wasmPaths = new URL('/runtime/', self.location.href).href;
const service = createTranscriptionService({
  pipeline, caches: self.caches,
  getGPUAdapter: () => self.navigator.gpu?.requestAdapter(),
  postMessage: message => self.postMessage(message),
});
self.addEventListener('message', event => void service.handle(event.data));
