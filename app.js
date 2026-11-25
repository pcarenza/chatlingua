import { androidRecognition, androidTranslator } from './android-bridge.js';
import { localizeInterface } from './i18n.js';

const { locale: interfaceLocale, t } = localizeInterface();

const android = globalThis.ChatLinguaAndroid;
const get = id => document.getElementById(id);
if (android) get('android-download')?.remove();
const ui = Object.fromEntries(['invite', 'status', 'remote', 'placeholder', 'stage-title', 'stage-description',
  'start', 'self', 'local', 'overlay', 'mic', 'camera', 'speaker', 'captions', 'end', 'spoken', 'source',
  'target', 'caption-status', 'history', 'chat-toggle', 'chat-label', 'chat-panel', 'chat-status',
  'chat-messages', 'chat-form', 'chat-input', 'chat-send'].map(id => [id, get(id)]));
const icon = path => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
const cameraIcon = icon('<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 10 6-4v12l-6-4"/>');
get('camera-icon').innerHTML = cameraIcon;
ui.camera.querySelector('.icon').innerHTML = cameraIcon;
ui.speaker.querySelector('.icon').innerHTML = icon('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>');
ui.mic.querySelector('.icon').innerHTML = icon('<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6"/>');
ui.captions.querySelector('.icon').innerHTML = icon('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9H8a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2m8-6h-2a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2"/>');
ui['chat-toggle'].querySelector('.icon').innerHTML = icon('<path d="M21 11a8 8 0 0 1-8 8H9l-5 3v-5a8 8 0 0 1-2-6 8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M7 9h9m-9 4h6"/>');
get('add-call-contact').querySelector('.icon').innerHTML = icon('<circle cx="9" cy="7" r="3.5"/><path d="M2.5 20v-2a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v2M19 7v8m-4-4h8"/>');
ui.end.querySelector('.icon').innerHTML = icon('<path d="M3 15v-2a4 4 0 0 1 2-3 15 15 0 0 1 14 0 4 4 0 0 1 2 3v2h-5v-3a11 11 0 0 0-8 0v3z"/>');

const languages = {
  'en-US': 'English', 'es-ES': 'Spanish', 'fr-FR': 'French', 'de-DE': 'German',
  'it-IT': 'Italian', 'pt-BR': 'Portuguese', 'ja-JP': 'Japanese', 'ko-KR': 'Korean',
  'zh-CN': 'Mandarin Chinese', 'ar-SA': 'Arabic', 'hi-IN': 'Hindi',
};
if (interfaceLocale !== 'en') {
  const names = new Intl.DisplayNames([interfaceLocale], { type: 'language' });
  for (const locale of Object.keys(languages)) languages[locale] = names.of(locale.split('-')[0]);
}
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
let incomingCall;
let contactState;
let refreshingContacts = false;

function status(message, state = 'idle') {
  ui.status.textContent = message;
  ui.status.dataset.state = state;
}

async function apiRequest(path, { method = 'GET', token, body, keepalive = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body && JSON.stringify(body), keepalive });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(t(data.error)), { status: response.status });
  return data;
}

const request = (path, options) => apiRequest('/api/rooms' + path, options);
const contactsRequest = (path, body) => apiRequest('/api/contacts' + path, {
  method: body ? 'POST' : 'GET',
  body,
});

function contactStatus(message) {
  get('contact-status').textContent = message;
}

function showIncoming() {
  incomingCall = !call && !ui.start.disabled ? contactState?.incoming[0] : undefined;
  get('incoming-call').hidden = !incomingCall;
  if (incomingCall) get('incoming-label').textContent = t('Incoming call from {name}', { name: incomingCall.label });
}

