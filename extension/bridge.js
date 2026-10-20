// Isolated-world relay: page (inject.js) -> extension service worker.
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || e.data.__igv !== 1) return;
  try {
    if (e.data.kind === 'doc') {
      // Stored-query ids Instagram uses for message-list queries (not secrets); kept so
      // "Fetch from Instagram" keeps working after Instagram ships new ids.
      chrome.storage.local.get('queryDocs', ({ queryDocs = {} }) => {
        queryDocs[e.data.name] = e.data.docId;
        chrome.storage.local.set({ queryDocs });
      });
      return;
    }
    if (typeof e.data.text !== 'string') return;
    chrome.runtime.sendMessage({ type: 'ingest', text: e.data.text, vars: e.data.vars });
  } catch (err) { /* extension reloaded */ }
});
