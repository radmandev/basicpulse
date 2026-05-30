// ─── State ────────────────────────────────────────────────────────────────────

let conversations = [];
let activeId = null;
let searchQuery = '';
let channelFilter = 'all';
let wsAlive = false;
let replySending = false;

// ─── DOM ──────────────────────────────────────────────────────────────────────

const convList     = document.getElementById('conv-list');
const convEmpty    = document.getElementById('conv-empty');
const noConv       = document.getElementById('no-conv');
const threadHeader = document.getElementById('thread-header');
const msgPane      = document.getElementById('msg-pane');
const replyBar     = document.getElementById('reply-bar');
const replyInput   = document.getElementById('reply-input');
const replySendBtn = document.getElementById('reply-send');
const connDot      = document.getElementById('conn-dot');
const searchInput  = document.getElementById('search-input');

// ─── Channel config ───────────────────────────────────────────────────────────

const CHANNELS = {
  whatsapp: {
    color: '#25D366', bg: '#dcfce7',
    icon: `<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>`,
  },
  telegram: {
    color: '#229ED9', bg: '#dbeafe',
    icon: `<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>`,
  },
  instagram: {
    color: '#E1306C', bg: '#fce7f3',
    icon: `<path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>`,
  },
};

function channelMeta(ch) {
  return CHANNELS[(ch || '').toLowerCase()] || {
    color: '#7a8293', bg: '#f1f2f4',
    icon: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  };
}

function channelBadge(ch) {
  const { color, bg, icon } = channelMeta(ch);
  return `<span class="ch-badge" style="color:${color};background:${bg}">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">${icon}</svg>
    ${escHtml(ch || 'unknown')}
  </span>`;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    wsAlive = true;
    connDot.classList.add('connected');
    connDot.title = 'Connected';
  });

  ws.addEventListener('close', () => {
    wsAlive = false;
    connDot.classList.remove('connected');
    connDot.title = 'Disconnected — polling…';
    setTimeout(connectWS, 3000);
  });

  ws.addEventListener('message', e => {
    const data = JSON.parse(e.data);
    if (data.type === 'new_message') handleNewMessage(data.message, data.conversation);
  });
}

// ─── Data ─────────────────────────────────────────────────────────────────────

async function loadConversations() {
  const res = await fetch('/api/conversations');
  const fresh = await res.json();

  fresh.forEach(fc => {
    const idx = conversations.findIndex(c => c.id === fc.id);
    if (idx >= 0) {
      const prev = conversations[idx];
      conversations[idx] = fc.id === activeId ? { ...fc, unread: 0 } : fc;
      // Refresh open thread if a new message arrived for this conversation
      if (fc.id === activeId && fc.last_time !== prev.last_time) loadMessages(activeId);
    } else {
      conversations.unshift(fc);
      if (fc.unread > 0) showToast(`New message from ${fc.contact_name}`);
    }
  });

  conversations.sort((a, b) => b.last_time - a.last_time);
  renderConvList();
}

setInterval(() => { if (!wsAlive) loadConversations(); }, 4000);

async function loadMessages(convId) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages`);
  const messages = await res.json();

  const conv = conversations.find(c => c.id === convId);
  if (conv) conv.unread = 0;
  renderConvList();
  renderThread(convId, messages);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function getFiltered() {
  const q = searchQuery.toLowerCase();
  return conversations.filter(c => {
    const matchSearch = !q
      || c.contact_name.toLowerCase().includes(q)
      || (c.last_message || '').toLowerCase().includes(q)
      || (c.channel || '').toLowerCase().includes(q);
    const matchChannel = channelFilter === 'all' || (c.channel || '').toLowerCase() === channelFilter;
    return matchSearch && matchChannel;
  });
}

function renderChannelFilters() {
  const channels = [...new Set(conversations.map(c => (c.channel || '').toLowerCase()).filter(Boolean))];

  let el = document.getElementById('channel-filters');
  if (channels.length <= 1) {
    el?.remove();
    return;
  }

  if (!el) {
    el = document.createElement('div');
    el.id = 'channel-filters';
    el.className = 'channel-filters';
    document.querySelector('.sidebar-header').appendChild(el);
  }

  el.innerHTML = ['all', ...channels].map(ch => {
    const active = channelFilter === ch;
    const meta = ch !== 'all' ? channelMeta(ch) : null;
    const style = meta && active ? `background:${meta.bg};color:${meta.color};border-color:${meta.color}` : '';
    return `<button class="ch-filter${active ? ' active' : ''}" data-ch="${ch}" style="${style}">${ch === 'all' ? 'All' : ch}</button>`;
  }).join('');

  el.querySelectorAll('.ch-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      channelFilter = btn.dataset.ch;
      renderChannelFilters();
      renderConvList();
    });
  });
}

function renderConvList() {
  renderChannelFilters();
  const filtered = getFiltered();

  convList.innerHTML = '';
  if (filtered.length === 0) {
    convList.appendChild(convEmpty);
    return;
  }

  filtered.forEach(conv => {
    const el = document.createElement('div');
    el.className = 'conv-item' + (conv.id === activeId ? ' active' : '');
    const { color } = channelMeta(conv.channel);
    const initial = (conv.contact_name || '?')[0].toUpperCase();
    const timeStr = formatTime(conv.last_time);
    const badge = conv.unread > 0 ? `<span class="unread-badge">${conv.unread}</span>` : '';

    el.innerHTML = `
      <div class="avatar" style="background:${color}">${initial}</div>
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
      document.body.classList.add('conv-open');
      renderConvList();
      loadMessages(conv.id);
    });

    convList.appendChild(el);
  });
}

