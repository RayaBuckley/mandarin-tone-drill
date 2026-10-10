/*! tests/run_tests.js - plain Node, no framework.  Run:  node tests/run_tests.js  */
"use strict";
const P = require("../progression.js");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("FAIL " + name + (extra ? " :: " + extra : "")); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function section(t) { console.log("\n== " + t); }

/* ---------- SCORING: Wilson ---------- */
section("Wilson interval");
let w = P.wilson(12, 20);
ok(near(w.low, 0.387, 0.001), "12/20 low = 38.7%", (w.low * 100).toFixed(2) + "%");
ok(near(w.high, 0.781, 0.001), "12/20 high = 78.1%", (w.high * 100).toFixed(2) + "%");
ok(P.wilson(9, 20).low > 0.25, "9/20 lower bound clears 25%", (P.wilson(9, 20).low * 100).toFixed(2) + "%");
ok(P.wilson(8, 20).low <= 0.25, "8/20 lower bound fails 25%", (P.wilson(8, 20).low * 100).toFixed(2) + "%");
ok(P.wilson(0, 0).p === null, "empty sample has no score");
ok(P.wilson(0, 20).low === 0 || P.wilson(0, 20).low < 0.02, "0/20 lower bound collapses", String(P.wilson(0, 20).low));

/* ---------- SCORING: first attempts only ---------- */
section("First attempts only (retries must not move the score)");
let sched = P.newScheduler(0);
let run = P.createRun(sched, 0);
run.beginCard("a1");
run.answer(false);                       // first attempt: wrong
run.answer(true);                        // retry after replay: correct
let st = run.stats();
ok(st.firstTotal === 1, "one first attempt recorded", JSON.stringify(st));
ok(st.firstCorrect === 0, "the retry did not score a point", JSON.stringify(st));
ok(st.retries === 1 && st.recovered === 1, "retry counted separately as recovered");
ok(run.line().text.indexOf("0.0%") >= 0, "score line shows 0.0%", run.line().text);
run.beginCard("a2");
run.answer(true);
run.answer(true);
run.answer(true);                        // two extra retries on a first-try correct card
st = run.stats();
ok(st.firstTotal === 2 && st.firstCorrect === 1, "score is 1 of 2 first attempts", JSON.stringify(st));
ok(st.retries === 3, "all three retries counted, none scored", String(st.retries));
ok(run.line().text.indexOf("50.0%") >= 0, "score line shows 50.0%", run.line().text);
ok(run.line().text.indexOf("Chance is 25%") >= 0, "chance note is present");

/* ---------- SCORING: guess correction gating ---------- */
section("Guess-corrected score gating");
ok(P.guessCorrected(30, 59).eligible === false, "59 trials: corrected score not shown");
ok(P.guessCorrected(31, 60).eligible === true, "60 trials: corrected score eligible");
ok(near(P.guessCorrected(30, 60).p, (0.5 - 0.25) / 0.75, 1e-9), "corrected p = (p-0.25)/0.75");
ok(P.guessCorrected(10, 40).p === 0, "below chance clamps to 0");

/* ---------- SCORING: mastery rule ---------- */
section("Mastery rule (two consecutive 20-trial blocks clearing 25%)");
const win = (s) => s.split("").map(c => c === "1");
ok(P.isMastered(win("1".repeat(9) + "0".repeat(11) + "1".repeat(20))) === true, "9/20 then 20/20 = mastered (9/20 low bound is 25.8%)");
ok(P.isMastered(win("1".repeat(8) + "0".repeat(12) + "1".repeat(20))) === false, "8/20 then 20/20 is not enough (needs two consecutive clearing blocks)");
ok(P.isMastered(win("1".repeat(8) + "0".repeat(12) + "1".repeat(20))) === false, "8/20 then 20/20 = not mastered");
ok(P.isMastered(win("1".repeat(39))) === false, "39 trials is not a full window");
ok(P.isMastered(win("1".repeat(40))) === true, "40 correct = mastered");