function renderContacts(state) {
  const list = get('contact-list');
  const unchanged = contactState && JSON.stringify(contactState.contacts) === JSON.stringify(state.contacts);
  contactState = state;
  get('setup-contacts').hidden = true;
  get('contact-details').hidden = false;
  get('my-code').value = state.code;
  if (!unchanged) {
    list.replaceChildren();
    for (const contact of state.contacts) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = contact.label;
      const dial = document.createElement('button');
      dial.textContent = t('Call');
      dial.setAttribute('aria-label', t('Call {name}', { name: contact.label }));
      dial.addEventListener('click', () => start({ contact }));
      const remove = document.createElement('button');
      remove.textContent = t('Remove');
      remove.setAttribute('aria-label', t('Remove {name}', { name: contact.label }));
      remove.addEventListener('click', async () => {
        try {
          await contactsRequest('/remove', { code: contact.code });
          await refreshContacts();
          contactStatus(t('Contact removed.'));
        } catch (error) {
          contactStatus(error.message);
        }
      });
      const rename = document.createElement('button');
      rename.textContent = t('Rename');
      rename.setAttribute('aria-label', t('Rename {name}', { name: contact.label }));
      rename.addEventListener('click', () => {
        get('contact-name').value = contact.label;
        get('contact-code').value = contact.code;
        get('contact-name').focus();
      });
      item.append(name, dial, rename, remove);
      list.append(item);
    }
  }
  for (const dial of list.querySelectorAll('button:first-of-type')) dial.disabled = Boolean(call) || ui.start.disabled;
  showIncoming();
}

async function refreshContacts() {
  if (refreshingContacts) return;
  refreshingContacts = true;
  try {
    renderContacts(await contactsRequest(''));
  } catch (error) {
    if (error.status !== 401) contactStatus(t('Could not refresh contacts. Retrying when the app is open.'));
  } finally {
    refreshingContacts = false;
  }
}

function setupContacts() {
  if (get('contacts').hidden) return;
  get('setup-contacts').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await contactsRequest('/profile', {});
      await refreshContacts();
    } catch (error) {
      contactStatus(error.message);
    } finally {
      button.disabled = false;
    }
  });
  get('copy-code').addEventListener('click', async () => {
    const input = get('my-code');
    try {
      await navigator.clipboard.writeText(input.value);
      contactStatus(t('Contact code copied.'));
    } catch {
      input.focus();
      input.select();
    }
  });
  get('contact-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await contactsRequest('/save', {
        code: get('contact-code').value.trim().toLowerCase(),
        label: get('contact-name').value.trim(),
      });
      form.reset();
      await refreshContacts();
      contactStatus(t('Contact saved.'));
    } catch (error) {
      contactStatus(error.message);
    }
  });
  get('accept-call').addEventListener('click', () => {
    if (incomingCall) start({ incoming: incomingCall });
  });
  get('decline-call').addEventListener('click', async () => {
    if (!incomingCall) return;
    try {
      await contactsRequest('/decline', { room: incomingCall.room });
      await refreshContacts();
    } catch (error) {
      contactStatus(error.message);
    }
  });
  refreshContacts();
  setInterval(() => {
    if (contactState && !document.hidden && !call) refreshContacts();
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !call) refreshContacts();
  });
}

function lobby() {
  ui.placeholder.hidden = false;
  ui['stage-title'].textContent = inviteId ? t('You’re invited') : t('Start a conversation');
  ui['stage-description'].textContent = inviteId ? t('Allow camera and microphone access to join the call.') : t('Create a room and share the invite link with one person.');
  ui.start.hidden = false;
  ui.start.textContent = inviteId ? t('Join call') : t('Create room');
  get('join-link').hidden = Boolean(inviteId);
}

function activateControls(active) {
  for (const button of [ui.mic, ui.camera, ui.speaker, ui.captions, ui['chat-toggle'], ui.end]) button.disabled = !active;
  ui.invite.hidden = !active || call?.role !== 'host' || Boolean(call.contact);
  ui.invite.textContent = android ? t('Share invite link') : t('Copy invite link');
  const add = get('add-call-contact');
  add.hidden = !active || get('contacts').hidden || Boolean(call?.contact || call?.incoming);
  add.disabled = !active || call?.channel?.readyState !== 'open';
}

