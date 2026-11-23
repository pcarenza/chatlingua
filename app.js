import { androidRecognition, androidTranslator } from './android-bridge.js';

const android = globalThis.ChatLinguaAndroid;
const get = id => document.getElementById(id);
const ui = Object.fromEntries(['invite', 'status', 'remote', 'placeholder', 'stage-title', 'stage-description',
  'start', 'self', 'local', 'overlay', 'mic', 'camera', 'captions', 'end', 'spoken', 'source',
  'target', 'caption-status', 'history'].map(id => [id, get(id)]));
const icon = path => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
const cameraIcon = icon('<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 10 6-4v12l-6-4"/>');
get('camera-icon').innerHTML = cameraIcon;
ui.camera.querySelector('.icon').innerHTML = cameraIcon;
ui.mic.querySelector('.icon').innerHTML = icon('<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6"/>');
ui.captions.querySelector('.icon').innerHTML = icon('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9H8a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2m8-6h-2a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2"/>');
ui.end.querySelector('.icon').innerHTML = icon('<path d="M3 15v-2a4 4 0 0 1 2-3 15 15 0 0 1 14 0 4 4 0 0 1 2 3v2h-5v-3a11 11 0 0 0-8 0v3z"/>');

const languages = {
  'en-US': 'English', 'es-ES': 'Spanish', 'fr-FR': 'French', 'de-DE': 'German',
  'it-IT': 'Italian', 'pt-BR': 'Portuguese', 'ja-JP': 'Japanese', 'ko-KR': 'Korean',
  'zh-CN': 'Mandarin Chinese', 'ar-SA': 'Arabic', 'hi-IN': 'Hindi',
};
for (const [locale, label] of Object.entries(languages)) {
  for (const select of [ui.spoken, ui.source, ui.target]) select.add(new Option(label, locale));
}
const invited = new URL(location.href).searchParams.get('room');
ui.spoken.value = ui.target.value = invited ? 'es-ES' : 'en-US';
ui.source.value = invited ? 'en-US' : 'es-ES';
let call;
let captionSession;
let inviteId = invited;
let overlayTimer;

function status(message, state = 'idle') {
  ui.status.textContent = message;
  ui.status.dataset.state = state;
}

