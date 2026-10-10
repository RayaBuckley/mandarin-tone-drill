/*! tests/simulate.js - measured evidence that the sampler changed.  Run: node tests/simulate.js  */
"use strict";
const P = require("../progression.js");
const fs = require("fs");
const path = require("path");

/* deterministic PRNG so the two samplers face the same learner */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "datasets", "tones", "metadata.json"), "utf8"));
const bank = meta.map(m => ({ id: m.syllable + m.tone, syllable: m.syllable, tone: m.tone }));

/* Simulated learner: a per-item latent skill (fixed seed), a tone effect, and a spacing gain while the item's
   box climbs.  No per-item difficulty model is exposed to either sampler - it only sees right/wrong. */
const TONE_EFFECT = { 1: 0.02, 2: -0.04, 3: -0.07, 4: 0.05 };
function makeLearner(seed) {
  const rnd = mulberry32(seed);
  const skill = {};
  bank.forEach(b => { skill[b.id] = 0.42 + 0.40 * rnd(); });
  return {
    p(id, box) {
      const tone = P.toneOf(id);
      const base = skill[id] + (TONE_EFFECT[tone] || 0) + 0.14 * (box / 7);
      return Math.max(0.05, Math.min(0.98, base));
    }
  };
}

function stats(xs) {
  if (!xs.length) return { n: 0, p10: null, median: null, p90: null, mean: null };
  const s = xs.slice().sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: s.length, p10: q(0.10), median: q(0.50), p90: q(0.90), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

/* ---------- new sampler ---------- */
function runNew(days, sessionsPerDay, seed, tag) {
  const sched = P.newScheduler(0);
  P.ensureItems(sched, bank.map(b => b.id));
  const learner = makeLearner(seed);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  let trials = 0, correct = 0, correctLast100 = [], seenTrial = {}, gaps = [], toneSlots = [], relaxedCount = 0, overCapTotal = 0;
  const taskTotals = {}; let worstToneRun = 0, worstTaskRun = 0, sessionsAllTones = 0, sessionsAllTasks = 0, sessionLengths = [];
  const trialsPerCard = {};
  const pendingLapse = {};              // card -> trial index when it was last failed
  const lapseReturnGaps = [];
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < sessionsPerDay; s++) {
      const sess = P.buildSession(sched, bank, d, { rng: mulberry32(d * 7919 + s) });
      /* "new" is here by design (the session is meant to hand out new cards); only the variety rules count */
      if (sess.relaxed.some(r => r !== "new")) relaxedCount++;
      overCapTotal += sess.overCapNew;
      sessionLengths.push(sess.slots.length);
      const tc = {};
      const seenTasks = {};
      sess.slots.forEach(slot => {
        const id = slot.id;
        seenTasks[slot.task] = (seenTasks[slot.task] || 0) + 1;
        taskTotals[slot.task] = (taskTotals[slot.task] || 0) + 1;
        const box = sched.items[id].box;
        const p = learner.p(id, box);
        const ok = rnd() < p;
        trials++; if (ok) correct++;
        correctLast100.push(ok ? 1 : 0);
        trialsPerCard[id] = (trialsPerCard[id] || 0) + 1;
        if (seenTrial[id] !== undefined) gaps.push(trials - seenTrial[id]);
        if (pendingLapse[id] !== undefined) { lapseReturnGaps.push(trials - pendingLapse[id]); delete pendingLapse[id]; }
        seenTrial[id] = trials;
        if (!ok) pendingLapse[id] = trials;
        P.recordFirstAttempt(sched, id, ok, d);
        const t = P.toneOf(id); tc[t] = (tc[t] || 0) + 1;
      });
      toneSlots.push(Math.max(...[1, 2, 3, 4].map(t => tc[t] || 0)));
      /* runs: how long the same tone, or the same task, can repeat back to back (the owner's complaint) */
      const tones = sess.slots.map(sl => P.toneOf(sl.id));
      let run = 0;
      tones.forEach((t, i) => { run = (i && t === tones[i - 1]) ? run + 1 : 1; if (run > worstToneRun) worstToneRun = run; });
      const taskSeq = sess.slots.map(sl => sl.task);
      run = 0;
      taskSeq.forEach((t, i) => { run = (i && t === taskSeq[i - 1]) ? run + 1 : 1; if (run > worstTaskRun) worstTaskRun = run; });
      if ([1, 2, 3, 4].every(t => tc[t] > 0)) sessionsAllTones++;
      if (Object.keys(seenTasks).length === 4) sessionsAllTasks++;
    }
  }
  const sum = P.summarise(sched, bank, days);
  const last100 = correctLast100.slice(-100).reduce((a, b) => a + b, 0) / Math.min(100, correctLast100.length);
  return {
    tag, trials, distinctItems: Object.keys(trialsPerCard).length,
    unseenShare: +(sum.unseen / sum.total).toFixed(4),
    gapTrials: stats(gaps), maxGap: gaps.length ? Math.max(...gaps) : null,
    worstOverdueDays: schedWorstOverdue(sched, bank, days), overdueCards: sum.dueNow,
    overdueDaysTotal: +sum.overdueDaysTotal.toFixed(1),
    toneSlotMaxMean: +(toneSlots.reduce((a, b) => a + b, 0) / Math.max(1, toneSlots.length)).toFixed(3),
    toneSlotMaxWorst: toneSlots.length ? Math.max(...toneSlots) : null,
    sessionsNeedingRelaxation: relaxedCount, overCapAdmissions: overCapTotal,
    accuracyAll: +(correct / trials).toFixed(4), accuracyLast100: +last100.toFixed(4),
    lapseReturn: stats(lapseReturnGaps), lapseReturnWorst: lapseReturnGaps.length ? Math.max(...lapseReturnGaps) : null,
    mastered: sum.mastered, serializedBytes: P.serializedSize(sched),
    worstToneRun, worstTaskRun, sessionsAllTones, sessionsAllTasks, taskTotals,
    sessionLength: { first: sessionLengths[0], last: sessionLengths[sessionLengths.length - 1],
                     min: Math.min(...sessionLengths), max: Math.max(...sessionLengths),
                     mean: +(sessionLengths.reduce((a, b) => a + b, 0) / sessionLengths.length).toFixed(2) }
  };
}