/* ---------- SCHEDULER: ladder ---------- */
section("Ladder transitions");
sched = P.newScheduler(0); P.ensureItems(sched, ["a1", "a2", "a3", "a4"]);
let e = sched.items["a1"];
ok(e.box === 0 && e.last === null, "new card starts unseen at box 0");
P.recordFirstAttempt(sched, "a1", true, 0);  ok(e.box === 1, "correct -> box 1", String(e.box));
P.recordFirstAttempt(sched, "a1", true, 1);  ok(e.box === 2, "correct -> box 2", String(e.box));
ok(P.intervalDays(e, 1) === P.LADDER_DAYS[2] && P.LADDER_DAYS[2] === 7, "box 2 interval is 7 days");
P.recordFirstAttempt(sched, "a1", false, 2); ok(e.box === 0, "lapse -> box-2 (floor 0)", String(e.box));
ok(e.lapses === 1, "lapse counted");
for (let i = 0; i < 10; i++) P.recordFirstAttempt(sched, "a1", true, 3 + i);
ok(e.box === P.MAX_BOX, "box saturates at the top of the ladder", String(e.box));
ok(P.intervalDays(e, 20) === 365, "top of ladder is 365 days");

/* ---------- SCHEDULER: backlog -> leech ---------- */
section("Leech rule (3 lapses within 30 days)");
sched = P.newScheduler(0); P.ensureItems(sched, ["b1"]);
e = sched.items["b1"];
P.recordFirstAttempt(sched, "b1", false, 0);
P.recordFirstAttempt(sched, "b1", false, 1);
ok(e.leech === false, "2 lapses: not a leech");
P.recordFirstAttempt(sched, "b1", false, 2);
ok(e.leech === true, "3 lapses inside 30 days: leech");
for (let i = 0; i < 5; i++) P.recordFirstAttempt(sched, "b1", true, 5 + i);
ok(e.box >= 3, "box climbs again after the lapse run", String(e.box));
ok(near(P.intervalDays(e, 30), P.LADDER_DAYS[Math.min(e.box, P.MAX_BOX)] / 2, 1e-9), "leech interval is halved");
P.recordFirstAttempt(sched, "b1", false, 400);      // far future: old lapses age out
P.recordFirstAttempt(sched, "b1", false, 401);
P.recordFirstAttempt(sched, "b1", false, 402);
ok(e.leech === true, "still a leech after fresh lapses");
sched = P.newScheduler(0); P.ensureItems(sched, ["b1"]);
e = sched.items["b1"];
P.recordFirstAttempt(sched, "b1", false, 0);
P.recordFirstAttempt(sched, "b1", false, 40);       // outside the 30-day window
P.recordFirstAttempt(sched, "b1", false, 80);
ok(e.leech === false, "three lapses spread over 80 days: not a leech", JSON.stringify(e.lapseDays));

/* ---------- SCHEDULER: priority ---------- */
section("Priority picker");
sched = P.newScheduler(0);
P.ensureItems(sched, ["a1", "ai1"]);
P.recordFirstAttempt(sched, "a1", true, 0);
P.recordFirstAttempt(sched, "ai1", true, 0);
const fresh = sched.items["ai1"];
const stale = sched.items["a1"];
ok(P.priority(stale, 40) > P.priority(fresh, 1), "an overdue card outranks a fresh one");
P.recordFirstAttempt(sched, "ai1", false, 0);
ok(P.priority(sched.items["ai1"], 0) >= 3, "a card whose last attempt was wrong gets the +3 bonus", String(P.priority(sched.items["ai1"], 0)));
ok(P.priority({ box: 0, last: null, reps: 0, lapses: 0, fw: "" }, 999) === 3.0, "unseen card has fixed priority 3.0");
ok(P.priority(stale, 0) < 3.0, "a card seen today is below the unseen priority", String(P.priority(stale, 0)));

/* ---------- SCHEDULER: session shape ---------- */
section("Session composition (real metadata)");
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "datasets", "tones", "metadata.json"), "utf8"));
const bank = meta.map(m => ({ id: m.syllable + m.tone, syllable: m.syllable, tone: m.tone }));
ok(bank.length === 1600, "bank is 1600 cards", String(bank.length));

/* seeded generator: the shape checks must be reproducible, and tests may not depend on Math.random */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function ids(session) { return session.slots.map(s => s.id); }
function tonesOf(session) { return ids(session).map(id => P.toneOf(id)); }
function maxRun(arr) { let best = 0, cur = 0; arr.forEach((v, i) => { cur = (i && v === arr[i - 1]) ? cur + 1 : 1; if (cur > best) best = cur; }); return best; }

sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
let rng = mulberry32(12345);
let sess = P.buildSession(sched, bank, 0, { rng });
ok(sess.slots.length === 5, "cold start: the first session is 5 cards, not a 20-card dump", String(sess.slots.length));
ok(sess.newAdmitted === 5, "the first session admits the 5 new cards the setting asks for", String(sess.newAdmitted));
ok(sess.overCapNew === 0, "no unasked-for new cards while nothing is due", String(sess.overCapNew));
ok(sess.slots.every(s => s.id && typeof s.task === "string"), "every slot carries a card id and a task type", JSON.stringify(sess.slots[0]));

/* the owner's report: a fresh session came out as tone 1 x8, tone 2 x8, tone 3 x4 and never tone 4 */
const t0 = tonesOf(sess);
ok(new Set(t0).size === 4, "the first session covers all four tones", t0.join(" "));
ok(maxRun(t0) <= P.MAX_TONE_RUN, "no more than two cards in a row on the same tone", t0.join(" "));
ok(new Set(ids(sess).map(id => (bank.find(b => b.id === id) || {}).syllable)).size === sess.slots.length,
   "at most one card per syllable in a session");

/* two sessions on the same day, different seeds: the pick must actually change */
const a1 = ids(P.buildSession(sched, bank, 0, { rng: mulberry32(1) })).join(",");
const a2 = ids(P.buildSession(sched, bank, 0, { rng: mulberry32(2) })).join(",");
ok(a1 !== a2, "two sessions from the same state are not identical (the pick is random)", a1.slice(0, 40) + " vs " + a2.slice(0, 40));
ok(P.buildSession(sched, bank, 0, { rng: mulberry32(7) }).newAdmitted === 5, "the daily new-card cap is gone", String(P.buildSession(sched, bank, 0, { rng: mulberry32(7) }).newAdmitted));

function checkConstraints(session, label) {
  const sid = ids(session);
  const syl = sid.map(id => (bank.find(b => b.id === id) || {}).syllable);
  ok(new Set(syl).size === sid.length, label + ": at most one card per syllable", new Set(syl).size + " of " + sid.length);
  let consec = 0;
  for (let i = 1; i < syl.length; i++) if (syl[i] === syl[i - 1]) consec++;
  ok(consec === 0, label + ": no two consecutive cards share a syllable", String(consec));
  const tc = {};
  sid.forEach(id => { const t = P.toneOf(id); tc[t] = (tc[t] || 0) + 1; });
  const worst = Math.max(...Object.values(tc));
  ok(worst <= Math.ceil(session.slots.length * P.TONE_CAP_SHARE), label + ": no tone above 40% of slots", JSON.stringify(tc));
  ok(maxRun(sid.map(id => P.toneOf(id))) <= P.MAX_TONE_RUN, label + ": no tone run longer than " + P.MAX_TONE_RUN,
     sid.map(id => P.toneOf(id)).join(" "));
  ok(maxRun(session.slots.map(s => s.task)) <= P.MAX_TASK_RUN, label + ": no task run longer than " + P.MAX_TASK_RUN,
     session.slots.map(s => s.task).join(" "));
}

/* 30 days, one session a day: the shape must hold and the session must grow to 20 */
sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
rng = mulberry32(999);
const toneTotals = { 1: 0, 2: 0, 3: 0, 4: 0 };
const taskTotals = {};
let slotTotal = 0, lengths = [], relaxedDays = 0, overTotal = 0;
for (let d = 0; d < 30; d++) {
  const s = P.buildSession(sched, bank, d, { rng });
  lengths.push(s.slots.length);
  if (s.relaxed.length) relaxedDays++;
  overTotal += s.overCapNew;
  slotTotal += s.slots.length;
  s.slots.forEach(sl => {
    toneTotals[P.toneOf(sl.id)]++;
    taskTotals[sl.task] = (taskTotals[sl.task] || 0) + 1;
    const b = bank.find(x => x.id === sl.id);
    const trueAcc = 0.75 + 0.15 * Math.sin((b.tone + d) * 0.1);
    P.recordFirstAttempt(sched, sl.id, rng() < trueAcc, d);
  });
  if (d === 0 || d === 29) checkConstraints(s, "day " + d);
}
console.log("  30 days: lengths " + lengths.slice(0, 6).join(",") + " ... " + lengths.slice(-3).join(",") +
            " | tone totals " + JSON.stringify(toneTotals) + " | tasks " + JSON.stringify(taskTotals) +
            " | relaxed days " + relaxedDays + " | over-cap new " + overTotal);