function retryableSignal(error) {
  return error instanceof TypeError || [429, 502, 503, 504].includes(error.status);
}

function signal(session, type, payload) {
  const send = async () => {
    for (let attempt = 0; call === session; attempt++) {
      try {
        return await request('/' + session.id + '/signals', {
          token: session.token, method: 'POST', body: { type, payload },
        });
      } catch (error) {
        if (!retryableSignal(error) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt));
      }
    }
  };
  const pending = session.outbound.then(send);
  session.outbound = pending.catch(() => {});
  return pending;
}

function showRemote(session) {
  const live = session.peer.connectionState === 'connected';
  ui.placeholder.hidden = live && session.remoteCamera;
  if (!live) return;
  ui['stage-title'].textContent = t('Camera is off');
  ui['stage-description'].textContent = t('Your call partner can still talk.');
}

const maxChatLength = 1000;
let unreadChat = 0;

function languageCode(locale) {
  return locale.split('-')[0];
}

function closeTranslator(session) {
  const active = session.translation;
  session.translation = undefined;
  active?.translator?.destroy();
}

function getTranslator(session, source, target) {
  const active = session.translation;
  if (active?.source === source && active.target === target) return active.ready;
  closeTranslator(session);
  const model = { source, target };
  session.translation = model;
  model.ready = (async () => {
    try {
      const translator = android
        ? await androidTranslator(source, target)
        : await globalThis.Translator.create({ sourceLanguage: source, targetLanguage: target });
      if (call !== session || session.translation !== model) {
        translator.destroy();
        return;
      }
      model.translator = translator;
      return translator;
    } catch {
      if (session.translation === model) session.translation = undefined;
    }
  })();
  return model.ready;
}

async function translateText(translator, text) {
  if (!android || text.length <= 600) return translator.translate(text);
  const characters = Array.from(text);
  const parts = [];
  while (characters.length) {
    const limit = Math.min(characters.length, 300);
    let split = limit;
    if (limit < characters.length) {
      while (split > 0 && !/\s/u.test(characters[split])) split--;
      if (split === 0) split = limit;
    }
    parts.push(characters.splice(0, split).join(''));
  }
  const translated = await Promise.all(parts.map(part => translator.translate(part.trim())));
  return translated.join(' ');
}

function translatePendingChat(session) {
  if (!session || !session.pendingChat.size) return;
  for (const [message, entry] of session.pendingChat) {
    const target = ui.target.value;
    const source = languageCode(entry.locale);
    if (source === languageCode(target)) {
      entry.sender.textContent = t('Partner');
      session.pendingChat.delete(message);
      continue;
    }
    if (entry.translating === target) continue;
    entry.translating = target;
    entry.sender.textContent = t('{sender} · {language}', { sender: t('Partner'), language: t('Original') });
    getTranslator(session, source, languageCode(target)).then(async translator => {
      if (!translator || call !== session || entry.translating !== target) return;
      const translated = await translateText(translator, entry.text);
      if (call !== session || entry.translating !== target || ui.target.value !== target || !translated?.trim()) return;
      entry.body.textContent = translated;
      entry.sender.textContent = t('{sender} · {language}', { sender: t('Partner'), language: languages[target] });
      session.pendingChat.delete(message);
    }).catch(() => {
      // Keep the original when the device cannot translate this message.
    }).finally(() => {
      if (entry.translating === target) entry.translating = undefined;
    });
  }
}

function prepareChat() {
  const session = call;
  if (!session) return;
  if (session.pendingChat.size) return translatePendingChat(session);
  const source = languageCode(session.remoteLocale || ui.source.value);
  const target = languageCode(ui.target.value);
  if (source !== target) getTranslator(session, source, target);
}

