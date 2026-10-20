// IndexedDB layer shared by the service worker and the viewer page.
// Messages are only ever added or merged, never removed automatically.
const DB_NAME = 'igvault';

const prom = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('chats', { keyPath: 'id' });
      const m = db.createObjectStore('messages', { keyPath: 'id' });
      m.createIndex('chatTs', ['chatId', 'ts']);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

let dbp = null;
const getDB = () => (dbp ||= openDB());

function chatTitle(thread, old) {
  if (old && old.nameLocked) return old.title;
  const others = Object.entries(thread.users)
    .filter(([id]) => id !== thread.viewerFbid)
    .map(([, u]) => userDisplay(u)).filter(Boolean);
  // Groups have their own name; in a 1:1 chat show what Instagram shows: your nickname
  // for the person, else their name.
  if (thread.isGroup && thread.title) return thread.title;
  return others.join(', ') || thread.title || (old && old.title) || thread.id;
}

// page: one entry from parseResponse(). Returns stats the UI uses to decide
// when a backup has reached the beginning or caught up with what we already had.
async function ingestPage(page, dir = 'unknown') {
  const trusted = dir === 'open' || dir === 'older'; // only these report on OLDER history
  const db = await getDB();
  const tx = db.transaction(['chats', 'messages'], 'readwrite');
  const cs = tx.objectStore('chats'), ms = tx.objectStore('messages');
  const finished = done(tx);

  const old = (await prom(cs.get(page.thread.id))) || null;
  let added = 0;
  for (const inc of page.messages) {
    const prev = (await prom(ms.get(inc.id))) || null;
    if (!prev) added++;
    ms.put(mergeMessage(prev, inc));
  }
  const th = page.thread;
  const chat = {
    id: th.id,
    threadId: th.threadId || (old && old.threadId) || null,
    title: chatTitle(th, old),
    nameLocked: !!(old && old.nameLocked),
    isGroup: page.hasThreadInfo ? th.isGroup : !!(old && old.isGroup),
    // thread info replaces each listed user wholesale (so a removed nickname disappears);
    // pagination pages carry no users and leave the stored ones alone
    users: page.hasThreadInfo ? { ...(old ? old.users : {}), ...th.users } : (old ? old.users : {}),
    viewerFbid: th.viewerFbid || (old && old.viewerFbid) || null,
    complete: !!(old && old.complete) || (trusted && !page.pageInfo.hasNext),
    updated: Date.now(),
    // Diagnostics: what the most recent page for this chat looked like.
    lastPage: {
      n: page.messages.length, added, hasNext: page.pageInfo.hasNext, dir,
      oldestTs: page.messages.length ? Math.min(...page.messages.map(m => m.ts)) : null,
      newestTs: page.messages.length ? Math.max(...page.messages.map(m => m.ts)) : null,
      at: Date.now(),
    },
  };
  const wasComplete = !!(old && old.complete);
  cs.put(chat);
  await finished;
  return {
    chatId: chat.id, threadId: chat.threadId, added,
    pageSize: page.messages.length, wasComplete, messages: page.messages,
    complete: chat.complete, reachedStart: trusted && !page.pageInfo.hasNext, dir,
  };
}

async function dbGetChats() {
  const db = await getDB();
  return prom(db.transaction('chats').objectStore('chats').getAll());
}

async function dbFindChat(urlId) {
  const chats = await dbGetChats();
  return chats.find(c => chatMatchesUrlId(c, urlId)) || null;
}

async function dbGetMessages(chatId) {
  const db = await getDB();
  const st = db.transaction('messages').objectStore('messages');
  if (chatId === '*') return (await prom(st.getAll())).sort((a, b) => a.ts - b.ts);
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Infinity]);
  return prom(st.index('chatTs').getAll(range));
}

async function dbRenameChat(id, title) {
  const db = await getDB();
  const tx = db.transaction('chats', 'readwrite');
  const st = tx.objectStore('chats');
  const c = await prom(st.get(id));
  if (c) st.put({ ...c, title, nameLocked: true });
  return done(tx);
}

async function dbDeleteChat(id) {
  const db = await getDB();
  const tx = db.transaction(['chats', 'messages'], 'readwrite');
  tx.objectStore('chats').delete(id);
  const ms = tx.objectStore('messages');
  const cur = ms.index('chatTs').openKeyCursor(IDBKeyRange.bound([id, 0], [id, Infinity]));
  cur.onsuccess = () => {
    const c = cur.result;
    if (c) { ms.delete(c.primaryKey); c.continue(); }
  };
  return done(tx);
}

// Phrase search across one chat or all chats; returns the newest matches plus the total.
async function dbSearch(source, chatId, limit = 60) {
  const re = new RegExp(source, 'i');
  const db = await getDB();
  const msgs = chatId ? await dbGetMessages(chatId) : await prom(db.transaction('messages').objectStore('messages').getAll());
  const titles = Object.fromEntries((await dbGetChats()).map(c => [c.id, c.title]));
  const hits = msgs.filter(m => m.text && re.test(m.text));
  hits.sort((a, b) => b.ts - a.ts);
  const chats = chatId ? [] : (await dbGetChats())
    .filter(c => chatAliases(c).some(a => re.test(a)))
    .slice(0, 5).map(c => ({ id: c.id, title: c.title, aliases: chatAliases(c).filter(a => a !== c.title) }));
  return {
    total: hits.length, chats,
    hits: hits.slice(0, limit).map(m => ({
      id: m.id, chatId: m.chatId, chat: titles[m.chatId] || '', ts: m.ts,
      text: m.text.slice(0, 220), unsent: !!m.unsent,
    })),
  };
}

// The conversation around one message (for the context view).
async function dbGetWindow(chatId, id, before = 25, after = 25) {
  const msgs = await dbGetMessages(chatId);
  const i = msgs.findIndex(m => m.id === id);
  if (i < 0) return { error: 'not-found' };
  const lo = Math.max(0, i - before), hi = Math.min(msgs.length, i + after + 1);
  const chat = (await dbGetChats()).find(c => c.id === chatId) || {};
  return {
    chat: { title: chat.title || '', users: chat.users || {}, viewerFbid: chat.viewerFbid || null, complete: !!chat.complete },
    msgs: msgs.slice(lo, hi), targetIdx: i - lo, hasEarlier: lo > 0, hasLater: hi < msgs.length, total: msgs.length,
  };
}
