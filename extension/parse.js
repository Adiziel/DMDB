// Pure parsing of Instagram's DM GraphQL responses (no DOM, no chrome.*),
// so it can be unit-tested in node and reused by the service worker.
//
// Two queries carry chat history; both return `slide_messages`:
//   IGDThreadDetailQuery        -> data.get_slide_thread_nullable.as_ig_direct_thread
//   IGDMessageListOffMsysQuery  -> data.fetch__SlideThread.as_ig_direct_thread
//   IGDMessageListAnchorMessageRange{Before,After}OffMsysQuery (jumping to a replied-to
//     message) -> same thread object, but the connection is `slide_messages_before` / `_after`
// We look for any object holding such a connection instead of hard-coding the path,
// so small wrapper changes don't break capture.
const CONNECTION_KEYS = ['slide_messages', 'slide_messages_before', 'slide_messages_after'];
const connectionsOf = t => CONNECTION_KEYS.filter(k => t[k] && Array.isArray(t[k].edges));

function findThreads(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (connectionsOf(node).length) out.push(node);
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') findThreads(v, out, depth + 1);
  }
  return out;
}

const str = v => (typeof v === 'string' && v ? v : null);

function normMessage(n, chatId) {
  const c = n.content || {};
  const xma = c.xma || {};
  const sender = n.sender || {};
  const ud = sender.user_dict || {};
  const reactions = (n.msg_reactions && n.msg_reactions.length ? n.msg_reactions : n.reactions) || [];
  return {
    id: n.message_id || n.id,
    chatId,
    ts: Number(n.timestamp_ms) || 0,
    sender: String(n.sender_fbid || sender.id || ''),
    senderName: str(ud.username) || str(sender.name) || null,
    text: str(n.text_body) || str(c.xma_text_body) || '',
    type: str(n.content_type) || str(c.__typename) || '',
    replyTo: n.replied_to_message_id || null,
    replyText: n.replied_to_message ? str(n.replied_to_message.text_body) : null,
    forwarded: !!n.igd_is_forwarded,
    pinned: !!n.is_pinned,
    unsent: !!n.tombstone_reason,
    reactions,
    editHistory: Array.isArray(n.slide_edit_history) ? n.slide_edit_history : [],
    link: str(xma.target_url),
    linkTitle: str(xma.header_title_text) || str(xma.xmaHeaderTitle),
  };
}

function normThread(t) {
  const users = {};
  // Nicknames are set by the viewer ("Casey") and are separate from the person's own
  // full name and @username. They arrive as [{ nickname, igid, eimu_id }].
  const nick = {};
  for (const n of Array.isArray(t.nicknames) ? t.nicknames : []) {
    if (!n || !n.nickname) continue;
    if (n.igid) nick[String(n.igid)] = n.nickname;
    if (n.eimu_id) nick[String(n.eimu_id)] = n.nickname;
  }
  const addUser = u => {
    if (!u) return;
    const fbid = String(u.interop_messaging_user_fbid || u.id || '');
    if (!fbid) return;
    const igid = str(u.id) || str(u.pk);
    users[fbid] = {
      username: str(u.username), name: str(u.full_name), igid,
      nickname: nick[igid] || nick[fbid] || null,
    };
  };
  (t.users || []).forEach(addUser);
  addUser(t.viewer);
  const viewerFbid = t.viewer ? String(t.viewer.interop_messaging_user_fbid || '') || null : null;
  return {
    id: String(t.thread_fbid || t.id),
    threadId: str(t.thread_id) || null,
    title: str(t.thread_title),
    isGroup: !!t.is_group,
    users,
    viewerFbid,
  };
}

