// ==UserScript==
// @name         Suno Local Song Collector
// @namespace    suno-local-collector
// @version      1.0.0
// @description  Passively save complete Library feed clips to your local SQLite collector. Never requests songs or scrolls.
// @match        https://suno.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
  'use strict';
  // Install the server-rendered version, not this template: /userscript.user.js.
  const BASE = '__INGRESS_BASE__';
  const TOKEN = '__INGRESS_TOKEN__';
  if (TOKEN.startsWith('__')) { console.error('[Suno collector] Install from the running localhost server.'); return; }
  const PREFIX = '[Suno collector]';
  const KEY_PREFIX = 'pending-batch-v1:';
  const page = unsafeWindow;
  let busy = false;
  let paused = GM_getValue('paused', false);
  let lastResult = 'No delivery yet';
  function queueKeys() { return GM_listValues().filter(key => key.startsWith(KEY_PREFIX)).sort(); }
  function matches(url) {
    try { const parsed = new URL(String(url), 'https://suno.com'); return parsed.origin === 'https://studio-api-prod.suno.com' && parsed.pathname === '/api/feed/v3'; }
    catch { return false; }
  }
  function capture(data) {
    if (!data || !Array.isArray(data.clips)) return;
    // Immutable per-capture records avoid read/modify/write races between tabs.
    const clips = [...new Map(data.clips.filter(clip => clip && typeof clip.id === 'string' && clip.id.trim()).map(clip => [clip.id, clip])).values()];
    try {
      for (let offset = 0; offset < clips.length; offset += 20) {
        const key = KEY_PREFIX + Date.now() + ':' + page.crypto.randomUUID();
        GM_setValue(key, JSON.stringify({ clips: clips.slice(offset, offset + 20) }));
      }
    } catch (error) { console.error(PREFIX, 'Could not persist capture; browser storage may be full.', error); return; }
    console.info(PREFIX, `Captured ${clips.length} clips; ${queueKeys().length} batches pending.`);
    flush();
  }
  function flush() {
    if (busy || paused) return;
    const key = queueKeys()[0];
    if (!key) return;
    const payload = GM_getValue(key, null);
    if (!payload) return;
    const batch = JSON.parse(payload).clips;
    busy = true;
    const failed = message => { busy = false; lastResult = message; console.warn(PREFIX, message, 'Pending data retained; retrying localhost in 15 seconds.'); };
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: BASE + '/api/ingest',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        data: payload,
        timeout: 10000,
        onload(response) {
          if (response.status !== 200) return failed(`Local ingress HTTP ${response.status}: ${response.responseText.slice(0, 200)}`);
          let result;
          try {
            result = JSON.parse(response.responseText);
            if (result.unique !== batch.length || !['inserted', 'updated', 'unchanged'].every(k => Number.isInteger(result[k])) || result.inserted + result.updated + result.unchanged !== batch.length) throw new Error('Invalid acknowledgement');
          } catch (error) { return failed(error.message); }
          // Delete only this acknowledged immutable batch; other captures are untouched.
          try { GM_deleteValue(key); } catch (error) { return failed('Could not persist acknowledgement: ' + error.message); }
          busy = false;
          lastResult = `${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged`;
          console.info(PREFIX, lastResult);
          if (queueKeys().length) setTimeout(flush, 250);
        },
        onerror: () => failed('Local collector unreachable'),
        ontimeout: () => failed('Local collector timed out'),
        onabort: () => failed('Local delivery aborted')
      });
    } catch (error) { failed(error.message); }
  }
  // Observe the response clone; never consume or modify the application's response.
  const originalFetch = page.fetch;
  page.fetch = function (...args) {
    const promise = Reflect.apply(originalFetch, this, args);
    const url = typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0]?.url;
    if (matches(url)) {
      promise.then(response => {
        if (response.ok) response.clone().json().then(capture).catch(error => console.warn(PREFIX, 'Could not capture feed response:', error));
      }, () => {});
    }
    return promise;
  };
  // Also cover XMLHttpRequest if Suno changes transport. Only the same endpoint is observed.
  const xhrPrototype = page.XMLHttpRequest.prototype;
  const originalOpen = xhrPrototype.open;
  const urls = new WeakMap();
  xhrPrototype.open = function (method, url, ...rest) {
    urls.set(this, url);
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  const originalSend = xhrPrototype.send;
  xhrPrototype.send = function (...args) {
    if (matches(urls.get(this))) this.addEventListener('load', function () {
      if (this.status < 200 || this.status >= 300) return;
      try {
        if (this.responseType === 'json') capture(this.response);
        else if (this.responseType === '' || this.responseType === 'text') capture(JSON.parse(this.responseText));
      } catch (error) { console.warn(PREFIX, 'Could not capture XHR:', error); }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
  GM_registerMenuCommand('Collector: status', () => page.alert(`${PREFIX}\nPending batches: ${queueKeys().length}\nDelivery paused: ${paused}\n${lastResult}\nReceiver: ${BASE}`));
  GM_registerMenuCommand('Collector: pause/resume local delivery', () => {
    paused = !paused; GM_setValue('paused', paused); console.info(PREFIX, 'Delivery paused:', paused); if (!paused) flush();
  });
  GM_registerMenuCommand('Collector: retry local delivery', flush);
  setInterval(flush, 15000); // Retries only localhost, never Suno.
  flush();
  console.info(PREFIX, 'Passive feed capture active. No automated navigation or Suno requests.');
})();
