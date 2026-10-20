/*
 * YT Boost — page-world engine. v1.1.0
 *
 * Runs INSIDE the page's JS context (injected by content.js at document_start).
 * YouTube exposes its player API (setPlaybackQualityRange, getAvailableQualityLevels,
 * getVideoData) as own properties on #movie_player in the PAGE's heap — an isolated
 * content script cannot see them, which is why the engine must live here.
 *
 * v1.0.0 bugs fixed in this version (the "only works after a manual reload" report):
 *  1. The retry loop killed itself after 45 tries (~31s). Browse longer than that,
 *     tap a video, and NOTHING re-applied: the one-shot navigate retries (50/800ms)
 *     fired before the player existed. -> replaced with an ETERNAL 1s watcher that
 *     never dies, plus a retry ladder on every navigation/video event.
 *  2. applyQuality() memoized "applied" even when the player had no API methods yet,
 *     permanently silencing retries for that video. -> memoize only on success.
 *  3. Video elements created mid-session fired their early events before listeners
 *     were attached. -> attach-on-swap now re-checks immediately, and listens to
 *     play/playing/loadeddata/canplay/durationchange.
 *  4. Stall events from feed preview players could trigger a downgrade. -> stalls
 *     only count on /watch and /shorts pages.
 *
 * Grounded in (research, Oct 2026):
 *  - iPhone WebKit: ManagedMediaSource (MMS) owns the buffer (~30s fill / ~10s resume);
 *    page code cannot change those thresholds — so we work AROUND them.
 *  - A15 (iPhone 13): no AV1 hardware decoder (first = A17 Pro) -> block AV1.
 *  - WebKit bug history: YouTube's VP9 isTypeSupported probe can race GPU-process
 *    init and cache a false "unsupported" -> silent 1080p cap. We force VP9 supported.
 *  - "Stable Volume" is DRC applied by default; community consensus: it degrades
 *    dynamic range -> stripped from player responses.
 *  - yt-player-quality localStorage format: {"data":"hd1440","expiration":ts,"creation":ts}
 */
