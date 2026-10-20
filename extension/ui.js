// In-page UI (isolated world): control panel, "scroll to start" driver,
// exact-timestamp overlay and search highlights.
//
// Message DATA comes only from captured network responses (see inject.js).
// The page is read in one place: matching on-screen bubbles to stored messages
// so we know where to draw a timestamp or a highlight. Nothing in Instagram's
// DOM is modified; labels live in our own overlay layer and highlights use the
// CSS Custom Highlight API.
(() => {
  if (window.__igvUI) return;
  window.__igvUI = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = msg => new Promise(res => {
    try { chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? null : r)); } catch (e) { res(null); }
  });
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const urlId = () => (location.pathname.match(/\/direct\/t\/([^/]+)/) || [])[1] || null;
  const pad = n => String(n).padStart(2, '0');
  const fmt = ts => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const S = {
    id: null, chat: null,
    msgs: new Map(),          // message id -> message
    list: [], index: new Map(), dirty: true, version: 0,
    showTs: true, query: '',
    running: false, stop: false,
    cache: new WeakMap(),     // leaf element -> {text, version, msg}
    hits: [], cur: -1,
    results: [], total: 0, chatHits: [],
  };
  try { chrome.storage.local.get({ showTs: true }, v => { S.showTs = v.showTs; paint(); }); } catch (e) {}

  // ---------------------------------------------------------------- data
  function rebuild() {
    S.list = [...S.msgs.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    // Only text messages have a bubble we can match by text, so index just those;
    // photos/reels/shares in between don't widen the gap between neighbours.
    S.tlist = S.list.filter(m => m.text);
    S.index = new Map();
    S.tlist.forEach((m, i) => {
      const k = norm(m.text);
      (S.index.get(k) || S.index.set(k, []).get(k)).push(i);
    });
    S.pos = new Map(S.list.map((m, i) => [m.id, i]));
    S.dirty = false; S.version++;
  }

  function addMessages(arr) {
    for (const m of arr) {
      const old = S.msgs.get(m.id);
      S.msgs.set(m.id, old && old.text && !m.text ? { ...m, text: old.text, unsent: true } : m);
    }
    S.dirty = true;
  }

  async function loadChat() {
    const id = urlId();
    S.id = id; S.chat = null; S.msgs = new Map(); S.dirty = true; S.hits = []; S.cur = -1;
    if (!id) return paint();
    const chat = await send({ type: 'findChat', urlId: id });
    if (urlId() !== id) return;
    if (chat) {
      S.chat = chat;
      const arr = (await send({ type: 'getMessages', chatId: chat.id })) || [];
      if (urlId() === id) addMessages(arr);
    }
    paint(); schedule();
  }

  const matchesThis = ev => !!S.id && (ev.chatId === S.id || ev.threadId === S.id || (S.chat && ev.chatId === S.chat.id));
  const waiters = [];

  chrome.runtime.onMessage.addListener(msg => { if (msg.type === 'ingested') handleIngested(msg); });

  async function handleIngested(ev) {
    // The URL id may be a participant id rather than the thread id, so (re)resolve the chat.
    if (!S.chat && S.id) {
      const c = await send({ type: 'findChat', urlId: S.id });
      if (c) {
        S.chat = c;
        addMessages((await send({ type: 'getMessages', chatId: c.id })) || []);
      }
    }
    if (!matchesThis(ev)) return;
    addMessages(ev.messages || []);
    paint(); schedule();
    while (waiters.length) waiters.shift()(ev);
  }

  const waitIngest = ms => new Promise(res => {
    const t = setTimeout(() => { const i = waiters.indexOf(fn); if (i >= 0) waiters.splice(i, 1); res(null); }, ms);
    const fn = ev => { clearTimeout(t); res(ev); };
    waiters.push(fn);
  });

  // ------------------------------------------------------ finding the pane
  // Class names are obfuscated; rely on structure: the message list is the
  // scrollable box (overflow auto/scroll, even if not overflowing yet) furthest
  // to the right that contains text.
  function findPane() {
    if (!urlId()) return null;
    let best = null, bestLeft = -1, bestN = 0;
    for (const el of document.querySelectorAll('div')) {
      if (el.clientHeight < 200) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300) continue;
      const n = el.querySelectorAll('[dir="auto"]').length;
      if (!n) continue;
      if (r.left > bestLeft + 20 || (Math.abs(r.left - bestLeft) <= 20 && n > bestN)) { best = el; bestLeft = r.left; bestN = n; }
    }
    return best;
  }
  let pane = null;
  const getPane = () => (pane && pane.isConnected ? pane : (pane = findPane()));

  // ------------------------------------------------ backup / scroll driver
  // Instagram's message pane is a column-reverse flex box: the newest message is
  // at scrollTop 0 and older ones are at NEGATIVE scrollTop. Scrolling to a huge
  // negative value clamps to the oldest loaded message in either layout.
  const toTop = p => { p.scrollTop = -p.scrollHeight; };
  const nearTop = p => { p.scrollTop = -(p.scrollHeight - p.clientHeight) + 60; };
  const toBottom = p => { p.scrollTop = p.scrollTop < 0 || p.scrollHeight <= p.clientHeight ? 0 : p.scrollHeight; };
  async function scrollLoop() {
    if (S.running) return;
    const p = getPane();
    if (!p) return setStatus('Open a chat first.');
    S.running = true; S.stop = false; paint();
    const wasComplete = !!(S.chat && S.chat.complete);
    let result = '', lastActive = Date.now(), quiet = 0;
    const STALL_MS = 90000; // give up after this long with no new page and no growth
    setStatus('Scrolling up…');
    while (!S.stop) {
      const pn = getPane();
      if (!pn) { result = 'Chat pane lost.'; break; }
      // Instagram keeps loaded messages in memory and renders them into the pane
      // progressively, so growth of the pane counts as activity just like a
      // network page does.
      const h0 = pn.scrollHeight;
      const evP = waitIngest(6000);
      // After a quiet round, scroll well away first so Instagram's top-of-list
      // loader sees the list leave and re-enter view and fires again.
      if (quiet) { pn.scrollTop = -(pn.scrollHeight - pn.clientHeight) + 800 + quiet * 200; await sleep(400); }
      nearTop(pn); await sleep(80); toTop(pn);
      let ev = null, grew = false;
      for (let t = 0; t < 24 && !ev && !grew && !S.stop; t++) {
        ev = await Promise.race([evP, sleep(250).then(() => null)]);
        grew = (getPane() || pn).scrollHeight !== h0;
      }
      if (!ev && grew) ev = await Promise.race([evP, sleep(900).then(() => null)]);
      if (ev || grew) { lastActive = Date.now(); quiet = 0; } else {
        quiet++;
        if (Date.now() - lastActive > STALL_MS) { result = 'No more history loaded.'; break; }
      }
      if (ev && ev.complete && S.chat) S.chat.complete = true;
      if (ev) {
        if (ev.reachedStart) { result = 'Reached the start of the chat.'; break; }
        if (wasComplete && ev.pageSize > 0 && ev.added === 0) { result = 'Caught up: nothing new.'; break; }
      }
      setStatus(`Scrolling up… ${S.msgs.size} messages saved`);
      await sleep(1200 + Math.random() * 1300); // gentle, human-ish pace
    }
    S.running = false;
    setStatus((S.stop ? 'Stopped. ' : result + ' ') + `${S.msgs.size} messages in backup.`);
    paint();
    const pn = getPane();
    if (pn) toBottom(pn);
    return result;
  }

  // ------------------------------------------- matching bubbles to messages
  function upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  const MAXGAP = 12;

  // leaves: DOM order (oldest -> newest). Returns idx (into S.tlist) or -1 per leaf.
  // A single anchor can be a false friend (UI text equal to some old message), so
  // try the few least-ambiguous leaves as anchors and keep the alignment that
  // explains the most leaves.
  function align(texts) {
    const cands = texts.map(t => S.index.get(t) || []);
    const out = new Array(texts.length).fill(-1);
    const anchors = cands.map((c, i) => [c.length, i]).filter(x => x[0]).sort((x, y) => x[0] - y[0]).slice(0, 6).map(x => x[1]);
    let best = null;
    for (const a of anchors) {
      for (const c0 of cands[a].slice(-30)) {
        const asg = new Map([[a, c0]]);
        let p = c0;
        for (let i = a + 1; i < texts.length; i++) {
          const c = cands[i]; const k = upperBound(c, p);
          if (k < c.length && c[k] <= p + MAXGAP) { p = c[k]; asg.set(i, p); }
        }
        p = c0;
        for (let i = a - 1; i >= 0; i--) {
          const c = cands[i]; const k = lowerBound(c, p) - 1;
          if (k >= 0 && c[k] >= p - MAXGAP) { p = c[k]; asg.set(i, p); }
        }
        if (!best || asg.size > best.size || (asg.size === best.size && c0 > best.c0)) { asg.c0 = c0; best = asg; }
      }
    }
    if (best) best.forEach((idx, i) => { out[i] = idx; });
    return out;
  }

  const leafTexts = root =>
    [...root.querySelectorAll('[dir="auto"]')].filter(el => !el.querySelector('[dir="auto"]') && (el.textContent.trim() || el.querySelector('img[alt]')));

  // Instagram renders emoji as <img alt="😂">, so textContent alone drops them.
  function textOf(el) {
    let out = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out += n.nodeType === 3 ? n.data : (n.tagName === 'IMG' ? n.alt || '' : '');
    return out;
  }

  // --------------------------------------------------------------- overlay
  const host = document.createElement('div');
  host.id = 'igv-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      .lbl { position:absolute; font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; color:#8e8e8e; white-space:nowrap; pointer-events:none; }
      .lbl.un { color:#e0245e; }
      #panel { position:fixed; right:14px; bottom:14px; width:260px; pointer-events:auto; font:12px system-ui,sans-serif;
        background:Canvas; color:CanvasText; border:1px solid #8886; border-radius:10px; box-shadow:0 4px 18px #0004; padding:8px; }
      #panel.min { width:auto; padding:4px 10px; cursor:pointer; }
      #panel.min > :not(.t) { display:none; }
      .t { font-weight:600; display:flex; justify-content:space-between; align-items:center; gap:10px; }
      .t span { cursor:pointer; opacity:.6; }
      #st { margin:6px 0; min-height:30px; opacity:.85; }
      button { font:inherit; padding:5px 8px; margin:2px 2px 0 0; border-radius:6px; border:1px solid #8886; background:#8881; color:inherit; cursor:pointer; }
      button.p { background:#3b6ef5; border-color:#3b6ef5; color:#fff; }
      button:disabled { opacity:.4; cursor:default; }
      input[type=search] { width:100%; box-sizing:border-box; padding:5px 7px; margin-top:6px; border-radius:6px; border:1px solid #8886; background:transparent; color:inherit; font:inherit; }
      label { display:flex; gap:6px; align-items:center; margin-top:6px; }
      #cnt { opacity:.7; margin-top:3px; }
      select { font:inherit; padding:3px; border-radius:6px; border:1px solid #8886; background:transparent; color:inherit; }
      #res { max-height:190px; overflow:auto; margin-top:4px; }
      .hit { padding:4px 6px; margin-top:3px; border:1px solid #8883; border-radius:6px; cursor:pointer; font-size:11px; overflow-wrap:anywhere; }
      .hit:hover { background:#8882; }
      .hit small { display:block; opacity:.65; }
      mark { background:#ffd54acc; color:#000; border-radius:2px; }
      .flash { position:absolute; border:2px solid #ff9100; border-radius:12px; box-shadow:0 0 0 3px #ff910055; pointer-events:none; animation:pulse 1s ease-in-out infinite; }
      [hidden] { display:none !important; }
      #ctx { position:fixed; inset:0; background:#0008; pointer-events:auto; display:flex; align-items:center; justify-content:center; z-index:1; font:13px system-ui,sans-serif; }
      .ctxbox { width:min(640px,94vw); height:min(82vh,780px); background:Canvas; color:CanvasText; border-radius:14px; display:flex; flex-direction:column; box-shadow:0 12px 48px #000a; overflow:hidden; }
      .ctxh { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid #8883; font-size:14px; }
      .ctxh span { cursor:pointer; opacity:.7; padding:0 4px; }
      #ctxinfo { padding:6px 14px; font-size:11px; opacity:.7; }
      #ctxlist { flex:1; overflow:auto; padding:8px 14px; }
      .day { text-align:center; font-size:11px; opacity:.55; margin:12px 0 4px; }
      .mrow { display:flex; flex-direction:column; margin:3px 0; }
      .mrow.me { align-items:flex-end; }
      .m { max-width:78%; padding:7px 11px; border-radius:14px; background:#8882; white-space:pre-wrap; overflow-wrap:anywhere; }
      .mrow.me .m { background:#3b6ef5; color:#fff; }
      .m.t { outline:3px solid #ff9100; }
      .m.un { opacity:.75; font-style:italic; }
      .meta { font:10px ui-monospace,Menlo,monospace; opacity:.6; margin:2px 6px; }
      .ctxf { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:10px 14px; border-top:1px solid #8883; }
      #ctxmsg { padding:0 14px 8px; font-size:11px; min-height:14px; color:#e0245e; }
      #ctxq { font-size:11px; opacity:.7; }
    </style>
    <div id="layer"></div>
    <div id="ctx" hidden>
      <div class="ctxbox">
        <div class="ctxh"><b id="ctxt"></b><span id="ctxx" title="Close">✕</span></div>
        <div id="ctxinfo"></div>
        <div id="ctxlist"></div>
        <div id="ctxmsg"></div>
        <div class="ctxf">
          <button id="ctxe">↑ Earlier</button><button id="ctxl">↓ Later</button>
          <button id="ctxf" class="p" title="Ask Instagram for the messages around this one (limited to 5 per 5 minutes)">Fetch from Instagram</button>
          <span id="ctxq"></span>
        </div>
      </div>
    </div>
    <div id="panel" class="min">
      <div class="t">DMDB <span id="x" title="Minimise">–</span></div>
      <div id="st"></div>
      <button id="go" class="p">Back up whole chat</button><button id="stop">Stop</button>
      <label><input type="checkbox" id="ts"> Exact timestamps on chat</label>
      <input type="search" id="q" placeholder="Search your backup (whole phrase)…">
      <label>Search in <select id="scope"><option value="all">all chats</option><option value="chat">this chat</option></select></label>
      <div id="cnt"></div>
      <div id="res"></div>
      <button id="prev">↑</button><button id="next">↓</button> <small>on-screen matches</small>
      <div><button id="view">Open viewer</button></div>
    </div>`;
  const $ = id => root.getElementById(id);
  const panel = $('panel'), layer = $('layer');
  let status = '';
  const setStatus = s => { status = s; paint(); };

  // Search is a whole-phrase, case-insensitive match; any run of whitespace in the
  // query matches any run of whitespace in a message.
  const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phraseRe = (q, flags) => {
    const src = q.split(/\s+/).filter(Boolean).map(escRe).join('\\s+');
    return src ? new RegExp(src, flags) : null;
  };

  function paint() {
    $('st').textContent = !S.id ? 'Open a DM thread to begin.'
      : status || (S.chat ? `${S.chat.title ? S.chat.title + ': ' : ''}${S.msgs.size} messages backed up${S.chat.complete ? ' (full history)' : ''}.` : 'Nothing saved yet. Open the chat or press Back up.');
    $('go').disabled = !S.id || S.running; $('stop').disabled = !S.running;
    $('ts').checked = S.showTs;
    $('cnt').textContent = S.query ? `${S.total} in backup · ${S.hits.length} on screen` : '';
  }

  // ---- search results (whole phrase, newest first) + jump to a result ------
  const escH = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let searchSeq = 0;
  async function runSearch() {
    const q = S.query, seq = ++searchSeq;
    if (!q) { S.results = []; S.total = 0; S.chatHits = []; renderResults(); paint(); return; }
    const scope = $('scope').value;
    const chatId = scope === 'chat' ? (S.chat && S.chat.id) || '__none__' : null;
    const r = await send({ type: 'search', source: phraseRe(q, 'i').source, chatId });
    if (seq !== searchSeq || !r || r.error) return;
    S.results = r.hits; S.total = r.total; S.chatHits = r.chats || [];
    renderResults(); paint();
  }

  function renderResults() {
    const box = $('res');
    box.textContent = '';
    const re = S.query ? phraseRe(escH(S.query), 'gi') : null;
    // chats whose nickname / real name / @username matches the query
    for (const c of S.chatHits) {
      const d = document.createElement('div');
      d.className = 'hit';
      d.innerHTML = `<small>chat</small>💬 ${escH(c.title)}` + (c.aliases.length ? ` <small>${escH(c.aliases.join(' · '))}</small>` : '');
      d.title = 'Open this chat';
      d.onclick = () => { if (sameChat(c.id)) return setStatus('You are already in this chat.'); location.assign('/direct/t/' + c.id + '/'); };
      box.appendChild(d);
    }
    for (const h of S.results) {
      const d = document.createElement('div');
      d.className = 'hit';
      d.innerHTML = `<small>${fmt(h.ts)}${h.chat ? ' · ' + escH(h.chat) : ''}${h.unsent ? ' · unsent' : ''}</small>` +
        (re ? escH(h.text).replace(re, x => `<mark>${x}</mark>`) : escH(h.text));
      d.title = 'Show the conversation around this message';
      d.onclick = () => openContext(h);
      box.appendChild(d);
    }
  }

  const sameChat = id => id === S.id || (S.chat && S.chat.id === id);

  // ============================================================ context view
  // Shows the conversation around a stored message, built from the backup (any chat,
  // without opening it in Instagram). "Fetch from Instagram" can fill in missing
  // neighbours by replaying Instagram's own anchor query; it is rate limited.
  const ctx = { hit: null, before: 25, after: 25, busy: false, total: 0 };
  const QUOTA_MAX = 5;

  const fmtDur = ms => { const s = Math.ceil(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
  const ctxMsg = t => { $('ctxmsg').textContent = t || ''; };

  const senderName = (chat, m) => {
    if (chat.viewerFbid && m.sender === chat.viewerFbid) return 'Me';
    const u = chat.users && chat.users[m.sender];
    return (u && (u.nickname || u.name || u.username)) || m.senderName || 'Them';
  };
  const bodyOf = m => {
    let t = m.text || '';
    if (!t && m.unsent) t = '[unsent message]';
    if (!t) t = `[${(m.type || 'attachment').toLowerCase().replace(/_/g, ' ')}]`;
    if (m.link && !t.includes(m.link)) t += (m.linkTitle ? `\n${m.linkTitle}` : '') + `\n${m.link}`;
    return t;
  };

  async function refreshQuota() {
    const q = await send({ type: 'quota', take: false });
    if (!q) return;
    $('ctxq').textContent = q.ok ? `${q.remaining} of ${QUOTA_MAX} fetches left` : `0 of ${QUOTA_MAX} left · resets in ${fmtDur(q.retryInMs)}`;
    $('ctxf').disabled = ctx.busy || !q.ok;
  }

  async function openContext(hit) {
    ctx.hit = hit; ctx.before = 25; ctx.after = 25;
    $('ctx').hidden = false;
    ctxMsg('');
    await renderContext('target');
    refreshQuota();
  }

  // keep: 'target' = centre on the message; 'top'/'bottom' = keep the reading position
  async function renderContext(keep) {
    const r = await send({ type: 'window', chatId: ctx.hit.chatId, id: ctx.hit.id, before: ctx.before, after: ctx.after });
    const list = $('ctxlist');
    if (!r || r.error) { list.textContent = 'This message is no longer in the backup.'; return null; }
    ctx.total = r.total;
    const prevH = list.scrollHeight, prevTop = list.scrollTop;
    $('ctxt').textContent = r.chat.title || 'Conversation';
    $('ctxinfo').textContent = (r.chat.complete ? '' : 'This chat is not fully backed up, so messages around this one may be missing. ') +
      `${r.msgs.length} of ${r.total.toLocaleString()} saved messages shown.`;
    list.textContent = '';
    let lastDay = '';
    r.msgs.forEach((m, i) => {
      const day = fmt(m.ts).slice(0, 10);
      if (day !== lastDay) { lastDay = day; const dd = document.createElement('div'); dd.className = 'day'; dd.textContent = day; list.appendChild(dd); }
      const mine = r.chat.viewerFbid && m.sender === r.chat.viewerFbid;
      const row = document.createElement('div');
      row.className = 'mrow' + (mine ? ' me' : '');
      const b = document.createElement('div');
      b.className = 'm' + (i === r.targetIdx ? ' t' : '') + (m.unsent ? ' un' : '');
      b.textContent = bodyOf(m);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${fmt(m.ts)} · ${senderName(r.chat, m)}${m.unsent ? ' · unsent' : ''}${m.previousTexts ? ' · edited' : ''}${m.reactions && m.reactions.length ? ' · ' + m.reactions.length + ' reaction(s)' : ''}`;
      row.append(b, meta);
      list.appendChild(row);
    });
    $('ctxe').disabled = !r.hasEarlier; $('ctxl').disabled = !r.hasLater;
    if (keep === 'target') { const t = list.querySelector('.t'); if (t) t.scrollIntoView({ block: 'center' }); }
    else if (keep === 'top') list.scrollTop = prevTop + (list.scrollHeight - prevH);
    else list.scrollTop = prevTop;
    return r;
  }

  // One page-side request: posts to inject.js and waits for its reply.
  let reqSeq = 0;
  function pageCall(payload, timeout = 25000) {
    return new Promise(res => {
      const reqId = 'r' + (++reqSeq) + '_' + Date.now();
      const t = setTimeout(() => { removeEventListener('message', h); res({ ok: false, error: 'timeout' }); }, timeout);
      const h = e => {
        if (e.source !== window || !e.data || e.data.__igvReply !== 1 || e.data.reqId !== reqId) return;
        clearTimeout(t); removeEventListener('message', h); res(e.data);
      };
      addEventListener('message', h);
      window.postMessage({ __igvReplay: 1, reqId, ...payload }, location.origin);
    });
  }

  async function fetchAround() {
    if (ctx.busy || !ctx.hit) return;
    ctx.busy = true; $('ctxf').disabled = true;
    try {
      const store = await chrome.storage.local.get('queryDocs');
      const docs = store.queryDocs || {};
      // 1) Make sure Instagram has made a request on this page we can model ours on.
      const probe = await pageCall({ probe: true, docs });
      if (!probe.ok || !probe.hasTemplate) {
        return ctxMsg('Nothing was sent. Instagram has not made a request on this page yet: scroll the chat a little (or reload the page) and try again.');
      }
      // 2) Rate limit: 5 fetches per rolling 5 minutes.
      const q = await send({ type: 'quota', take: true });
      if (!q || !q.ok) {
        return ctxMsg(q && q.reason === 'cooldown'
          ? `Paused: Instagram recently pushed back, so fetching is blocked for another ${fmtDur(q.retryInMs)}.`
          : `Limit reached: at most ${QUOTA_MAX} fetches per 5 minutes, to protect your account. Try again in ${fmtDur(q.retryInMs)}.`);
      }
      const { chatId, id } = ctx.hit;
      const jobs = [
        { name: 'IGDMessageListAnchorMessageRangeBeforeOffMsysQuery', label: 'newer messages',
          variables: { after: null, before: null, first: null, include_edge_message: true, is_anchor_message: true, last: 20, newer_than_message_id: id, older_than_message_id: null, id: chatId } },
        { name: 'IGDMessageListAnchorMessageRangeAfterOffMsysQuery', label: 'older messages',
          variables: { after: null, before: null, first: 20, include_edge_message: false, is_anchor_message: true, last: null, newer_than_message_id: null, older_than_message_id: id, id: chatId } },
      ];
      const notes = [], before = ctx.total;
      for (const job of jobs) {
        ctxMsg(`Asking Instagram for ${job.label}…`);
        const r = await pageCall({ name: job.name, variables: job.variables, docs });
        if (r.error === 'no-doc') { notes.push(`${job.label}: skipped (Instagram's query id for it hasn't been seen yet; open any reply preview once so it can be learned)`); continue; }
        if (r.status === 429 || r.status === 403 || r.status === 401) {
          await send({ type: 'penalty' });
          return ctxMsg(`Instagram refused the request (HTTP ${r.status}), which usually means rate limiting. Fetching is paused for 10 minutes. Nothing else was sent.`);
        }
        if (!r.ok) { notes.push(`${job.label}: failed (${r.error || 'unknown'}${r.status ? ' HTTP ' + r.status : ''})`); continue; }
        notes.push(`${job.label}: ${r.hasMessages ? 'received' : 'none returned'}`);
        await sleep(1200);
      }
      await sleep(1500); // let the service worker store the responses
      const r2 = await renderContext('bottom-keep');
      const added = r2 ? r2.total - before : 0;
      ctxMsg(`Done. ${added > 0 ? added + ' new message(s) saved.' : 'Nothing new: this part of the chat was already complete.'} (${notes.join('; ')})`);
    } finally {
      ctx.busy = false; refreshQuota();
    }
  }

  // ---- rows: every message is one child of a single list element -------------
  let listEl = null;
  function getList(p) {
    if (listEl && p.contains(listEl) && listEl.children.length >= 3) return listEl;
    let best = null, bn = 2;
    for (const e of p.querySelectorAll('div')) if (e.children.length > bn) { bn = e.children.length; best = e; }
    return (listEl = best);
  }

  // Bounding box of what a row actually shows (bubble / media), ignoring avatars.
  function contentRect(row) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const e of row.querySelectorAll('img,video,[dir="auto"]')) {
      const q = e.getBoundingClientRect();
      if (q.width < 30 || q.height < 14 || (e.tagName === 'IMG' && q.width <= 44)) continue;
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    }
    return l === Infinity ? null : { left: l, top: t, right: r, bottom: b };
  }

  const TIME_RE = /\d{1,2}:\d{2}/;

  // Work out which stored message each visible row is. Text rows are matched by
  // text; photo/reel/voice/unsent rows in between are matched by order, but only
  // when the counts agree exactly (a wrong timestamp is worse than none).
  function classifyRows(p, leaves) {
    const list = getList(p);
    if (!list) return [];
    const info = [...list.children].map(row => {
      const lv = leaves.filter(el => row.contains(el));
      const hit = lv.map(el => S.cache.get(el)).find(c => c && c.idx >= 0);
      const h = row.getBoundingClientRect().height;
      if (hit) return { row, kind: 'text', li: S.pos.get(S.tlist[hit.idx].id), leaf: lv.find(el => S.cache.get(el) === hit) };
      const sep = lv.length > 0 && lv.every(el => { const t = el.textContent.trim(); return t.length < 40 && TIME_RE.test(t); }) && !row.querySelector('img,video');
      if (sep || h < 28) return { row, kind: 'skip' };
      return { row, kind: 'cand' };
    });

    // keep text rows strictly increasing in list position
    let last = -1;
    for (const r of info) if (r.kind === 'text') { if (r.li > last) last = r.li; else r.kind = 'cand'; }

    const texts = info.map((r, i) => (r.kind === 'text' ? i : -1)).filter(i => i >= 0);
    const take = (rows, data) => rows.forEach((r, k) => { r.li = data[k]; r.kind = 'media'; });
    const nonText = j => j >= 0 && j < S.list.length && !S.list[j].text;

    for (let t = 0; t + 1 < texts.length; t++) {
      const A = info[texts[t]], B = info[texts[t + 1]];
      const rows = info.slice(texts[t] + 1, texts[t + 1]).filter(r => r.kind === 'cand');
      const idxs = []; for (let j = A.li + 1; j < B.li; j++) idxs.push(j);
      if (rows.length && rows.length === idxs.length && idxs.every(nonText)) take(rows, idxs);
    }
    if (texts.length) {
      const first = texts[0], lastT = texts[texts.length - 1];
      const above = info.slice(0, first).filter(r => r.kind === 'cand').reverse(); // nearest first
      const up = []; for (let j = info[first].li - 1; nonText(j) && up.length < above.length; j--) up.push(j);
      if (up.length === above.length) above.forEach((r, k) => { r.li = up[k]; r.kind = 'media'; });
      const below = info.slice(lastT + 1).filter(r => r.kind === 'cand');
      const dn = []; for (let j = info[lastT].li + 1; nonText(j) && dn.length < below.length; j++) dn.push(j);
      if (dn.length === below.length) below.forEach((r, k) => { r.li = dn[k]; r.kind = 'media'; });
    }
    return info;
  }

  function render() {
    const p = getPane();
    layer.textContent = '';
    CSS.highlights && CSS.highlights.delete('igv-hit');
    CSS.highlights && CSS.highlights.delete('igv-cur');
    S.hits = [];
    if (!p || !S.id) return;
    if (S.dirty) rebuild();
    const pr = p.getBoundingClientRect();
    const leaves = leafTexts(p);
    const texts = leaves.map(el => norm(textOf(el)));

    // Re-align text bubbles only when something changed since last time.
    const stale = leaves.some((el, i) => { const c = S.cache.get(el); return !c || c.version !== S.version || c.text !== texts[i]; });
    if (stale) {
      const idx = align(texts);
      leaves.forEach((el, i) => S.cache.set(el, { text: texts[i], version: S.version, idx: idx[i] }));
    }

    // --- search highlights (whole phrase)
    const ranges = [];
    const re = S.query ? phraseRe(S.query, 'gi') : null;
    if (re) {
      for (const el of leaves) {
        const r = el.getBoundingClientRect();
        if (!(r.bottom > pr.top && r.top < pr.bottom && r.width > 0)) continue;
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode());) {
          re.lastIndex = 0;
          for (let m; (m = re.exec(n.data));) {
            if (!m[0]) { re.lastIndex++; continue; }
            const rg = new Range(); rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length); ranges.push(rg);
          }
        }
      }
    }

    // --- exact timestamps on every identifiable message row
    let labelled = 0, rowCount = 0, inView = 0; const unl = [];
    if (S.showTs) {
      const frag = document.createDocumentFragment();
      const rows = classifyRows(p, leaves);
      rowCount = rows.length;
      for (const r of rows) {
        if (r.kind === 'skip') continue;
        const q = (r.kind === 'text' ? r.leaf : r.row).getBoundingClientRect();
        if (!(q.bottom > pr.top && q.top < pr.bottom)) continue;
        inView++;
        if (r.kind !== 'text' && r.kind !== 'media') { unl.push({ h: Math.round(q.height), lv: leaves.filter(el => r.row.contains(el)).length, img: r.row.querySelectorAll('img').length, vid: r.row.querySelectorAll('video').length }); continue; }
        const m = S.list[r.li];
        if (!m) continue;
        const box = r.kind === 'text' ? q : (contentRect(r.row) || q);
        const mine = S.chat && m.sender === S.chat.viewerFbid;
        const d = document.createElement('div');
        d.className = 'lbl' + (m.unsent ? ' un' : '');
        d.textContent = fmt(m.ts) + (m.unsent ? ' · unsent' : '') + (m.previousTexts ? ' · edited' : '');
        d.style.top = Math.round(box.top + Math.min((box.bottom - box.top) / 2, 14) - 6) + 'px';
        if (mine) d.style.right = Math.round(innerWidth - box.left + 8) + 'px';
        else d.style.left = Math.round(box.right + 8) + 'px';
        frag.appendChild(d); labelled++;
      }
      layer.appendChild(frag);
    }
    host.dataset.rows = rowCount;
    host.dataset.labelled = labelled;
    host.dataset.inview = inView;
    host.dataset.unlabelled = JSON.stringify(unl.slice(0, 12));
    host.dataset.leaves = leaves.length;
    host.dataset.msgs = S.msgs.size;

    S.hits = ranges;
    if (S.cur >= ranges.length) S.cur = ranges.length - 1;
    if (CSS.highlights && ranges.length) {
      CSS.highlights.set('igv-hit', new Highlight(...ranges));
      if (S.cur >= 0) CSS.highlights.set('igv-cur', new Highlight(ranges[S.cur]));
    }
    paint();
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; try { render(); } catch (e) { console.warn('[igv] render failed:', e && e.stack || e); } }); };

  function go(delta) {
    if (!S.hits.length) return;
    S.cur = (S.cur + delta + S.hits.length) % S.hits.length;
    const el = S.hits[S.cur].startContainer.parentElement;
    el && el.scrollIntoView({ block: 'center' });
    schedule();
  }

  // ----------------------------------------------------------------- wiring
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('::highlight(igv-hit){background:#ffd54acc;color:#000}::highlight(igv-cur){background:#ff9100;color:#000}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch (e) {}

  $('x').onclick = e => { e.stopPropagation(); panel.classList.add('min'); };
  panel.onclick = () => panel.classList.remove('min');
  $('go').onclick = () => { status = ''; scrollLoop(); };
  $('stop').onclick = () => { S.stop = true; };
  $('ts').onchange = () => { S.showTs = $('ts').checked; try { chrome.storage.local.set({ showTs: S.showTs }); } catch (x) {} schedule(); };
  let qt = 0;
  // Read the value synchronously: inside a shadow root e.target is null once dispatch ends.
  $('q').oninput = () => {
    const val = $('q').value.trim();
    clearTimeout(qt);
    qt = setTimeout(() => { S.query = val; S.cur = -1; schedule(); runSearch(); }, 250);
  };
  $('q').onkeydown = e => { if (e.key === 'Enter') go(e.shiftKey ? -1 : 1); };
  $('scope').onchange = () => runSearch();
  $('ctxx').onclick = () => { $('ctx').hidden = true; };
  $('ctx').onclick = e => { if (e.target === $('ctx')) $('ctx').hidden = true; };
  $('ctxe').onclick = () => { ctx.before += 40; renderContext('top'); };
  $('ctxl').onclick = () => { ctx.after += 40; renderContext('keep'); };
  $('ctxf').onclick = fetchAround;
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('ctx').hidden) $('ctx').hidden = true; });
  $('prev').onclick = () => go(-1);
  $('next').onclick = () => go(1);
  $('view').onclick = () => send({ type: 'openViewer', chatId: S.chat && S.chat.id });

  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true, characterData: true });

  const mount = () => { if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host); };
  setInterval(() => {
    mount();
    if (urlId() !== S.id) { status = ''; loadChat(); }
  }, 500);
  mount(); paint();
})();