async function request(path, { method = 'GET', token, body, keepalive = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/rooms' + path, { method, headers, body: body && JSON.stringify(body), keepalive });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

function lobby() {
  ui.placeholder.hidden = false;
  ui['stage-title'].textContent = inviteId ? 'You’re invited' : 'Start a conversation';
  ui['stage-description'].textContent = inviteId ? 'Allow camera and microphone access to join the call.' : 'Create a room and share the invite link with one person.';
  ui.start.hidden = false;
  ui.start.textContent = inviteId ? 'Join call' : 'Create room';
  get('join-link').hidden = Boolean(inviteId);
}

function activateControls(active) {
  for (const button of [ui.mic, ui.camera, ui.captions, ui.end]) button.disabled = !active;
  ui.invite.hidden = !active || call?.role !== 'host';
  ui.invite.textContent = android ? 'Share invite link' : 'Copy invite link';
}

function signal(session, type, payload) {
  return request('/' + session.id + '/signals', {
    token: session.token, method: 'POST', body: { type, payload },
  });
}

function showRemote(session) {
  const live = session.peer.connectionState === 'connected';
  ui.placeholder.hidden = live && session.remoteCamera;
  if (!live) return;
  ui['stage-title'].textContent = 'Camera is off';
  ui['stage-description'].textContent = 'Your call partner can still talk.';
}

function sendCaption(session, message) {
  if (session.channel?.readyState === 'open') session.channel.send(JSON.stringify(message));
}

function connectChannel(session, channel) {
  session.channel = channel;
  channel.onopen = () => sendCaption(session, { type: 'language', locale: ui.spoken.value });
  channel.onmessage = event => {
    if (call !== session || typeof event.data !== 'string' || event.data.length > 4500) return;
    try {
      const message = JSON.parse(event.data);
      if (!Object.hasOwn(languages, message.locale)) return;
      if (message.type === 'language') {
        session.remoteLocale = message.locale;
        if (!captionSession) ui.source.value = message.locale;
      }
      if (message.type === 'caption' && typeof message.text === 'string') showCaption(message);
    } catch {
      // Ignore messages outside the caption protocol.
    }
  };
}

async function applySignal(session, { type, payload }) {
  const peer = session.peer;
  if (type === 'candidate') {
    if (peer.remoteDescription) await peer.addIceCandidate(payload);
    else session.candidates.push(payload);
  }
  if (type === 'offer' || type === 'answer') {
    await peer.setRemoteDescription(payload);
    for (const candidate of session.candidates.splice(0)) await peer.addIceCandidate(candidate);
    if (type === 'offer') {
      await peer.setLocalDescription(await peer.createAnswer());
      await signal(session, 'answer', peer.localDescription);
    }
  }
  if (type === 'media') {
    session.remoteCamera = payload?.camera !== false;
    showRemote(session);
  }
}

async function poll(session) {
  if (call !== session) return;
  try {
    const result = await request('/' + session.id + '/signals?after=' + session.cursor, { token: session.token });
    if (call !== session) return;
    if (result.paired && !session.paired) {
      session.paired = true;
      status('Connecting');
      ui['stage-title'].textContent = 'Connecting…';
      ui['stage-description'].textContent = 'Establishing the video call.';
      if (session.role === 'host') {
        connectChannel(session, session.peer.createDataChannel('captions'));
        await session.peer.setLocalDescription(await session.peer.createOffer());
        await signal(session, 'offer', session.peer.localDescription);
      }
      await signal(session, 'media', { camera: session.stream.getVideoTracks()[0].enabled });
    }
    for (const message of result.messages) {
      if (call !== session) return;
      await applySignal(session, message.data);
      session.cursor = message.sequence;
    }
    session.failures = 0;
  } catch (error) {
    if (call !== session) return;
    if (error.status === 410 || error.status === 403) return leave('Call ended');
    if (++session.failures >= 3 || !(error instanceof TypeError)) {
      return leave('The call connection was interrupted.', 'error');
    }
  }
  if (call === session) session.pollTimer = setTimeout(() => poll(session), 950);
}

function leave(message, state = 'idle') {
  const session = call;
  if (!session) return;
  call = undefined;
  clearTimeout(session.pollTimer);
  stopCaptions();
  session.peer?.close();
  session.stream.getTracks().forEach(track => track.stop());
  request('/' + session.id + '/leave', { token: session.token, method: 'POST', keepalive: true }).catch(() => {});
  ui.local.srcObject = ui.remote.srcObject = null;
  ui.self.hidden = true;
  ui.history.replaceChildren();
  inviteId = null;
  if (invited) history.replaceState(null, '', location.pathname);
  activateControls(false);
  lobby();
  status(message, state);
}

async function start() {
  ui.start.disabled = true;
  status('Requesting camera and microphone');
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require HTTPS or localhost.');
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const info = await request(inviteId ? '/' + encodeURIComponent(inviteId) + '/join' : '', { method: 'POST' });
    const session = { ...info, stream, candidates: [], cursor: 0, failures: 0, remoteCamera: true };
    call = session;
    const peer = session.peer = new RTCPeerConnection({ iceServers: info.iceServers });
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    peer.ontrack = event => { ui.remote.srcObject = event.streams[0]; };
    peer.ondatachannel = event => connectChannel(session, event.channel);
    peer.onicecandidate = event => {
      if (event.candidate && call === session) signal(session, 'candidate', event.candidate.toJSON()).catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      if (call !== session) return;
      if (peer.connectionState === 'failed') return leave('Could not connect the video call.', 'error');
      if (peer.connectionState === 'disconnected') status('Reconnecting');
      if (peer.connectionState === 'connected') {
        status('In call', 'live');
        showRemote(session);
      }
    };
    ui.local.srcObject = stream;
    ui.self.hidden = false;
    ui.start.hidden = true;
    get('join-link').hidden = true;
    ui.mic.setAttribute('aria-pressed', 'true');
    ui.camera.setAttribute('aria-pressed', 'true');
    activateControls(true);
    ui['stage-title'].textContent = info.role === 'host' ? 'Waiting for someone to join' : 'Connecting…';
    ui['stage-description'].textContent = info.role === 'host' ? 'Copy the invite link and send it to your call partner.' : 'Establishing the video call.';
    status(info.role === 'host' ? 'Waiting for guest' : 'Connecting');
    poll(session);
  } catch (error) {
    const message = error.name === 'NotAllowedError' ? 'Allow camera and microphone access to continue.'
      : error.name === 'NotFoundError' ? 'A camera and microphone are required.' : error.message;
    if (call) leave(message, 'error');
    else {
      stream?.getTracks().forEach(track => track.stop());
      if (error.status === 410 || error.status === 404) {
        inviteId = null;
        history.replaceState(null, '', location.pathname);
        lobby();
      }
      status(message, 'error');
    }
  } finally {
    ui.start.disabled = false;
  }
}

function captionStatus(message) {
  ui['caption-status'].textContent = message;
}

function stopCaptions(message = 'Turn on captions during the call.') {
  const current = captionSession;
  captionSession = undefined;
  if (current?.recognition?.destroy) current.recognition.destroy();
  else current?.recognition?.abort();
  current?.translator?.destroy();
  for (const select of [ui.spoken, ui.source, ui.target]) select.disabled = false;
  ui.captions.setAttribute('aria-pressed', 'false');
  ui.overlay.hidden = true;
  clearTimeout(overlayTimer);
  captionStatus(message);
}

function showCaption({ text, locale }) {
  const current = captionSession;
  if (!current || !text.trim()) return;
  current.queue = current.queue.then(async () => {
    if (captionSession !== current) return;
    let display = text;
    let label = languages[locale];
    if (locale === current.source && current.translator) {
      display = await current.translator.translate(text);
      label = languages[current.target];
    } else if (locale.split('-')[0] !== current.target.split('-')[0]) {
      captionStatus('The speaker’s language changed. Turn captions off, update “They speak”, and turn captions back on.');
      label += ' · Original';
    }
    if (captionSession !== current) return;
    const entry = document.createElement('article');
    const language = document.createElement('small');
    language.textContent = label;
    entry.append(language, document.createTextNode(display));
    ui.history.append(entry);
    if (ui.history.childElementCount > 60) ui.history.firstElementChild.remove();
    ui.history.scrollTop = ui.history.scrollHeight;
    ui.overlay.textContent = display;
    ui.overlay.hidden = false;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => { ui.overlay.hidden = true; }, 6500);
  }).catch(() => {
    if (captionSession === current) captionStatus('A caption could not be translated. Listening for the next phrase.');
  });
}