function updateChatAvailability() {
  const ready = call?.channel?.readyState === 'open';
  ui['chat-input'].disabled = !ready;
  ui['chat-send'].disabled = !ready || !ui['chat-input'].value.trim();
  ui['chat-status'].textContent = ready ? '' : t('Chat opens when your call connects.');
  ui['chat-status'].hidden = Boolean(ready);
}

function openChat(open) {
  ui['chat-panel'].hidden = !open;
  ui['chat-toggle'].setAttribute('aria-expanded', String(open));
  if (open) {
    unreadChat = 0;
    ui['chat-label'].textContent = t('Chat');
    ui['chat-messages'].scrollTop = ui['chat-messages'].scrollHeight;
    prepareChat();
  }
}

function addChatMessage(text, fromSelf, locale) {
  const message = document.createElement('article');
  message.className = fromSelf ? 'chat-message from-self' : 'chat-message';
  const sender = document.createElement('small');
  sender.textContent = fromSelf ? t('You') : t('Partner');
  const body = document.createElement('div');
  body.dir = 'auto';
  body.textContent = text;
  message.append(sender, body);
  const log = ui['chat-messages'];
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.append(message);
  if (log.childElementCount > 200) {
    call?.pendingChat.delete(log.firstElementChild);
    log.firstElementChild.remove();
  }
  if (!fromSelf && locale && call) {
    call.pendingChat.set(message, { text, locale, sender, body });
    translatePendingChat(call);
  }
  if (fromSelf || atBottom) log.scrollTop = log.scrollHeight;
  if (!fromSelf && ui['chat-panel'].hidden) {
    unreadChat++;
    ui['chat-label'].textContent = t('Chat ({count})', { count: unreadChat });
  }
}

function handleChatSubmit(event) {
  event.preventDefault();
  const input = ui['chat-input'];
  const text = input.value.trim();
  const channel = call?.channel;
  if (!text || text.length > maxChatLength || channel?.readyState !== 'open') return;
  try {
    channel.send(JSON.stringify({ type: 'chat', text, locale: ui.spoken.value }));
  } catch {
    ui['chat-status'].textContent = t('Message could not be sent. Try again.');
    ui['chat-status'].hidden = false;
    return;
  }
  addChatMessage(text, true);
  input.value = '';
  updateChatAvailability();
  input.focus();
}

function sendCaption(session, message) {
  if (session.channel?.readyState === 'open') session.channel.send(JSON.stringify(message));
}

function contactExchangeStatus(message, offer = false) {
  get('contact-exchange').hidden = !message;
  get('contact-exchange-status').textContent = message;
  get('accept-contact').hidden = !offer;
  get('decline-contact').hidden = !offer;
}

async function saveCallContact(code) {
  await contactsRequest('/save', { code, label: t('Call partner · {code}', { code: code.slice(-4) }), keepLabel: true });
  await refreshContacts();
}

async function requestCallContact() {
  const session = call;
  if (!session || session.contactRequest || session.channel?.readyState !== 'open') return;
  const button = get('add-call-contact');
  button.disabled = true;
  try {
    const { code } = await contactsRequest('/profile', {});
    if (call !== session || session.channel?.readyState !== 'open') return;
    session.contactRequest = crypto.randomUUID();
    sendCaption(session, { type: 'contact-request', id: session.contactRequest, code });
    if (!session.contactOffer) contactExchangeStatus(t('Contact request sent. Waiting for your call partner.'));
  } catch (error) {
    if (call !== session) return;
    session.contactRequest = undefined;
    button.disabled = false;
    contactExchangeStatus(error.message || t('Could not send contact request.'), Boolean(session.contactOffer));
  }
}

async function acceptCallContact() {
  const session = call;
  const offer = session?.contactOffer;
  if (!offer) return;
  const button = get('accept-contact');
  button.disabled = true;
  try {
    const { code } = await contactsRequest('/profile', {});
    await saveCallContact(offer.code);
    if (call !== session) return;
    sendCaption(session, { type: 'contact-accept', id: offer.id, code });
    session.contactOffer = undefined;
    get('add-call-contact').disabled = true;
    contactExchangeStatus(t('Contact saved. Rename it in Contacts.'));
  } catch (error) {
    if (call === session) contactExchangeStatus(error.message || t('Could not save contact.'), true);
  } finally {
    button.disabled = false;
  }
}

