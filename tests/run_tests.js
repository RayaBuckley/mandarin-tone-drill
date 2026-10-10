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
ok(Object.keys(taskTotals).length === 4, "all four task types appear inside 30 days", JSON.stringify(taskTotals));
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
ok(pairLine.text.indexOf("Chance is 50%") >= 0, "the same/different task states its own 50% chance", pairLine.text);
ok(tl.find(l => l.task === "tone").text.indexOf("Chance is 25%") >= 0, "the tone task states 25% chance");
ok(run.line().text.indexOf("Chance is 25%") >= 0, "the overall line keeps the 25% reference and says so");

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

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) { console.log("failures:\n  " + failures.join("\n  ")); process.exit(1); }
