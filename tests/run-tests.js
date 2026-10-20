/*
 * YT Boost — test battery (v1.1.0).
 * Boots the real engine.js inside jsdom (page-world conditions) and the real
 * content.js with a mocked chrome, then attacks every module — including the
 * regression tests for the "only works after a manual reload" bugs:
 *   T13  synchronous engine injection (and async fallback)
 *   T16  eternal watcher catches a video change LONG after v1.0.0's timer died
 *   T17  attach-on-swap applies immediately for freshly created video elements
 *   T18  a player shell with no API methods is never memoized as "applied"
 *
 * Run: npm install && npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const engineSrc = read('engine.js');
const contentSrc = read('content.js');

const BASE_HTML = '<!doctype html><html><head></head><body></body></html>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* Fake ManagedMediaSource simulating the WebKit probe race:
   VP9 wrongly reports unsupported (the documented bug), AV1 "supported". */
function installFakeMedia(win) {
  const fake = {
    isTypeSupported(t) {
      t = String(t).toLowerCase();
      if (t.includes('vp9') || t.includes('vp09')) return false; // race condition
      if (t.includes('av01')) return true;
      if (t.includes('opus')) return true;
      if (t.includes('mp4a')) return true;
      if (t.includes('mp4')) return true;
      return false;
    }
  };
  win.ManagedMediaSource = fake;
  win.MediaSource = fake;
}