function handleContactMessage(session, message) {
  if (get('contacts').hidden || typeof message.id !== 'string' || message.id.length > 64) return;
  if (message.type === 'contact-decline') {
    if (session.contactRequest !== message.id) return;
    session.contactRequest = undefined;
    get('add-call-contact').disabled = false;
    if (!session.contactOffer) contactExchangeStatus(t('Contact request declined.'));
    return;
  }
  if (typeof message.code !== 'string' || !/^[a-f0-9]{12}$/.test(message.code)) return;
  if (message.type === 'contact-request' && !session.contactOffer) {
    session.contactOffer = message;
    contactExchangeStatus(t('Your call partner wants to add you as a contact.'), true);
  }
  if (message.type === 'contact-accept' && session.contactRequest === message.id) {
    session.contactRequest = undefined;
    saveCallContact(message.code).then(() => {
      if (call !== session) return;
      session.contactOffer = undefined;
      contactExchangeStatus(t('Contact saved. Rename it in Contacts.'));
    }).catch(error => {
      if (call !== session) return;
      get('add-call-contact').disabled = false;
      contactExchangeStatus(error.message || t('Could not save contact.'));
    });
  }
}

function connectChannel(session, channel) {
  session.channel = channel;
  channel.onopen = () => {
    if (call !== session) return;
    updateChatAvailability();
    get('add-call-contact').disabled = false;
    sendCaption(session, { type: 'language', locale: ui.spoken.value });
  };
  channel.onclose = () => {
    if (call === session) {
      updateChatAvailability();
      get('add-call-contact').disabled = true;
    }
  };
  channel.onmessage = event => {
    if (call !== session || typeof event.data !== 'string' || event.data.length > 8192) return;
    try {
      const message = JSON.parse(event.data);
      if (typeof message?.type === 'string' && message.type.startsWith('contact-')) {
        handleContactMessage(session, message);
        return;
      }
      if (message?.type === 'chat') {
        if (typeof message.text === 'string' && message.text.length <= maxChatLength && message.text.trim()) {
          const locale = Object.hasOwn(languages, message.locale) ? message.locale : session.remoteLocale;
          addChatMessage(message.text.trim(), false, locale);
        }
        return;
      }
      if (!message || !Object.hasOwn(languages, message.locale)) return;
      if (message.type === 'language') {
        session.remoteLocale = message.locale;
        if (!captionSession) ui.source.value = message.locale;
      }
      if (message.type === 'caption' && typeof message.text === 'string') showCaption(message);
    } catch {
      // Ignore messages outside the call data protocol.
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
    if (peer.remoteDescription?.type === payload.type && peer.remoteDescription.sdp === payload.sdp) return;
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
    if (!result.paired && session.contact && Date.now() >= session.checkRingAt) {
      session.checkRingAt = Date.now() + 3000;
      const ring = await contactsRequest('/status', { room: session.id });
      if (call !== session) return;
      if (ring.state === 'declined') return leave(t('Call declined'));
      if (ring.state === 'expired') return leave(t('No answer'));
    }
    if (result.paired && !session.paired) {
      session.paired = true;
      status(t('Connecting'));
      ui['stage-title'].textContent = t('Connecting…');
      ui['stage-description'].textContent = t('Establishing the video call.');
      if (session.role === 'host') {
        connectChannel(session, session.peer.createDataChannel('captions'));
        await session.peer.setLocalDescription(await session.peer.createOffer());
        await signal(session, 'offer', session.peer.localDescription);
      }
      signal(session, 'media', { camera: session.stream.getVideoTracks()[0].enabled }).catch(() => {});
    }
    for (const message of result.messages) {
      if (call !== session) return;
      await applySignal(session, message.data);
      session.cursor = message.sequence;
    }
    session.signalFailureAt = undefined;
  } catch (error) {
    if (call !== session) return;
    if (error.status === 410 || error.status === 403) return leave(t('Call ended'));
    if (!retryableSignal(error)) return leave(t('The call connection was interrupted.'), 'error');
    session.signalFailureAt ??= Date.now();
    if (session.peer.connectionState !== 'connected' && Date.now() - session.signalFailureAt >= 20_000) {
      return leave(t('The call server could not reconnect.'), 'error');
    }
  }
  if (call === session) session.pollTimer = setTimeout(() => poll(session), 950);
}

function leave(message, state = 'idle') {
  const session = call;
  if (!session) return;
  call = undefined;
  clearTimeout(session.pollTimer);
  closeTranslator(session);
  session.pendingChat.clear();
  stopCaptions();
  session.peer?.close();
  session.stream.getTracks().forEach(track => track.stop());
  request('/' + session.id + '/leave', { token: session.token, method: 'POST', keepalive: true }).catch(() => {});
  ui.local.srcObject = ui.remote.srcObject = null;
  ui.remote.muted = false;
  ui.speaker.setAttribute('aria-pressed', 'true');
  ui.self.hidden = true;
  ui.history.replaceChildren();
  ui['chat-messages'].replaceChildren();
  ui['chat-input'].value = '';
  unreadChat = 0;
  ui['chat-label'].textContent = t('Chat');
  openChat(false);
  updateChatAvailability();
  inviteId = null;
  if (invited) history.replaceState(null, '', location.pathname);
  activateControls(false);
  get('interface-language').disabled = false;
  contactExchangeStatus('');
  lobby();
  status(message, state);
  if (contactState) {
    renderContacts(contactState);
    refreshContacts();
  }
}

async function start({ contact, incoming } = {}) {
  if (call || ui.start.disabled) return;
  ui.start.disabled = true;
  get('interface-language').disabled = true;
  if (contactState) renderContacts(contactState);
  status(t('Requesting camera and microphone'));
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('Camera and microphone require HTTPS or localhost.'));
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const info = incoming
      ? await contactsRequest('/accept', { room: incoming.room })
      : await request(!contact && inviteId ? '/' + encodeURIComponent(inviteId) + '/join' : '', { method: 'POST' });
    const session = { ...info, stream, candidates: [], cursor: 0, outbound: Promise.resolve(), pendingChat: new Map(), remoteCamera: true };
    session.contact = contact;
    session.incoming = incoming;
    session.checkRingAt = 0;
    call = session;
    if (contact) await contactsRequest('/ring', { code: contact.code, room: session.id, hostToken: session.token });
    const peer = session.peer = new RTCPeerConnection({ iceServers: info.iceServers });
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    peer.ontrack = event => { ui.remote.srcObject = event.streams[0]; };
    peer.ondatachannel = event => connectChannel(session, event.channel);
    peer.onicecandidate = event => {
      if (event.candidate && call === session) signal(session, 'candidate', event.candidate.toJSON()).catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      if (call !== session) return;
      if (peer.connectionState === 'failed') return leave(t('Could not connect the video call.'), 'error');
      if (peer.connectionState === 'disconnected') status(t('Reconnecting'));
      if (peer.connectionState === 'connected') {
        status(t('In call'), 'live');
        showRemote(session);
      }
    };
    ui.local.srcObject = stream;
    ui.self.hidden = false;
    ui.start.hidden = true;
    get('join-link').hidden = true;
    ui.mic.setAttribute('aria-pressed', 'true');
    ui.camera.setAttribute('aria-pressed', 'true');
    ui.remote.muted = false;
    ui.speaker.setAttribute('aria-pressed', 'true');
    activateControls(true);
    ui['stage-title'].textContent = contact ? t('Calling {name}', { name: contact.label }) : info.role === 'host' ? t('Waiting for someone to join') : t('Connecting…');
    ui['stage-description'].textContent = contact ? t('Waiting for your contact to accept.') : info.role === 'host' ? t('Copy the invite link and send it to your call partner.') : t('Establishing the video call.');
    status(contact ? t('Ringing') : info.role === 'host' ? t('Waiting for guest') : t('Connecting'));
    poll(session);
  } catch (error) {
    const message = error.name === 'NotAllowedError' ? t('Allow camera and microphone access to continue.')
      : error.name === 'NotFoundError' ? t('A camera and microphone are required.') : error.message;
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
    get('interface-language').disabled = Boolean(call);
    if (contactState) renderContacts(contactState);
  }
}