function listen(current) {
  if (current.listening || !current.call.stream.getAudioTracks()[0].enabled) return;
  try {
    current.recognition.start();
    current.listening = true;
  } catch {
    stopCaptions('Speech recognition could not start. Turn captions on to retry.');
  }
}

async function toggleCaptions() {
  if (!call) return;
  if (captionSession) return stopCaptions('Captions are off.');
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!android && !Recognition) return captionStatus('Speech recognition is unavailable in this browser. Try desktop Chrome.');
  const current = {
    call, spoken: ui.spoken.value, source: ui.source.value, target: ui.target.value,
    queue: Promise.resolve(),
  };
  captionSession = current;
  for (const select of [ui.spoken, ui.source, ui.target]) select.disabled = true;
  ui.captions.setAttribute('aria-pressed', 'true');
  const sourceLanguage = current.source.split('-')[0];
  const targetLanguage = current.target.split('-')[0];
  try {
    if (sourceLanguage !== targetLanguage) {
      if (!android && !globalThis.Translator) throw new Error('Translation is unavailable in this browser. Try desktop Chrome.');
      captionStatus('Preparing translation. The language model may need to download.');
      const translator = android
        ? await androidTranslator(sourceLanguage, targetLanguage)
        : await globalThis.Translator.create({ sourceLanguage, targetLanguage });
      if (captionSession !== current) return translator.destroy();
      current.translator = translator;
    }
    const onText = text => {
      if (captionSession !== current || !current.call.stream.getAudioTracks()[0].enabled) return;
      sendCaption(current.call, { type: 'caption', locale: current.spoken, text: text.slice(0, 600) });
    };
    const onError = error => {
      if (captionSession === current && !['no-speech', 'aborted'].includes(error)) {
        stopCaptions('Speech recognition is unavailable (' + error + '). Turn captions on to retry.');
      }
    };
    const onEnd = () => {
      current.listening = false;
      if (captionSession === current) setTimeout(() => {
        if (captionSession === current) listen(current);
      }, 300);
    };
    if (android) {
      current.recognition = androidRecognition(current.call.stream, current.spoken, {
        onresult: onText, onerror: onError, onend: onEnd,
      });
    } else {
      const recognition = current.recognition = new Recognition();
      recognition.lang = current.spoken;
      recognition.continuous = true;
      recognition.onresult = event => {
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (result.isFinal) onText(result[0].transcript);
        }
      };
      recognition.onerror = event => onError(event.error);
      recognition.onend = onEnd;
    }
    captionStatus('Captions are on. Waiting for your call partner to speak.');
    sendCaption(current.call, { type: 'language', locale: current.spoken });
    listen(current);
  } catch (error) {
    if (captionSession === current) stopCaptions(error.message || 'Could not prepare translation.');
  }
}

ui.start.addEventListener('click', start);
ui.end.addEventListener('click', () => leave('You left the call'));
ui.captions.addEventListener('click', toggleCaptions);
ui.spoken.addEventListener('change', () => {
  if (call) sendCaption(call, { type: 'language', locale: ui.spoken.value });
});
ui.invite.addEventListener('click', async () => {
  const url = new URL('/', location.origin);
  url.searchParams.set('room', call.id);
  if (android) return android.share(url.href);
  try {
    await navigator.clipboard.writeText(url.href);
    ui.invite.textContent = 'Invite copied';
  } catch {
    window.prompt('Copy this invite link', url.href);
  }
});
for (const [button, kind] of [[ui.mic, 'audio'], [ui.camera, 'video']]) {
  button.addEventListener('click', () => {
    const session = call;
    const track = session.stream.getTracks().find(item => item.kind === kind);
    track.enabled = !track.enabled;
    button.setAttribute('aria-pressed', String(track.enabled));
    if (kind === 'video' && session.paired) signal(session, 'media', { camera: track.enabled }).catch(() => {});
    if (kind === 'audio' && captionSession?.recognition) {
      if (track.enabled) listen(captionSession);
      else captionSession.recognition.abort();
    }
  });
}
get('join-link').addEventListener('click', () => {
  const link = window.prompt('Paste your ChatLingua invite link');
  if (!link) return;
  try {
    const url = new URL(link);
    if (url.origin !== location.origin || url.pathname !== '/' || !/^[a-f0-9]{36}$/.test(url.searchParams.get('room'))) throw new Error();
    location.assign(url.href);
  } catch {
    status('Enter an invite link for this ChatLingua site.', 'error');
  }
});
window.addEventListener('pagehide', () => leave('You left the call'));
lobby();
