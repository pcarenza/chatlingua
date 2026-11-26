// Ringtone (WebAudio two-tone ring), vibration and desktop notification for an incoming call.
export function createRinger({ android, t, onNotificationClick }) {
  let context;
  let timer;
  let expiryTimer;
  let current;
  let nodes = [];
  let notification;
  let master;

  const audioContext = () => {
    if (!context) {
      try { context = new (globalThis.AudioContext || globalThis.webkitAudioContext)(); } catch { return undefined; }
    }
    return context;
  };
  // Browsers block audio until a gesture; resume the context on the first one so later rings can sound.
  const unlock = () => { const audio = audioContext(); if (audio?.state === 'suspended') audio.resume().catch(() => {}); };
  for (const type of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, unlock, { passive: true });

  function burst() {
    const audio = audioContext();
    if (audio?.state === 'suspended') audio.resume().catch(() => {});
    if (audio?.state === 'running') {
      if (!master) { master = audio.createGain(); master.gain.value = 0.18; master.connect(audio.destination); }
      const start = audio.currentTime + 0.02;
      // Classic ring: 440 Hz + 480 Hz, two 0.4 s bursts, then silence.
      for (const [from, length] of [[0, 0.4], [0.6, 0.4]]) {
        const envelope = audio.createGain();
        envelope.gain.setValueAtTime(0, start + from);
        envelope.gain.linearRampToValueAtTime(1, start + from + 0.02);
        envelope.gain.setValueAtTime(1, start + from + length - 0.03);
        envelope.gain.linearRampToValueAtTime(0, start + from + length);
        envelope.connect(master);
        for (const frequency of [440, 480]) {
          const oscillator = audio.createOscillator();
          oscillator.frequency.value = frequency;
          oscillator.connect(envelope);
          oscillator.start(start + from);
          oscillator.stop(start + from + length + 0.05);
          oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); nodes = nodes.filter(node => node !== oscillator); };
          nodes.push(oscillator);
        }
      }
    }
    try { navigator.vibrate?.([400, 200, 400]); } catch {}
  }

  function stop() {
    if (!current) return;
    const { room } = current;
    current = undefined;
    clearInterval(timer);
    clearTimeout(expiryTimer);
    for (const oscillator of nodes) { try { oscillator.stop(); } catch {} }
    nodes = [];
    try { navigator.vibrate?.(0); } catch {}
    notification?.close();
    notification = undefined;
    if (android?.stopRinging) { try { android.stopRinging(); } catch {} }
    else navigator.serviceWorker?.getRegistration?.().then(registration => registration?.getNotifications({ tag: 'ring-' + room }))
      .then(list => list?.forEach(item => item.close())).catch(() => {});
  }

  function start({ room, label }) {
    if (current?.room === room) return;
    stop();
    current = { room };
    let nativeSound = false;
    if (android?.ringIncoming) {
      try { nativeSound = android.ringIncoming(label, room) === true; } catch {}
    } else if (document.hidden && globalThis.Notification?.permission === 'granted') {
      try {
        notification = new Notification(t('Incoming call from {name}', { name: label }), {
          tag: 'ring-' + room, requireInteraction: true, renotify: true, body: 'ChatLingua',
        });
        notification.onclick = () => { window.focus(); onNotificationClick?.(room); notification?.close(); };
      } catch {}
    }
    if (!nativeSound) {
      burst();
      timer = setInterval(burst, 3000);
    }
    // Ring lifetime is 45 s server-side; use a local timer rather than comparing against the server clock.
    expiryTimer = setTimeout(stop, 46_000);
  }

  return { start, stop };
}