function captionStatus(message) {
  ui['caption-status'].textContent = message;
}

function stopCaptions(message = t('Turn on captions during the call.')) {
  const current = captionSession;
  captionSession = undefined;
  if (current?.recognition?.destroy) current.recognition.destroy();
  else current?.recognition?.abort();
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
    const model = current.call.translation;
    if (locale === current.source && model?.source === languageCode(locale) && model.target === languageCode(current.target) && model.translator) {
      try {
        display = await model.translator.translate(text);
        label = languages[current.target];
      } catch {
        label = t('{sender} · {language}', { sender: label, language: t('Original') });
        if (!current.speechFailed) captionStatus(t('Translation failed for this phrase. Showing the original caption.'));
      }
    } else if (locale.split('-')[0] !== current.target.split('-')[0]) {
      if (locale !== current.source && !current.speechFailed) captionStatus(t('The speaker’s language changed. Turn captions off, update “They speak”, and turn captions back on.'));
      label = t('{sender} · {language}', { sender: label, language: t('Original') });
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
    if (captionSession === current) captionStatus(t('A caption could not be translated. Listening for the next phrase.'));
  });
}

function listen(current) {
  if (!current.recognition || current.speechFailed || current.listening || !current.call.stream.getAudioTracks()[0].enabled) return;
  try {
    if (current.localSpeech) current.recognition.start(current.call.stream.getAudioTracks()[0]);
    else current.recognition.start();
    current.listening = true;
  } catch {
    speechUnavailable(current, t('could not start'));
  }
}