ok(lengths[0] < 20 && lengths[29] === 20, "the session grows from a short first day to 20 slots", lengths.join(","));
ok(Math.max(...Object.values(toneTotals)) / slotTotal <= 0.35, "no tone takes more than a third of all slots over 30 days",
   JSON.stringify(toneTotals) + " of " + slotTotal);
ok(Math.min(...Object.values(toneTotals)) / slotTotal >= 0.15, "every tone is served properly (no tone starved)", JSON.stringify(toneTotals));
/* Live = the tasks the scheduler actually deals. Sentence-demo tasks are injected by the app, so they are
   checked separately below: the scheduler must never pick them. */
const scheduled = Object.keys(P.TASK_WEIGHTS).filter(t => t !== "tone");
ok(scheduled.every(t => (taskTotals[t] || 0) > 0), "every scheduled task type appears inside 30 days", JSON.stringify(taskTotals));
ok(P.SENTENCE_TASKS.every(t => !(taskTotals[t] > 0)), "the sentence-demo tasks are never scheduled", JSON.stringify(P.SENTENCE_TASKS));
ok(P.DEFAULT_TASKS.every(t => P.SENTENCE_TASKS.indexOf(t) < 0), "the default task list holds clip tasks only", JSON.stringify(P.DEFAULT_TASKS));
ok(!(taskTotals.tone > 0), "the archived tone-number task is absent unless it is switched on", JSON.stringify(taskTotals));
ok(Math.min(...Object.values(taskTotals)) / slotTotal >= 0.05, "no task type is a rarity", JSON.stringify(taskTotals));
checkConstraints(P.buildSession(sched, bank, 30, { rng }), "day 30");

/* a mature bank, 200 days of daily sessions */
sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
rng = mulberry32(4242);
for (let d = 0; d < 200; d++) {
  const s = P.buildSession(sched, bank, d, { rng });
  s.slots.forEach(sl => {
    const b = bank.find(x => x.id === sl.id);
    const trueAcc = 0.75 + 0.15 * Math.sin((b.tone + d) * 0.1);   // simulated learner
    P.recordFirstAttempt(sched, sl.id, rng() < trueAcc, d);
  });
}
const s200 = P.buildSession(sched, bank, 200, { rng });
checkConstraints(s200, "day 200 (mature bank)");
ok(ids(s200).some(id => !P.isUnseen(sched.items[id])), "mature session is mostly seen cards");
const sum = P.summarise(sched, bank, 200);
console.log("  mature-bank summary:", JSON.stringify(sum));
ok(sum.seen >= 900, "200 days of 5 new cards a day covers a large part of the bank", String(sum.seen));
ok(s200.overCapNew === 0 && s200.relaxed.every(r => r !== "syllable"), "a mature bank needs no over-cap admission",
   JSON.stringify({ over: s200.overCapNew, rel: s200.relaxed }));
ok(P.summarise(sched, bank, 200).introduced >= P.summarise(sched, bank, 200).seen, "introduced cards are a superset of attempted cards");
ok(sum.unseen > 0, "cards remain unseen, so the funnel is not drained early", String(sum.unseen));

/* ---------- SCORING: per-task chance levels ---------- */
section("Per-task scoring");
sched = P.newScheduler(0);
run = P.createRun(sched, 0);
run.beginCard("a1", "pair"); run.answer(true);      // same/different is a 50% guess
run.beginCard("a2", "tone"); run.answer(true);
run.beginCard("a3", "contour"); run.answer(false);
run.beginCard("a4", "syllable"); run.answer(false);
let byTask = run.stats().byTask;
ok(byTask.pair.firstTotal === 1 && byTask.pair.firstCorrect === 1, "pair answers land in the pair bucket", JSON.stringify(byTask.pair));
ok(byTask.tone.firstTotal === 1 && byTask.tone.firstCorrect === 1, "tone answers land in the tone bucket");
ok(byTask.contour.firstTotal === 1 && byTask.syllable.firstTotal === 1, "contour and syllable buckets are separate");
const tl = run.taskLines();
ok(tl.length === 4, "one score line per task type seen", String(tl.length));
const pairLine = tl.find(l => l.task === "pair");
ok(pairLine.text.indexOf("Chance is 25%") >= 0, "the two-clip task states its own 25% chance", pairLine.text);
ok(P.TASK_LABELS.pair === "Which tone was first?", "the pair task is labelled as a first-clip question", P.TASK_LABELS.pair);
ok(P.TASK_CHANCE.pair === 0.25 && P.TASK_CHANCE.tone === 0.25 && P.TASK_CHANCE.syllable === 0.25 && P.TASK_CHANCE.contour === 0.25 &&
   P.TASK_CHANCE.seq_target === 0.25, "every single-answer task type is a one-in-four guess", JSON.stringify(P.TASK_CHANCE));