function schedWorstOverdue(sched, bank, day) {
  let worst = 0, card = null;
  bank.forEach(b => {
    const e = sched.items[b.id];
    if (!e || e.last === null) return;
    const od = P.overdueDays(e, day);
    if (od > worst) { worst = od; card = b.id; }
  });
  return { days: worst, card };
}

/* ---------- legacy sampler: uniform random from the deck, never the card just shown (what the app does today) ---------- */
function runLegacy(days, sessionsPerDay, seed, tag) {
  const learner = makeLearner(seed);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const box = {}; bank.forEach(b => { box[b.id] = 0; });
  let trials = 0, correct = 0, correctLast100 = [], seenTrial = {}, gaps = [], toneSlots = [], last = null;
  const trialsPerCard = {};
  const pendingLapse = {};
  const lapseReturnGaps = [];
  const LADDER = P.LADDER_DAYS;
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < sessionsPerDay; s++) {
      const tc = {};
      for (let k = 0; k < 20; k++) {
        let id;
        do { id = bank[Math.floor(rnd() * bank.length)].id; } while (id === last && bank.length > 1);
        last = id;
        const p = learner.p(id, box[id]);
        const ok = rnd() < p;
        trials++; if (ok) correct++;
        correctLast100.push(ok ? 1 : 0);
        trialsPerCard[id] = (trialsPerCard[id] || 0) + 1;
        if (seenTrial[id] !== undefined) gaps.push(trials - seenTrial[id]);
        if (pendingLapse[id] !== undefined) { lapseReturnGaps.push(trials - pendingLapse[id]); delete pendingLapse[id]; }
        seenTrial[id] = trials;
        if (!ok) pendingLapse[id] = trials;
        box[id] = ok ? Math.min(box[id] + 1, LADDER.length - 1) : Math.max(box[id] - 2, 0);
        const t = P.toneOf(id); tc[t] = (tc[t] || 0) + 1;
      }
      toneSlots.push(Math.max(...[1, 2, 3, 4].map(t => tc[t] || 0)));
    }
  }
  const distinct = Object.keys(trialsPerCard).length;
  const last100 = correctLast100.slice(-100).reduce((a, b) => a + b, 0) / Math.min(100, correctLast100.length);
  return {
    tag, trials, distinctItems: distinct, unseenShare: +((bank.length - distinct) / bank.length).toFixed(4),
    gapTrials: stats(gaps), maxGap: gaps.length ? Math.max(...gaps) : null,
    worstOverdueDays: { days: null, card: null }, overdueCards: null, overdueDaysTotal: null,
    toneSlotMaxMean: +(toneSlots.reduce((a, b) => a + b, 0) / toneSlots.length).toFixed(3),
    toneSlotMaxWorst: Math.max(...toneSlots), sessionsNeedingRelaxation: null, overCapAdmissions: null,
    accuracyAll: +(correct / trials).toFixed(4), accuracyLast100: +last100.toFixed(4),
    lapseReturn: stats(lapseReturnGaps), lapseReturnWorst: lapseReturnGaps.length ? Math.max(...lapseReturnGaps) : null,
    mastered: null, serializedBytes: null
  };
}

