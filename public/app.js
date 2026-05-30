// State
let conversations = [];
let activeId = null;

// DOM
const convList  = document.getElementById('conv-list');
const convEmpty = document.getElementById('conv-empty');
const thread    = document.getElementById('thread');
const noConv    = document.getElementById('no-conv');
const connDot   = document.getElementById('conn-dot');

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    connDot.classList.add('connected');
    connDot.title = 'Connected';
  });

  ws.addEventListener('close', () => {
    connDot.classList.remove('connected');
    connDot.title = 'Disconnected — reconnecting…';
    setTimeout(connectWS, 3000);
  });

  ws.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'new_message') {
      handleNewMessage(data.message, data.conversation);
    }
  });
}

// ─── Data ─────────────────────────────────────────────────────────────────────

async function loadConversations() {
  const res  = await fetch('/api/conversations');
  conversations = await res.json();
  renderConvList();
}

async function loadMessages(convId) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages`);
  const messages = await res.json();

  // Mark unread as 0 locally
  const conv = conversations.find(c => c.id === convId);
  if (conv) conv.unread = 0;
  renderConvList();

  renderThread(convId, messages);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderConvList() {
  convList.innerHTML = '';
  if (conversations.length === 0) {
    convList.appendChild(convEmpty);
    return;
  }

  conversations.forEach(conv => {
    const el = document.createElement('div');
    el.className = 'conv-item' + (conv.id === activeId ? ' active' : '');
    el.dataset.id = conv.id;

    const initial = (conv.contact_name || '?')[0].toUpperCase();
    const timeStr = formatTime(conv.last_time);
    const badge   = conv.unread > 0
      ? `<span class="unread-badge">${conv.unread}</span>`
      : '';

    el.innerHTML = `
      <div class="avatar">${initial}</div>
      <div class="conv-meta">
        <div class="conv-name">${escHtml(conv.contact_name)}</div>
        <div class="conv-preview">${escHtml(conv.last_message || '')}</div>
      </div>
      <div class="conv-right">
        <span class="conv-time">${timeStr}</span>
        ${badge}
      </div>
    `;

    el.addEventListener('click', () => {
      activeId = conv.id;
      renderConvList();
      loadMessages(conv.id);
    });

    convList.appendChild(el);
  });
}

function renderThread(convId, messages) {
  const conv = conversations.find(c => c.id === convId);
  if (!conv) return;

  thread.innerHTML = `
    <div class="thread-header">
      <div class="avatar">${(conv.contact_name || '?')[0].toUpperCase()}</div>
      <div class="contact-name">${escHtml(conv.contact_name)}</div>
      <span class="channel-tag">${escHtml(conv.channel)}</span>
    </div>
    <div class="messages" id="msg-pane">
      ${messages.map(renderBubble).join('')}
      ${messages.length === 0 ? '<div style="color:var(--muted);font-size:13px;text-align:center;margin-top:32px;">No messages yet</div>' : ''}
    </div>
  `;

  scrollToBottom();
}

function renderBubble(msg) {
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="msg-row ${msg.direction}">
      <div>
        <div class="bubble">${escHtml(msg.text)}</div>
        <div class="msg-time">${time}</div>
      </div>
    </div>
  `;
}

// ─── Real-time update ─────────────────────────────────────────────────────────

function handleNewMessage(message, updatedConv) {
  // Update or prepend conversation in local list
  const idx = conversations.findIndex(c => c.id === updatedConv.id);
  if (idx >= 0) {
    conversations[idx] = updatedConv;
    // Keep unread count if this isn't the active conversation
    if (updatedConv.id === activeId) conversations[idx].unread = 0;
  } else {
    conversations.unshift(updatedConv);
  }

  // Re-sort by last_time desc
  conversations.sort((a, b) => b.last_time - a.last_time);
  renderConvList();

  // If this conversation is open, append the bubble
  if (message.conversation_id === activeId) {
    const pane = document.getElementById('msg-pane');
    if (pane) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderBubble(message);
      pane.appendChild(tmp.firstElementChild);
      scrollToBottom();
    }
    // Mark as read immediately
    updatedConv.unread = 0;
  } else {
    showToast(`New message from ${updatedConv.contact_name}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scrollToBottom() {
  const pane = document.getElementById('msg-pane');
  if (pane) pane.scrollTop = pane.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const days = Math.floor((now - d) / 86400000);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadConversations();
connectWS();