ok(Math.abs(P.TASK_CHANCE.seq_recall - 1 / 64) < 1e-12, "the whole-sequence task states its own 1-in-64 chance", String(P.TASK_CHANCE.seq_recall));
ok(P.SEQ_LEN === 3 && P.sequenceLength() === 3, "a sequence card is three clips long by default", String(P.SEQ_LEN));

/* ---------- SEQUENCE LENGTH: the setting drives the chance figure ---------- */
P.setSequenceLength(6);
ok(P.SEQ_LEN === 6 && P.sequenceLength() === 6, "the sequence length setting takes effect at once", String(P.SEQ_LEN));
ok(Math.abs(P.TASK_CHANCE.seq_recall - Math.pow(0.25, 6)) < 1e-12, "a six-clip sequence states its own one-in-4096 chance",
   String(P.TASK_CHANCE.seq_recall));
ok(P.TASK_CHANCE.seq_target === 0.25, "the one-tone question stays a one-in-four guess at any length", String(P.TASK_CHANCE.seq_target));
/* A separate run, so the pooled line of the run above keeps its flat 25% mix for the checks below. */
const longRun = P.createRun(sched, 0);
longRun.beginCard("a5", "seq_recall");
longRun.answer(false);
const longLine = longRun.taskLines().find(l => l.task === "seq_recall");
ok(longLine.text.indexOf("Chance is 1 in 4096") >= 0, "a long sequence spells the tiny chance out in full", longLine.text);
P.setSequenceLength(1);
ok(P.sequenceLength() === 2 && P.SEQ_LEN === 2, "a length below the range is clamped up", String(P.sequenceLength()));
P.setSequenceLength(99);
ok(P.sequenceLength() === 8 && P.SEQ_LEN === 8, "a length above the range is clamped down", String(P.sequenceLength()));
const sentScore = P.recordFirstAttempt(sched, "sent:e001", true, 0);
ok(sentScore === null, "a sentence card never enters the clip scheduler", String(sentScore));
ok(sched.items["sent:e001"] === undefined, "no scheduler item is created for a sentence card");
P.setSequenceLength(3);
ok(P.SEQ_LEN === 3, "the length goes back to the default for the later checks", String(P.SEQ_LEN));
const wsum = Object.keys(P.TASK_WEIGHTS).reduce((a, k) => a + P.TASK_WEIGHTS[k], 0);
ok(near(wsum, 1, 1e-9), "task weights sum to 1", String(wsum));
const liveWeights = Object.keys(P.TASK_WEIGHTS).filter(k => k !== "tone").map(k => P.TASK_WEIGHTS[k]);
ok(P.TASK_WEIGHTS.pair === Math.min(...liveWeights), "the two-clip task carries the smallest share of the live tasks", JSON.stringify(P.TASK_WEIGHTS));
ok(tl.find(l => l.task === "tone").text.indexOf("Chance is 25%") >= 0, "the tone task states 25% chance");
ok(run.line().text.indexOf("Chance is 25%") >= 0, "the overall line keeps the 25% reference and says so");

/* ---------- SCHEDULER: per-tone tallies and weak-tone focus (revision 3) ---------- */
section("Per-tone first-attempt tallies");
sched = P.newScheduler(0);
ok(JSON.stringify(P.toneStats(sched)) === JSON.stringify({ 1: { n: 0, k: 0, p: null }, 2: { n: 0, k: 0, p: null },
   3: { n: 0, k: 0, p: null }, 4: { n: 0, k: 0, p: null } }), "an empty scheduler reports four tones with no data",
   JSON.stringify(P.toneStats(sched)));
