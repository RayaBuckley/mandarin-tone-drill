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

/* A page is ready when the clip deck is loaded and the card area is drawn: a fixed sleep is a race, and the
   revision-5 build fetches the sentence pack on top of the clips. */
async function waitReady(c, budgetMs) {
  const until = Date.now() + (budgetMs || 12000);
  for (;;) {
    let ready = false;
    try {
      ready = await evaluate(c, `(() => {
          const items = typeof ITEMS !== "undefined" && Array.isArray(ITEMS) ? ITEMS.length : 0;
          const area = document.getElementById("answerArea");
          return items > 0 && !!area && area.children.length > 0;
        })()`);
    } catch (err) { ready = false; }
    if (ready) return true;
    if (Date.now() > until) return false;
    await sleep(120);
  }
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
    check("the drill is ready after a cold load", await waitReady(c, 15000), "deck and card area drawn");

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
        progressDetail: document.getElementById('progressDetail').textContent,
        h1: document.querySelectorAll('h1').length,
        explainers: /How scoring and scheduling work|Update behavior/.test(document.body.textContent),
        drillVisible: !document.getElementById('screenDrill').hidden,
        status: document.getElementById('statusText').textContent,
        badge: document.getElementById('taskBadge').textContent,
        answerButtons: document.querySelectorAll('#answerArea button').length,
        bw: document.getElementById('cacheBadge').textContent,
        newSlider: document.getElementById('newPerSessionSlider') && document.getElementById('newPerSessionSlider').value,
        taskButtons: Array.from(document.querySelectorAll('#taskSelect button')).map(b => b.id)
      }))()`);
    check("progression.js and the gain hook are loaded", meta.hasProgress && meta.hasNorm, meta.scripts);
    check("score line renders", /First attempts:/.test(meta.scoreLine || ""), meta.scoreLine);
    check("chance note is visible", /Chance is \d/.test(meta.scoreLine || ""), meta.scoreLine);
    check("progress line renders", /Session \d+\/\d+/.test(meta.progressLine || ""), meta.progressLine);
    check("the detail line renders on the settings screen", /cards met/.test(meta.progressDetail || ""), meta.progressDetail);
    check("the drill opens on its own screen, without a title or explainer text",
          meta.drillVisible === true && meta.h1 === 0 && meta.explainers === false,
          { drillVisible: meta.drillVisible, h1: meta.h1, explainers: meta.explainers });
    check("dataset loaded (a card is on screen)", !/Could not load|Loading the tone bank/.test(meta.status), meta.status);
    check("an answer area is drawn for the card on screen", meta.answerButtons === 2 || meta.answerButtons === 4,
          { buttons: meta.answerButtons, badge: meta.badge });
    check("every task type is listed in the settings, including the archived one",
          (meta.taskButtons || []).length === 6 && meta.taskButtons.indexOf("task_tone") >= 0, meta.taskButtons);
    check("the new-cards-per-session slider defaults to 5", meta.newSlider === "5", meta.newSlider);

    /* Walk the real UI card by card. For each card: note the task badge, the shape of the answer area, the
       clips the app played, then answer it with the first button. */
    const walk = await evaluate(c, `(async () => {
        const cards = [];
        const settle = async (ms) => { await new Promise(r => setTimeout(r, ms)); };
        /* relative luminance of a computed colour: this is what a grayscale screen shows */
        const lum = (color) => {
          const m = (color.match(/[0-9.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
          const f = m.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
          return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
        };
        for (let i = 0; i < 12; i++) {
          window.__clips = [];
          document.getElementById('nextBtn').click();
          await settle(300);
          const badge = document.getElementById('taskBadge').textContent;
          /* revision 5: the sequence tasks are named by their real length ("One tone of 4", "All 4 tones in
             order"), and the sentence demo deals a whole-sentence card of its own. */
          const recallCard = /all [0-9]+ tones/i.test(badge);
          const seqCard = /one tone of [0-9]+/i.test(badge) || recallCard;
          const sentenceCard = /sentence demo/i.test(badge);
          const pairCard = /first/i.test(badge);
          /* the sequence length is a setting now, so ask the app how many clips a run holds */
          const runLen = typeof sequenceLength === 'function' ? sequenceLength() : 3;
          const want = pairCard ? 2 : (seqCard || recallCard) ? runLen : 1;
          const titleBefore = document.getElementById('answerTitle').textContent;
          const disabledBefore = document.querySelectorAll('#answerArea button[disabled]').length;
          /* the pair task plays a second clip, a sequence card plays three: give them time to arrive */
          for (let waited = 0; waited < 4000 && window.__clips.length < want; waited += 150) await settle(150);
          const clips = window.__clips.slice();
          /* a sequence card only lets you answer once every clip has played */
          if (seqCard) for (let waited = 0; waited < 3000 && document.querySelectorAll('#answerArea button[disabled]').length; waited += 150) await settle(150);
          const titleAfter = document.getElementById('answerTitle').textContent;
          const buttons = Array.from(document.querySelectorAll('#answerArea button'));
          const area = { count: buttons.length, values: buttons.map(b => b.dataset.value),
                         labels: buttons.map(b => b.textContent.trim()),
                         heights: buttons.map(b => Math.round(b.getBoundingClientRect().height)),
                         slots: document.querySelectorAll('#answerArea .seq-slot').length };
          /* answer it: the first button once, or one tap per position on a whole-sequence card */
          const taps = recallCard ? document.querySelectorAll('#answerArea .seq-slot').length : 1;
          for (let t = 0; t < taps; t++) {
            const live = Array.from(document.querySelectorAll('#answerArea button:not([disabled])'));
            if (!live.length) break;
            live[0].click();
            await settle(taps > 1 ? 60 : 0);
          }
          const status = document.getElementById('statusText').textContent;
          const locked = document.querySelectorAll('#answerArea button.locked').length;
          const score = document.getElementById('scoreLine').textContent;
          const answered = Array.from(document.querySelectorAll('#answerArea button'));
          const markOf = (b) => { const m = b.querySelector('.mark'); return m ? m.textContent : ""; };
          const cls = (b) => Array.from(b.classList).filter(x => x === 'correct' || x === 'wrong' || x === 'picked').join(' ');
          /* the mark and the colour are both set in the click tick, so read them right away */
          const marksNow = answered.map(b => ({ value: b.dataset.value, cls: cls(b), mark: markOf(b) }));
          const slots = Array.from(document.querySelectorAll('#answerArea .seq-slot')).map(s => ({ text: s.textContent.trim(), cls: Array.from(s.classList).filter(x => x !== 'seq-slot').join(' ') }));
          const rev = document.getElementById('revealBox');
          const reveal = { shown: rev ? rev.classList.contains('shown') : null,
                           rows: rev ? rev.querySelectorAll('.reveal-row').length : 0,
                           contours: rev ? rev.querySelectorAll('svg.contour').length : 0,
                           pinyin: rev ? Array.from(rev.querySelectorAll('.reveal-pinyin')).map(s => s.textContent) : [],
                           tones: rev ? Array.from(rev.querySelectorAll('.reveal-tone')).map(s => s.textContent) : [],
                           replay: !!(rev && rev.querySelector('#revealReplay')) };
          await settle(280);
          const marks = marksNow.map(m => { const el = document.querySelector('#answerArea button[data-value="' + m.value + '"]');
            return { value: m.value, cls: m.cls, mark: m.mark, live: !!el,
                     lum: lum(getComputedStyle(el || document.createElement('button')).backgroundColor) }; });
          const statusBoxOk = document.getElementById('statusBox').classList.contains('ok');
          const statusBoxBad = document.getElementById('statusBox').classList.contains('bad');
          const statusMark = document.getElementById('statusMark').textContent;
          await settle(220);
          cards.push({ badge: badge, sentenceCard: sentenceCard, area: area, clips: clips, status: status, locked: locked, score: score, reveal: reveal,
                       schedTone: typeof currentTone === 'number' ? currentTone : null,
                       sessionIndex: typeof sessionIndex === 'number' ? sessionIndex : null,
                       marks: marks, slots: slots, titleBefore: titleBefore, titleAfter: titleAfter,
                       disabledBefore: disabledBefore, statusBoxOk: statusBoxOk, statusBoxBad: statusBoxBad, statusMark: statusMark });
          await settle(140);
        }
        return { cards: cards,
                 score: document.getElementById('scoreLine').textContent,
                 acc: document.getElementById('accuracyText').textContent,
                 taskLines: document.getElementById('taskLines').textContent,
                 progress: document.getElementById('progressLine').textContent,
                 toneLines: document.getElementById('toneLines').textContent,
                 focusLabel: document.getElementById('focusWeakTones').textContent,
                 focusPressed: document.getElementById('focusWeakTones').getAttribute('aria-pressed'),
                 toneTaskPressed: document.getElementById('task_tone').getAttribute('aria-pressed'),
                 toneTaskLabel: document.getElementById('task_tone').textContent,
                 itemMeta: document.getElementById('itemMeta').textContent,
                 stored: Object.keys(localStorage).filter(k => k.indexOf('mandarin-tone') === 0),
                 payload: JSON.parse(JSON.stringify(window.exportPayload ? window.exportPayload() : {})) };
      })()`);

    const cards = walk.cards.filter(card => card.area.count > 0);
    /* Sentence-demo cards are not clip cards: their reveals carry a whole sentence, not a syllable, so the
       clip-task assertions below run on the clip cards and the sentence assertions run on their own set. */
    const clipCards = cards.filter(card => !card.sentenceCard);
    const sentCards = cards.filter(card => card.sentenceCard);
    const taskLabels = Array.from(new Set(clipCards.map(card => card.badge)));
    const heardTone = (card) => Number(String((card.clips[0] || "")).match(/([1-4])\.mp3$/)?.[1]);
    const toneSeq = cards.map(card => card.schedTone).filter(n => n >= 1 && n <= 4);
    const toneHist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    toneSeq.forEach(t => { toneHist[t] += 1; });
    /* The scheduler's tone rules are per session, and a walk can cross the end of one: measure the
       same-tone runs inside each session group (the whole-session rules are covered by the unit tests). */
    let worstRun = 0;
    const sessionGroups = new Map();
    cards.forEach(card => {
      const key = card.sessionIndex === null || card.sessionIndex === undefined ? -1 : card.sessionIndex;
      if (!sessionGroups.has(key)) sessionGroups.set(key, []);
      sessionGroups.get(key).push(card);
    });
    sessionGroups.forEach(group => {
      const tones = group.map(card => card.schedTone).filter(n => n >= 1 && n <= 4);
      let run = 0;
      tones.forEach((t, i) => { run = (i && t === tones[i - 1]) ? run + 1 : 1; if (run > worstRun) worstRun = run; });
    });
    console.log("  cards:", cards.length, "| sessions:", JSON.stringify(Array.from(sessionGroups.values()).map(g => g.length)),
                "| tasks:", JSON.stringify(taskLabels), "| scheduled tones:", toneSeq.join(""), JSON.stringify(toneHist), "| worst same-tone run", worstRun);
    console.log("  first-clip tones:", cards.map(heardTone).join(""));
    console.log("  task areas:", JSON.stringify(cards.slice(0, 6).map(card => ({ task: card.badge, n: card.area.count, v: card.area.values.slice(0, 4), clips: card.clips.length }))));

    check("the walk answered 12 cards through the UI", cards.length === 12, cards.length);
    check("every clip the app played belongs to the card on screen", cards.every(card => card.clips.length >= 1),
          cards.map(card => card.clips.length).slice(0, 6));
    const pairCards = clipCards.filter(card => /which tone was first/i.test(card.badge));
    check("the pair task plays two clips", pairCards.length > 0 && pairCards.every(card => card.clips.length === 2),
          pairCards.map(card => card.clips));
    check("the pair clips are the same syllable with two different tones",
          pairCards.every(card => {
            if (card.clips.length !== 2) return false;
            const a = card.clips[0].replace(".mp3", ""), b = card.clips[1].replace(".mp3", "");
            return (/^[a-z]+([1-4])$/.test(a) && /^[a-z]+([1-4])$/.test(b)) &&
                   a.replace(/[1-4]$/, "") === b.replace(/[1-4]$/, "") && a.slice(-1) !== b.slice(-1);
          }), pairCards.map(card => card.clips));
    check("the pair task asks about clip A and offers the four tones",
          pairCards.every(card => card.area.count === 4 && card.area.values.join() === "1,2,3,4"), pairCards.map(card => card.area.values));
    const pairWrong = pairCards.filter(card => /^Wrong/.test(card.status));
    check("the pair status line names clip A and clip B",
          pairWrong.length >= 1 && pairWrong.every(card => /clip A was .*\(tone [1-4], (high|rising|dipping|falling)\), clip B was .*\(tone [1-4]/.test(card.status)),
          pairCards.map(card => card.status));
    check("the pair reveal names both clips with tone marks",
          pairWrong.length >= 1 && pairWrong.every(card => card.reveal.rows === 2 && card.reveal.pinyin.length === 2 &&
                                  card.reveal.pinyin.every(p => /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(p)) &&
                                  card.reveal.tones.every(s => /tone [1-4] · (high|rising|dipping|falling)/.test(s))),
          pairCards.map(card => card.reveal));
    check("at least three task types appeared in 12 cards", taskLabels.length >= 3, taskLabels);
    /* the reveal panel after every answer: pinyin, tone name, contour shape, unscored replay */
    const wrongCards = clipCards.filter(card => /^Wrong/.test(card.status));
    /* Cards that grade the four tone buttons: a sentence card grades its own rows and a whole-sequence
       card grades its chips, so each of those is judged by its own check instead. */
    const rightCards = cards.filter(card => /^Correct/.test(card.status) && !card.sentenceCard &&
                                            card.marks.some(m => m.cls === 'correct'));
    check("every wrong answer reveals the syllable in tone-marked pinyin, its tone and a replay",
          wrongCards.length >= 2 && wrongCards.every(card => card.reveal.shown && card.reveal.rows >= 1 &&
                              card.reveal.pinyin.length >= 1 && card.reveal.tones.length >= 1 && card.reveal.replay === true &&
                              card.reveal.pinyin.every(p => /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(p))),
          wrongCards.slice(0, 2).map(card => card.reveal));
    check("a correct answer shows no reveal at all", rightCards.every(card => card.reveal.shown === false),
          rightCards.map(card => card.reveal.shown));
    const oneClipWrong = wrongCards.filter(card => !/one tone of|all \d+ tones/i.test(card.badge));
    check("every single-clip reveal carries a pitch-shape diagram",
          oneClipWrong.length >= 2 && oneClipWrong.every(card => card.reveal.contours === card.reveal.rows),
          wrongCards.map(card => ({ badge: card.badge, contours: card.reveal.contours, rows: card.reveal.rows })));
    /* grayscale: the verdict must survive with no colour at all - a bright true answer, a dark wrong tap,
       a tick, a cross, and a faded rest */
    const graySet = wrongCards.filter(card => card.area.count === 4 && card.marks.some(m => m.cls === 'correct') &&
                                              card.marks.some(m => m.cls === 'wrong'));
    check("in grayscale the true answer is the brightest button and the wrong tap the darkest",
          graySet.length >= 2 && graySet.every(card => {
            const correct = card.marks.find(m => m.cls === 'correct');
            const wrong = card.marks.find(m => m.cls === 'wrong');
            const rest = card.marks.filter(m => !m.cls);
            const restTop = rest.length ? Math.max.apply(null, rest.map(m => m.lum)) : 0;
            return correct.lum > restTop + 0.05 && correct.lum - wrong.lum >= 0.25;
          }),
          graySet.slice(0, 2).map(card => card.marks.map(m => ({ cls: m.cls, live: m.live, lum: Number(m.lum.toFixed(3)) }))));
    check("the verdict is also carried by a tick, a cross and a lit status line",
          rightCards.length >= 1 &&
          graySet.every(card => card.marks.find(m => m.cls === 'correct').mark === "\u2713" &&
                                card.marks.find(m => m.cls === 'wrong').mark === "\u2717" &&
                                card.statusBoxBad === true && card.statusMark === "\u2717") &&
          rightCards.every(card => card.marks.find(m => m.cls === 'correct')?.mark === "\u2713" &&
                                   card.statusBoxOk === true && card.statusMark === "\u2713" && card.statusBoxBad === false),
          { wrong: graySet.map(card => card.marks.map(m => m.mark)), right: rightCards.map(card => card.marks.map(m => m.mark)) });
    check("the per-tone accuracy line is shown", /Tone accuracy \(first attempts\): 1 /.test(walk.toneLines || ""), walk.toneLines);
    check("the focus switch is off by default and says what it reads", walk.focusPressed === "false" && /Focus my weakest tones/.test(walk.focusLabel || ""),
          { pressed: walk.focusPressed, label: walk.focusLabel });
    check("each answer area matches its task", cards.every(card => {
        const b = card.badge.toLowerCase();
        if (b.indexOf("sentence demo") >= 0) return card.area.count === 4 && card.clips.length === 1 &&
                                                    card.area.values.join() === "0,1,2,3";
        if (b.indexOf("one tone of") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4" &&
                                                  card.clips.length === 3 && card.area.slots === 0;
        if (/^all \d+ tones/.test(b)) return card.area.count === 4 && card.area.values.join() === "1,2,3,4" &&
                                              card.clips.length === 3 && card.area.slots === 3;
        if (b.indexOf("first") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4" && card.clips.length === 2;
        if (b.indexOf("syllable") >= 0) return card.area.count === 4 && card.area.values.every(v => /^[a-z]+[1-4]$/.test(v));
        if (b.indexOf("shape") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4";
        return card.area.count === 4 && card.area.values.join() === "1,2,3,4";
      }), cards.map(card => ({ badge: card.badge, values: card.area.values, clips: card.clips.length, slots: card.area.slots })));

    /* the owner's ask: three syllables, then a question about ONE of them that could not be known in advance */
    const seqTargets = clipCards.filter(card => /one tone of \d+/i.test(card.badge));
    check("the sequence task plays every clip before it says which one it asks about",
          seqTargets.length > 0 && seqTargets.every(card => card.clips.length === 3 && card.disabledBefore === 4 &&
                                                            !/syllable \d/.test(card.titleBefore) && /syllable \d/.test(card.titleAfter)),
          seqTargets.slice(0, 3).map(card => ({ clips: card.clips.length, disabled: card.disabledBefore, before: card.titleBefore, after: card.titleAfter })));
    check("the asked position moves from card to card",
          new Set(seqTargets.map(card => (card.titleAfter.match(/syllable (\d)/) || [])[1])).size >= 2 ||
          seqTargets.length < 3,
          seqTargets.map(card => card.titleAfter));
    const seqRecalls = clipCards.filter(card => /all \d+ tones/i.test(card.badge));
    /* A whole-sequence card is a 1-in-64 chance, so twelve random cards often hold none of them: the check
       only judges the ones that did appear, and the forced walk further down covers the task on purpose. */
    check("the whole-sequence task collects every position and checks them once",
          seqRecalls.every(card => card.area.slots === 3 && card.locked === 4 &&
                                   /tones were [0-9]-[0-9]-[0-9]/.test(card.status) &&
                                   card.marks.every(m => !/^[0-9]+/.test(m.mark))),
          seqRecalls.slice(0, 3).map(card => ({ slots: card.area.slots, status: card.status, locked: card.locked })));
    check("a wrong whole-sequence card marks each position and stays put for the owner to read",
          seqRecalls.filter(card => /^Wrong/.test(card.status)).every(card => {
            const cls = card.slots.map(s => s.cls);
            return cls.length === 3 && cls.some(c => c.indexOf('wrong') >= 0) && cls.filter(c => c.indexOf('wrong') >= 0).length >= 1 &&
                   card.reveal.shown === true && /tones [0-9]-[0-9]-[0-9]/.test(card.reveal.tones.join(" "));
          }),
          seqRecalls.filter(card => /^Wrong/.test(card.status)).slice(0, 2).map(card => card.slots));
    check("the graded sequence chips carry a tick or a cross each",
          seqRecalls.filter(card => /^Wrong/.test(card.status)).every(card =>
            card.slots.length === 3 && card.slots.every(s => /[\u2713\u2717]/.test(s.text.trim()))),
          seqRecalls.filter(card => /^Wrong/.test(card.status)).slice(0, 2).map(card => card.slots));
    const sylCards = clipCards.filter(card => /syllable/i.test(card.badge));
    check("the syllable task offers four same-tone near syllables with tone marks", sylCards.length > 0 &&
          sylCards.every(card => card.area.count === 4 &&
            card.area.values.every(v => /^[a-z]+([1-4])$/.test(v)) &&
            new Set(card.area.values.map(v => v.slice(-1))).size === 1 &&
            card.area.labels.every(l => /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(l))),
          sylCards.slice(0, 3).map(card => ({ values: card.area.values, labels: card.area.labels })));
    check("the reveal names the answer for every task", cards.every(card => /Correct|Wrong/.test(card.status)), cards.map(card => card.status).slice(0, 4));
    check("the buttons lock once the card is answered", cards.every(card => card.locked === card.area.count), cards.map(card => card.locked));
    /* the owner's bug: never a block of one tone; every tone must appear inside a dozen cards */
    check("no more than two cards in a row on the same tone", worstRun <= 2, { seq: toneSeq.join(""), worstRun, heard: cards.map(heardTone).join("") });
    check("all four tones appear inside 12 cards", Object.values(toneHist).every(n => n > 0), toneHist);
    check("tone counts stay balanced (no tone above 40%)", Math.max(...Object.values(toneHist)) <= Math.ceil(toneSeq.length * 0.4), toneHist);

    check("every card answered in the walk registers in the score line", new RegExp("n=" + cards.length).test(walk.score), walk.score);
    check("a whole-sentence card appeared in 12 cards and played exactly one clip",
          sentCards.length >= 1 && sentCards.every(card => card.clips.length === 1 && /^[a-z]\d+\.mp3$/.test(String(card.clips[0]))),
          sentCards.map(card => ({ badge: card.badge, clips: card.clips, status: card.status })));
    check("score line still carries the interval and the chance note", /95% CI/.test(walk.score) && /Chance is \d/.test(walk.score), walk.score);
    check("guess-corrected score stays hidden below 60 trials", /hidden until 60/.test(walk.acc), walk.acc);
    check("a score line is shown per task type that was answered", /first attempts/i.test(walk.taskLines), walk.taskLines.slice(0, 200));
    check("every task line states its own chance level", !/Chance is 50%/.test(walk.taskLines) &&
          (walk.taskLines.match(/Chance is \d/g) || []).length >= 2 && !/No answers yet/.test(walk.taskLines),
          walk.taskLines.slice(0, 400));
    check("the whole-sequence line states its own one-in-64 chance",
          /Chance is 1 in 64\./.test(walk.taskLines) || !/All the tones in order/.test(walk.taskLines), walk.taskLines.slice(0, 400));
    check("scheduler state is persisted", walk.stored.indexOf("mandarin-tone-scheduler-v1") >= 0, walk.stored);
    check("item meta describes the card", /Box \d of 7|New card/.test(walk.itemMeta || ""), walk.itemMeta);
    check("the export lists the task of each session slot", Array.isArray(walk.payload?.session?.tasks) && walk.payload.session.tasks.length > 0,
          walk.payload?.session?.tasks);
    check("the export carries the new settings", walk.payload?.settings?.newPerSession === 5 &&
          walk.payload?.settings?.focusWeakTones === false &&
          (walk.payload?.settings?.tasksEnabled || []).indexOf("tone") < 0,
          walk.payload?.settings);
    check("the archived tone-number task is off and labelled as archived", walk.toneTaskPressed === "false" && /archived/i.test(walk.toneTaskLabel || ""),
          { pressed: walk.toneTaskPressed, label: walk.toneTaskLabel });
    check("no card in the walk came from the archived tone-number task", walk.cards.every(card => card.badge !== "Which tone?"),
          Array.from(new Set(walk.cards.map(card => card.badge))));

    /* ================= revision 5 =================
       The owner's bug report: the sequence card marked a right answer wrong. The walk above taps the FIRST
       button, so it can only ever see the wrong-answer path - it never noticed. This walk answers every card
       CORRECTLY, taking the right answer from the app's own record, and the hand-over time is measured. */
    const rightWalk = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const wait = async (fn, ms) => { for (let w = 0; w < ms; w += 60) { if (fn()) return true; await settle(60); } return fn(); };
        /* count the cards the app presents, so the hand-over can be measured without guessing */
        const shown = [];
        const origPresent = window.presentCard;
        window.presentCard = function () { shown.push(performance.now()); return origPresent.apply(this, arguments); };
        const records = [];
        for (let i = 0; i < 14; i++) {
          document.getElementById('nextBtn').click();
          await settle(260);
          const badge = document.getElementById('taskBadge').textContent;
          const task = currentTask;
          const isRecall = /all [0-9]+ tones/i.test(badge);
          /* the tone buttons wait for the clips: do not answer a card that is still listening */
          await wait(() => !document.querySelectorAll('#answerArea button[disabled]').length, 6000);
          const truth = isRecall ? sequenceTones().slice() : (String(task).indexOf('sent_') === 0 ? null : correctValue(task));
          const wanted = String(task).indexOf('sent_') === 0 ? String(sentCard && sentCard.correct) : String(correctValue(task));
          const before = shown.length;
          const t0 = performance.now();
          if (isRecall) {
            for (const tone of sequenceTones()) {
              const b = document.querySelector('#answerArea button[data-value="' + tone + '"]');
              if (b) b.click();
              await settle(40);
            }
          } else {
            const b = document.querySelector('#answerArea button[data-value="' + wanted + '"]');
            if (b) b.click();
          }
          const status = document.getElementById('statusText').textContent;
          const mark = document.getElementById('statusMark').textContent;
          const boxOk = document.getElementById('statusBox').classList.contains('ok');
          /* Read the marking after a paint, not in the same turn of the loop: a beat of no length at all
             cleared the tick and the lock before the browser could ever draw them. */
          await settle(80);
          const btnEl = document.querySelector('#answerArea button.correct');
          const btnState = btnEl ? { mark: (btnEl.querySelector('.mark') || {}).textContent || '',
                                     cls: String(btnEl.className),
                                     locked: btnEl.classList.contains('locked') } : null;
          /* the beat has to pass before the next card is presented: wait for the hand-over, then time it */
          await wait(() => shown.length > before, 2500);
          const handoverMs = shown.length > before ? Math.round(shown[before] - t0) : null;
          records.push({ task: task, badge: badge, answer: isRecall ? sequenceTones().join('-') : wanted,
                         status: status, mark: mark, boxOk: boxOk, btn: btnState, handoverMs: handoverMs });
        }
        window.presentCard = origPresent;
        return records;
      })()`);
    console.log("  correct-answer walk:", JSON.stringify(rightWalk.slice(0, 14).map(r => ({ t: r.task, s: r.status.slice(0, 26), ms: r.handoverMs }))));
    check("a right tap is marked correct on every card, whatever the task",
          rightWalk.length === 14 && rightWalk.every(r => /^Correct/.test(r.status)),
          rightWalk.filter(r => !/^Correct/.test(r.status)).map(r => ({ task: r.task, badge: r.badge, status: r.status })));
    check("the tick, the green status line and the verdict follow a right answer",
          rightWalk.every(r => r.mark === "\u2713" && r.boxOk === true && r.badge !== "Which tone?"),
          rightWalk.filter(r => !(r.mark === "\u2713" && r.boxOk === true)).map(r => ({ task: r.task, mark: r.mark, ok: r.boxOk })));
    check("the correct-answer walk covered the sequence tasks, a sentence card and a plain card",
          rightWalk.some(r => r.task === "seq_target") && rightWalk.some(r => r.task === "seq_recall") &&
          rightWalk.some(r => String(r.task).indexOf("sent_") === 0),
          Array.from(new Set(rightWalk.map(r => r.task))));

    check("a right tap leaves its tick and its lock on the button long enough to be seen",
          rightWalk.filter(r => r.btn).length >= 8 &&
          rightWalk.filter(r => r.btn).every(r => r.btn.mark === "\u2713" && r.btn.cls.indexOf("correct") >= 0 && r.btn.locked === true),
          rightWalk.filter(r => r.btn && !(r.btn.mark === "\u2713" && r.btn.locked)).map(r => ({ t: r.task, btn: r.btn })));
    /* the owner's ask: the next sound comes quickly after a right answer, with the tick still readable
       (revision 5 first shipped no beat at all: the tick was never painted, and the walk caught it) */
    const handovers = rightWalk.map(r => r.handoverMs).filter(ms => typeof ms === "number");
    check("a right answer hands over to the next card after a beat that can be read",
          handovers.length >= 10 && handovers.every(ms => ms >= 300 && ms <= 900),
          { n: handovers.length, min: Math.min.apply(null, handovers), max: Math.max.apply(null, handovers), all: rightWalk.map(r => r.handoverMs) });

    /* the same walk with the sequence tasks forced, so the fix is checked against the sequence the app played */
    const seqTruth = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const wait = async (fn, ms) => { for (let w = 0; w < ms; w += 60) { if (fn()) return true; await settle(60); } return fn(); };
        const stored = JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}');
        const keptTasks = stored.tasksEnabled || ['syllable', 'pair', 'contour', 'seq_target', 'seq_recall'];
        const keptSentences = stored.sentenceDemo === undefined ? true : !!stored.sentenceDemo;
        settings.tasksEnabled = ['seq_target'];
        setSentenceDemo(false);
        startSession();
        nextQuestion(true);
        const out = [];
        for (let i = 0; i < 6; i++) {
          document.getElementById('nextBtn').click();
          await settle(220);
          await wait(() => !document.querySelectorAll('#answerArea button[disabled]').length, 6000);
          const where = seqAskedAt;
          const played = sequence[where] ? sequence[where].tone : null;
          const claimed = correctValue('seq_target');
          const btn = document.querySelector('#answerArea button[data-value="' + claimed + '"]');
          if (btn) btn.click();
          out.push({ where: where, played: played, claimed: claimed, claimedType: typeof claimed,
                     badge: document.getElementById('taskBadge').textContent,
                     status: document.getElementById('statusText').textContent });
          await settle(200);
        }
        settings.tasksEnabled = keptTasks;
        setSentenceDemo(keptSentences);
        startSession();
        nextQuestion(true);
        return out;
      })()`);
    check("the sequence card's own record of the answer is the tone it played",
          seqTruth.length === 6 && seqTruth.every(r => r.played >= 1 && r.claimed === String(r.played)),
          seqTruth.map(r => ({ where: r.where, played: r.played, claimed: r.claimed })));
    check("the sequence answer is a string, so the tap comparison can match it",
          seqTruth.every(r => r.claimedType === "string"), seqTruth.map(r => r.claimedType));
    check("every right tap on a sequence card is marked correct",
          seqTruth.every(r => /^Correct/.test(r.status)), seqTruth.map(r => r.status));
    check("a sequence card is named by its real length", seqTruth.every(r => /^One tone of \d+$/.test(r.badge)),
          seqTruth.map(r => r.badge));

    /* The whole-sequence ("All 3 tones in order") task on purpose, because twelve random cards may hold
       none of them - and this is where the owner's original report lived (a right sequence marked wrong).
       Every card is answered correctly once and wrongly once. */
    const recallWalk = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const wait = async (fn, ms) => { for (let w = 0; w < ms; w += 60) { if (fn()) return true; await settle(60); } return fn(); };
        const stored = JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}');
        const keptTasks = stored.tasksEnabled || ['syllable', 'pair', 'contour', 'seq_target', 'seq_recall'];
        const keptSentences = stored.sentenceDemo === undefined ? true : !!stored.sentenceDemo;
        const slots = () => Array.from(document.querySelectorAll('#answerArea .seq-slot'));
        const text = () => document.getElementById('statusText').textContent;
        settings.tasksEnabled = ['seq_recall'];
        setSentenceDemo(false);
        startSession();
        nextQuestion(true);
        const out = [];
        for (let i = 0; i < 4; i++) {
          const next = document.getElementById('nextBtn');
          /* a right run, tapped from the app's own record of the sequence it played */
          next.click();
          await settle(240);
          await wait(() => !document.querySelectorAll('#answerArea button[disabled]').length, 6000);
          const played = sequenceTones().slice();
          const slotsBefore = slots().length;
          for (const tone of played) {
            const b = document.querySelector('#answerArea button[data-value="' + tone + '"]');
            if (b) b.click();
            await settle(70);
          }
          const right = { badge: document.getElementById('taskBadge').textContent,
                          played: played, slotsBefore: slotsBefore,
                          status: text(), mark: document.getElementById('statusMark').textContent,
                          boxOk: document.getElementById('statusBox').classList.contains('ok'),
                          locked: document.querySelectorAll('#answerArea button.locked').length,
                          chips: slots().map(s => s.textContent.trim()),
                          chipCls: slots().map(s => Array.from(s.classList).filter(x => x !== 'seq-slot').join(' ')),
                          claimed: String(correctValue('seq_recall')),
                          toneCount: sequenceTones().length };
          /* a wrong run: one tone off at every position, so at least one slot must be graded wrong */
          next.click();
          await settle(240);
          await wait(() => !document.querySelectorAll('#answerArea button[disabled]').length, 6000);
          const played2 = sequenceTones().slice();
          for (const tone of played2) {
            const other = tone === 1 ? '2' : '1';
            const b = document.querySelector('#answerArea button[data-value="' + other + '"]');
            if (b) b.click();
            await settle(70);
          }
          const wrongStatus = text();
          const rev = document.getElementById('revealBox');
          const chips2 = slots().map(s => ({ text: s.textContent.trim(), cls: Array.from(s.classList).filter(x => x !== 'seq-slot').join(' ') }));
          /* a wrong whole-sequence card must stay put with its graded slots, so it is left alone for a beat */
          await settle(800);
          const wrong = { played: played2, status: wrongStatus,
                          stayed: text() === wrongStatus && document.querySelectorAll('#answerArea button.locked').length === 4,
                          chips: chips2, rows: rev ? rev.querySelectorAll('.reveal-row').length : 0,
                          shown: rev ? rev.classList.contains('shown') : null };
          out.push({ right: right, wrong: wrong });
          next.click();                       // clear the stuck card before the next round
          await settle(200);
        }
        settings.tasksEnabled = keptTasks;
        setSentenceDemo(keptSentences);
        startSession();
        nextQuestion(true);
        return out;
      })()`);
    console.log("  recall walk:", JSON.stringify(recallWalk.map(r => ({ badge: r.right.badge, played: r.right.played.join('-'),
        right: r.right.status.slice(0, 22), locked: r.right.locked, chips: r.right.chips.join(' '),
        wrong: r.wrong.status.slice(0, 18), stayed: r.wrong.stayed }))));
    check("the whole-sequence card asks about every position it played",
          recallWalk.length === 4 && recallWalk.every(r => /^All [0-9] tones in order$/.test(r.right.badge) &&
                                                          r.right.slotsBefore === 3 && r.right.played.length === 3 &&
                                                          r.right.claimed === r.right.played.join(",")),
          recallWalk.map(r => ({ badge: r.right.badge, played: r.right.played, claimed: r.right.claimed })));
    check("a right whole-sequence answer is marked correct, locked and ticked",
          recallWalk.every(r => /^Correct/.test(r.right.status) && r.right.mark === "\u2713" &&
                                r.right.boxOk === true && r.right.locked === 4 &&
                                r.right.chips.length === 3 && r.right.chips.every(t => t.indexOf("\u2713") >= 0)),
          recallWalk.map(r => ({ status: r.right.status, mark: r.right.mark, locked: r.right.locked, chips: r.right.chips })));
    check("a wrong whole-sequence answer grades each position and stays put for the owner to read",
          recallWalk.every(r => /^Wrong/.test(r.wrong.status) && r.wrong.stayed === true &&
                                r.wrong.chips.length === 3 && r.wrong.chips.some(c => c.cls.indexOf('wrong') >= 0) &&
                                r.wrong.chips.every(c => /[\u2713\u2717]/.test(c.text)) &&
                                r.wrong.rows >= 1 && r.wrong.shown === true),
          recallWalk.map(r => ({ status: r.wrong.status, stayed: r.wrong.stayed, chips: r.wrong.chips })));

    /* the sentence demo: all three kinds of whole-sentence question, answered through the UI */
    const sentWalk = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const stored = JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}');
        const keptTasks = stored.tasksEnabled || ['syllable', 'pair', 'contour', 'seq_target', 'seq_recall'];
        settings.tasksEnabled = ['syllable'];
        setSentenceDemo(true);
        startSession();
        nextQuestion(true);
        const cards = [];
        for (let i = 0; i < 3; i++) {
          /* the app deals a sentence card after six scheduled cards: step to it instead of waiting */
          cardsSinceSentence = 6;
          document.getElementById('nextBtn').click();
          await settle(280);
          const card = sentCard;
          const head = document.querySelector('#answerArea .sent-text');
          const sentence = card && card.sentence;
          const snap = {
            badge: document.getElementById('taskBadge').textContent,
            task: card ? card.task : null,
            labels: card ? card.options.map(o => o.label) : [],
            values: card ? card.options.map(o => String(o.value)) : [],
            subs: card ? card.options.map(o => String(o.sub || '')) : [],
            correct: card ? String(card.correct) : null,
            hanzi: sentence ? sentence.hanzi : null,
            gloss: sentence ? sentence.gloss : null,
            plain: sentence ? sentence.pinyin.map(p => String(p).replace(/[0-9]/g, '')) : [],
            textShown: !!head,
            textHanzi: head ? head.querySelector('.sent-hanzi').textContent : null,
            textPinyin: head ? head.querySelector('.sent-pinyin').textContent : null,
            markClass: null, status: null, wrong: null
          };
          const right = document.querySelector('#answerArea button[data-value="' + snap.correct + '"]');
          if (right) right.click();
          snap.status = document.getElementById('statusText').textContent;
          snap.markClass = right ? String(right.className) : null;
          await settle(260);
          /* the same kind of card once more, answered wrong, to read the reveal */
          cardsSinceSentence = 6;
          document.getElementById('nextBtn').click();
          await settle(280);
          const card2 = sentCard;
          const wrongValue = String((Number(card2.correct) + 1) % card2.options.length);
          const wrong = document.querySelector('#answerArea button[data-value="' + wrongValue + '"]');
          if (wrong) wrong.click();
          const rev = document.getElementById('revealBox');
          snap.wrong = {
            status: document.getElementById('statusText').textContent,
            rows: rev ? rev.querySelectorAll('.reveal-row').length : 0,
            pinyin: rev ? Array.from(rev.querySelectorAll('.reveal-pinyin')).map(s => s.textContent) : [],
            tone: rev ? Array.from(rev.querySelectorAll('.reveal-tone')).map(s => s.textContent) : []
          };
          cards.push(snap);
          await settle(140);
        }
        settings.tasksEnabled = keptTasks;
        startSession();
        nextQuestion(true);
        return cards;
      })()`);
    console.log("  sentence walk:", JSON.stringify(sentWalk.map(r => ({ task: r.task, status: r.status, shown: r.textShown }))));
    const packLoaded = await evaluate(c, `(() => ({
        n: SENTENCES.length,
        audio: SENTENCES.map(s => s.audio),
        glosses: new Set(SENTENCES.map(s => s.gloss)).size,
        tones: Array.from(new Set(SENTENCES.reduce((a, s) => a.concat(s.tones), []))).sort(),
        bad: SENTENCES.filter(s => !s.hanzi || !s.pinyin || !s.tones || !s.gloss).map(s => s.id)
      }))()`);
    check("the page loads the twelve-sentence pack with its audio paths",
          packLoaded.n === 12 && packLoaded.glosses === 12 && packLoaded.bad.length === 0 &&
          packLoaded.audio.every(a => /^\.\/datasets\/sentences\/audio\/[a-z0-9]+\.mp3$/.test(a)),
          { n: packLoaded.n, glosses: packLoaded.glosses, bad: packLoaded.bad, first: packLoaded.audio[0] });
    check("the demo pack covers all five tones of the recordings",
          packLoaded.tones.join() === "1,2,3,4,5", packLoaded.tones);
    check("the sentence demo asks all three kinds of whole-sentence question",
          sentWalk.map(r => r.task).slice().sort().join() === "sent_mean,sent_syllable,sent_word" &&
          sentWalk.length === 3, sentWalk.map(r => r.task));
    check("every sentence question offers four options, one per card kind",
          sentWalk.every(r => r.labels.length === 4 && r.correct !== null && !!r.labels[Number(r.correct)]),
          sentWalk.map(r => ({ task: r.task, labels: r.labels, correct: r.correct })));
    check("a right tap on a sentence card is marked correct",
          sentWalk.every(r => /^Correct/.test(r.status) && /correct/.test(r.markClass || "")),
          sentWalk.map(r => ({ task: r.task, status: r.status, cls: r.markClass })));
    check("only the meaning question shows the sentence before the answer",
          sentWalk.every(r => (r.task === "sent_mean") === r.textShown) &&
          sentWalk.filter(r => r.task === "sent_mean").every(r => r.textHanzi === r.hanzi && r.textPinyin),
          sentWalk.map(r => ({ task: r.task, shown: r.textShown, hanzi: r.textHanzi })));
    check("a wrong tap on a sentence card reveals the sentence and its meaning",
          sentWalk.every(r => r.wrong && /^Wrong/.test(r.wrong.status) && r.wrong.rows === 2 &&
                              /[\u4e00-\u9fff]/.test(r.wrong.pinyin[0] || "") && (r.wrong.tone[0] || "").length > 0),
          sentWalk.map(r => r.wrong));
    check("no sentence question can have two right answers",
          sentWalk.every(r => {
            const at = Number(r.correct);
            const others = r.values.filter((v, i) => i !== at);
            if (r.task === "sent_syllable") {
              const mine = r.plain;
              return mine.indexOf(r.values[at].replace(/[0-9]/g, "")) >= 0 &&
                     others.every(v => mine.indexOf(v.replace(/[0-9]/g, "")) < 0);
            }
            if (r.task === "sent_word") return r.hanzi.indexOf(r.values[at]) >= 0 && others.every(v => r.hanzi.indexOf(v) < 0);
            return r.values[at] === r.gloss && new Set(r.values).size === 4 && others.every(v => v !== r.gloss);
          }),
          sentWalk.map(r => ({ task: r.task, correct: r.values[Number(r.correct)], others: r.values.filter((v, i) => i !== Number(r.correct)), hanzi: r.hanzi })));

    /* the sentence-demo switch: off means no sentence cards at all, on brings them back */
    const sentenceSwitch = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const toggle = document.getElementById('sentenceToggle');
        const before = toggle.getAttribute('aria-pressed');
        const noteOn = document.getElementById('sentenceNote').textContent;
        toggle.click();
        await settle(150);
        const off = { pressed: toggle.getAttribute('aria-pressed'),
                      stored: JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}').sentenceDemo,
                      note: document.getElementById('sentenceNote').textContent };
        let seenWhileOff = 0;
        for (let i = 0; i < 8; i++) {
          document.getElementById('nextBtn').click();
          await settle(170);
          if (/sentence demo/i.test(document.getElementById('taskBadge').textContent)) seenWhileOff += 1;
        }
        toggle.click();
        await settle(150);
        let seenWhileOn = 0;
        for (let i = 0; i < 8; i++) {
          document.getElementById('nextBtn').click();
          await settle(200);
          if (/sentence demo/i.test(document.getElementById('taskBadge').textContent)) seenWhileOn += 1;
          if (seenWhileOn) break;
        }
        return { before: before, noteOn: noteOn, off: off, seenWhileOff: seenWhileOff, seenWhileOn: seenWhileOn,
                 backOn: toggle.getAttribute('aria-pressed') };
      })()`);
    check("the sentence switch starts on and names the pack",
          sentenceSwitch.before === "true" && /12 sentences/.test(sentenceSwitch.noteOn || ""), sentenceSwitch.noteOn);
    check("switching the sentence demo off stops the sentence cards and saves the choice",
          sentenceSwitch.off.pressed === "false" && sentenceSwitch.off.stored === false &&
          /not loaded|off/.test(sentenceSwitch.off.note || "") && sentenceSwitch.seenWhileOff === 0, sentenceSwitch.off);
    check("switching it back on brings the sentence cards back",
          sentenceSwitch.backOn === "true" && sentenceSwitch.seenWhileOn >= 1, sentenceSwitch);

    /* revision 5: the sequence length is a setting, and the speed has a typable box beside its slider */
    const lengthSetting = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const read = () => JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}');
        const stored = read();
        const keptTasks = stored.tasksEnabled || ['syllable', 'pair', 'contour', 'seq_target', 'seq_recall'];
        const P = window.MTDProgress;
        setSentenceDemo(false);
        settings.tasksEnabled = ['seq_recall'];
        const before = { len: P.sequenceLength(), chance: P.TASK_CHANCE.seq_recall };
        document.querySelector('#seqLenRow [data-len="6"]').click();
        await settle(150);
        const six = { len: P.sequenceLength(), saved: read().seqLength, chance: P.TASK_CHANCE.seq_recall,
                      label: document.getElementById('seqLenValue').textContent,
                      pressed: Array.from(document.querySelectorAll('#seqLenRow button')).filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.len) };
        startSession();
        nextQuestion(true);
        window.__clips = [];
        document.getElementById('nextBtn').click();
        await settle(300);
        const chips = document.querySelectorAll('#answerArea .seq-slot').length;
        const badge = document.getElementById('taskBadge').textContent;
        for (let w = 0; w < 6000 && window.__clips.length < 6; w += 150) await settle(150);
        const clips = window.__clips.slice();
        for (const tone of sequenceTones()) {
          const b = document.querySelector('#answerArea button[data-value="' + tone + '"]');
          if (b) b.click();
          await settle(40);
        }
        const status = document.getElementById('statusText').textContent;
        document.querySelector('#seqLenRow [data-len="3"]').click();
        await settle(150);
        const back = { len: P.sequenceLength(), saved: read().seqLength, chance: P.TASK_CHANCE.seq_recall };
        settings.tasksEnabled = keptTasks;
        setSentenceDemo(true);
        startSession();
        nextQuestion(true);
        return { before: before, six: six, chips: chips, badge: badge, clips: clips, status: status, back: back };
      })()`);
    check("the sequence length starts at three and the whole-sequence chance follows it",
          lengthSetting.before.len === 3 && Math.abs(lengthSetting.before.chance - 1 / 64) < 1e-12, lengthSetting.before);
    check("the sequence length setting saves six and states the new chance",
          lengthSetting.six.len === 6 && lengthSetting.six.saved === 6 &&
          Math.abs(lengthSetting.six.chance - Math.pow(0.25, 6)) < 1e-12 &&
          /6 syllables/.test(lengthSetting.six.label) && lengthSetting.six.pressed.join() === "6", lengthSetting.six);
    check("a six-syllable run plays six clips, shows six chips and is named as six",
          lengthSetting.clips.length === 6 && lengthSetting.chips === 6 && /All 6 tones in order/.test(lengthSetting.badge) &&
          /six tones were/.test(lengthSetting.status),
          { clips: lengthSetting.clips, chips: lengthSetting.chips, badge: lengthSetting.badge, status: lengthSetting.status });
    check("the longer sequence is still marked correct", /^Correct/.test(lengthSetting.status), lengthSetting.status);
    check("the length goes back to three and the chance figure with it",
          lengthSetting.back.len === 3 && lengthSetting.back.saved === 3 && Math.abs(lengthSetting.back.chance - 1 / 64) < 1e-12,
          lengthSetting.back);

    const speedBox = await evaluate(c, `(() => {
        const read = () => JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}');
        const input = document.getElementById('speedInput');
        const slider = document.getElementById('speedSlider');
        const label = document.getElementById('speedValue');
        const set = (v) => { input.value = v; input.dispatchEvent(new Event('input')); };
        set('2.20');
        const typed = { rate: settings.audioSpeed, stored: read().audioSpeed, slider: slider.value, label: label.textContent, box: input.value };
        set('9');                      // above the range: it must clamp rather than stick
        const high = { rate: settings.audioSpeed, stored: read().audioSpeed, slider: slider.value, label: label.textContent, box: input.value };
        set('0.02');                   // below the range
        const low = { rate: settings.audioSpeed, stored: read().audioSpeed, slider: slider.value, label: label.textContent, box: input.value };
        slider.value = '1.50';
        slider.dispatchEvent(new Event('input'));
        const slid = { rate: settings.audioSpeed, stored: read().audioSpeed, box: input.value, label: label.textContent };
        set('0.90');
        return { typed: typed, high: high, low: low, slid: slid,
                 max: slider.getAttribute('max'), min: slider.getAttribute('min'), back: settings.audioSpeed };
      })()`);
    check("the typed speed box sets the rate, the slider and the label",
          speedBox.typed.rate === 2.2 && speedBox.typed.stored === 2.2 && Number(speedBox.typed.slider) === 2.2 &&
          speedBox.typed.label === "2.20x" && speedBox.typed.box === "2.20", speedBox.typed);
    check("a typed speed above the range clamps to 2.50x and says so",
          speedBox.high.rate === 2.5 && speedBox.high.stored === 2.5 && Number(speedBox.high.slider) === 2.5 &&
          speedBox.high.box === "2.50", speedBox.high);
    check("a typed speed below the range clamps to 0.10x", speedBox.low.rate === 0.1 && speedBox.low.box === "0.10" && speedBox.low.label === "0.10x",
          speedBox.low);
    check("the slider and the typed box stay in step, and the slider covers 0.10x to 2.50x",
          Number(speedBox.slid.box) === 1.5 && speedBox.slid.label === "1.50x" && speedBox.slid.stored === 1.5 &&
          speedBox.max === "2.50" && speedBox.min === "0.10" && speedBox.back === 0.9, speedBox);

    const storedBefore = await evaluate(c, `(localStorage.getItem('mandarin-tone-scheduler-v1') || '').length`);

    /* reload: the scheduler state must survive */
    await c.send("Page.navigate", { url: APP });
    check("the drill is ready again after a reload", await waitReady(c, 15000), "deck and card area drawn");
    const after = await evaluate(c, `(() => {
        const raw = localStorage.getItem('mandarin-tone-scheduler-v1') || '{"items":{}}';
        const parsed = JSON.parse(raw);
        const seen = Object.values(parsed.items).filter(e => e.last !== null).length;
        return { len: raw.length, seen: seen, progress: document.getElementById('progressDetail').textContent,
                 score: document.getElementById('scoreLine').textContent, taskLines: document.getElementById('taskLines').textContent,
                 storedSeen: seen, answered: (document.getElementById('progressDetail').textContent.split('answered ')[1] || '').split(')')[0] };
      })()`);
    check("scheduler state survives the reload", after.seen === after.storedSeen && after.seen >= 8 && String(after.seen) === after.answered,
          { seen: after.seen, storedSeen: after.storedSeen, answered: after.answered });
    check("the progress detail reflects the restored state", new RegExp("cards met \\d+/\\d+ \\(answered " + after.seen + "\\)").test(after.progress), after.progress);
    check("score line resets per sitting while the cards keep their history", /First attempts: 0/.test(after.score), after.score);
    check("the per-task lines are empty again for the new sitting", /No answers yet/.test(after.taskLines), after.taskLines);

    await hookPlay();

    /* verify a wrong answer followed by a replay does not move the score */
    const retry = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        /* the restored card can be a sequence card, whose buttons wait for the clips to finish */
        for (let w = 0; w < 4000 && !document.querySelector('#answerArea button:not([disabled])'); w += 150) await settle(150);
        const buttons = Array.from(document.querySelectorAll('#answerArea button:not([disabled])'));
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
                 stored: JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}').tasksEnabled };
      })()`);
    check("a task type can be switched off and on", settingsEffect.off === "false" && settingsEffect.on === "true", settingsEffect);
    check("the setting is persisted with the task mix", Array.isArray(settingsEffect.stored) && settingsEffect.stored.length === 5 &&
          settingsEffect.stored.indexOf("tone") < 0 && settingsEffect.stored.indexOf("pair") >= 0, settingsEffect.stored);

    /* the weakest-tone focus switch: toggles, persists, and reports which tones it would use */
    const focusEffect = await evaluate(c, `(async () => {
        const btn = document.getElementById('focusWeakTones');
        const before = btn.getAttribute('aria-pressed');
        btn.click();
        await new Promise(r => setTimeout(r, 250));
        const on = btn.getAttribute('aria-pressed');
        const label = btn.textContent;
        const stored = JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}').focusWeakTones;
        btn.click();
        await new Promise(r => setTimeout(r, 250));
        const back = btn.getAttribute('aria-pressed');
        return { before: before, on: on, label: label, stored: stored, back: back,
                 storedAfter: JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}').focusWeakTones };
      })()`);
    check("the focus switch toggles on and off", focusEffect.before === "false" && focusEffect.on === "true" && focusEffect.back === "false", focusEffect);
    check("the focus choice is saved", focusEffect.stored === true && focusEffect.storedAfter === false, focusEffect);
    check("the focus label names the tones it would use, or says it needs data first",
          /Focus my weakest tones \((now [1-4]( and [1-4])?|needs data)\)/.test(focusEffect.label || ""), focusEffect.label);

    const sliderEffect = await evaluate(c, `(() => {
        const s = document.getElementById('newPerSessionSlider');
        s.value = '8';
        s.dispatchEvent(new Event('input'));
        return { value: s.value, out: document.getElementById('newPerSessionValue').textContent,
                 stored: JSON.parse(localStorage.getItem('mandarin-tone-settings-v3') || '{}').newPerSession };
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

    /* the drill screen must fit one phone viewport and must not move when an answer lands */
    const fit = await evaluate(c, `(() => {
        const btns = Array.from(document.querySelectorAll('#answerArea button')).map(b => Math.round(b.getBoundingClientRect().height));
        return { drillHeight: Math.round(document.getElementById('screenDrill').getBoundingClientRect().height),
                 innerHeight: window.innerHeight, docScroll: document.documentElement.scrollHeight, scrollY: window.scrollY,
                 drillScroll: document.getElementById('screenDrill').scrollHeight,
                 drillOverflow: document.getElementById('screenDrill').scrollHeight - Math.round(document.getElementById('screenDrill').clientHeight),
                 answerHeights: btns, minTap: btns.length ? Math.min.apply(null, btns) : 0 };
      })()`);
    check("the drill fits one phone viewport with no page scrolling",
          fit.docScroll <= fit.innerHeight + 1 && fit.scrollY === 0 && fit.drillOverflow <= 1, fit);
    check("answer buttons stay above the 44 px tap target", fit.minTap >= 44, fit.answerHeights);

    const shift = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        document.getElementById('nextBtn').click();
        await settle(400);
        const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; };
        const before = { area: box('answerArea'), play: box('playBtn'), status: box('statusBox') };
        const live = Array.from(document.querySelectorAll('#answerArea button:not([disabled])'));
        if (live.length) live[0].click();
        await settle(120);
        const after = { area: box('answerArea'), play: box('playBtn'), status: box('statusBox') };
        return { before: before, after: after };
      })()`);
    check("nothing moves when an answer lands",
          JSON.stringify(shift.before) === JSON.stringify(shift.after), shift);
    /* the settings screen is a separate view now: open it before measuring its controls */
    const screens = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        document.getElementById('settingsBtn').click();
        await settle(200);
        const opened = { settingsHidden: document.getElementById('screenSettings').hidden, drillHidden: document.getElementById('screenDrill').hidden,
                         reportsInside: !!document.querySelector('#screenSettings button[onclick="reportAnError()"]') &&
                                        !!document.querySelector('#screenSettings button[onclick="downloadReports()"]'),
                         slidersInside: !!document.querySelector('#screenSettings input#newPerSessionSlider') };
        return opened;
      })()`);
    check("the gear opens a separate settings screen that holds the reports",
          screens.settingsHidden === false && screens.drillHidden === true && screens.reportsInside === true && screens.slidersInside === true,
          screens);

    const layout = await evaluate(c, `(() => {
        const ids = ['scoreLine', 'accuracyText', 'progressDetail', 'itemMeta', 'taskLines'];
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
        const scroll = document.querySelector('#screenSettings .settings-scroll');
        const wide = Array.from(document.querySelectorAll('#screenSettings *'))
          .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 6).map(e => ({ tag: e.tagName + (e.id ? '#' + e.id : ''), right: Math.round(e.getBoundingClientRect().right) }));
        return { out: out, wide: wide, docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
                 settingsW: Math.round(scroll.getBoundingClientRect().width), settingsScrollW: scroll.scrollWidth,
                 answerHeights: btns, minTap: Math.min.apply(null, btns), taskBtns: taskBtns,
                 sliderW: Math.round((document.getElementById('newPerSessionSlider') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width) };
      })()`);
    const wideOnScreen = (layout.wide || []).slice(0, 6);
    const spills = Object.keys(layout.out).filter(k => layout.out[k] && layout.out[k].right > layout.innerW + 1);
    const clipped = Object.keys(layout.out).filter(k => layout.out[k] && layout.out[k].clipping);
    check("the page does not scroll sideways on a 390 px viewport", layout.docScrollW <= layout.innerW + 1, { scroll: layout.docScrollW, inner: layout.innerW });
    check("no line overflows the viewport", spills.length === 0, spills);
    check("nothing on the settings screen is wider than the phone", wideOnScreen.length === 0, wideOnScreen);
    check("no line clips its own text", clipped.length === 0, clipped);
    check("the settings buttons stay above the 44 px tap target", layout.taskBtns.every(b => b.h >= 44), layout.taskBtns);
    check("the new-cards slider fits the phone width", layout.sliderW > 200 && layout.sliderW <= layout.settingsW + 1 && layout.settingsW <= layout.innerW,
          { slider: layout.sliderW, settings: layout.settingsW, inner: layout.innerW, scrollW: layout.settingsScrollW, docScrollW: layout.docScrollW });

    /* zoom: the owner sometimes pinches out by accident, and a zoomed-out page is a smaller text size and a
       different shape. The layout must survive a wide window and a narrow one, and the tap targets must stay
       big enough at both ends. */
    const backHome = await evaluate(c, `(async () => {
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        document.getElementById('backBtn').click();
        await settle(200);
        return { back: document.getElementById('screenDrill').hidden === false };
      })()`);
    check("the back arrow returns to the drill", backHome.back === true, backHome);

    const measure = `(() => {
        const btns = Array.from(document.querySelectorAll('#answerArea button')).map(b => Math.round(b.getBoundingClientRect().height));
        const blocks = Array.from(document.querySelectorAll('#screenDrill .bar, #screenDrill .prompt, #answerArea, #screenDrill .feedback, #screenDrill .controls'))
          .map(el => Math.round(el.getBoundingClientRect().right));
        return { docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
                 minTap: btns.length ? Math.min.apply(null, btns) : 0,
                 widest: blocks.length ? Math.max.apply(null, blocks) : 0,
                 drillOverflow: document.getElementById('screenDrill').scrollHeight - document.getElementById('screenDrill').clientHeight,
                 barH: Math.round(document.querySelector('#screenDrill .bar').getBoundingClientRect().height) };
      })()`;

    await c.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 520, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const wide = await evaluate(c, measure);
    check("a wide, short window (a zoomed-out view) still fits without sideways scrolling",
          wide.docScrollW <= wide.innerW + 1 && wide.widest <= wide.innerW + 1 && wide.minTap >= 44 && wide.drillOverflow <= 1, wide);

    await c.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const narrow = await evaluate(c, measure);
    check("a narrow screen (a zoomed-in view) still fits, still taps, and still fits the height",
          narrow.docScrollW <= narrow.innerW + 1 && narrow.minTap >= 44 && narrow.drillOverflow <= 1, narrow);
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(200);

    const muteFlag = chrome.spawnargs.includes("--mute-audio");
    check("browser ran with --mute-audio", muteFlag);
    check("no chromium error lines mentioning crash", consoleErrors.filter(s => /crash/i.test(s)).length === 0, consoleErrors.slice(0, 3));

    fs.writeFileSync(path.join(__dirname, "smoke_results.json"), JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
    fs.writeFileSync(path.join(__dirname, "smoke_debug.json"), JSON.stringify({ walk: walk, shift: shift, fit: fit }, null, 2));
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
