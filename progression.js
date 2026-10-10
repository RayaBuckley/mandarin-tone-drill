/*! progression.js - scoring and spaced scheduling for mandarin-tone-drill.
 *
 *  Pure logic, no DOM. Usable from the page (window.MTDProgress) and from Node (require).
 *  Two responsibilities:
 *    1. SCORING  - Wilson 95% interval over FIRST attempts only, chance level 25%, the mastery rule.
 *    2. SCHEDULER - per-item ladder boxes, lapses, leeches, a priority picker and a 20-slot session shape.
 *
 *  Design notes that matter:
 *    - only the FIRST attempt on a card is scored; a retry after replay is recorded separately and never moves
 *      the score (the old app counted the retry, which inflated displayed accuracy);
 *    - the picker is a priority picker, not a due-filter: a backlog of overdue items can never permanently
 *      starve a card, it only reorders it;
 *    - scheduling state is not difficulty estimation. No per-item difficulty model is kept: measured earlier,
 *      it lost to a per-tone prior on held-out log-loss. Only per-tone accuracy is exported as a hint.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MTDProgress = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var Z95 = 1.96;
  var CHANCE = 0.25;                 // four tones, one answer
  var LADDER_DAYS = [1, 3, 7, 16, 35, 75, 160, 365];
  var MAX_BOX = LADDER_DAYS.length - 1;
  var MASTERY_BLOCK = 20;            // two consecutive 20-trial blocks
  var WINDOW_CAP = 40;               // first-try window kept per item (exactly the mastery window)
  var LEECH_LAPSES = 3;              // 3 lapses ...
  var LEECH_WINDOW_DAYS = 30;        // ... within 30 days
  var UNSEEN_PRIORITY = 3.0;
  var NEW_PER_DAY = 3;
  var SESSION_LEN = 20;
  var WARMUP = 2;
  var NEW_SLOTS = 3;
  var TONE_CAP_SHARE = 0.4;          // one tone may take at most 8 of 20 slots
  var SCHEMA = "mtd-progress/1";

  /* ---------- 1. SCORING ---------- */

  function wilson(k, n, z) {
    z = z || Z95;
    if (!n || n <= 0) return { p: null, low: 0, high: 1, centre: null, half: null, n: 0, k: 0 };
    var phat = k / n;
    var denom = 1 + (z * z) / n;
    var centre = (phat + (z * z) / (2 * n)) / denom;
    var half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
    return { p: phat, low: Math.max(0, centre - half), high: Math.min(1, centre + half), centre: centre, half: half, n: n, k: k };
  }

  /* Corrected for guessing: p_c = (p - 0.25) / 0.75, clamped at 0, applied to the interval ends too.
     Only meaningful with enough trials - see MIN_TRIALS_FOR_CORRECTED. */
  var MIN_TRIALS_FOR_CORRECTED = 60;

  function guessCorrected(k, n, z) {
    var w = wilson(k, n, z);
    if (w.p === null) return { eligible: false, n: 0, p: null, low: null, high: null };
    var f = function (x) { return Math.max(0, (x - CHANCE) / (1 - CHANCE)); };
    return { eligible: n >= MIN_TRIALS_FOR_CORRECTED, n: n, p: f(w.p), low: f(w.low), high: f(w.high) };
  }

  /* A card is mastered only when the last two consecutive 20-trial blocks both clear 25% at the lower bound,
     i.e. at least 9 of 20 in each block (9/20 -> 25.8% low, 8/20 -> 21.9% low). */
  function masteryBlockPass(tries) {
    var w = wilson(tries.reduce(function (a, b) { return a + b; }, 0), tries.length);
    return w.low > CHANCE;
  }

  /* The stored window is a compact string ("1101"); tests may pass an array of 0/1. Accept both. */
  function toTries(x) {
    if (typeof x === "string") return x.split("").map(function (c) { return c === "1" ? 1 : 0; });
    return Array.isArray(x) ? x : [];
  }

  function isMastered(firstTries) {
    firstTries = toTries(firstTries);
    if (firstTries.length < 2 * MASTERY_BLOCK) return false;
    var last = firstTries.slice(-2 * MASTERY_BLOCK);
    return masteryBlockPass(last.slice(0, MASTERY_BLOCK)) && masteryBlockPass(last.slice(MASTERY_BLOCK));
  }

  function formatPercent(x) { return (x * 100).toFixed(1) + "%"; }

  /* The one line the app shows. First attempts only. */
  function scoreLine(firstCorrect, firstTotal) {
    var w = wilson(firstCorrect, firstTotal);
    if (!firstTotal) return { text: "First attempts: 0 - no score yet. Chance is 25% (4 tones).", raw: null, corrected: null, note: "Chance is 25% (4 tones)." };
    var text = "First attempts: " + formatPercent(w.p) + " (95% CI " + formatPercent(w.low) + "-" + formatPercent(w.high) +
               ", n=" + firstTotal + "). Chance is 25%.";
    var corrected = guessCorrected(firstCorrect, firstTotal);
    return { text: text, raw: w, corrected: corrected.eligible ? corrected : null,
             note: "Chance is 25% (4 tones)." };
  }

  /* ---------- 2. SCHEDULER ---------- */

  function newScheduler(nowMs) {
    return { schema: SCHEMA, created: nowMs || 0, items: {}, daily: {} };
  }

  function blankEntry() {
    /* introduced: the day the card first appeared on screen. A card that was shown but never answered is no
       longer "new", otherwise every session would re-admit it and blow through the daily new-card cap. */
    return { box: 0, last: null, reps: 0, lapses: 0, fw: "", leech: false, lapseDays: [], introduced: null };
  }

  function ensureItems(sched, ids) {
    var added = 0;
    for (var i = 0; i < ids.length; i++) {
      if (!sched.items[ids[i]]) { sched.items[ids[i]] = blankEntry(); added++; }
    }
    return added;
  }

  function dayOf(nowMs) { return Math.floor(nowMs / 86400000); }

  function intervalDays(entry, dayIndex) {
    var base = LADDER_DAYS[Math.min(entry.box, MAX_BOX)];
    if (entry.leech) base = base / 2;                       // leeches come back sooner, quietly
    return base;
  }

  function dueDay(entry, ) { return entry.last === null ? null : entry.last + intervalDays(entry); }

  function overdueDays(entry, dayIndex) {
    if (entry.last === null) return 0;
    var d = dueDay(entry);
    return Math.max(0, dayIndex - d);
  }

  function elapsedDays(entry, dayIndex) {
    return entry.last === null ? 0 : Math.max(0, dayIndex - entry.last);
  }

  /* priority = min(overdue, 4) + 3 if last attempt wrong + 0.02 * elapsed since last seen.
     Unseen cards get a flat 3.0 and are only admitted through the daily new-item cap. */
  function priority(entry, dayIndex) {
    if (entry.last === null) {
      /* shown once, never answered (the owner pressed Next): keep it near the new-card priority, plus a
         small age kick so it cannot be starved by freshly introduced cards */
      if (entry.introduced !== null && entry.introduced !== undefined) {
        return UNSEEN_PRIORITY + 0.02 * Math.max(0, dayIndex - entry.introduced);
      }
      return UNSEEN_PRIORITY;
    }
    var over = Math.min(overdueDays(entry, dayIndex), 4);
    var wrong = entry.fw.length && entry.fw.charAt(entry.fw.length - 1) === "0" ? 3 : 0;
    return over + wrong + 0.02 * elapsedDays(entry, dayIndex);
  }

  function pushWindow(fw, ok) {
    fw = fw + (ok ? "1" : "0");
    return fw.length > WINDOW_CAP ? fw.slice(fw.length - WINDOW_CAP) : fw;
  }

  /* Lapses inside the 30-day window decide leech status. */
  function refreshLeech(entry, dayIndex) {
    entry.lapseDays = (entry.lapseDays || []).filter(function (d) { return dayIndex - d <= LEECH_WINDOW_DAYS; });
    entry.leech = entry.lapseDays.length >= LEECH_LAPSES;
    return entry.leech;
  }

  function recordFirstAttempt(sched, id, correct, dayIndex) {
    var e = sched.items[id] || (sched.items[id] = blankEntry());
    e.reps += 1;
    e.fw = pushWindow(e.fw, !!correct);
    if (correct) {
      e.box = Math.min(e.box + 1, MAX_BOX);
    } else {
      e.box = Math.max(e.box - 2, 0);
      e.lapses += 1;
      e.lapseDays = (e.lapseDays || []).concat([dayIndex]);
    }
    e.last = dayIndex;
    refreshLeech(e, dayIndex);
    return e;
  }

  function isUnseen(entry) {
    return entry.last === null && (entry.introduced === null || entry.introduced === undefined);
  }

  function toneOf(id) { var m = String(id).match(/(\d)$/); return m ? Number(m[1]) : 0; }

  /* Build one 20-slot session:
       2 warm-up (weakest recent cards) + 3 new (daily cap) + the rest by priority.
     Hard constraints while the deck allows them: one card per syllable per session, never two consecutive
     cards from the same syllable, no tone above 40% of the slots, unseen cards admitted only through the
     daily cap. When the deck is too small or too uniform for a rule, the rule is relaxed in a fixed order
     (tone cap -> syllable rules -> new-item cap -> repeats) and every relaxation is reported in the result. */
  function buildSession(sched, bank, dayIndex, opts) {
    opts = opts || {};
    var len = opts.length || SESSION_LEN;
    var warmN = opts.warmup === undefined ? WARMUP : opts.warmup;
    var newSlots = opts.newSlots === undefined ? NEW_SLOTS : opts.newSlots;
    var cap = opts.newPerDay === undefined ? NEW_PER_DAY : opts.newPerDay;

    var byId = {};
    for (var i = 0; i < bank.length; i++) byId[bank[i].id] = bank[i];

    var day = sched.daily[String(dayIndex)] || (sched.daily[String(dayIndex)] = { newAdmitted: 0, overCap: 0 });
    var toneCap = Math.max(1, Math.floor(len * TONE_CAP_SHARE));

    var chosen = [], usedSyllable = {}, toneCount = {}, relaxed = [], overCap = 0;

    function syllableOf(id) { return (byId[id] || { syllable: id }).syllable; }
    function toneOfId(id) { return toneOf(id); }

    function fits(id, allow) {
      allow = allow || {};
      var syl = syllableOf(id);
      if (!allow.syllable) {
        if (usedSyllable[syl]) return "syllable-used";
        if (chosen.length && syllableOf(chosen[chosen.length - 1]) === syl) return "same-syllable-consecutive";
      }
      var t = toneOfId(id);
      if (!allow.toneCap && (toneCount[t] || 0) >= toneCap) return "tone-cap";
      return null;
    }

    function add(id) {
      chosen.push(id);
      usedSyllable[syllableOf(id)] = true;
      toneCount[toneOfId(id)] = (toneCount[toneOfId(id)] || 0) + 1;
      var e = sched.items[id];
      if (e && (e.introduced === null || e.introduced === undefined)) e.introduced = dayIndex;
    }

    function note(what) { if (relaxed.indexOf(what) < 0) relaxed.push(what); }

    function list(predicate) {
      var out = [];
      for (var j = 0; j < bank.length; j++) {
        var id = bank[j].id, e = sched.items[id];
        if (!e) continue;
        if (predicate && !predicate(id, e)) continue;
        out.push({ id: id, e: e, pr: priority(e, dayIndex) });
      }
      out.sort(function (a, b) {
        if (b.pr !== a.pr) return b.pr - a.pr;
        return String(a.id) < String(b.id) ? -1 : 1;                  // deterministic tie-break
      });
      return out;
    }

    /* Try to place the best-fitting card from a list. Returns true when a slot was filled. */
    function tryAdd(cands, allow) {
      if (chosen.length >= len) return false;
      for (var k = 0; k < cands.length; k++) {
        var id = cands[k].id;
        if (chosen.indexOf(id) >= 0 && !allow.repeat) continue;
        if (fits(id, allow) === null) { add(id); return true; }
      }
      return false;
    }

    var seenPool = list(function (id, e) { return !isUnseen(e); });
    var unseenPool = list(function (id, e) { return isUnseen(e); });
    var allowAll = { toneCap: true, syllable: true };

    /* 1. warm-up: the weakest cards seen recently, then the most overdue */
    seenPool.slice().sort(function (a, b) {
      var ra = recentRate(a.e), rb = recentRate(b.e);
      if (ra !== rb) return ra - rb;
      return overdueDays(b.e, dayIndex) - overdueDays(a.e, dayIndex);
    }).forEach(function (c) {
      if (chosen.length < Math.min(warmN, len) && chosen.indexOf(c.id) < 0 && fits(c.id, {}) === null) add(c.id);
    });

    /* 2. new cards, through the per-day cap */
    var roomForNew = Math.max(0, Math.min(newSlots, cap - day.newAdmitted, len - chosen.length));
    var admitted = 0;
    for (var u = 0; u < unseenPool.length && admitted < roomForNew; u++) {
      if (chosen.indexOf(unseenPool[u].id) < 0 && fits(unseenPool[u].id, {}) === null) { add(unseenPool[u].id); admitted++; }
    }
    day.newAdmitted += admitted;

    /* 3. fill the rest by priority. The ladder below is the relaxation order: keep every hard rule until the
          deck cannot satisfy it, and record each rule that had to give way. */
    var ladder = [
      /* cheapest first: use cards the owner has already met, under every rule */
      { cands: seenPool,   allow: {},          note: null,       newCard: false },
      /* then spend a little more of the new-item budget rather than break syllable variety:
         a fresh card brings a fresh syllable with it */
      { cands: unseenPool, allow: {},          note: "new-cap",  newCard: true },
      { cands: seenPool,   allow: { toneCap: true }, note: "tone-cap", newCard: false },
      { cands: unseenPool, allow: { toneCap: true }, note: "new-cap", newCard: true },
      { cands: seenPool,   allow: allowAll,    note: "syllable", newCard: false },
      { cands: unseenPool, allow: allowAll,    note: "new-cap",  newCard: true },
      { cands: list(null), allow: { toneCap: true, syllable: true, repeat: true }, note: "repeat", newCard: false }
    ];
    var guard = 0;
    while (chosen.length < len && guard++ < 500) {
      var placed = false;
      for (var s = 0; s < ladder.length && !placed; s++) {
        var step = ladder[s];
        if (tryAdd(step.cands, step.allow)) {
          if (step.note) note(step.note);
          if (step.newCard) { overCap += 1; day.overCap = (day.overCap || 0) + 1; }
          placed = true;
        }
      }
      if (!placed) break;
    }

    return { day: dayIndex, slots: chosen, newAdmitted: admitted, overCapNew: overCap, relaxed: relaxed, toneCap: toneCap };
  }

  function recentRate(entry) {
    var fw = entry.fw || "";
    if (!fw.length) return 1;
    var window = fw.slice(-10);
    var k = 0;
    for (var i = 0; i < window.length; i++) if (window.charAt(i) === "1") k++;
    return k / window.length;
  }

  /* Per-tone accuracy hint - the only difficulty signal the scheduler keeps (spec: no per-item model). */
  function tonePriors(sched, bank) {
    var agg = {}, syl = {};
    for (var i = 0; i < bank.length; i++) {
      var id = bank[i].id, e = sched.items[id];
      var t = toneOf(id);
      if (!agg[t]) agg[t] = { n: 0, k: 0 };
      var fw = (e && e.fw) || "";
      agg[t].n += fw.length;
      for (var j = 0; j < fw.length; j++) if (fw.charAt(j) === "1") agg[t].k++;
    }
    var out = {};
    Object.keys(agg).forEach(function (t) {
      out[t] = { n: agg[t].n, k: agg[t].k, p: agg[t].n ? agg[t].k / agg[t].n : null };
    });
    return out;
  }

  function summarise(sched, bank, dayIndex) {
    var seen = 0, mastered = 0, leeches = 0, dueNow = 0, overdue = 0, introduced = 0, boxes = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < bank.length; i++) {
      var e = sched.items[bank[i].id];
      if (!e) continue;
      if (e.introduced !== null && e.introduced !== undefined) introduced++;
      if (e.last !== null) {
        seen++;
        var od = overdueDays(e, dayIndex);
        if (od > 0) { dueNow++; overdue += od; }
        if (od > 3) { /* keep a simple backlog counter below */ }
        boxes[Math.min(e.box, MAX_BOX)]++;
      }
      if (isMastered(e.fw)) mastered++;
      if (e.leech) leeches++;
    }
    return { total: bank.length, seen: seen, introduced: introduced, unseen: bank.length - introduced,
             mastered: mastered, leeches: leeches, dueNow: dueNow, overdueDaysTotal: overdue, boxes: boxes };
  }

  function serializedSize(sched) { return JSON.stringify(sched).length; }

  /* ---------- 3. RUN: the exact path the app scores through ----------
     One open card at a time. The first answer on a card is scored and updates the ladder; any further answer
     on the same card is a RETRY: it is counted as "recovered after replay" and can never move the score. */
  function createRun(sched, dayIndex) {
    var open = null;
    var firstCorrect = 0, firstTotal = 0, retries = 0, recovered = 0;
    var perCard = {};
    return {
      beginCard: function (id) { open = { id: id, answered: false, firstWasCorrect: null }; return open; },
      answer: function (isCorrect) {
        if (!open) return { ignored: true };
        if (!open.answered) {
          open.answered = true;
          open.firstWasCorrect = !!isCorrect;
          firstTotal += 1;
          if (isCorrect) firstCorrect += 1;
          recordFirstAttempt(sched, open.id, isCorrect, dayIndex);
          var p = perCard[open.id] || (perCard[open.id] = { n: 0, k: 0 });
          p.n += 1; if (isCorrect) p.k += 1;
          return { scored: true, first: true, correct: !!isCorrect };
        }
        retries += 1;
        if (isCorrect && open.firstWasCorrect === false) recovered += 1;
        return { scored: false, first: false, retry: true, correct: !!isCorrect };
      },
      get openCard() { return open ? open.id : null; },
      get firstAttemptSeen() { return open ? open.answered : false; },
      stats: function () { return { firstCorrect: firstCorrect, firstTotal: firstTotal, retries: retries, recovered: recovered, perCard: perCard }; },
      line: function () {
        var l = scoreLine(firstCorrect, firstTotal);
        l.retries = retries; l.recovered = recovered;
        if (retries) l.text += " Retries after replay are not scored (" + retries + " so far, " + recovered + " recovered).";
        return l;
      }
    };
  }

  return {
    SCHEMA: SCHEMA, CHANCE: CHANCE, Z95: Z95, LADDER_DAYS: LADDER_DAYS, MAX_BOX: MAX_BOX,
    SESSION_LEN: SESSION_LEN, WARMUP: WARMUP, NEW_SLOTS: NEW_SLOTS, NEW_PER_DAY: NEW_PER_DAY,
    MIN_TRIALS_FOR_CORRECTED: MIN_TRIALS_FOR_CORRECTED,
    wilson: wilson, guessCorrected: guessCorrected, isMastered: isMastered, scoreLine: scoreLine,
    newScheduler: newScheduler, ensureItems: ensureItems, recordFirstAttempt: recordFirstAttempt,
    priority: priority, overdueDays: overdueDays, elapsedDays: elapsedDays, intervalDays: intervalDays,
    isUnseen: isUnseen, buildSession: buildSession, summarise: summarise, tonePriors: tonePriors,
    toneOf: toneOf, dayOf: dayOf, serializedSize: serializedSize, refreshLeech: refreshLeech,
    createRun: createRun
  };
});