function speechUnavailable(current, reason) {
  current.speechFailed = true;
  const retry = android ? t('Turn captions off and back on to retry.') : t('Open the call in Google Chrome and turn captions on to retry.');
  captionStatus(t('Your speech could not be transcribed ({reason}). Incoming captions are still on.', { reason: t(reason) }) + ' ' + retry);
}

async function prepareLocalSpeech(Recognition, locale) {
  if (!Recognition?.available || !Recognition.install || !('processLocally' in Recognition.prototype)) return false;
  const options = { langs: [locale], processLocally: true, quality: 'conversation' };
  try {
    const availability = await Recognition.available(options);
    if (availability === 'available') return true;
    if (availability === 'unavailable') return false;
    return await Recognition.install(options);
  } catch {
    return false;
  }
}

async function prepareTranslation(current, source, target) {
  if (source === target) return;
  const translator = await getTranslator(current.call, source, target);
  current.translationUnavailable = !translator;
}

async function toggleCaptions() {
  if (!call) return;
  if (captionSession) return stopCaptions(t('Captions are off.'));
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
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
    captionStatus(t('Preparing captions. This may download language packs.'));
    current.translationReady = prepareTranslation(current, sourceLanguage, targetLanguage);
    const onText = text => {
      if (captionSession !== current || !current.call.stream.getAudioTracks()[0].enabled) return;
      if (!text.trim()) return;
      if (current.call.channel?.readyState !== 'open') {
        return captionStatus(t('Your microphone is transcribing. Waiting for the call connection to send captions.'));
      }
      sendCaption(current.call, { type: 'caption', locale: current.spoken, text: text.slice(0, 600) });
      current.sentCaption = true;
      captionStatus(t('Your speech was sent as a caption. Waiting for your partner’s next phrase.'));
    };
    const onError = error => {
      if (captionSession === current && !['no-speech', 'aborted'].includes(error)) {
        speechUnavailable(current, error);
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
        onready() {
          if (captionSession === current && !current.sentCaption) {
            captionStatus(t('Android speech recognition is ready. Speak a short phrase, then pause.'));
          }
        },
        onresult: onText, onerror: onError, onend: onEnd,
      });
    } else if (Recognition) {
      const recognition = current.recognition = new Recognition();
      current.localSpeech = await prepareLocalSpeech(Recognition, current.spoken);
      if (captionSession !== current) return;
      if (current.localSpeech) recognition.processLocally = true;
      recognition.lang = current.spoken;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onaudiostart = () => {
        if (captionSession === current && !current.sentCaption) captionStatus(t('Microphone active. Speak a short phrase, then pause.'));
      };
      recognition.onspeechstart = () => {
        if (captionSession === current && !current.sentCaption) captionStatus(t('Speech detected. Waiting for a complete phrase.'));
      };
      recognition.onresult = event => {
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (result.isFinal) onText(result[0].transcript);
          else if (captionSession === current && result[0].transcript.trim()) {
            captionStatus(t('Speech recognized: {text}', { text: result[0].transcript.slice(0, 100) }));
          }
        }
      };
      recognition.onerror = event => onError(event.error);
      recognition.onend = onEnd;
    }
    if (!current.recognition) speechUnavailable(current, t('unsupported browser'));
    else {
      captionStatus(android ? t('Starting Android speech recognition…') : t('Starting speech recognition…'));
      current.translationReady.then(() => {
        if (captionSession === current && !current.speechFailed && current.translationUnavailable) {
          if (!current.sentCaption) captionStatus(t('Translation is unavailable. Incoming captions will show the original language.'));
        }
      });
    }
    sendCaption(current.call, { type: 'language', locale: current.spoken });
    listen(current);
  } catch (error) {
    if (captionSession === current) speechUnavailable(current, error.message || t('setup failed'));
  }
}