function renderThread(convId, messages) {
  const conv = conversations.find(c => c.id === convId);
  if (!conv) return;

  const { color } = channelMeta(conv.channel);

  noConv.style.display = 'none';
  threadHeader.style.display = 'flex';
  msgPane.style.display = 'flex';
  replyBar.style.display = 'flex';

  threadHeader.innerHTML = `
    <button class="back-btn" id="back-btn" title="Back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    </button>
    <div class="avatar" style="background:${color}">${(conv.contact_name || '?')[0].toUpperCase()}</div>
    <div class="thread-contact">
      <div class="contact-name">${escHtml(conv.contact_name)}</div>
      ${channelBadge(conv.channel)}
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => {
    document.body.classList.remove('conv-open');
    activeId = null;
    noConv.style.display = '';
    threadHeader.style.display = 'none';
    msgPane.style.display = 'none';
    replyBar.style.display = 'none';
    renderConvList();
  });

  msgPane.innerHTML = messages.length === 0
    ? '<div class="msg-empty">No messages yet</div>'
    : messages.map(renderBubble).join('');

  scrollToBottom();
}

function renderBubble(msg) {
  const t = Number(msg.ts);
  const time = new Date(t || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="msg-row ${msg.direction}">
      <div>
        <div class="bubble">${escHtml(msg.body)}</div>
        <div class="msg-time">${time}</div>
      </div>
    </div>
  `;
}

// ─── Real-time ────────────────────────────────────────────────────────────────

function handleNewMessage(message, updatedConv) {
  const idx = conversations.findIndex(c => c.id === updatedConv.id);
  if (idx >= 0) {
    conversations[idx] = updatedConv;
    if (updatedConv.id === activeId) conversations[idx].unread = 0;
  } else {
    conversations.unshift(updatedConv);
  }

  conversations.sort((a, b) => b.last_time - a.last_time);
  renderConvList();

  if (message.conversation_id === activeId) {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderBubble(message);
    msgPane.appendChild(tmp.firstElementChild);
    scrollToBottom();
    updatedConv.unread = 0;
  } else {
    showToast(`New message from ${updatedConv.contact_name}`);
  }
}

// ─── Reply ────────────────────────────────────────────────────────────────────

async function sendReply() {
  const text = replyInput.value.trim();
  if (!text || replySending || !activeId) return;

  replySending = true;
  replySendBtn.disabled = true;

  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(activeId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Failed to send');
      return;
    }

    replyInput.value = '';
    replyInput.style.height = 'auto';
  } catch {
    showToast('Network error — could not send');
  } finally {
    replySending = false;
    replySendBtn.disabled = false;
    replyInput.focus();
  }
}

replySendBtn.addEventListener('click', sendReply);
replyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});
replyInput.addEventListener('input', () => {
  replyInput.style.height = 'auto';
  replyInput.style.height = Math.min(replyInput.scrollHeight, 120) + 'px';
});

// ─── Search ───────────────────────────────────────────────────────────────────

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchInput.value.trim();
    renderConvList();
  }, 150);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scrollToBottom() {
  msgPane.scrollTop = msgPane.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
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