function makeWindow() {
  return new JSDOM(BASE_HTML, {
    url: 'https://www.youtube.com/watch?v=abc123',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
}

function bootEngine(dom) {
  dom.window.eval(engineSrc);
  return dom.window.YQE;
}

function fakePlayer(win, opts) {
  opts = opts || {};
  const p = win.document.createElement('div');
  p.id = 'movie_player';
  p.getAvailableQualityLevels = () => opts.levels || ['hd2160', 'hd1440', 'hd1080', 'hd720'];
  const calls = [];
  if (!opts.noRange) p.setPlaybackQualityRange = (a, b) => calls.push(['range', a, b]);
  if (!opts.noSet) p.setPlaybackQuality = (q) => calls.push(['set', q]);
  p.getVideoData = () => ({ video_id: opts.vid || 'vid1' });
  win.document.body.appendChild(p);
  return { p, calls };
}

(async function main() {
  console.log('YT Boost v1.1.0 — test battery\n');

  /* ---- T01 boot ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    ok(!!YQE && YQE.version === '1.1.0', 'T01a engine boots in page world (v1.1.0)');
    ok(YQE.config.targetQuality === 'hd1440', 'T01b default target hd1440');
    dom.window.eval(engineSrc);
    ok(dom.window.YQE === YQE, 'T01c double injection is a no-op');
  }

  /* ---- T02 codec steering ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const w = dom.window;
    const MS = w.MediaSource;
    ok(MS.isTypeSupported('video/webm; codecs="vp9"') === true, 'T02a VP9 forced true (probe-race vaccine)');
    ok(MS.isTypeSupported('video/webm; codecs="av01.0.05M.08"') === false, 'T02b AV1 blocked');
    ok(MS.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') === false, 'T02c AAC blocked (Opus available)');
    ok(MS.isTypeSupported('video/mp4; codecs="avc1.42E01E"') === true, 'T02d H.264 untouched');
    const v = w.document.createElement('video');
    ok(v.canPlayType('video/webm; codecs="vp9"') === 'probably', 'T02e canPlayType VP9 -> probably');
    ok(v.canPlayType('video/webm; codecs="av01"') === '', 'T02f canPlayType AV1 -> empty');
    ok(v.canPlayType('audio/mp4; codecs="mp4a.40.2"') === '', 'T02g canPlayType AAC -> empty');
    void YQE;
  }

  /* ---- T03 preferOpus off -> AAC passes through ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    YQE.setConfig({ preferOpus: false });
    ok(dom.window.MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') === true,
       'T03 AAC passthrough when preferOpus off');
  }

  /* ---- T04 decodingInfo ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    dom.window.navigator.mediaCapabilities = {
      decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true })
    };
    const YQE = bootEngine(dom);
    const r1 = await dom.window.navigator.mediaCapabilities.decodingInfo(
      { video: { contentType: 'video/mp4; codecs="av01.0.05M.08"' } });
    ok(r1.supported === false, 'T04a decodingInfo AV1 -> unsupported');
    const r2 = await dom.window.navigator.mediaCapabilities.decodingInfo(
      { video: { contentType: 'video/webm; codecs="vp9"' } });
    ok(r2.supported === true && r2.smooth === true, 'T04b decodingInfo VP9 -> supported');
    void YQE;
  }

  /* ---- T05 quick start seeds yt-player-quality ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    bootEngine(dom);
    const raw = dom.window.localStorage.getItem('yt-player-quality');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {}
    ok(!!parsed && parsed.data === 'hd1440' && typeof parsed.expiration === 'number',
       'T05 yt-player-quality seeded with exact payload', raw);
  }

  /* ---- T06 quality lock pins via setPlaybackQualityRange ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const { calls } = fakePlayer(dom.window);
    YQE.applyQuality();
    const range = calls.find((c) => c[0] === 'range');
    ok(!!range && range[1] === 'hd1440' && range[2] === 'hd1440',
       'T06 setPlaybackQualityRange pinned (hd1440, hd1440)', JSON.stringify(calls));
    ok(calls.some((c) => c[0] === 'set' && c[1] === 'hd1440'), 'T06b setPlaybackQuality called');
  }

  /* ---- T07 fallbacks: no range method; next-best rung ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const a = fakePlayer(dom.window, { noRange: true, vid: 'v2' });
    YQE.applyQuality();
    ok(a.calls.some((c) => c[0] === 'set' && c[1] === 'hd1440'), 'T07a setPlaybackQuality fallback works');
  }
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const b = fakePlayer(dom.window, { levels: ['hd2160', 'hd1080', 'hd720'], vid: 'v3' });
    YQE.applyQuality();
    ok(b.calls.some((c) => c[0] === 'range' && c[1] === 'hd1080'),
       'T07b next-best rung below missing hd1440 = hd1080', JSON.stringify(b.calls));
  }

  /* ---- T08 stall recovery state machine ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const { calls } = fakePlayer(dom.window);
    const video = dom.window.document.createElement('video');
    video.className = 'html5-main-video';
    dom.window.document.body.appendChild(video);
    YQE._internal.attachVideo();
    video.dispatchEvent(new dom.window.Event('waiting'));
    video.dispatchEvent(new dom.window.Event('waiting'));
    ok(YQE._internal.recovery.downgraded === true, 'T08a two stalls trigger downgrade');
    ok(calls.some((c) => c[0] === 'range' && c[1] === 'hd720'),
       'T08b downgraded to hd720 (two rungs below hd1440)', JSON.stringify(calls));
    let last = null;
    for (let i = 0; i < 10; i++) last = YQE._internal.evalRecovery(25);
    ok(last === 'restore' && YQE._internal.recovery.downgraded === false, 'T08c healthy buffer restores hd1440');
    ok(calls.some((c) => c[0] === 'range' && c[1] === 'hd1440'),
       'T08d restore re-pins hd1440');
    YQE._internal.noteStall(); YQE._internal.noteStall();
    for (let i = 0; i < 9; i++) YQE._internal.evalRecovery(25);
    const r = YQE._internal.evalRecovery(5);
    ok(r === 'wait' && YQE._internal.recovery.downgraded === true,
       'T08e buffer dip resets recovery countdown');
  }

  /* ---- T09 fetch patch strips loudness; non-player URLs untouched ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const playerJson = () => ({
      playerConfig: { audioConfig: { loudnessNormalization: true, stableVolume: true } },
      videoDetails: { video_id: 'x' }
    });
    const stableOther = {
      ok: true, status: 200, url: 'https://www.youtube.com/other',
      clone() { return { json: async () => playerJson() }; },
      json: async () => playerJson()
    };
    const mkRes = (url) => ({
      ok: true, status: 200, url,
      clone() { return { json: async () => playerJson() }; },
      json: async () => playerJson()
    });
    dom.window.fetch = async (input) =>
      String(input) === 'https://www.youtube.com/other' ? stableOther : mkRes(String(input));
    bootEngine(dom);
    const w = dom.window;

    const r1 = await w.fetch('https://www.youtube.com/youtubei/v1/player?key=1');
    const j1 = await r1.json();
    ok(j1.playerConfig.audioConfig.loudnessNormalization === false,
       'T09a loudnessNormalization stripped in player response');
    ok(j1.playerConfig.audioConfig.stableVolume === false, 'T09b stableVolume stripped');

    const r2 = await w.fetch('https://www.youtube.com/other');
    ok(r2 === stableOther, 'T09c non-player URL returns the original response object untouched');

    const r3 = await w.fetch('https://www.youtube.com/watch?v=abc');
    const j3 = await r3.json();
    ok(j3 && j3.videoDetails && j3.videoDetails.video_id === 'x',
       'T09d rebuilt responses still parse with data intact');
  }

  /* ---- T10 config bridge via postMessage ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    fakePlayer(dom.window);
    dom.window.postMessage({ __YQE: 'config', cfg: { targetQuality: 'hd1080' } }, '*');
    await sleep(80);
    ok(YQE.config.targetQuality === 'hd1080', 'T10a config applied from postMessage');
    const saved = JSON.parse(dom.window.localStorage.getItem('yqe-config') || '{}');
    ok(saved.targetQuality === 'hd1080', 'T10b config persisted to localStorage');
    ok(dom.window.localStorage.getItem('yt-player-quality').includes('hd1080'),
       'T10c quick-start reseeded at new target');
  }

  /* ---- T11 setConfig merge keeps unspecified defaults ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    YQE.setConfig({ targetQuality: 'hd2160' });
    ok(YQE.config.forceVP9 === true && YQE.config.stableVolumeOff === true,
       'T11 partial config preserves other defaults');
  }

  /* ---- T12 stats fields ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    fakePlayer(dom.window);
    const video = dom.window.document.createElement('video');
    video.className = 'html5-main-video';
    Object.defineProperty(video, 'videoWidth', { value: 2560 });
    Object.defineProperty(video, 'videoHeight', { value: 1440 });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 600, droppedVideoFrames: 3 });
    dom.window.document.body.appendChild(video);
    YQE._internal.attachVideo();
    YQE.applyQuality();
    const s = YQE.stats;
    ok(s.res === '2560x1440', 'T12a stats resolution', s.res);
    ok(s.dropped === 3 && s.total === 600, 'T12b dropped/total frames');
    ok(s.applied === 'hd1440', 'T12c applied quality');
  }

  /* ---- T13 content script: SYNCHRONOUS injection beats the page ---- */
  {
    const dom = new JSDOM(BASE_HTML, {
      url: 'https://www.youtube.com/watch?v=abc123',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    const w = dom.window;
    installFakeMedia(w);
    w.chrome = {
      runtime: { getURL: (p) => 'chrome-extension://fake/' + p },
      storage: { local: { set: () => {}, get: (d, cb) => cb({}) } }
    };
    // sync XHR mock: engine source is available with ZERO async delay
    w.XMLHttpRequest = function () {
      this.status = 0; this.responseText = '';
      this.open = function () {};
      this.send = function () { this.status = 200; this.responseText = engineSrc; };
    };
    w.eval(contentSrc);
    ok(typeof w.YQE === 'object' && w.YQE.version === '1.1.0',
       'T13a engine EXECUTED synchronously (no await, no sleep)');
    ok(w.MediaSource.isTypeSupported('video/webm; codecs="vp9"') === true,
       'T13b codec patches already live at injection time');
    ok(w.document.querySelectorAll('link[rel="preconnect"]').length >= 2,
       'T13c preconnect hints added');
    ok(w.__YT_BOOST_CS === true, 'T13d content script armed');
  }

  /* ---- T13b async fallback when sync XHR is unavailable ---- */
  {
    const dom = new JSDOM(BASE_HTML, {
      url: 'https://www.youtube.com/watch?v=abc123',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    const w = dom.window;
    installFakeMedia(w);
    w.chrome = {
      runtime: { getURL: (p) => 'chrome-extension://fake/' + p },
      storage: { local: { set: () => {}, get: (d, cb) => cb({}) } }
    };
    // force the sync path to fail -> async fetch fallback
    w.XMLHttpRequest = function () {
      this.status = 0; this.responseText = '';
      this.open = function () { throw new Error('sync blocked'); };
      this.send = function () {};
    };
    w.fetch = async () => ({ ok: true, text: async () => engineSrc });
    w.eval(contentSrc);
    ok(typeof w.YQE !== 'object', 'T13e sync failure does not inject synchronously');
    await sleep(250);
    ok(typeof w.YQE === 'object' && w.YQE.version === '1.1.0',
       'T13f async fetch fallback injects the engine');
  }

  /* ---- T16 THE ETERNAL WATCHER: catches videos long after v1.0.0's
          suicide timer would have died (~31s). Simulate: apply once, wait,
          then swap to a "new video" — the 1s watcher must re-apply. ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const { p, calls } = fakePlayer(dom.window);
    YQE.applyQuality();
    const callsAfterFirst = calls.length;
    // ...minutes pass (in v1.0.0 the retry loop is long dead)...
    // user taps a new video: same player object, new video id
    p.getVideoData = () => ({ video_id: 'vid-much-later' });
    await sleep(2300); // eternal watcher ticks every 1000ms
    ok(calls.length > callsAfterFirst &&
       calls.slice(callsAfterFirst).some((c) => c[0] === 'range' && c[1] === 'hd1440'),
       'T16 eternal watcher re-applies to a NEW video without any reload',
       JSON.stringify(calls));
  }

  /* ---- T17 attach-on-swap: freshly created video element gets an
          immediate check (its early events fired before attachment) ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const { p, calls } = fakePlayer(dom.window, { vid: 'vidA' });
    YQE.applyQuality();
    const before = calls.length;
    // SPA navigation swaps BOTH the video element and the video id
    p.getVideoData = () => ({ video_id: 'vidB' });
    const v2 = dom.window.document.createElement('video');
    v2.className = 'html5-main-video';
    dom.window.document.body.appendChild(v2);
    YQE._internal.attachVideo(); // synchronous immediate check must fire
    ok(calls.length > before &&
       calls.slice(before).some((c) => c[0] === 'range' && c[1] === 'hd1440'),
       'T17 attach-on-swap applies immediately for a fresh video element',
       JSON.stringify(calls.slice(before)));
  }

  /* ---- T18 player shell without API methods must NOT be memoized ---- */
  {
    const dom = makeWindow();
    installFakeMedia(dom.window);
    const YQE = bootEngine(dom);
    const { p, calls } = fakePlayer(dom.window, { noRange: true, noSet: true });
    const r = YQE.applyQuality();
    ok(r === false && calls.length === 0, 'T18a method-less player returns false, calls nothing');
    ok(YQE._internal.findPlayer() === p, 'T18b player is there — watcher will keep retrying');
    // now the API arrives (player finished booting) — the watcher applies
    p.setPlaybackQualityRange = (a, b) => calls.push(['range', a, b]);
    p.setPlaybackQuality = (q) => calls.push(['set', q]);
    await sleep(2300);
    ok(calls.some((c) => c[0] === 'range' && c[1] === 'hd1440'),
       'T18c watcher applies as soon as the player API exists',
       JSON.stringify(calls));
  }

  /* ---- T14 manifest + files lint ---- */
  {
    const m = JSON.parse(read('manifest.json'));
    ok(m.manifest_version === 3, 'T14a manifest v3');
    ok(m.version === '1.1.0', 'T14b version 1.1.0');
    ok(m.content_scripts[0].matches[0] === '*://*.youtube.com/*', 'T14c matches youtube');
    ok(m.permissions.length === 1 && m.permissions[0] === 'storage', 'T14d minimal permissions');
    const war = m.web_accessible_resources || [];
    ok(Array.isArray(war) && war.some((r) => (r.resources || []).includes('engine.js')),
       'T14e engine.js declared web-accessible (content script may fetch it)');
    for (const f of ['engine.js', 'content.js', 'popup.html', 'popup.js', 'README.md']) {
      ok(fs.existsSync(path.join(ROOT, f)), 'T14f file present: ' + f);
    }
  }

  /* ---- T15 engine has no chrome dependency (page-world purity) ---- */
  {
    const usesChrome = /chrome\s*\./.test(engineSrc);
    ok(usesChrome === false, 'T15 engine.js never references chrome.* (safe in page world)');
  }

  console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed, ' + (pass + fail) + ' total');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