(() => {
  'use strict';

  if (globalThis.YQE) return; // double-injection guard
  const VERSION = '1.1.0';
  const CFG_KEY = 'yqe-config';
  const QUALITY_KEY = 'yt-player-quality';

  /* quality ladder, high -> low (YouTube's own ordering) */
  const ORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

  const DEFAULTS = {
    targetQuality: 'hd1440', // 'auto' = don't lock
    forceVP9: true,          // VP9 vaccine (WebKit probe-race bug)
    blockAV1: true,          // no AV1 hardware on A15
    preferOpus: true,        // prefer Opus audio track (~160k) over AAC (~128k)
    stableVolumeOff: true,   // disable loudness normalization / DRC in player responses
    quickStart: true,        // seed yt-player-quality before the player boots
    stallRecovery: true,     // drop a rung on repeated stalls, restore when healthy
    statsOverlay: false,     // on-screen stats badge (via content script)
    feedDataSaver: false     // pause autoplaying feed previews (opt-in; off by default)
  };

  const config = loadConfig();

  function loadConfig() {
    const cfg = Object.assign({}, DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      for (const k of Object.keys(DEFAULTS)) {
        if (typeof saved[k] === typeof DEFAULTS[k]) cfg[k] = saved[k];
      }
    } catch (e) { /* fresh */ }
    return cfg;
  }

  function saveConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(config)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 1. Codec steering                                                   */
  /* ------------------------------------------------------------------ */
  const origSupported = (checker, type) => {
    try { return checker(type); } catch (e) { return ''; }
  };

  function decide(type, original) {
    if (typeof type !== 'string' || !type) return original;
    const t = type.toLowerCase();
    if (config.blockAV1 && t.includes('av01')) {
      return typeof original === 'string' ? '' : false;
    }
    if (config.forceVP9 && (t.includes('vp9') || t.includes('vp09'))) {
      return typeof original === 'string' ? (original || 'probably') : true;
    }
    if (config.preferOpus && t.includes('mp4a')) {
      // only block AAC when the browser genuinely supports Opus (safety valve)
      const opusOK = origSupported(isTypeSupportedRaw, 'audio/webm; codecs="opus"');
      if (opusOK) return typeof original === 'string' ? '' : false;
    }
    return original;
  }

  let isTypeSupportedRaw = () => true;

  function patchCodecs() {
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (MS && typeof MS.isTypeSupported === 'function') {
      const orig = MS.isTypeSupported.bind(MS);
      isTypeSupportedRaw = orig;
      const patched = function (type) { return decide(type, orig(type)); };
      try { MS.isTypeSupported = patched; } catch (e) {}
      if (window.ManagedMediaSource && window.MediaSource &&
          window.ManagedMediaSource !== window.MediaSource) {
        try { window.MediaSource.isTypeSupported = patched; } catch (e) {}
      }
    }
    try {
      const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (proto && proto.canPlayType) {
        const orig = proto.canPlayType;
        proto.canPlayType = function (type) { return decide(type, orig.call(this, type)); };
      }
    } catch (e) {}
    try {
      const mc = navigator.mediaCapabilities;
      if (mc && typeof mc.decodingInfo === 'function') {
        const orig = mc.decodingInfo.bind(mc);
        mc.decodingInfo = function (cfg) {
          try {
            const ct = cfg && cfg.video && cfg.video.contentType;
            const verdict = ct !== undefined ? decide(ct, true) : null;
            if (verdict === '' || verdict === false) {
              return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
            }
            if (ct && config.forceVP9 && /vp9|vp09/i.test(ct)) {
              return orig(cfg).then((r) => Object.assign({}, r, { supported: true, smooth: r.smooth !== false }));
            }
          } catch (e) {}
          return orig(cfg);
        };
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 2. Audio: strip Stable Volume / loudness normalization              */
  /* ------------------------------------------------------------------ */
  const PLAYER_URL_RE = /\/youtubei\/v1\/player|\/player\?|\/player$/;

  function stripLoudness(obj) {
    let touched = false;
    try {
      const ac = obj && obj.playerConfig && obj.playerConfig.audioConfig;
      if (ac) {
        if ('loudnessNormalization' in ac && ac.loudnessNormalization !== false) {
          ac.loudnessNormalization = false; touched = true;
        }
        if ('stableVolume' in ac && ac.stableVolume !== false) {
          ac.stableVolume = false; touched = true;
        }
        if ('stableVolumeEnabled' in ac && ac.stableVolumeEnabled !== false) {
          ac.stableVolumeEnabled = false; touched = true;
        }
      }
    } catch (e) {}
    return touched;
  }

  function makeResponse(res, json) {
    if (typeof Response !== 'undefined') {
      try {
        return new Response(JSON.stringify(json), {
          status: res.status || 200,
          statusText: res.statusText || '',
          headers: { 'content-type': 'application/json' }
        });
      } catch (e) { /* fall through */ }
    }
    return {
      ok: res.ok, status: res.status, url: res.url,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
      clone: () => makeResponse(res, JSON.parse(JSON.stringify(json)))
    };
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') return;
    const orig = window.fetch;
    window.fetch = function () {
      const args = arguments;
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = orig.apply(this, args);
      if (!config.stableVolumeOff || !PLAYER_URL_RE.test(url)) return p;
      return p.then(async (res) => {
        try {
          if (!res || !res.ok || typeof res.json !== 'function') return res;
          const json = await res.json();
          if (json && typeof json === 'object' && stripLoudness(json)) {
            return makeResponse(res, json);
          }
          return makeResponse(res, json); // still rebuild: json() was consumed
        } catch (e) {
          return res;
        }
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Quality lock + quick start                                       */
  /* ------------------------------------------------------------------ */
  const stats = {
    version: VERSION, target: config.targetQuality, applied: '', codec: '',
    res: '', dropped: 0, total: 0, bufferSec: 0, stalls: 0, downgraded: false,
    ready: false
  };

  function seedQuality() {
    if (!config.quickStart || config.targetQuality === 'auto') return;
    try {
      const now = Date.now();
      localStorage.setItem(QUALITY_KEY, JSON.stringify({
        data: config.targetQuality,
        creation: now,
        expiration: now + 2592000000
      }));
    } catch (e) {}
  }

  function findPlayer() {
    return document.getElementById('movie_player') ||
      document.getElementsByClassName('html5-video-player')[0] || null;
  }

  function findVideo() {
    return document.querySelector('video.html5-main-video') ||
      document.querySelector('video');
  }

  function pickLevel(levels, target) {
    const tIdx = ORDER.indexOf(target);
    for (const l of levels) {
      const idx = ORDER.indexOf(l);
      if (idx >= tIdx) return l; // at target, or first rung below it
    }
    return levels[levels.length - 1] || target;
  }

  let appliedThisVideo = '';
  let videoId = '';

  function applyQuality(reason) {
    stats.target = config.targetQuality;
    stats.downgraded = recovery.downgraded;
    if (config.targetQuality === 'auto') return false;
    const player = findPlayer();
    if (!player) { computeStats(); return false; }
    let target = config.targetQuality;
    if (recovery.downgraded) {
      const tIdx = ORDER.indexOf(config.targetQuality);
      target = ORDER[Math.min(tIdx + 2, ORDER.length - 1)]; // two rungs down while recovering
    }
    try {
      const hadRange = typeof player.setPlaybackQualityRange === 'function';
      const hadSet = typeof player.setPlaybackQuality === 'function';
      if (!hadRange && !hadSet) {
        // player shell exists but its API is not ready yet — do NOT memoize,
        // the eternal watcher will retry.
        computeStats();
        return false;
      }
      const levels = typeof player.getAvailableQualityLevels === 'function'
        ? player.getAvailableQualityLevels() : null;
      if (Array.isArray(levels) && levels.length) target = pickLevel(levels, target);
      if (hadRange) player.setPlaybackQualityRange(target, target); // pin: stops ABR drift
      if (hadSet) player.setPlaybackQuality(target);
      appliedThisVideo = target;
      videoId = currentVideoId(player);
      stats.applied = target;
      try {
        const vd = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
        stats.codec = (vd && (vd.videoCoding || vd.codec || '')) || '';
      } catch (e) {}
      computeStats();
      return true;
    } catch (e) {
      computeStats();
      return false;
    }
  }

  function currentVideoId(player) {
    try {
      const d = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      if (d && d.video_id) return d.video_id;
    } catch (e) {}
    try {
      const v = findVideo();
      if (v && v.dataset && v.dataset.videoId) return v.dataset.videoId;
    } catch (e) {}
    return location.pathname + location.search;
  }

  /* retry ladder: the player becomes ready at unpredictable times, so every
     trigger fans out attempts over the first ~2.5 seconds. */
  const LADDER = [0, 150, 500, 1200, 2500];
  function retryApply(reason) {
    for (const d of LADDER) {
      setTimeout(() => {
        if (config.targetQuality !== 'auto') applyQuality(reason);
      }, d);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 4. Stall recovery (works WITH the MMS ~30s/~10s buffer, not against it) */
  /* ------------------------------------------------------------------ */
  const recovery = { stalls: [], downgraded: false, healthyTicks: 0, attached: null };

  function onMainVideoPage() {
    const p = location.pathname;
    return p.startsWith('/watch') || p.startsWith('/shorts');
  }

  function noteStall() {
    if (!onMainVideoPage()) return; // ignore feed-preview players
    stats.stalls++;
    if (!config.stallRecovery || config.targetQuality === 'auto') return;
    const now = Date.now();
    recovery.stalls = recovery.stalls.filter((t) => now - t < 30000);
    recovery.stalls.push(now);
    if (recovery.stalls.length >= 2 && !recovery.downgraded) {
      const tIdx = ORDER.indexOf(config.targetQuality);
      if (tIdx < ORDER.indexOf('hd1080')) { // only if we're above 1080p
        recovery.downgraded = true;
        recovery.healthyTicks = 0;
        applyQuality('stall-downgrade');
      }
    }
  }

  function forwardBufferSec(v) {
    try {
      const b = v.buffered;
      if (!b || !b.length) return 0;
      return Math.max(0, b.end(b.length - 1) - v.currentTime);
    } catch (e) { return 0; }
  }

  /* returns action for testability; called every second when downgraded */
  function evalRecovery(fbSec) {
    if (!recovery.downgraded) return 'none';
    if (fbSec > 20) {
      recovery.healthyTicks++;
      if (recovery.healthyTicks >= 10) {
        recovery.downgraded = false;
        recovery.healthyTicks = 0;
        recovery.stalls = [];
        applyQuality('stall-restore');
        return 'restore';
      }
      return 'wait';
    }
    recovery.healthyTicks = 0;
    return 'wait';
  }

  function attachVideo() {
    const v = findVideo();
    if (!v || recovery.attached === v) return;
    recovery.attached = v;
    try {
      const onVidEvent = () => {
        const player = findPlayer();
        if (player && currentVideoId(player) !== videoId) applyQuality('video-event');
      };
      for (const ev of ['play', 'playing', 'loadeddata', 'canplay', 'durationchange']) {
        v.addEventListener(ev, onVidEvent, true);
      }
      v.addEventListener('waiting', noteStall, true);
      v.addEventListener('stalled', noteStall, true);
      // this element may have been created mid-session and already fired its
      // early events before we attached — check right now.
      onVidEvent();
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 5. Optional feed data-saver (OFF by default; never removes content) */
  /* ------------------------------------------------------------------ */
  function setupFeedDataSaver() {
    if (!config.feedDataSaver) return;
    document.addEventListener('play', (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      if (!location.pathname.startsWith('/watch')) {
        if (!v.closest || !v.closest('.html5-video-player, #movie_player, #shorts-player')) {
          try { v.pause(); } catch (e2) {}
        }
      }
    }, true);
  }

  /* ------------------------------------------------------------------ */
  /* 6. Stats + bridge to content script (isolated world)                */
  /* ------------------------------------------------------------------ */
  function computeStats() {
    stats.target = config.targetQuality;
    stats.downgraded = recovery.downgraded;
    const v = recovery.attached || findVideo();
    if (v) {
      stats.res = v.videoWidth + 'x' + v.videoHeight;
      try {
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        stats.dropped = q ? q.droppedVideoFrames : (v.webkitDroppedFrameCount || 0);
        stats.total = q ? q.totalVideoFrames : 0;
      } catch (e) {}
      stats.bufferSec = Math.round(forwardBufferSec(v));
    }
    stats.ready = true;
    return stats;
  }

  window.addEventListener('message', (e) => {
    if (e.source && e.source !== window) return;
    const d = e.data;
    if (!d || d.__YQE !== 'config' || !d.cfg) return;
    setConfig(d.cfg);
  });

  function setConfig(partial) {
    for (const k of Object.keys(DEFAULTS)) {
      if (partial && typeof partial[k] === typeof DEFAULTS[k]) config[k] = partial[k];
    }
    saveConfig();
    seedQuality();
    applyQuality('config');
    try { window.postMessage({ __YQE: 'stats', stats: computeStats(), config }, '*'); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 7. Triggers: THE ETERNAL WATCHER (never dies)                       */
  /*    v1.0.0's retry loop killed itself after ~31s, which is why the   */
  /*    extension only worked after a manual reload. This one runs       */
  /*    forever: every second it re-applies whenever the video changed,  */
  /*    the memo is empty, or a new video element appeared.              */
  /* ------------------------------------------------------------------ */
  setInterval(() => {
    try {
      attachVideo();
      const player = findPlayer();
      if (player) {
        const id = currentVideoId(player);
        if (id !== videoId || appliedThisVideo === '') applyQuality('watcher');
      }
      const v = recovery.attached;
      if (recovery.downgraded && v) evalRecovery(forwardBufferSec(v));
    } catch (e) { /* never let the watcher die */ }
    try {
      window.postMessage({ __YQE: 'stats', stats: computeStats(), config }, '*');
    } catch (e) {}
  }, 1000);

  /* SPA navigation events — each gets a full retry ladder */
  const onNavStart = () => { appliedThisVideo = ''; };
  const onNavFinish = () => {
    appliedThisVideo = '';
    seedQuality();
    retryApply('navigate');
  };
  const NAV_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated'];
  for (const ev of NAV_EVENTS) {
    document.addEventListener(ev, onNavFinish, true);
    window.addEventListener(ev, onNavFinish, true);
  }
  document.addEventListener('yt-navigate-start', onNavStart, true);
  window.addEventListener('yt-navigate-start', onNavStart, true);

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  patchCodecs();
  patchFetch();
  seedQuality();
  setupFeedDataSaver();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { attachVideo(); retryApply('dom'); }, { once: true });
  } else {
    attachVideo();
    retryApply('boot');
  }

  /* public + test API */
  globalThis.YQE = {
    version: VERSION,
    config,
    stats,
    setConfig,
    applyQuality,
    _internal: {
      decide, pickLevel, stripLoudness, makeResponse, noteStall, evalRecovery,
      recovery, attachVideo, findPlayer, findVideo, retryApply, ORDER
    }
  };
})();
