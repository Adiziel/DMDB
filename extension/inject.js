// Runs in the PAGE's own JS world at document_start so it can wrap fetch/XHR
// before Instagram grabs references to them.
//
// 1. Capture: copies GraphQL responses that contain DM history (`slide_messages*`)
//    to bridge.js. It never changes a request or a response.
// 2. Learn: remembers the most recent GraphQL request Instagram itself made (headers and
//    form fields, in memory only, never persisted) plus the stored-query ids (`doc_id`)
//    of the message-list queries.
// 3. Replay (only when the user clicks "Fetch from Instagram"): sends ONE same-origin
//    request that looks like Instagram's own anchor query, using that live template.
(() => {
  if (window.__igvInject) return;
  window.__igvInject = true;
  const MARK = 'slide_messages';
  const post = (text, vars) => { try { window.postMessage({ __igv: 1, text, vars: vars || null }, location.origin); } catch (e) {} };
  const say = obj => { try { window.postMessage(obj, location.origin); } catch (e) {} };

  // Request variables tell us HOW a page was requested (open / older / jump).
  const paramsOf = body => {
    try {
      const s = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '';
      return s ? new URLSearchParams(s) : null;
    } catch (e) { return null; }
  };
  const varsOf = body => {
    try { const v = (paramsOf(body) || new URLSearchParams()).get('variables'); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  };

  // ---- what we have learned from Instagram's own traffic (memory only)
  // Known-good id for the "messages around an anchor" query; replaced by whatever Instagram uses.
  const docs = { IGDMessageListAnchorMessageRangeBeforeOffMsysQuery: '29028969043363744' };
  let tpl = null; // { url, headers, params } of the latest Instagram GraphQL request

  function learn(url, headers, body) {
    const params = paramsOf(body);
    if (!params) return;
    const name = params.get('fb_api_req_friendly_name'), doc = params.get('doc_id');
    if (!name || !doc || !params.get('variables')) return;
    tpl = { url, headers: { ...headers }, params: new URLSearchParams(params) };
    if (/^IGDMessageList/.test(name) && docs[name] !== doc) {
      docs[name] = doc;
      say({ __igv: 1, kind: 'doc', name, docId: doc });
    }
  }

  // ---- capture: fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url.includes('graphql')) {
        const vars = varsOf(init && init.body);
        learn(url, (init && init.headers && !(init.headers instanceof Headers)) ? init.headers : {}, init && init.body);
        p.then(r => r.clone().text()).then(t => { if (t.includes(MARK)) post(t, vars); }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  // ---- capture: XHR (what Instagram's DM views actually use)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__igvUrl = String(u); this.__igvH = {}; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__igvH[String(k).toLowerCase()] = v; } catch (e) {} return origSetHeader.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    if ((this.__igvUrl || '').includes('graphql')) {
      const vars = varsOf(body);
      try { learn(this.__igvUrl, this.__igvH || {}, body); } catch (e) {}
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const t = this.responseText;
            if (t && t.includes(MARK)) post(t, vars);
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- replay, on explicit user request only
  window.addEventListener('message', async e => {
    const d = e.data;
    if (e.source !== window || !d || d.__igvReplay !== 1) return;
    const reply = extra => say({ __igvReply: 1, reqId: d.reqId, ...extra });
    if (d.docs) for (const k of Object.keys(d.docs)) if (!docs[k]) docs[k] = d.docs[k];

    if (d.probe) return reply({ ok: true, hasTemplate: !!tpl, docNames: Object.keys(docs) });
    if (!tpl) return reply({ ok: false, error: 'no-template' });
    const doc = docs[d.name];
    if (!doc) return reply({ ok: false, error: 'no-doc' });
    try {
      const params = new URLSearchParams(tpl.params);
      params.set('fb_api_req_friendly_name', d.name);
      params.set('doc_id', doc);
      params.set('variables', JSON.stringify(d.variables));
      const headers = { ...tpl.headers, 'x-fb-friendly-name': d.name };
      const r = await origFetch.call(window, tpl.url, { method: 'POST', credentials: 'include', headers, body: params.toString() });
      const text = await r.text();
      const has = text.includes(MARK);
      if (r.ok && has) post(text, d.variables);
      reply({ ok: r.ok, status: r.status, hasMessages: has, error: r.ok ? null : 'http' });
    } catch (err) {
      reply({ ok: false, error: 'network' });
    }
  });
})();