// Returns one entry per thread object found in the response text.
// Streamed responses contain several JSON documents, one per line.
function parseResponse(text) {
  const pages = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let json;
    try { json = JSON.parse(s); } catch { continue; }
    for (const t of findThreads(json)) {
      const thread = normThread(t);
      for (const key of connectionsOf(t)) {
        const sm = t[key];
        const pi = sm.page_info || {};
        pages.push({
          thread,
          connection: key,
          messages: sm.edges.map(e => e && e.node).filter(Boolean).map(n => normMessage(n, thread.id)).filter(m => m.id),
          pageInfo: { hasNext: !!pi.has_next_page, endCursor: pi.end_cursor || null },
          hasThreadInfo: !!t.users || !!t.viewer,
        });
      }
    }
  }
  return pages;
}

// Never lose data: keep text/edits that an earlier capture had, mark unsends.
function mergeMessage(old, inc) {
  if (!old) return { ...inc, firstSeen: Date.now() };
  const m = { ...old, ...inc, firstSeen: old.firstSeen };
  if (old.text && !inc.text) m.text = old.text;
  if (old.unsent || inc.unsent) m.unsent = true;
  if (old.editHistory.length > inc.editHistory.length) m.editHistory = old.editHistory;
  if (old.text && inc.text && old.text !== inc.text) {
    m.previousTexts = [...new Set([...(old.previousTexts || []), old.text])];
  }
  if (old.previousTexts && !m.previousTexts) m.previousTexts = old.previousTexts;
  return m;
}

// "Fetch from Instagram" is limited to QUOTA_MAX uses per QUOTA_WINDOW ms (rolling) to keep
// automated requests rare. `stamps` are the times of recent uses; `cooldownUntil` is an
// extra block (set after Instagram itself rate-limits us).
const QUOTA_MAX = 5, QUOTA_WINDOW = 5 * 60 * 1000;
function quotaDecision(stamps, now, cooldownUntil = 0) {
  const live = (stamps || []).filter(t => now - t < QUOTA_WINDOW);
  if (cooldownUntil > now) return { ok: false, remaining: 0, retryInMs: cooldownUntil - now, live, reason: 'cooldown' };
  if (live.length >= QUOTA_MAX) return { ok: false, remaining: 0, retryInMs: QUOTA_WINDOW - (now - live[0]), live, reason: 'limit' };
  return { ok: true, remaining: QUOTA_MAX - live.length, retryInMs: 0, live };
}

// What Instagram shows for a person: your nickname for them, else their name, else @username.
const userDisplay = u => (u && (u.nickname || u.name || u.username)) || '';

// Every name a chat can be found by: nickname, real name and @username of each other
// participant, plus the stored title.
function chatAliases(chat) {
  const out = new Set();
  if (chat.title) out.add(chat.title);
  for (const [fbid, u] of Object.entries(chat.users || {})) {
    if (fbid === chat.viewerFbid) continue;
    for (const v of [u.nickname, u.name, u.username]) if (v) out.add(v);
  }
  return [...out];
}

// Instagram's URL id for a chat isn't always the thread id in the message data: for 1:1
// chats it can be the OTHER participant's user id (a key of chat.users).
function chatMatchesUrlId(chat, id) {
  if (!id || !chat) return false;
  if (chat.id === id || chat.threadId === id) return true;
  return !chat.isGroup && Object.keys(chat.users || {}).some(k => k === id && k !== chat.viewerFbid);
}

// How was this page requested?
//  'open'    chat opened / inbox preview      -> newest messages; has_next_page refers to OLDER history
//  'older'   normal pagination with a cursor  -> has_next_page refers to OLDER history
//  'jump'    anchored on / paging towards a specific message (e.g. clicking a reply) -> flags may mean "newer"
//  'unknown' request variables couldn't be read -> don't trust completeness flags
function pageDirection(vars) {
  if (!vars || typeof vars !== 'object') return 'unknown';
  if (vars.older_than_message_id || vars.newer_than_message_id || vars.before || vars.last) return 'jump';
  if (vars.after) return 'older';
  return 'open';
}

if (typeof module !== 'undefined') module.exports = { parseResponse, mergeMessage, normMessage, normThread, pageDirection, chatMatchesUrlId, userDisplay, chatAliases, quotaDecision, QUOTA_MAX, QUOTA_WINDOW };
