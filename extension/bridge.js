// Isolated-world relay: page (inject.js) -> extension background.
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || e.data.__igv !== 1) return;
  try {
    if (e.data.kind === 'doc') {
      // Stored-query ids Instagram uses for message-list queries (not secrets); kept so
      // "Fetch from Instagram" keeps working after Instagram ships new ids.
      api.storage.local.get('queryDocs')
        .then(({ queryDocs = {} }) => { queryDocs[e.data.name] = e.data.docId; return api.storage.local.set({ queryDocs }); })
        .catch(() => {});
      return;
    }
    if (typeof e.data.text !== 'string') return;
    api.runtime.sendMessage({ type: 'ingest', text: e.data.text, vars: e.data.vars }).catch(() => {});
  } catch (err) { /* extension reloaded */ }
});
