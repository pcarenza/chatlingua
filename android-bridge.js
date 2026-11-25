const android = globalThis.ChatLinguaAndroid;
let nextId = 0;
const translations = new Map();

globalThis.androidTranslationResult = (id, value) => finishTranslation(id, value);
globalThis.androidTranslationError = (id, message) => finishTranslation(id, undefined, new Error(message));

function finishTranslation(id, value, error) {
  const pending = translations.get(id);
  if (!pending) return;
  translations.delete(id);
  clearTimeout(pending.timeout);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

function operation(id, send, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finishTranslation(id, undefined, new Error('Android translation timed out.')), timeoutMs);
    translations.set(id, { resolve, reject, timeout });
    send();
  });
}

export async function androidTranslator(source, target) {
  const owner = ++nextId;
  try {
    await operation(owner, () => android.prepare(owner, source, target), 180_000);
  } catch (error) {
    android.release(owner);
    throw error;
  }
  return {
    translate(text) {
      const id = ++nextId;
      return operation(id, () => android.translate(id, owner, text), 15_000);
    },
    destroy() { android.release(owner); },
  };
}

let active;
globalThis.androidSpeechReady = id => {
  if (active?.id === id) active.onready();
};
globalThis.androidSpeechResult = (id, text) => {
  if (active?.id === id) active.onresult(text);
};
globalThis.androidSpeechError = (id, message) => {
  if (active?.id === id) active.onerror(message);
};
globalThis.androidSpeechEnd = id => {
  if (active?.id === id) active.onend();
};

export function androidRecognition(stream, locale, callbacks) {
  const context = new AudioContext({ sampleRate: 16000 });
  let input = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(1024, 1, 1);
  const session = { id: 0, ...callbacks };
  processor.onaudioprocess = event => {
    if (active !== session) return;
    const samples = event.inputBuffer.getChannelData(0);
    const pcm = new Uint8Array(samples.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, sample * (sample < 0 ? 32768 : 32767), true);
    }
    android.feed(btoa(String.fromCharCode(...pcm)));
  };
  input.connect(processor);
  processor.connect(context.destination);
  return {
    useStream(next) {
      input.disconnect();
      input = context.createMediaStreamSource(next);
      input.connect(processor);
    },
    start() {
      session.id = ++nextId;
      active = session;
      context.resume().catch(() => {});
      android.start(session.id, locale, context.sampleRate);
    },
    abort() {
      if (active !== session) return;
      active = undefined;
      android.stop(session.id);
      session.onend();
    },
    destroy() {
      this.abort();
      context.close().catch(() => {});
    },
  };
}