const results = [];
results.push(runNew(30, 1, 12345, "new sampler: 30 days x 1 session (600 trials, realistic use)"));
results.push(runLegacy(30, 1, 12345, "legacy sampler: 30 days x 1 session (600 trials)"));
results.push(runNew(30, 9, 12345, "new sampler: 30 days x 9 sessions (5,400 trials, spec floor)"));
results.push(runLegacy(30, 9, 12345, "legacy sampler: 30 days x 9 sessions (5,400 trials)"));
results.push(runNew(250, 1, 12345, "new sampler: 250 days x 1 session (5,000 trials, long horizon)"));
results.push(runLegacy(250, 1, 12345, "legacy sampler: 250 days x 1 session (5,000 trials, long horizon)"));

const out = { generated: new Date().toISOString(), bank: bank.length, results };
fs.writeFileSync(path.join(__dirname, "sim_results.json"), JSON.stringify(out, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("scenario", 60) + pad("trials", 8) + pad("distinct", 9) + pad("unseen", 8) + pad("gap med", 9) + pad("gap p90", 9) + pad("maxGap", 8) +
            pad("wrong->back med", 16) + pad("worst", 7) + pad("acc100", 8));
results.forEach(r => {
  console.log(pad(r.tag, 60) + pad(r.trials, 8) + pad(r.distinctItems, 9) + pad(r.unseenShare, 8) +
              pad(r.gapTrials.median, 9) + pad(r.gapTrials.p90, 9) + pad(r.maxGap, 8) +
              pad(r.lapseReturn.median, 16) + pad(r.lapseReturnWorst, 7) + pad(r.accuracyLast100, 8));
});
console.log("\nnew sampler only - backlog and session shape:");
results.filter(r => /^new/.test(r.tag)).forEach(r => {
  console.log("  " + pad(r.tag.split(":")[1].trim(), 46) + " worst overdue " + pad(r.worstOverdueDays.days + " d (" + r.worstOverdueDays.card + ")", 18) +
              " cards overdue " + pad(r.overdueCards, 6) + " overdue-day total " + pad(r.overdueDaysTotal, 9) +
              " tone-slot max avg/worst " + r.toneSlotMaxMean + "/" + r.toneSlotMaxWorst +
              " relaxed sessions " + r.sessionsNeedingRelaxation + " over-cap new " + r.overCapAdmissions +
              " state " + (r.serializedBytes / 1024).toFixed(1) + " KiB");
});
console.log("\nnew sampler only - task mix and session shape (the owner's complaint was blocks, not spread):");
results.filter(r => /^new/.test(r.tag)).forEach(r => {
  console.log("  " + pad(r.tag.split(":")[1].trim(), 46) + " tasks " + pad(JSON.stringify(r.taskTotals), 52) +
              " worst tone run " + r.worstToneRun + " worst task run " + r.worstTaskRun +
              " sessions with all 4 tones " + r.sessionsAllTones + "/" + r.sessionLength.mean);
});
console.log("\nfull detail written to tests/sim_results.json");
