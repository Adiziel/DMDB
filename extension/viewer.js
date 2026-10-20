const $ = id => document.getElementById(id);
let chats = [], cur = null, MSGS = [], chatById = {};
const WINDOW = 200;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const dayOf = ts => fmt(ts).slice(0, 10);

// Nickname (what Instagram shows) first, then real name, then @username.
function who(m) {
  const c = chatById[m.chatId];
  if (c && m.sender === c.viewerFbid) return 'Me';
  const u = c && c.users[m.sender];
  return (u && (u.nickname || u.name || u.username)) || m.senderName || 'Them';
}
// "Casey (Alex Doe · @alex_doe)" so the nickname is never confused with the real person.
function realNames(c) {
  return Object.entries(c.users || {}).filter(([id]) => id !== c.viewerFbid)
    .map(([, u]) => [u.nickname ? (u.name || u.username) : '', u.username ? '@' + u.username : ''].filter(Boolean).join(' · '))
    .filter(Boolean).join(', ');
}
const chatMatchesFilter = (c, f) => !f || [c.title, ...Object.values(c.users || {}).flatMap(u => [u.nickname, u.name, u.username])]
  .filter(Boolean).some(x => x.toLowerCase().includes(f));
const isMine = m => { const c = chatById[m.chatId]; return !!c && m.sender === c.viewerFbid; };

function body(m) {
  let t = m.text || '';
  if (!t && m.unsent) t = '[unsent message]';
  if (!t) t = `[${(m.type || 'attachment').toLowerCase().replace(/_/g, ' ')}]`;
  if (m.link && !t.includes(m.link)) t += (m.linkTitle ? `\n${m.linkTitle}` : '') + `\n${m.link}`;
  return t;
}

// Whole-phrase, case-insensitive; any whitespace run in the query matches any whitespace run in text.
function phraseRe(q, flags) {
  const src = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return src ? new RegExp(src, flags) : null;
}

function hl(text, q) {
  // match on the escaped text with the escaped query so the HTML stays valid
  const re = q ? phraseRe(esc(q), 'gi') : null;
  const h = esc(text);
  return re ? h.replace(re, x => `<mark>${x}</mark>`) : h;
}

async function loadChats(keepSel = true) {
  chats = (await dbGetChats()).sort((a, b) => b.updated - a.updated);
  chatById = Object.fromEntries(chats.map(c => [c.id, c]));
  const el = $('chats');
  el.innerHTML = '';
  const add = (id, name, sub) => {
    const d = document.createElement('div');
    d.className = 'chat' + (cur === id ? ' sel' : '');
    d.innerHTML = `${esc(name)}<small>${esc(sub)}</small>`;
    d.onclick = () => selectChat(id);
    el.appendChild(d);
  };
  add('*', 'All chats', 'search everything');
  const f = ($('cf') && $('cf').value || '').trim().toLowerCase();
  for (const c of chats) if (chatMatchesFilter(c, f)) add(c.id, c.title || c.id, [realNames(c), `${c.complete ? 'full history' : 'partial'} · ${new Date(c.updated).toLocaleDateString()}`].filter(Boolean).join(' — '));
  if (!chats.length) $('list').innerHTML = '<div class="empty">Nothing saved yet. Open Instagram DMs with the extension installed; chats are saved as they load.</div>';
}

async function selectChat(id, focusId) {
  cur = id;
  MSGS = await dbGetMessages(id);
  await loadChats();
  const c = chatById[id];
  const sel = $('who');
  sel.innerHTML = '<option value="">Anyone</option><option value="me">Me</option><option value="them">Others</option>';
  if (c && c.isGroup) for (const [fbid, u] of Object.entries(c.users)) if (fbid !== c.viewerFbid) sel.add(new Option(u.name || u.username || fbid, fbid));
  $('info').textContent = `${MSGS.length.toLocaleString()} messages` + (c ? (c.complete ? ' · full history saved' : ' · partial: scroll the chat on Instagram to save more') : '');
  if ($('q').value.trim()) search();
  else if (focusId) viewAround(MSGS.findIndex(m => m.id === focusId));
  else viewAround(MSGS.length - 1);
}

function pass(m, f) {
  if (f.who === 'me' && !isMine(m)) return false;
  if (f.who === 'them' && isMine(m)) return false;
  if (f.who && f.who !== 'me' && f.who !== 'them' && m.sender !== f.who) return false;
  if (f.kind === 'text' && (!m.text || m.type !== 'TEXT')) return false;
  if (f.kind === 'unsent' && !(m.unsent || (m.previousTexts && m.previousTexts.length))) return false;
  if (f.kind === 'shares' && !m.link) return false;
  const d = dayOf(m.ts);
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  return true;
}

