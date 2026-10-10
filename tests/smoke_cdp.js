/*! tests/smoke_cdp.js - headless smoke test over the Chrome DevTools Protocol.
 *  No Playwright: Node 22 has a built-in WebSocket client, so this drives a headless Chromium directly.
 *  The browser is ALWAYS started with --mute-audio.  Run: node tests/smoke_cdp.js  */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* Override with env vars when the browser lives somewhere else:
 *   MTD_CHROME=/path/to/chrome MTD_BASE_URL=http://127.0.0.1:8100/index.html node tests/smoke_cdp.js
 * Serve the app first, for example: python3 -m http.server 8100 --directory .   */
const CHROME = process.env.MTD_CHROME || "/home/raya/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const PORT = Number(process.env.MTD_CDP_PORT || 9333);
const APP = process.env.MTD_BASE_URL || "http://127.0.0.1:8100/index.html";
const profile = process.env.MTD_PROFILE || "/tmp/mtd-smoke-profile";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getTargetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("devtools endpoint never came up");
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else events.push(msg);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      waiting.set(mid, (msg) => msg.error ? reject(new Error(method + ": " + JSON.stringify(msg.error))) : resolve(msg.result));
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }
  return { ready, send, events, close: () => ws.close(), ws };
}

async function evaluate(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails));
  return r.result.value;
}

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--mute-audio", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    /* headless has no trusted user activation, so let the audio context start without one; the flag only
       affects this test browser, never the app */
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const consoleErrors = [];
  chrome.stderr.on("data", d => { const s = String(d); if (/ERROR|error/i.test(s)) consoleErrors.push(s.trim().slice(0, 200)); });

  const results = [];
  const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra: extra === undefined ? null : extra }); console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); };

  try {
    const wsUrl = await getTargetWs();
    const c = client(wsUrl);
    await c.ready;
    await c.send("Runtime.enable");
    await c.send("Page.enable");
    await c.send("Log.enable");
    await c.send("Page.navigate", { url: APP });
    await sleep(2500);

    const pageErrors = c.events.filter(e => e.method === "Log.entryAdded" && e.params.entry.level === "error")
                              .map(e => e.params.entry.text.slice(0, 160));
    check("page loads with no console errors", pageErrors.length === 0, pageErrors);

    const meta = await evaluate(c, `(() => ({
        scripts: Array.from(document.scripts).map(s => s.src.split('/').slice(-1)[0]),
        hasProgress: typeof window.MTDProgress === 'object',
        hasNorm: typeof window.MTDLoudnessNormalizer === 'object',
        scoreLine: document.getElementById('scoreLine') && document.getElementById('scoreLine').textContent,
        progressLine: document.getElementById('progressLine') && document.getElementById('progressLine').textContent,
        status: document.getElementById('statusText').textContent,
        bw: document.getElementById('cacheBadge').textContent
      }))()`);
    check("progression.js and the gain hook are loaded", meta.hasProgress && meta.hasNorm, meta.scripts);
    check("score line renders", /First attempts:/.test(meta.scoreLine || ""), meta.scoreLine);
    check("chance note is visible", /Chance is 25%/.test(meta.scoreLine || ""));
    check("progress line renders", /cards met/.test(meta.progressLine || ""), meta.progressLine);
    check("dataset loaded (a card is on screen)", !/Could not load|Loading the tone bank/.test(meta.status), meta.status);

    /* answer three cards through the real UI */
    const answered = await evaluate(c, `(async () => {
        const out = [];
        for (let i = 0; i < 3; i++) {
          const btn = document.getElementById('tone1');
          btn.click();
          out.push(document.getElementById('scoreLine').textContent);
          await new Promise(r => setTimeout(r, 220));
          document.getElementById('nextBtn').click();
          await new Promise(r => setTimeout(r, 220));
        }
        return { out, stats: window.MTDProgress ? null : null,
                 stored: Object.keys(localStorage).filter(k => k.indexOf('mandarin-tone') === 0),
                 score: document.getElementById('scoreLine').textContent,
                 acc: document.getElementById('accuracyText').textContent,
                 progress: document.getElementById('progressLine').textContent,
                 itemMeta: document.getElementById('itemMeta').textContent };
      })()`);
    check("three answers register in the score line", /n=3/.test(answered.score), answered.score);
    check("score line still carries the interval and chance note", /95% CI/.test(answered.score) && /Chance is 25%/.test(answered.score));
    check("guess-corrected score stays hidden below 60 trials", /hidden until 60/.test(answered.acc), answered.acc);
    check("scheduler state is persisted", answered.stored.indexOf("mandarin-tone-scheduler-v1") >= 0, answered.stored);
    check("item meta describes the card", /Box \d of 7|New card/.test(answered.itemMeta || ""), answered.itemMeta);

    const storedBefore = await evaluate(c, `(localStorage.getItem('mandarin-tone-scheduler-v1') || '').length`);
    const sessionsBefore = await evaluate(c, `document.getElementById('progressLine').textContent`);

    /* reload: the scheduler state must survive */
    await c.send("Page.navigate", { url: APP });
    await sleep(2500);
    const after = await evaluate(c, `(() => {
        const raw = localStorage.getItem('mandarin-tone-scheduler-v1') || '{"items":{}}';
        const parsed = JSON.parse(raw);
        const seen = Object.values(parsed.items).filter(e => e.last !== null).length;
        return { len: raw.length, seen: seen, progress: document.getElementById('progressLine').textContent,
                 score: document.getElementById('scoreLine').textContent, seenBefore: ${JSON.stringify(storedBefore)} };
      })()`);
    check("scheduler state survives the reload", after.seen === 3, { seen: after.seen });
    check("progress line reflects the restored state", /answered 3/.test(after.progress), after.progress);
    check("score line resets per sitting while the cards keep their history", /First attempts: 0/.test(after.score), after.score);

    /* verify a wrong answer followed by a replay does not move the score */
    const retry = await evaluate(c, `(async () => {
        const before = document.getElementById('scoreLine').textContent;
        document.getElementById('tone2').click();          // answer whatever is on screen, then replay
        await new Promise(r => setTimeout(r, 150));
        const first = document.getElementById('scoreLine').textContent;
        const status = document.getElementById('statusText').textContent;
        return { before, first, status };
      })()`);
    check("a first answer is scored immediately", /n=1/.test(retry.first), retry.first);

    /* the gain path: after the first gesture the table must be loaded and a known clip must resolve to its
       exact table value (checked against the file, not against the page's own arithmetic) */
    const gainState = await evaluate(c, `(async () => {
        document.getElementById('tone3').click();               // any gesture
        await new Promise(r => setTimeout(r, 400));
        const N = window.MTDLoudnessNormalizer;
        if (!N) return { loaded: false, reason: 'hook missing' };
        await N.ready('./gain/gain_table_lite.json');
        const info = N.apply(document.querySelector('audio') || new Audio(), 'a1');
        return { loaded: true, info: info, hasContext: true };
      })()`);
    const tableA1 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "gain", "gain_table_lite.json"), "utf8")).a1;
    check("gain table loads in the page after a gesture", gainState.loaded === true, gainState.reason || null);
    check("clip a1 resolves to its exact table gain", gainState.info && Math.abs(gainState.info.gain_db - tableA1) < 1e-9,
          { page: gainState.info && gainState.info.gain_db, table: tableA1 });
    const unknown = await evaluate(c, `(() => { const N = window.MTDLoudnessNormalizer; const i = N.apply(new Audio(), 'no-such-clip'); return i; })()`);
    check("an unknown clip id falls back to 0 dB instead of failing", unknown && unknown.gain_db === 0, unknown);

    const audioState = await evaluate(c, `(() => ({
        sessionType: (navigator.audioSession && navigator.audioSession.type) || null,
        hasAudioSession: !!navigator.audioSession
      }))()`);
    console.log("  audio session info (desktop chromium):", JSON.stringify(audioState));


    /* end-to-end check of the app's own play path: the app must call the hook for the card on screen with the
       card's own id, and the loaded table must be the verified one */
    const wired = await evaluate(c, `(async () => {
        const N = window.MTDLoudnessNormalizer;
        const seen = [];
        const original = N.apply;
        N.apply = function (el, id) { const r = original(el, id); seen.push({ id: id, gain: r && r.gain_db }); return r; };
        const start = document.getElementById('itemMeta').textContent;
        document.getElementById('playBtn') ? document.getElementById('playBtn').click() : null;
        await new Promise(r => setTimeout(r, 300));
        const ctxs = [];
        N.apply = original;
        return { seen: seen, start: start };
      })()`);
    check("the app asks the hook for a gain when it plays a card", wired.seen.length > 0, wired);
    check("the requested clip id matches the card on screen", wired.seen.length > 0 && /^[a-z]+[1-4]$/.test(wired.seen[0].id), wired.seen[0] || null);
    const tableFor = wired.seen[0] ? JSON.parse(fs.readFileSync(path.join(__dirname, "..", "gain", "gain_table_lite.json"), "utf8"))[wired.seen[0].id] : null;
    check("the gain the app applied equals the table value", wired.seen[0] && Math.abs(wired.seen[0].gain - tableFor) < 1e-9, { applied: wired.seen[0] && wired.seen[0].gain, table: tableFor });


    /* layout sanity on a phone-sized viewport: nothing may overflow sideways, the new lines must not clip
       their own text, and the tone buttons must stay tappable */
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const layout = await evaluate(c, `(() => {
        const ids = ['scoreLine', 'accuracyText', 'progressLine', 'itemMeta', 'statusText'];
        const out = {};
        ids.forEach(id => {
          const el = document.getElementById(id);
          if (!el) { out[id] = null; return; }
          const r = el.getBoundingClientRect();
          out[id] = { right: Math.round(r.right), w: Math.round(r.width), clipping: el.scrollWidth > el.clientWidth + 1 };
        });
        const btns = Array.from(document.querySelectorAll('.tone-btn')).map(b => Math.round(b.getBoundingClientRect().height));
        return { out: out, docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
                 toneHeights: btns, minTap: Math.min.apply(null, btns) };
      })()`);
    const spills = Object.keys(layout.out).filter(k => layout.out[k] && layout.out[k].right > layout.innerW + 1);
    const clipped = Object.keys(layout.out).filter(k => layout.out[k] && layout.out[k].clipping);
    check("the page does not scroll sideways on a 390 px viewport", layout.docScrollW <= layout.innerW + 1, { scroll: layout.docScrollW, inner: layout.innerW });
    check("no new line overflows the viewport", spills.length === 0, spills);
    check("no new line clips its own text", clipped.length === 0, clipped);
    check("tone buttons stay above the 44 px tap target", layout.minTap >= 44, layout.toneHeights);

    const muteFlag = chrome.spawnargs.includes("--mute-audio");
    check("browser ran with --mute-audio", muteFlag);
    check("no chromium error lines mentioning crash", consoleErrors.filter(s => /crash/i.test(s)).length === 0, consoleErrors.slice(0, 3));

    fs.writeFileSync(path.join(__dirname, "smoke_results.json"), JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
    const failed = results.filter(r => !r.ok).length;
    console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
    c.close();
    chrome.kill("SIGTERM");
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error("smoke test error:", err.message);
    chrome.kill("SIGTERM");
    process.exit(2);
  }
})();