ui['chat-toggle'].addEventListener('click', () => openChat(ui['chat-panel'].hidden));
get('add-call-contact').addEventListener('click', requestCallContact);
get('accept-contact').addEventListener('click', acceptCallContact);
get('decline-contact').addEventListener('click', () => {
  if (!call?.contactOffer) return;
  sendCaption(call, { type: 'contact-decline', id: call.contactOffer.id });
  call.contactOffer = undefined;
  contactExchangeStatus(call.contactRequest ? t('Contact request sent. Waiting for your call partner.') : '');
});
ui['chat-input'].addEventListener('input', updateChatAvailability);
for (const select of [ui.source, ui.target]) {
  select.addEventListener('change', () => {
    if (!ui['chat-panel'].hidden) prepareChat();
  });
}
ui['chat-form'].addEventListener('submit', handleChatSubmit);
ui.start.addEventListener('click', () => start());
ui.end.addEventListener('click', () => leave(t('You left the call')));
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
    ui.invite.textContent = t('Invite copied');
  } catch {
    window.prompt(t('Copy this invite link'), url.href);
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
ui.speaker.addEventListener('click', () => {
  ui.remote.muted = !ui.remote.muted;
  ui.speaker.setAttribute('aria-pressed', String(!ui.remote.muted));
});
get('join-link').addEventListener('click', () => {
  const link = window.prompt(t('Paste your ChatLingua invite link'));
  if (!link) return;
  try {
    const url = new URL(link);
    if (url.origin !== location.origin || url.pathname !== '/' || !/^[a-f0-9]{36}$/.test(url.searchParams.get('room'))) throw new Error();
    location.assign(url.href);
  } catch {
    status(t('Enter an invite link for this ChatLingua site.'), 'error');
  }
});
window.addEventListener('pagehide', () => leave(t('You left the call')));
lobby();
setupContacts();
