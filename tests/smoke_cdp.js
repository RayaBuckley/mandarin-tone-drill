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
          const seqCard = /three|sequence/i.test(badge);
          const recallCard = /all three/i.test(badge);
          const pairCard = /first/i.test(badge);
          const want = pairCard ? 2 : seqCard ? 3 : 1;
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
          const taps = recallCard ? 3 : 1;
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
          cards.push({ badge: badge, area: area, clips: clips, status: status, locked: locked, score: score, reveal: reveal,
                       schedTone: typeof currentTone === 'number' ? currentTone : null,
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
    const taskLabels = Array.from(new Set(cards.map(card => card.badge)));
    const heardTone = (card) => Number(String((card.clips[0] || "")).match(/([1-4])\.mp3$/)?.[1]);
    const toneSeq = cards.map(card => card.schedTone).filter(n => n >= 1 && n <= 4);
    const toneHist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    toneSeq.forEach(t => { toneHist[t] += 1; });
    let run = 0, worstRun = 0;
    toneSeq.forEach((t, i) => { run = (i && t === toneSeq[i - 1]) ? run + 1 : 1; if (run > worstRun) worstRun = run; });
    console.log("  cards:", cards.length, "| tasks:", JSON.stringify(taskLabels), "| scheduled tones:", toneSeq.join(""), JSON.stringify(toneHist), "| worst same-tone run", worstRun);
    console.log("  first-clip tones:", cards.map(heardTone).join(""));
    console.log("  task areas:", JSON.stringify(cards.slice(0, 6).map(card => ({ task: card.badge, n: card.area.count, v: card.area.values.slice(0, 4), clips: card.clips.length }))));

    check("the walk answered 12 cards through the UI", cards.length === 12, cards.length);
    check("every clip the app played belongs to the card on screen", cards.every(card => card.clips.length >= 1),
          cards.map(card => card.clips.length).slice(0, 6));
    const pairCards = cards.filter(card => /which tone was first/i.test(card.badge));
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
    const wrongCards = cards.filter(card => /^Wrong/.test(card.status));
    const rightCards = cards.filter(card => /^Correct/.test(card.status));
    check("every wrong answer reveals the syllable in tone-marked pinyin, its tone and a replay",
          wrongCards.length >= 2 && wrongCards.every(card => card.reveal.shown && card.reveal.rows >= 1 &&
                              card.reveal.pinyin.length >= 1 && card.reveal.tones.length >= 1 && card.reveal.replay === true &&
                              card.reveal.pinyin.every(p => /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(p))),
          wrongCards.slice(0, 2).map(card => card.reveal));
    check("a correct answer shows no reveal at all", rightCards.every(card => card.reveal.shown === false),
          rightCards.map(card => card.reveal.shown));
    const oneClipWrong = wrongCards.filter(card => !/three/i.test(card.badge));
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
        if (b.indexOf("in the three") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4" &&
                                                   card.clips.length === 3 && card.area.slots === 0;
        if (b.indexOf("all three") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4" &&
                                              card.clips.length === 3 && card.area.slots === 3;
        if (b.indexOf("first") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4" && card.clips.length === 2;
        if (b.indexOf("syllable") >= 0) return card.area.count === 4 && card.area.values.every(v => /^[a-z]+[1-4]$/.test(v));
        if (b.indexOf("shape") >= 0) return card.area.count === 4 && card.area.values.join() === "1,2,3,4";
        return card.area.count === 4 && card.area.values.join() === "1,2,3,4";
      }), cards.map(card => ({ badge: card.badge, values: card.area.values, clips: card.clips.length, slots: card.area.slots })));

    /* the owner's ask: three syllables, then a question about ONE of them that could not be known in advance */
    const seqTargets = cards.filter(card => /in the three/i.test(card.badge));
    check("the three-syllable task plays three clips before it says which one it asks about",
          seqTargets.length > 0 && seqTargets.every(card => card.clips.length === 3 && card.disabledBefore === 4 &&
                                                            !/syllable \d/.test(card.titleBefore) && /syllable \d/.test(card.titleAfter)),
          seqTargets.slice(0, 3).map(card => ({ clips: card.clips.length, disabled: card.disabledBefore, before: card.titleBefore, after: card.titleAfter })));
    check("the asked position moves from card to card",
          new Set(seqTargets.map(card => (card.titleAfter.match(/syllable (\d)/) || [])[1])).size >= 2 ||
          seqTargets.length < 3,
          seqTargets.map(card => card.titleAfter));
    const seqRecalls = cards.filter(card => /all three/i.test(card.badge));
    check("the whole-sequence task collects three positions and checks them once",
          seqRecalls.length > 0 && seqRecalls.every(card => card.area.slots === 3 && card.locked === 4 &&
                                                            /three tones were \d-\d-\d/.test(card.status) &&
                                                            card.marks.every(m => !/^\d+/.test(m.mark))),
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
            card.slots.length === 3 && card.slots.every(s => /[\u2713\u2717]$/.test(s.text.trim()))),
          seqRecalls.filter(card => /^Wrong/.test(card.status)).slice(0, 2).map(card => card.slots));
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
    check("no more than two cards in a row on the same tone", worstRun <= 2, { seq: toneSeq.join(""), worstRun, heard: cards.map(heardTone).join("") });
    check("all four tones appear inside 12 cards", Object.values(toneHist).every(n => n > 0), toneHist);
    check("tone counts stay balanced (no tone above 40%)", Math.max(...Object.values(toneHist)) <= Math.ceil(toneSeq.length * 0.4), toneHist);

    check("every card answered in the walk registers in the score line", new RegExp("n=" + cards.length).test(walk.score), walk.score);
    check("score line still carries the interval and the chance note", /95% CI/.test(walk.score) && /Chance is \d/.test(walk.score), walk.score);
    check("guess-corrected score stays hidden below 60 trials", /hidden until 60/.test(walk.acc), walk.acc);
    check("a score line is shown per task type that was answered", /first attempts/i.test(walk.taskLines), walk.taskLines.slice(0, 200));
    check("every task line states its own chance level", !/Chance is 50%/.test(walk.taskLines) &&
          (walk.taskLines.match(/Chance is \d/g) || []).length >= 2 && !/No answers yet/.test(walk.taskLines),
          walk.taskLines.slice(0, 400));
    check("the whole-sequence line states its 1-in-64 chance", /Chance is 2%\.|Chance is 1\.6%|Chance is 2%/.test(walk.taskLines) ||
          !/All three tones/.test(walk.taskLines), walk.taskLines.slice(0, 400));
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

    const storedBefore = await evaluate(c, `(localStorage.getItem('mandarin-tone-scheduler-v1') || '').length`);

    /* reload: the scheduler state must survive */
    await c.send("Page.navigate", { url: APP });
    await sleep(2500);
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
