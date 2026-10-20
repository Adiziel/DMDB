importScripts('parse.js', 'db.js');

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }));

// Last ingest result / error are kept for diagnostics (read them from the viewer page console:
// chrome.storage.local.get(['lastIngest','lastError'])).
const note = (key, val) => chrome.storage.local.set({ [key]: { ...val, at: Date.now() } }).catch(() => {});

// Rolling log of the last pages captured: how each was requested and what it claimed.
// Contains no message text. Read via chrome.storage.local.get('recent').
async function logRecent(entry) {
  try {
    const { recent = [] } = await chrome.storage.local.get('recent');
    recent.push({ ...entry, at: Date.now() });
    await chrome.storage.local.set({ recent: recent.slice(-40) });
  } catch (e) { /* diagnostics only */ }
}
const varFlags = v => !v ? null : Object.fromEntries(
  ['after', 'before', 'first', 'last', 'older_than_message_id', 'newer_than_message_id']
    .map(k => [k, v[k] == null ? null : (typeof v[k] === 'number' ? v[k] : 'set')]));

// Structure only (keys and value types), never values, for responses we couldn't parse.
function skeleton(o, depth = 0) {
  if (depth > 9) return '…';
  if (Array.isArray(o)) return o.length ? [skeleton(o[0], depth + 1), 'x' + o.length] : [];
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).slice(0, 30).map(k => [k, skeleton(o[k], depth + 1)]));
  return o === null ? 'null' : typeof o;
}
async function noteUnparsed(text, vars) {
  try {
    const line = String(text).split('\n').find(l => l.trim()[0] === '{');
    const { unparsed = [] } = await chrome.storage.local.get('unparsed');
    unparsed.push({ at: Date.now(), flags: varFlags(vars), shape: skeleton(JSON.parse(line)) });
    await chrome.storage.local.set({ unparsed: unparsed.slice(-4) });
  } catch (e) { /* diagnostics only */ }
}

async function ingest(text, vars, tabId) {
  const dir = pageDirection(vars);
  let pages;
  try { pages = parseResponse(text); } catch (e) { return note('lastError', { where: 'parse', msg: String((e && e.stack) || e).slice(0, 600) }); }
  if (!pages.length) noteUnparsed(text, vars);
  for (const page of pages) {
    try {
      const r = await ingestPage(page, dir);
      logRecent({ dir, flags: varFlags(vars), n: r.pageSize, added: r.added, hasNext: !r.reachedStart, chat: r.chatId.slice(-4) });
      note('lastIngest', { chat: r.chatId.slice(-4), n: r.pageSize, added: r.added, reachedStart: r.reachedStart, dir });
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'ingested', ...r }).catch(() => {});
    } catch (e) {
      note('lastError', { where: 'ingest', msg: String((e && e.stack) || e).slice(0, 600) });
    }
  }
}

// Rate limit for "Fetch from Instagram" (see quotaDecision). Persisted so reloads can't reset it.
async function quota(take) {
  const { quota: stamps = [], cooldownUntil = 0 } = await chrome.storage.local.get(['quota', 'cooldownUntil']);
  const now = Date.now();
  const d = quotaDecision(stamps, now, cooldownUntil);
  if (take && d.ok) {
    const live = [...d.live, now];
    await chrome.storage.local.set({ quota: live });
    return { ...d, remaining: QUOTA_MAX - live.length, live: undefined };
  }
  return { ...d, live: undefined };
}
// Instagram itself pushed back (HTTP 429 etc.): block further fetches for 10 minutes.
async function penalty() {
  const until = Date.now() + 10 * 60 * 1000;
  await chrome.storage.local.set({ cooldownUntil: until });
  return { until };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const reply = p => { p.then(send).catch(e => send({ error: String(e) })); return true; };
  switch (msg.type) {
    case 'ingest': ingest(msg.text, msg.vars, sender.tab && sender.tab.id); return false;
    case 'findChat': return reply(dbFindChat(msg.urlId));
    case 'getMessages': return reply(dbGetMessages(msg.chatId));
    case 'quota': return reply(quota(!!msg.take));
    case 'penalty': return reply(penalty());
    case 'window': return reply(dbGetWindow(msg.chatId, msg.id, msg.before, msg.after));
    case 'search': return reply(dbSearch(msg.source, msg.chatId));
    case 'openViewer':
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + (msg.chatId ? '#chat=' + msg.chatId : '') });
      return false;
  }
});
