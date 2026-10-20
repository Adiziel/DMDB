# DMDB

*A searchable database of your Instagram DMs.* Not affiliated with, endorsed by, or connected to Instagram or Meta.

A Chromium extension (Chrome, Brave, Edge) that backs up your Instagram web DMs **locally**,
keeps them even after Instagram drops or you unsend them, shows exact timestamps in the chat,
highlights search matches in the page, and has a full search/export viewer.

Nothing leaves your browser. Data lives in the extension's IndexedDB.

## Install (unpacked)

1. Open `chrome://extensions` (or `brave://extensions`), enable **Developer mode**.
2. **Load unpacked** → choose this repo's `extension/` folder.
3. Open <https://www.instagram.com/direct/inbox/> (reload if it was already open).

## Use

A small **DMDB** panel appears bottom-right on instagram.com. Click it to expand.

| Control | What it does |
|---|---|
| Back up whole chat | Scrolls the open chat to its first message so Instagram loads all history; everything is saved as it arrives. Stops at the start, or early if you're already up to date. |
| Exact timestamps on chat | Draws `YYYY-MM-DD HH:MM:SS` next to each message (millisecond-accurate source data). Unsent / edited messages are marked. |
| Search box | Whole-phrase, case-insensitive search of your backup, across **all chats** or just this one. Matches on screen are highlighted (↑/↓ step through them). Chats can also be found by nickname, real name or @username. |
| Search result → context view | Shows the conversation around that message (exact timestamps, nickname-aware names), built from the backup. Works for any chat without opening it in Instagram. |
| Fetch from Instagram | In the context view: asks Instagram for the messages around that one (see below) and saves them. |
| Open viewer | Full-page search across one or all chats with sender/date/type filters, export to JSON/CSV/text, and a filter box for chats by nickname / name / @username. |

Chats are also saved passively whenever you open them, and the inbox view saves recent messages of
every visible chat.

## Names: nickname vs real name vs @username
Instagram lets you set a **nickname** for a person (e.g. "Casey"), separate from their real name ("Alex Doe")
and @username. The extension stores all three. Chats, senders and results show the nickname, like Instagram
does, and every one of the three finds the chat.

## "Fetch from Instagram" and its limits
This is the only feature that sends requests. It runs **only when you click it**, sends one or two requests
shaped like Instagram's own "messages around an anchor" queries, and models them on the latest request Instagram
itself made on the page (its tokens are read live and **never stored**).

* At most **5 fetches per rolling 5 minutes**; when the limit is hit the panel says how long to wait.
* If Instagram answers with HTTP 429/401/403 the extension pauses fetching for **10 minutes** and says why.
* The "older messages" half needs Instagram's query id for that query, which is learned the first time
  Instagram makes it (e.g. when you click a reply preview that jumps to an old message).

## How it works

* `inject.js` runs in the page's world at `document_start` and wraps `fetch`/XHR. It copies only
  GraphQL responses that contain `slide_messages` (`IGDThreadDetailQuery`, `IGDMessageListOffMsysQuery`,
  and the inbox query's previews). It never alters Instagram's own requests or responses. It sends a request of its
  own only when you click **Fetch from Instagram** (see above).
* `bridge.js` relays them to the service worker, `parse.js` normalises them, `db.js` merges them into
  IndexedDB keyed by Instagram's `message_id`. Merging never discards text: unsent messages keep their
  earlier text and edits keep previous versions.
* `ui.js` draws the panel, the context view and the search UI, drives the "scroll to start" backup, and matches
  on-screen bubbles to stored messages (by text and order, including emoji and media rows) to place timestamps and highlights. The overlay is a separate layer; Instagram's DOM is not modified.

## Limitations

* Instagram's GraphQL shapes are undocumented and can change; `tests/` and `research/` help re-derive them.
* Messages that arrive in real time while you're **not** looking at the chat travel over a binary websocket
  that is not captured. They are picked up the next time the chat loads (open it, or press *Back up*).
* Media is stored as metadata and links only; Instagram's media URLs expire.
* Automated scrolling is paced slowly on purpose. Use it on your own account and don't hammer it.

## Privacy

Everything stays in your browser (the extension's IndexedDB). The only request the extension ever sends is
**Fetch from Instagram**, when you click it, to `www.instagram.com` itself. There is no server, analytics or
remote code. Host access is limited to `https://www.instagram.com/*`.

## Packaging

```bash
./package.sh        # audits extension/ for personal data, then builds dist/dmdb-<version>.zip
```

The folder to load in the browser is `extension/`. The extension has a fixed id (via the `key` field in
`manifest.json`), so moving or re-cloning the folder does not orphan the saved data.