P.ensureItems(sched, ["a1", "a2", "a3", "a4"]);
P.recordFirstAttempt(sched, "a1", true, 0);
P.recordFirstAttempt(sched, "a1", false, 0);
P.recordFirstAttempt(sched, "a3", false, 0);
P.recordFirstAttempt(sched, "a3", false, 1);
let ts = P.toneStats(sched);
ok(ts[1].n === 2 && ts[1].k === 1 && near(ts[1].p, 0.5, 1e-9), "tone 1 tally counts first attempts only", JSON.stringify(ts[1]));
ok(ts[3].n === 2 && ts[3].k === 0, "tone 3 tally records both misses", JSON.stringify(ts[3]));
ok(ts[2].n === 0 && ts[2].p === null, "an untouched tone is reported as no data, never as 0%", JSON.stringify(ts[2]));
ok(P.weakestTones(sched, 5, 2).length === 0, "no focus without enough attempts to mean anything");
P.recordFirstAttempt(sched, "a1", true, 2);
P.recordFirstAttempt(sched, "a1", true, 2);
P.recordFirstAttempt(sched, "a1", true, 3);
P.recordFirstAttempt(sched, "a3", false, 3);
P.recordFirstAttempt(sched, "a3", false, 4);
P.recordFirstAttempt(sched, "a3", true, 4);
ts = P.toneStats(sched);
ok(ts[1].n === 5 && ts[3].n === 5, "both tones reach the 5-attempt gate", JSON.stringify({ one: ts[1], three: ts[3] }));
ok(JSON.stringify(P.weakestTones(sched, 5, 2)) === JSON.stringify([3, 1]), "the two weakest tones come back worst first",
   JSON.stringify(P.weakestTones(sched, 5, 2)));
ok(P.weakestTones(sched, 5, 1).length === 1, "the caller can ask for one tone");

section("Weak-tone focus shifts the session mix without breaking the rules");
sched = P.newScheduler(0);
P.ensureItems(sched, bank.map(b => b.id));
rng = mulberry32(2024);
for (let d = 0; d < 40; d++) {
  const s = P.buildSession(sched, bank, d, { rng });
  s.slots.forEach(sl => {
    /* tone 4 is deliberately the weak one for this learner */
    const b = bank.find(x => x.id === sl.id);
    const acc = b.tone === 4 ? 0.35 : 0.85;
    P.recordFirstAttempt(sched, sl.id, rng() < acc, d);
  });
}
const weak = P.weakestTones(sched, 5, 2);
ok(weak.indexOf(4) >= 0, "the simulated weak tone is detected", JSON.stringify(weak));
/* Both runs start from the same scheduler state, so the only difference is the focus list. */
const focusBase = JSON.stringify(sched);
function toneMix(session) { const m = { 1: 0, 2: 0, 3: 0, 4: 0 }; ids(session).forEach(id => { m[P.toneOf(id)] += 1; }); return m; }
const plainMix = { 1: 0, 2: 0, 3: 0, 4: 0 }, focusMix = { 1: 0, 2: 0, 3: 0, 4: 0 };
const focusSessions = [], plainSessions = [];
for (let k = 0; k < 40; k++) {
  const a = P.buildSession(JSON.parse(focusBase), bank, 200 + k, { rng: mulberry32(1000 + k) });
  const b = P.buildSession(JSON.parse(focusBase), bank, 200 + k, { rng: mulberry32(1000 + k), focusTones: weak });
  plainSessions.push(a); focusSessions.push(b);
  const ma = toneMix(a), mb = toneMix(b);
  Object.keys(plainMix).forEach(t => { plainMix[t] += ma[t]; focusMix[t] += mb[t]; });
}
const plainTotal = Object.values(plainMix).reduce((x, y) => x + y, 0);
const focusTotal = Object.values(focusMix).reduce((x, y) => x + y, 0);
const share = (mix, total, list) => list.reduce((acc, t) => acc + mix[t], 0) / total;
console.log("  plain mix", JSON.stringify(plainMix), "| focus mix", JSON.stringify(focusMix), "| focus list", JSON.stringify(weak));
ok(share(focusMix, focusTotal, weak) > share(plainMix, plainTotal, weak) + 0.1,
   "the focus run puts at least ten points more of the session on the weak tones",
   JSON.stringify({ plain: share(plainMix, plainTotal, weak), focus: share(focusMix, focusTotal, weak) }));
ok(Math.min(...weak.map(t => focusMix[t] / focusTotal)) > 0.1, "each focus tone is served, not just the weakest one",
   JSON.stringify(focusMix));
ok(focusSessions.every(s => s.focusTones.join() === weak.join()), "the session reports the focus list it used");
plainSessions.concat(focusSessions).forEach(s => checkConstraints(s, "focus-and-plain session"));
ok(Math.min(...Object.keys(focusMix).map(t => focusMix[t] / focusTotal)) > 0.05, "focus still leaves room for the other tones",
   JSON.stringify(focusMix));
