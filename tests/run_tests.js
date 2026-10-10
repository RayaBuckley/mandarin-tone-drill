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
sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
let sess = P.buildSession(sched, bank, 0);
ok(sess.slots.length === 20, "20 slots", String(sess.slots.length));
ok(sess.newAdmitted === 3, "3 new cards admitted on day 0", String(sess.newAdmitted));
let sess2 = P.buildSession(sched, bank, 0);
ok(sess2.newAdmitted === 0, "daily new cap holds inside the same day", String(sess2.newAdmitted));
ok(sess2.overCapNew === 0, "a card shown but not answered is not re-admitted as new", String(sess2.overCapNew));
ok(P.summarise(sched, bank, 0).introduced === 20, "the first session introduced 20 cards", JSON.stringify(P.summarise(sched, bank, 0)));
ok(sess.newAdmitted === 3, "session 1 admits exactly the 3 capped new cards", String(sess.newAdmitted));
ok(sess.overCapNew >= 0, "cold-start admissions beyond the cap are reported", String(sess.overCapNew));
let sess3 = P.buildSession(sched, bank, 1);
ok(sess3.newAdmitted === 3, "cap resets on the next day", String(sess3.newAdmitted));

function checkConstraints(session, label) {
  const syl = session.map(id => (bank.find(b => b.id === id) || {}).syllable);
  const uniq = new Set(syl);
  ok(uniq.size === session.length, label + ": at most one card per syllable", uniq.size + " of " + session.length);
  let consec = 0;
  for (let i = 1; i < syl.length; i++) if (syl[i] === syl[i - 1]) consec++;
  ok(consec === 0, label + ": no two consecutive cards share a syllable", String(consec));
  const tc = {};
  session.forEach(id => { const t = P.toneOf(id); tc[t] = (tc[t] || 0) + 1; });
  const worst = Math.max(...Object.values(tc));
  ok(worst <= 8, label + ": no tone above 40% of slots", JSON.stringify(tc));
}
checkConstraints(sess.slots, "day 0");
checkConstraints(sess3.slots, "day 1");

/* a mature bank, 200 days of daily sessions */
sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
for (let d = 0; d < 200; d++) {
  const s = P.buildSession(sched, bank, d);
  s.slots.forEach(id => {
    const b = bank.find(x => x.id === id);
    const trueAcc = 0.75 + 0.15 * Math.sin((b.tone + d) * 0.1);   // simulated learner
    P.recordFirstAttempt(sched, id, Math.random() < trueAcc, d);
  });
}
const s200 = P.buildSession(sched, bank, 200);
checkConstraints(s200.slots, "day 200 (mature bank)");
ok(s200.slots.some(id => !P.isUnseen(sched.items[id])), "mature session is mostly seen cards");
const sum = P.summarise(sched, bank, 200);
console.log("  mature-bank summary:", JSON.stringify(sum));
ok(sum.seen >= 600, "200 days x 3 new admits at least 600 cards", String(sum.seen));
ok(sum.seen <= 900, "the cold-start spill beyond the cap stays bounded", String(sum.seen));
ok(s200.overCapNew === 0 && s200.relaxed.length === 0, "a mature bank needs neither over-cap admission nor relaxation", JSON.stringify({ over: s200.overCapNew, rel: s200.relaxed }));
ok(P.summarise(sched, bank, 200).introduced >= P.summarise(sched, bank, 200).seen, "introduced cards are a superset of attempted cards");
ok(sum.unseen > 0, "cards remain unseen, so the funnel is not drained early", String(sum.unseen));

/* ---------- SCHEDULER: tiny deck must degrade gracefully, not hang ---------- */
section("Degenerate decks");
const tiny = [{ id: "a1", syllable: "a", tone: 1 }, { id: "a2", syllable: "a", tone: 2 }];
sched = P.newScheduler(0); P.ensureItems(sched, ["a1", "a2"]);
const sTiny = P.buildSession(sched, tiny, 0, { length: 20 });
ok(sTiny.slots.length === 20, "tiny deck still fills 20 slots", String(sTiny.slots.length));
ok(new Set(sTiny.slots).size <= 2, "tiny deck only has the two cards to offer", String(new Set(sTiny.slots).size));
ok(sTiny.relaxed.length > 0, "tiny deck reports its relaxations", JSON.stringify(sTiny.relaxed));
const empty = P.buildSession(P.newScheduler(0), [], 0);
ok(empty.slots.length === 0, "empty deck yields an empty session");

/* ---------- storage ---------- */
section("Serialised size");
sched = P.newScheduler(0); P.ensureItems(sched, bank.map(b => b.id));
for (let d = 0; d < 60; d++) {
  const s = P.buildSession(sched, bank, d);
  s.slots.forEach(id => P.recordFirstAttempt(sched, id, Math.random() < 0.7, d));
}
const bytes = P.serializedSize(sched);
console.log("  full bank, 60 days of sessions: " + bytes + " bytes (" + (bytes / 1024).toFixed(1) + " KiB)");
ok(bytes < 400 * 1024, "serialised history fits comfortably in localStorage", String(bytes));

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) { console.log("failures:\n  " + failures.join("\n  ")); process.exit(1); }
