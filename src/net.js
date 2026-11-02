// WebSocket connection to the game server. Remembers your seat (code + token) for this tab,
// so a refresh or a wifi blip puts you straight back in your room.

const SESSION_KEY = 'tootraft.session';

export function createNet({ onMessage, onStatus }) {
  let ws = null;
  let wanted = false;
  let retry = 0;
  let queue = [];

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  function open() {
    wanted = true;
    if (ws && ws.readyState <= 1) return;
    onStatus('connecting');
    const sock = new WebSocket(url);
    ws = sock;
    ws.onopen = () => {
      retry = 0;
      onStatus('online');
      const saved = loadSession();
      if (saved) ws.send(JSON.stringify({ t: 'rejoin', code: saved.code, token: saved.token }));
      for (const m of queue) ws.send(m);
      queue = [];
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') saveSession({ code: msg.code, token: msg.token });
      onMessage(msg);
    };
    ws.onclose = () => {
      if (ws !== sock) return; // an old connection closing after a new one has started
      ws = null;
      if (!wanted) return onStatus('offline');
      onStatus('reconnecting');
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 300 * 2 ** retry);
    };
  }

  function send(msg) {
    const data = JSON.stringify(msg);
    if (ws && ws.readyState === 1) ws.send(data);
    else if (msg.t !== 'input') queue.push(data); // inputs are only useful live
    if (!ws) open();
  }

  function close() {
    wanted = false;
    clearSession();
    if (ws) ws.close();
  }

  return { open, send, close, hasSession: () => !!loadSession(), clearSession };
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}
function saveSession(s) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {}
}
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}