ok(P.buildSession(sched, bank, 200, { rng: mulberry32(5), focusTones: [] }).focusTones.length === 0, "an empty focus list is a plain session");

/* ---------- SCHEDULER: tiny deck must degrade gracefully, not hang ---------- */
section("Degenerate decks");
const tiny = [{ id: "a1", syllable: "a", tone: 1 }, { id: "a2", syllable: "a", tone: 2 }];
sched = P.newScheduler(0); P.ensureItems(sched, ["a1", "a2"]);
const sTiny = P.buildSession(sched, tiny, 0, { length: 20, rng: mulberry32(5) });
ok(sTiny.slots.length > 0, "tiny deck still yields a session", String(sTiny.slots.length));
ok(new Set(ids(sTiny)).size <= 2, "tiny deck only has the two cards to offer", String(new Set(ids(sTiny)).size));
ok(sTiny.relaxed.length > 0, "tiny deck reports its relaxations", JSON.stringify(sTiny.relaxed));
const empty = P.buildSession(P.newScheduler(0), [], 0);
ok(empty.slots.length === 0, "empty deck yields an empty session");

/* ---------- storage ---------- */
section("Serialised size");
sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
rng = mulberry32(31337);
for (let d = 0; d < 60; d++) {
  const s = P.buildSession(sched, bank, d, { rng });
  s.slots.forEach(sl => P.recordFirstAttempt(sched, sl.id, rng() < 0.7, d));
}
const bytes = P.serializedSize(sched);
console.log("  full bank, 60 days of sessions: " + bytes + " bytes (" + (bytes / 1024).toFixed(1) + " KiB)");
ok(bytes < 400 * 1024, "serialised history fits comfortably in localStorage", String(bytes));

/* ---------- the offline shell list: every path the service worker pre-caches must exist ---------- */
section("Service worker shell");
const swSrc = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
const shellBlock = (swSrc.match(/const APP_SHELL = \[([\s\S]*?)\];/) || [null, ""])[1];
const shell = shellBlock.split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
const appRoot = path.join(__dirname, "..");
const missingShell = shell.filter(p => p !== "./" && !fs.existsSync(path.join(appRoot, p.replace(/^\.\//, ""))));
ok(shell.length >= 20, "the shell list is not empty", String(shell.length));
ok(missingShell.length === 0, "every file the shell pre-caches exists on disk", JSON.stringify(missingShell));
ok(shell.indexOf("./datasets/sentences/demo.json") >= 0, "the sentence pack is in the shell list, so the demo works offline");
const swCache = (swSrc.match(/const CACHE_NAME = "([^"]+)"/) || [null, ""])[1];
ok(/-v10$/.test(swCache), "the cache name is bumped, or a Home-Screen copy keeps serving the old files", swCache);
const packPath = path.join(appRoot, "datasets", "sentences", "demo.json");
const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
const packList = Array.isArray(pack.sentences) ? pack.sentences : [];
ok(packList.length === 12, "the sentence demo ships twelve sentences", String(packList.length));
const packMissing = packList.filter(s => !fs.existsSync(path.join(appRoot, "datasets", "sentences", s.audio)));
ok(packMissing.length === 0, "every sentence record names an audio file that is shipped", JSON.stringify(packMissing.map(s => s.id)));
ok(packList.every(s => shell.indexOf("./datasets/sentences/" + s.audio) >= 0),
   "every sentence clip is pre-cached for offline use",
   JSON.stringify(packList.filter(s => shell.indexOf("./datasets/sentences/" + s.audio) < 0).map(s => s.id)));
const badRecords = packList.filter(s => !s.hanzi || !Array.isArray(s.pinyin) || !Array.isArray(s.tones) ||
   s.pinyin.length !== s.chars.length || s.pinyin.some(p => !/^[A-Za-z]+[1-5]?$/.test(p)) || !s.gloss || !s.licence || !s.attribution);
ok(badRecords.length === 0, "every sentence record carries hanzi, numbered pinyin, tones, a gloss and its licence",
   JSON.stringify(badRecords.map(s => s.id)));
ok(new Set(packList.map(s => s.gloss)).size === packList.length, "no two demo sentences share a gloss, so a meaning question has one answer");
ok(new Set(packList.map(s => s.id)).size === packList.length, "the demo ids are unique");

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) { console.log("failures:\n  " + failures.join("\n  ")); process.exit(1); }