function search() {
  if (cur == null) return;
  const q = $('q').value.trim();
  const re = phraseRe(q, 'i');
  const f = { who: $('who').value, kind: $('kind').value, from: $('from').value, to: $('to').value };
  const res = [];
  for (let i = 0; i < MSGS.length; i++) {
    const m = MSGS[i];
    if (!pass(m, f)) continue;
    const hay = (body(m) + '\n' + (m.previousTexts || []).join('\n')).toLowerCase();
    if (!re || re.test(hay)) res.push(i);
  }
  const shown = res.slice(-500).reverse();
  $('info').textContent = `${res.length.toLocaleString()} matches` + (res.length > 500 ? ' (showing newest 500)' : '');
  const list = $('list');
  list.innerHTML = '';
  if (!shown.length) { list.innerHTML = '<div class="empty">No matches.</div>'; return; }
  for (const i of shown) {
    const m = MSGS[i];
    const d = document.createElement('div');
    d.className = 'hit';
    const chat = cur === '*' ? ` · ${esc((chatById[m.chatId] || {}).title || m.chatId)}` : '';
    const flags = (m.unsent ? ' <span class="tag">unsent</span>' : '') + (m.previousTexts ? ' <span class="tag">edited</span>' : '');
    d.innerHTML = `<div class="meta">${fmt(m.ts)} · ${esc(who(m))}${chat}${flags}</div>${hl(body(m), q)}`;
    d.onclick = () => (cur === '*' ? selectChatAt(m) : viewAround(i));
    list.appendChild(d);
  }
}

async function selectChatAt(m) { $('q').value = ''; await selectChat(m.chatId, m.id); }

function viewAround(center) {
  const list = $('list');
  if (!MSGS.length) { list.innerHTML = '<div class="empty">No messages.</div>'; return; }
  let lo = Math.max(0, center - WINDOW), hi = Math.min(MSGS.length, center + WINDOW);
  const draw = () => {
    list.innerHTML = '';
    if (lo > 0) list.appendChild(more('Load earlier', () => { lo = Math.max(0, lo - WINDOW); draw(); }));
    let lastDay = '';
    for (let i = lo; i < hi; i++) {
      const m = MSGS[i];
      const day = dayOf(m.ts);
      if (day !== lastDay) { lastDay = day; const d = document.createElement('div'); d.className = 'day'; d.textContent = day; list.appendChild(d); }
      const r = document.createElement('div');
      r.className = 'row ' + (isMine(m) ? 'me' : 'them') + (i === center ? ' focus' : '');
      const q = m.replyText ? `<div class="quote">${esc(m.replyText)}</div>` : '';
      const flags = (m.unsent ? ' · unsent' : '') + (m.previousTexts ? ' · edited' : '') + (m.reactions && m.reactions.length ? ` · ${m.reactions.length} reaction(s)` : '');
      r.innerHTML = `<div class="b">${q}${esc(body(m))}</div><small>${fmt(m.ts)} · ${esc(who(m))}${flags}</small>`;
      list.appendChild(r);
    }
    if (hi < MSGS.length) list.appendChild(more('Load later', () => { hi = Math.min(MSGS.length, hi + WINDOW); draw(); }));
    const f = list.querySelector('.focus');
    if (f) f.scrollIntoView({ block: 'center' }); else list.scrollTop = list.scrollHeight;
  };
  draw();
}

function more(label, fn) {
  const d = document.createElement('div');
  d.className = 'more';
  const b = document.createElement('button'); b.textContent = label; b.onclick = fn;
  d.appendChild(b);
  return d;
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const refresh = () => ($('q').value.trim() || $('who').value || $('kind').value || $('from').value || $('to').value ? search() : viewAround(MSGS.length - 1));
$('q').oninput = () => cur != null && refresh();
$('cf').oninput = () => loadChats();
for (const id of ['who', 'kind', 'from', 'to']) $(id).onchange = () => cur != null && refresh();
$('view').onclick = () => { $('q').value = ''; viewAround(MSGS.length - 1); };
const slug = () => ((chatById[cur] || {}).title || 'all-chats').replace(/[^\w-]+/g, '_');
$('expjson').onclick = () => cur && download(`${slug()}.json`, JSON.stringify(MSGS.map(m => ({ ...m, time: fmt(m.ts), from: who(m) })), null, 1), 'application/json');
$('expcsv').onclick = () => {
  if (!cur) return;
  const q = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const rows = ['chat,time,from,unsent,text', ...MSGS.map(m => [q((chatById[m.chatId] || {}).title), q(fmt(m.ts)), q(who(m)), m.unsent ? 1 : 0, q(body(m))].join(','))];
  download(`${slug()}.csv`, rows.join('\n'), 'text/csv');
};
$('exptxt').onclick = () => cur && download(`${slug()}.txt`, MSGS.map(m => `[${fmt(m.ts)}] ${who(m)}: ${body(m)}`).join('\n'), 'text/plain');
$('rename').onclick = async () => {
  if (!cur || cur === '*') return;
  const n = prompt('Chat name', (chatById[cur] || {}).title);
  if (n) { await dbRenameChat(cur, n); loadChats(); }
};
$('del').onclick = async () => {
  if (!cur || cur === '*') return;
  if (confirm(`Permanently delete the saved copy of "${(chatById[cur] || {}).title}" from this extension? This cannot be undone. Instagram itself is not affected.`)) {
    await dbDeleteChat(cur); cur = null; MSGS = []; $('list').innerHTML = ''; loadChats();
  }
};

loadChats().then(() => {
  const m = location.hash.match(/chat=([^&]+)/);
  if (m) selectChat(decodeURIComponent(m[1]));
});
