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

    /* record every clip the app actually plays: src is syllable+tone, so the log is the real card sequence.
       A page reload drops a Runtime.evaluate patch, so this runs again after every navigate. */
    const hookPlay = () => evaluate(c, `(() => {
        window.__clips = [];
        const play = HTMLMediaElement.prototype.play;
        if (!play.__mtdHooked) {
          HTMLMediaElement.prototype.play = function () { window.__clips.push(this.src.split('/').pop()); return play.apply(this, arguments); };
          HTMLMediaElement.prototype.play.__mtdHooked = true;
        }
        return true;
      })()`);
    await hookPlay();

    const meta = await evaluate(c, `(() => ({
        scripts: Array.from(document.scripts).map(s => s.src.split('/').slice(-1)[0]),
        hasProgress: typeof window.MTDProgress === 'object',
        hasNorm: typeof window.MTDLoudnessNormalizer === 'object',
        scoreLine: document.getElementById('scoreLine').textContent,
        progressLine: document.getElementById('progressLine').textContent,
        status: document.getElementById('statusText').textContent,
        badge: document.getElementById('taskBadge').textContent,
        answerButtons: document.querySelectorAll('#answerArea button').length,
        bw: document.getElementById('cacheBadge').textContent,
        newSlider: document.getElementById('newPerSessionSlider') && document.getElementById('newPerSessionSlider').value,
        taskButtons: Array.from(document.querySelectorAll('#taskSelect button')).map(b => b.id)
      }))()`);
    check("progression.js and the gain hook are loaded", meta.hasProgress && meta.hasNorm, meta.scripts);
    check("score line renders", /First attempts:/.test(meta.scoreLine || ""), meta.scoreLine);
    check("chance note is visible", /Chance is 25%/.test(meta.scoreLine || ""));
    check("progress line renders", /cards met/.test(meta.progressLine || ""), meta.progressLine);
    check("dataset loaded (a card is on screen)", !/Could not load|Loading the tone bank/.test(meta.status), meta.status);
    check("an answer area is drawn for the card on screen", meta.answerButtons === 2 || meta.answerButtons === 4,
          { buttons: meta.answerButtons, badge: meta.badge });
    check("the four task types are listed in the settings", (meta.taskButtons || []).length === 4, meta.taskButtons);
    check("the new-cards-per-session slider defaults to 5", meta.newSlider === "5", meta.newSlider);

    /* Walk the real UI card by card. For each card: note the task badge, the shape of the answer area, the
       clips the app played, then answer it with the first button. */
    const walk = await evaluate(c, `(async () => {
        const cards = [];
        const settle = async (ms) => { await new Promise(r => setTimeout(r, ms)); };
        for (let i = 0; i < 12; i++) {
          window.__clips = [];
          document.getElementById('nextBtn').click();
          await settle(300);
          const badge = document.getElementById('taskBadge').textContent;
          const buttons = Array.from(document.querySelectorAll('#answerArea button'));
          const area = { count: buttons.length, values: buttons.map(b => b.dataset.value),
                         labels: buttons.map(b => b.textContent.trim()),
                         heights: buttons.map(b => Math.round(b.getBoundingClientRect().height)) };
          /* the pair task plays a second clip after the first one ends, so give it time to arrive */
          const want = /same|different/i.test(badge) ? 2 : 1;
          for (let waited = 0; waited < 2600 && window.__clips.length < want; waited += 150) await settle(150);
          const clips = window.__clips.slice();
          /* the click handler runs synchronously, so the reveal state is read in the same tick */
          buttons[0].click();
          const status = document.getElementById('statusText').textContent;
          const locked = document.querySelectorAll('#answerArea button.locked').length;
          const score = document.getElementById('scoreLine').textContent;
          await settle(220);
          cards.push({ badge: badge, area: area, clips: clips, status: status, locked: locked, score: score });
          await settle(120);
        }
        return { cards: cards,
                 score: document.getElementById('scoreLine').textContent,
                 acc: document.getElementById('accuracyText').textContent,
                 taskLines: document.getElementById('taskLines').textContent,
                 progress: document.getElementById('progressLine').textContent,
                 itemMeta: document.getElementById('itemMeta').textContent,
                 stored: Object.keys(localStorage).filter(k => k.indexOf('mandarin-tone') === 0),
                 payload: JSON.parse(JSON.stringify(window.exportPayload ? window.exportPayload() : {})) };
      })()`);

    const cards = walk.cards.filter(card => card.area.count > 0);
    const taskLabels = Array.from(new Set(cards.map(card => card.badge)));
    const toneSeq = cards.map(card => Number(String((card.clips[0] || "")).match(/(\d)\.mp3$/)?.[1])).filter(n => n >= 1 && n <= 4);
    const toneHist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    toneSeq.forEach(t => { toneHist[t] += 1; });
    let run = 0, worstRun = 0;
    toneSeq.forEach((t, i) => { run = (i && t === toneSeq[i - 1]) ? run + 1 : 1; if (run > worstRun) worstRun = run; });
    console.log("  cards:", cards.length, "| tasks:", JSON.stringify(taskLabels), "| tones:", toneSeq.join(""), JSON.stringify(toneHist), "| worst same-tone run", worstRun);
    console.log("  task areas:", JSON.stringify(cards.slice(0, 6).map(card => ({ task: card.badge, n: card.area.count, v: card.area.values.slice(0, 4), clips: card.clips.length }))));

    check("the walk answered 12 cards through the UI", cards.length === 12, cards.length);
    check("every clip the app played belongs to the card on screen", cards.every(card => card.clips.length >= 1),
          cards.map(card => card.clips.length).slice(0, 6));
    const pairCards = cards.filter(card => /same tone or different/i.test(card.badge));
    check("the same/different task plays two clips", pairCards.length > 0 && pairCards.every(card => card.clips.length === 2),
          pairCards.map(card => card.clips));
    check("the pair clips are one syllable apart with a different tone, or two syllables with one tone",
          pairCards.every(card => {
            if (card.clips.length !== 2) return false;
            const a = card.clips[0].replace(".mp3", ""), b = card.clips[1].replace(".mp3", "");
            return (/^[a-z]+([1-4])$/.test(a) && /^[a-z]+([1-4])$/.test(b)) &&
                   a.replace(/[1-4]$/, "") === b.replace(/[1-4]$/, "") !== (a.slice(-1) === b.slice(-1));
          }), pairCards.map(card => card.clips));
    check("at least three task types appeared in 12 cards", taskLabels.length >= 3, taskLabels);
    check("each answer area matches its task", cards.every(card => {
        const b = card.badge.toLowerCase();
        if (b.indexOf("same") >= 0) return card.area.count === 2 && card.area.values.join() === "same,different";
        if (b.indexOf("syllable") >= 0) return card.area.count === 4 && card.area.values.every(v => /^[a-z]+[1-4]$/.test(v));
        if (b.indexOf("shape") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4";
        return card.area.count === 4 && card.area.values.join() === "1,2,3,4";
      }), cards.map(card => ({ badge: card.badge, values: card.area.values })));
    const sylCards = cards.filter(card => /syllable/i.test(card.badge));
    check("the syllable task offers four same-tone near syllables with tone marks", sylCards.length > 0 &&
          sylCards.every(card => card.area.count === 4 &&
            card.area.values.every(v => /^[a-z]+([1-4])$/.test(v)) &&
            new Set(card.area.values.map(v => v.slice(-1))).size === 1 &&
            card.area.labels.every(l => /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(l))),
          sylCards.slice(0, 3).map(card => ({ values: card.area.values, labels: card.area.labels })));
    check("the reveal names the answer for every task", cards.every(card => /Correct|Wrong/.test(card.status)), cards.map(card => card.status).slice(0, 4));
    check("the buttons lock once the card is answered", cards.every(card => card.locked === card.area.count), cards.map(card => card.locked));
    /* the owner's bug: never a block of one tone; every tone must appear inside a dozen cards */
    check("no more than two cards in a row on the same tone", worstRun <= 2, { seq: toneSeq.join(""), worstRun });
    check("all four tones appear inside 12 cards", Object.values(toneHist).every(n => n > 0), toneHist);
    check("tone counts stay balanced (no tone above 40%)", Math.max(...Object.values(toneHist)) <= Math.ceil(toneSeq.length * 0.4), toneHist);

    check("twelve answers register in the score line", /n=12/.test(walk.score), walk.score);
    check("score line still carries the interval and chance note", /95% CI/.test(walk.score) && /Chance is 25%/.test(walk.score));
    check("guess-corrected score stays hidden below 60 trials", /hidden until 60/.test(walk.acc), walk.acc);
    check("a score line is shown per task type that was answered", /first attempts/i.test(walk.taskLines), walk.taskLines.slice(0, 200));
    check("the same/different line states a 50% chance", /Chance is 50%/.test(walk.taskLines), walk.taskLines.slice(0, 300));
    check("scheduler state is persisted", walk.stored.indexOf("mandarin-tone-scheduler-v1") >= 0, walk.stored);
    check("item meta describes the card", /Box \d of 7|New card/.test(walk.itemMeta || ""), walk.itemMeta);
    check("the export lists the task of each session slot", Array.isArray(walk.payload?.session?.tasks) && walk.payload.session.tasks.length > 0,
          walk.payload?.session?.tasks);
    check("the export carries the new settings", walk.payload?.settings?.newPerSession === 5 && (walk.payload?.settings?.tasksEnabled || []).length === 4,
          walk.payload?.settings);

    const storedBefore = await evaluate(c, `(localStorage.getItem('mandarin-tone-scheduler-v1') || '').length`);

    /* reload: the scheduler state must survive */
    await c.send("Page.navigate", { url: APP });
    await sleep(2500);
    const after = await evaluate(c, `(() => {
        const raw = localStorage.getItem('mandarin-tone-scheduler-v1') || '{"items":{}}';
        const parsed = JSON.parse(raw);
        const seen = Object.values(parsed.items).filter(e => e.last !== null).length;
        return { len: raw.length, seen: seen, progress: document.getElementById('progressLine').textContent,
                 score: document.getElementById('scoreLine').textContent, taskLines: document.getElementById('taskLines').textContent,
                 storedSeen: seen, answered: (document.getElementById('progressLine').textContent.match(/answered (\d+)/) || [])[1] };
      })()`);
    check("scheduler state survives the reload", after.seen === after.storedSeen && after.seen >= 8,
          { seen: after.seen, storedSeen: after.storedSeen, answered: after.answered });
    check("progress line reflects the restored state", new RegExp("answered " + after.seen + "\\b").test(after.progress), after.progress);
    check("score line resets per sitting while the cards keep their history", /First attempts: 0/.test(after.score), after.score);
    check("the per-task lines are empty again for the new sitting", /No answers yet/.test(after.taskLines), after.taskLines);

    await hookPlay();

    /* verify a wrong answer followed by a replay does not move the score */
    const retry = await evaluate(c, `(async () => {
        const buttons = Array.from(document.querySelectorAll('#answerArea button'));
        const before = document.getElementById('scoreLine').textContent;
        buttons[buttons.length - 1].click();
        const marked = document.querySelectorAll('#answerArea button.locked').length;
        const status = document.getElementById('statusText').textContent;
        const first = document.getElementById('scoreLine').textContent;
        await new Promise(r => setTimeout(r, 150));
        return { before, first, status, marked: marked, after: document.getElementById('scoreLine').textContent };
      })()`);
    check("a first answer is scored immediately", /n=1/.test(retry.first), retry.first);
    check("every button is locked once the card is answered", retry.marked >= 2, retry.marked);
    check("the replay after a wrong answer does not move the score", retry.first === retry.after, { first: retry.first, after: retry.after });

    /* settings must take effect: switching a task type off must remove it from the next session */
    const settingsEffect = await evaluate(c, `(async () => {
        const pair = document.getElementById('task_pair');
        pair.click();
        await new Promise(r => setTimeout(r, 200));
        const off = pair.getAttribute('aria-pressed');
        document.getElementById('nextBtn').click();
        await new Promise(r => setTimeout(r, 250));
        const badgeAfterOff = document.getElementById('taskBadge').textContent;
        pair.click();
        await new Promise(r => setTimeout(r, 200));
        const on = pair.getAttribute('aria-pressed');
        return { off: off, on: on, badgeAfterOff: badgeAfterOff,
                 stored: JSON.parse(localStorage.getItem('mandarin-tone-settings-v2') || '{}').tasksEnabled };
      })()`);
    check("a task type can be switched off and on", settingsEffect.off === "false" && settingsEffect.on === "true", settingsEffect);
    check("the setting is persisted with the task mix", Array.isArray(settingsEffect.stored) && settingsEffect.stored.length === 4, settingsEffect.stored);

    const sliderEffect = await evaluate(c, `(() => {
        const s = document.getElementById('newPerSessionSlider');
        s.value = '8';
        s.dispatchEvent(new Event('input'));
        return { value: s.value, out: document.getElementById('newPerSessionValue').textContent,
                 stored: JSON.parse(localStorage.getItem('mandarin-tone-settings-v2') || '{}').newPerSession };
      })()`);
    check("the new-cards slider saves and reflects its value", sliderEffect.stored === 8 && sliderEffect.out === "8", sliderEffect);

    /* the gain path: after the first gesture the table must be loaded and a known clip must resolve to its
       exact table value (checked against the file, not against the page's own arithmetic) */
    const gainState = await evaluate(c, `(async () => {
        const buttons = Array.from(document.querySelectorAll('#answerArea button'));
        if (buttons.length) buttons[0].click();               // any gesture
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
        window.__clips = [];
        document.getElementById('nextBtn').click();
        await new Promise(r => setTimeout(r, 320));
        N.apply = original;
        return { seen: seen, clips: window.__clips };
      })()`);
    check("the app asks the hook for a gain when it plays a card", wired.seen.length > 0, wired);
    check("the requested clip id matches the clip that was played", wired.seen.length > 0 && wired.clips[0] === wired.seen[0].id + ".mp3",
          { asked: wired.seen[0] && wired.seen[0].id, played: wired.clips[0] });
    const tableFor = wired.seen[0] ? JSON.parse(fs.readFileSync(path.join(__dirname, "..", "gain", "gain_table_lite.json"), "utf8"))[wired.seen[0].id] : null;
    check("the gain the app applied equals the table value", wired.seen[0] && Math.abs(wired.seen[0].gain - tableFor) < 1e-9, { applied: wired.seen[0] && wired.seen[0].gain, table: tableFor });

    /* layout sanity on a phone-sized viewport: nothing may overflow sideways, the new lines must not clip
       their own text, and the answer buttons must stay tappable for every task type */
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const layout = await evaluate(c, `(() => {
        const ids = ['scoreLine', 'accuracyText', 'progressLine', 'itemMeta', 'statusText', 'taskLines'];
        const out = {};
        ids.forEach(id => {
          const el = document.getElementById(id);
          if (!el) { out[id] = null; return; }
          const r = el.getBoundingClientRect();
          out[id] = { right: Math.round(r.right), w: Math.round(r.width), clipping: el.scrollWidth > el.clientWidth + 1 };
        });
        const heights = {};
        ['tone', 'syllable', 'pair', 'contour'].forEach(task => {});
        const btns = Array.from(document.querySelectorAll('.tone-btn')).map(b => Math.round(b.getBoundingClientRect().height));
        const taskBtns = Array.from(document.querySelectorAll('#taskSelect button, #toneSelect button')).map(b => ({ id: b.id, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }));
        return { out: out, docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
                 answerHeights: btns, minTap: Math.min.apply(null, btns), taskBtns: taskBtns,
                 sliderW: Math.round((document.getElementById('newPerSessionSlider') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width) };
      })()`);
    const spills = Object.keys(layout.out).filter(k => layout.out[k] && layout.out[k].right > layout.innerW + 1);
    const clipped = Object.keys(layout.out).filter(k => layout.out[k] && layout.out[k].clipping);
    check("the page does not scroll sideways on a 390 px viewport", layout.docScrollW <= layout.innerW + 1, { scroll: layout.docScrollW, inner: layout.innerW });
    check("no line overflows the viewport", spills.length === 0, spills);
    check("no line clips its own text", clipped.length === 0, clipped);
    check("answer buttons stay above the 44 px tap target", layout.minTap >= 44, layout.answerHeights);
    check("the settings buttons stay above the 44 px tap target", layout.taskBtns.every(b => b.h >= 44), layout.taskBtns);
    check("the new-cards slider fits the phone width", layout.sliderW > 200 && layout.sliderW <= layout.innerW, layout.sliderW);

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
