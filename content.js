/*
 * YT Boost — content script (isolated world). v1.1.0
 *
 * 1. Injects engine.js into the PAGE world SYNCHRONOUSLY at document_start.
 *    v1.0.0 bug fixed here: the engine used to be fetched asynchronously, so on a
 *    cold first load YouTube's player could boot and cache its codec probes before
 *    the patches landed (reload won the race by hitting cache — which is why
 *    everything "worked after reloading the tab"). We now try a synchronous XHR
 *    first so the engine is installed before any page script runs; async fetch and
 *    a <script src> tag remain as fallbacks for engines that block sync XHR.
 * 2. Adds preconnect hints so the first video segment fetch starts sooner.
 * 3. Bridges page-world stats <-> popup via window.postMessage + chrome.runtime.
 * 4. Draws the optional on-screen stats badge.
 */
(() => {
  'use strict';

  if (globalThis.__YT_BOOST_CS) return;
  globalThis.__YT_BOOST_CS = true;

  const ENGINE_MARKER = 'YQE';

  function looksLikeEngine(src) {
    return typeof src === 'string' && src.indexOf(ENGINE_MARKER) !== -1;
  }

  function bootEngine(src) {
    const s = document.createElement('script');
    s.textContent = src;
    s.setAttribute('data-ytboost', '1');
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------- 1. inject engine into the page world ---------- */

  function engineURL() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return null;
      return chrome.runtime.getURL('engine.js');
    } catch (e) { return null; }
  }

  /* fastest path: synchronous XHR — blocks until the (local, tiny) resource is
     read, so the engine lands BEFORE YouTube's scripts execute. */
  function loadEngineSync(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // synchronous
      xhr.send(null);
      if ((xhr.status === 200 || xhr.status === 0) && looksLikeEngine(xhr.responseText)) {
        return xhr.responseText;
      }
    } catch (e) { /* sync path unavailable in this engine */ }
    return null;
  }

  (function injectEngine() {
    const url = engineURL();
    if (!url) return;

    const src = loadEngineSync(url);
    if (src) {
      bootEngine(src); // synchronous victory — patches beat the page
      return;
    }

    // fallback A: async fetch
    (async () => {
      try {
        const res = await fetch(url);
        const asyncSrc = await res.text();
        if (looksLikeEngine(asyncSrc)) { bootEngine(asyncSrc); return; }
      } catch (e) { /* fall through */ }
      // fallback B: external script tag (may be blocked by page CSP)
      try {
        const s = document.createElement('script');
        s.src = url;
        s.setAttribute('data-ytboost', 'src');
        (document.head || document.documentElement).appendChild(s);
      } catch (e) { /* engine absent: page still works normally */ }
    })();
  })();

  /* ---------- 2. preconnect hints (sync, immediate) ---------- */
  try {
    const hosts = ['https://redirector.googlevideo.com', 'https://i.ytimg.com'];
    for (const h of hosts) {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = h;
      l.crossOrigin = '';
      (document.head || document.documentElement).appendChild(l);
    }
  } catch (e) {}

  /* ---------- 3. page -> content bridge ---------- */
  let latest = { stats: null, config: null };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__YQE !== 'stats' || !d.stats) return;
    latest = { stats: d.stats, config: d.config || null };
    renderBadge();
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ lastStats: latest });
      }
    } catch (e2) {}
  });

  /* ---------- 4. popup -> page bridge ---------- */
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
        const m = msg || {};
        try {
          if (m.type === 'YQE_GET') {
            respond({ ok: true, stats: latest.stats, config: latest.config });
          } else if (m.type === 'YQE_SET') {
            window.postMessage({ __YQE: 'config', cfg: m.cfg || {} }, '*');
            setTimeout(() => respond({ ok: true, stats: latest.stats, config: latest.config }), 250);
            return true; // async respond
          } else {
            respond({ ok: false, error: 'unknown type' });
          }
        } catch (e) {
          try { respond({ ok: false, error: String(e) }); } catch (e2) {}
        }
      });
    }
  } catch (e) {}

  /* ---------- 5. stats badge ---------- */
  let badge = null;

  function renderBadge() {
    const cfg = latest.config;
    const on = !!(cfg && cfg.statsOverlay);
    if (!on) {
      if (badge) { badge.remove(); badge = null; }
      return;
    }
    const s = latest.stats;
    if (!s) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'ytboost-badge';
      badge.style.cssText =
        'position:fixed;top:4px;right:4px;z-index:2147483647;pointer-events:none;' +
        'font:10px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.65);' +
        'padding:3px 6px;border-radius:6px;white-space:pre;';
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.textContent =
      'YT⇧ ' + (s.applied || s.target || 'auto') + (s.downgraded ? ' ⏳' : '') +
      '\n' + (s.res || '–') + '  ' + (s.codec || '') +
      '\nbuf ' + (s.bufferSec || 0) + 's  drop ' + (s.dropped || 0) + '/' + (s.total || 0) +
      '  stalls ' + (s.stalls || 0);
  }
})();
