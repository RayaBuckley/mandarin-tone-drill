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
  /* The daily new-card cap is GONE. It was a workload heuristic, not a learning finding, and the owner
     found it got in the way. New material is now a per-session setting (NEW_PER_SESSION) and the session
     shortens itself on a cold start instead of spending a hidden budget. */
  var NEW_PER_SESSION = 5;
  var SESSION_LEN = 20;
  var WARMUP = 2;
  var TONE_CAP_SHARE = 0.4;          // one tone may take at most 8 of 20 slots
  var MAX_TONE_RUN = 2;              // never three cards in a row on the same tone
  var MAX_TASK_RUN = 2;
  var TOP_K = 8;                     // pick at random among the K most urgent eligible cards
  var SCHEMA = "mtd-progress/1";

  /* Task types. Every one of them uses only the existing clips, so nothing new is downloaded. */
  var TASKS = ["tone", "syllable", "pair", "contour"];
  var TASK_WEIGHTS = { tone: 0.40, syllable: 0.25, pair: 0.20, contour: 0.15 };
  var TASK_LABELS = { tone: "Which tone?", syllable: "Which syllable?", pair: "Same tone or different?",
                      contour: "Which tone shape?" };
  var TASK_CHANCE = { tone: 0.25, syllable: 0.25, pair: 0.5, contour: 0.25 };

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

  function guessCorrected(k, n, z, chance) {
    var c = chance === undefined ? CHANCE : chance;
    var w = wilson(k, n, z);
    if (w.p === null) return { eligible: false, n: 0, p: null, low: null, high: null, chance: c };
    var f = function (x) { return Math.max(0, (x - c) / (1 - c)); };
    return { eligible: n >= MIN_TRIALS_FOR_CORRECTED, n: n, p: f(w.p), low: f(w.low), high: f(w.high), chance: c };
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
  function scoreLine(firstCorrect, firstTotal, chance, label) {
    var c = chance === undefined ? CHANCE : chance;
    var chanceText = "Chance is " + Math.round(c * 100) + "%.";
    var head = label ? label + " - first attempts: " : "First attempts: ";
    var w = wilson(firstCorrect, firstTotal);
    if (!firstTotal) return { text: head + "0, no score yet. " + chanceText, raw: null, corrected: null, note: chanceText };
    var text = head + formatPercent(w.p) + " (95% CI " + formatPercent(w.low) + "-" + formatPercent(w.high) +
               ", n=" + firstTotal + "). " + chanceText;
    var corrected = guessCorrected(firstCorrect, firstTotal, undefined, c);
    return { text: text, raw: w, corrected: corrected.eligible ? corrected : null, note: chanceText };
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

  /* Build one session.
   *
   * The old builder walked the bank in order and took the first card that fit the rules. The bank is ordered
   * syllable-major, tone-minor, and the "one card per syllable per session" rule then took the tone-1 card of
   * each syllable: a fresh session came out as eight tone-1 cards, eight tone-2, four tone-3 and no tone 4 at
   * all. Measured on the owner's phone. The builder now samples at random among the most urgent eligible
   * cards, balances tones, and refuses to place more than MAX_TONE_RUN cards in a row on one tone.
   *
   * Session shape: WARMUP weak cards, then `newPerSession` new cards, then the rest by priority. On a cold
   * start the session is shorter instead of quietly spending more new material than asked for.
   *
   * Hard rules, relaxed in a fixed order and reported in `relaxed` when the deck cannot satisfy them:
   * one card per syllable per session, no tone above TONE_CAP_SHARE of the slots, no long same-tone run.
   */
  function buildSession(sched, bank, dayIndex, opts) {
    opts = opts || {};
    var rnd = opts.rng || Math.random;
    var wantLen = opts.length || SESSION_LEN;
    var warmN = opts.warmup === undefined ? WARMUP : opts.warmup;
    var newPerSession = opts.newPerSession === undefined ? NEW_PER_SESSION : opts.newPerSession;
    var topK = opts.topK || TOP_K;

    var byId = {};
    for (var i = 0; i < bank.length; i++) byId[bank[i].id] = bank[i];

    /* the owner can switch task types off; an empty list means "all of them" */
    var tasks = (opts.tasks && opts.tasks.length) ? TASKS.filter(function (t) { return opts.tasks.indexOf(t) >= 0; }) : TASKS.slice();
    if (!tasks.length) tasks = TASKS.slice();

    var day = sched.daily[String(dayIndex)] || (sched.daily[String(dayIndex)] = { newAdmitted: 0, overCap: 0 });

    var seenAvail = 0, unseenAvail = 0, seenSyllables = {};
    for (var b = 0; b < bank.length; b++) {
      var e0 = sched.items[bank[b].id];
      if (!e0) continue;
      if (isUnseen(e0)) unseenAvail++;
      else { seenAvail++; seenSyllables[bank[b].syllable || bank[b].id] = true; }
    }
    /* A slot can come from a seen card (at most one per syllable, so the distinct seen syllables are the
       ceiling) or from the new-card allowance. The session shortens itself rather than silently spending
       more new material than the owner asked for. */
    var seenUsable = Object.keys(seenSyllables).length;
    /* A new card on a syllable that a waiting review card still needs steals that review slot: the session
       then runs out of review cards and quietly spends extra new ones. Fresh picks therefore avoid the
       syllables the review pool is holding, until nothing else fits. */
    var len = Math.min(wantLen, Math.max(1, newPerSession + seenUsable));
    var toneCap = Math.max(1, Math.floor(len * TONE_CAP_SHARE));

    var trace = opts.trace ? [] : null;
    var chosen = [];                 // [{id, task}]
    var usedSyllable = {}, toneCount = {}, taskCount = {}, overCap = 0, admitted = 0;
    var relaxed = [];

    function syllableOf(id) { return (byId[id] || { syllable: id }).syllable; }
    function toneOfId(id) { return toneOf(id); }
    function note(what) { if (relaxed.indexOf(what) < 0) relaxed.push(what); }

    function toneRunWouldBe(t) {
      var run = 0;
      for (var j = chosen.length - 1; j >= 0 && toneOfId(chosen[j].id) === t; j--) run++;
      return run + 1;
    }

    function fits(id, allow) {
      allow = allow || {};
      var syl = syllableOf(id);
      if (!allow.syllable && usedSyllable[syl]) return "syllable-used";
      var t = toneOfId(id);
      if (!allow.toneCap && (toneCount[t] || 0) >= toneCap) return "tone-cap";
      if (!allow.toneRun && toneRunWouldBe(t) > MAX_TONE_RUN) return "tone-run";
      return null;
    }

    /* Random choice among the topK eligible cards, weighted towards tones that are behind, so a session
       cannot come out in blocks and cannot favour one tone. */
    function candidates(pool, allow, role, avoidSeen) {
      var out = [];
      for (var j = 0; j < pool.length; j++) {
        var id = pool[j].id;
        if (chosen.some(function (c) { return c.id === id; })) continue;
        if (avoidSeen && seenSyllables[syllableOf(id)]) continue;
        if (fits(id, allow) !== null) continue;
        var e = sched.items[id];
        var score = priority(e, dayIndex);
        if (role === "warm") {
          score = 10 * (1 - recentRate(e)) + Math.min(overdueDays(e, dayIndex), 4);   // weakest first
        }
        score += 0.5 * (maxToneCount() - (toneCount[toneOfId(id)] || 0));             // balance the tones
        out.push({ id: id, score: score });
      }
      out.sort(function (a, b) { return b.score - a.score; });
      return out.slice(0, topK);
    }

    function maxToneCount() {
      var m = 0;
      Object.keys(toneCount).forEach(function (k) { if (toneCount[k] > m) m = toneCount[k]; });
      return m;
    }

    function pickTask() {
      var last = chosen.length ? chosen[chosen.length - 1].task : null;
      var runLen = 0;
      for (var j = chosen.length - 1; j >= 0 && chosen[j].task === last; j--) runLen++;
      var pool = tasks.filter(function (t) { return !(t === last && runLen >= MAX_TASK_RUN); });
      if (!pool.length) pool = tasks.slice();
      /* a session of any length should not come out as one task type: weight the least-used type up */
      var minCount = Math.min.apply(null, tasks.map(function (t) { return taskCount[t] || 0; }));
      var weights = pool.map(function (t) { return TASK_WEIGHTS[t] * (1 + (minCount === (taskCount[t] || 0) ? 1.4 : 0)); });
      var total = weights.reduce(function (a, b) { return a + b; }, 0);
      var r = rnd() * total;
      for (var k = 0; k < pool.length; k++) { r -= weights[k]; if (r <= 0) return pool[k]; }
      return pool[pool.length - 1];
    }

    function add(id, spendsNew) {
      var task = opts.fixedTask || pickTask();
      chosen.push({ id: id, task: task });
      usedSyllable[syllableOf(id)] = true;
      toneCount[toneOfId(id)] = (toneCount[toneOfId(id)] || 0) + 1;
      taskCount[task] = (taskCount[task] || 0) + 1;
      var e = sched.items[id];
      if (e && (e.introduced === null || e.introduced === undefined)) e.introduced = dayIndex;
      if (spendsNew) {
        if (admitted < newPerSession) admitted++;
        else { overCap++; day.overCap = (day.overCap || 0) + 1; note("more-new-than-asked"); }
      }
    }

    function pickFrom(list, allow, role, avoidSeen) {
      var cands = candidates(list, allow, role, avoidSeen);
      if (!cands.length) return null;
      return cands[Math.min(cands.length - 1, Math.floor(rnd() * cands.length))].id;
    }

    var seenPool = [], unseenPool = [];
    for (var q = 0; q < bank.length; q++) {
      var ee = sched.items[bank[q].id];
      if (!ee) continue;
      (isUnseen(ee) ? unseenPool : seenPool).push({ id: bank[q].id });
    }

    /* Per-slot ladder. Seen cards are preferred over spending extra new material: relaxing a session-variety
       rule costs nothing, while an unasked-for new card changes the pace the owner set. Fresh tiers sit after
       the seen ones for that reason, and the harshest rule (a second card on a syllable already used in this
       session) is relaxed last. */
    var LADDER = [
      { pool: "seen",   allow: {},                                            note: null,       fresh: false },
      { pool: "seen",   allow: { toneCap: true },                             note: "tone-cap", fresh: false },
      { pool: "seen",   allow: { toneRun: true },                             note: "tone-run", fresh: false },
      { pool: "seen",   allow: { toneCap: true, toneRun: true },              note: "tone-run", fresh: false },
      { pool: "unseen", allow: {},                                            note: "new",      fresh: true, avoidSeen: true },
      { pool: "seen",   allow: { syllable: true, toneCap: true, toneRun: true }, note: "syllable", fresh: false },
      { pool: "unseen", allow: { toneCap: true, toneRun: true },              note: "new",      fresh: true, avoidSeen: true },
      { pool: "unseen", allow: { syllable: true, toneCap: true, toneRun: true }, note: "new",    fresh: true },
      { pool: "any",    allow: { syllable: true, toneCap: true, toneRun: true, repeat: true }, note: "repeat", fresh: true }
    ];
    /* New-material slots ask for fresh cards first; the seen tiers remain as a fallback for a drained bank. */
    var LADDER_FRESH = [LADDER[4], LADDER[6], LADDER[7], LADDER[0], LADDER[1], LADDER[5], LADDER[8]];

    for (var slot = 0; slot < len; slot++) {
      var role = slot < warmN ? "warm" : (slot < warmN + newPerSession ? "new" : "fill");
      var order = role === "new" ? LADDER_FRESH : LADDER;
      var placed = false;
      for (var s = 0; s < order.length && !placed; s++) {
        var step = order[s];
        var pool = step.pool === "seen" ? seenPool : step.pool === "unseen" ? unseenPool : seenPool.concat(unseenPool);
        var id = pickFrom(pool, step.allow, role, step.avoidSeen);
        if (id) {
          if (step.note) note(step.note);
          add(id, step.fresh);
          if (trace) trace.push({ slot: slot, role: role, tier: s, pool: step.pool, note: step.note, id: id });
          placed = true;
        }
      }
      if (!placed) break;
    }

    day.newAdmitted = admitted;
    return { day: dayIndex, length: len, slots: chosen, newAdmitted: admitted, overCapNew: overCap,
             relaxed: relaxed, toneCap: toneCap, seenPoolSize: seenPool.length, unseenPoolSize: unseenPool.length,
             trace: trace };
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
    var retries = 0, recovered = 0;
    var perCard = {};
    var byTask = {};
    TASKS.forEach(function (t) { byTask[t] = { firstCorrect: 0, firstTotal: 0, retries: 0, recovered: 0 }; });
    var totalFirst = 0, totalCorrect = 0, scoredRetries = 0, scoredRecovered = 0;

    function bucket(task) {
      var t = TASKS.indexOf(task) >= 0 ? task : "tone";
      return byTask[t];
    }

    return {
      beginCard: function (id, task) {
        open = { id: id, task: TASKS.indexOf(task) >= 0 ? task : "tone", answered: false, firstWasCorrect: null };
        return open;
      },
      answer: function (isCorrect, task) {
        if (!open) return { ignored: true };
        var t = task === undefined ? open.task : task;
        var b = bucket(t);
        if (!open.answered) {
          open.answered = true;
          open.firstWasCorrect = !!isCorrect;
          b.firstTotal += 1; totalFirst += 1;
          if (isCorrect) { b.firstCorrect += 1; totalCorrect += 1; }
          recordFirstAttempt(sched, open.id, isCorrect, dayIndex);
          var p = perCard[open.id] || (perCard[open.id] = { n: 0, k: 0 });
          p.n += 1; if (isCorrect) p.k += 1;
          return { scored: true, first: true, correct: !!isCorrect, task: open.task };
        }
        retries += 1; b.retries += 1;
        scoredRetries += 1;
        if (isCorrect && open.firstWasCorrect === false) { recovered += 1; b.recovered += 1; scoredRecovered += 1; }
        return { scored: false, first: false, retry: true, correct: !!isCorrect, task: open.task };
      },
      get openCard() { return open ? open.id : null; },
      get openTask() { return open ? open.task : null; },
      get firstAttemptSeen() { return open ? open.answered : false; },
      stats: function () {
        return { firstCorrect: totalCorrect, firstTotal: totalFirst, retries: scoredRetries,
                 recovered: scoredRecovered, perCard: perCard, byTask: byTask };
      },
      /* One line per task type, each with its own chance level (same/different is a 50% guess). */
      taskLines: function () {
        return TASKS.map(function (t) {
          var b = byTask[t];
          var l = scoreLine(b.firstCorrect, b.firstTotal, TASK_CHANCE[t], TASK_LABELS[t]);
          l.task = t; l.stats = b;
          return l;
        }).filter(function (l) { return l.stats.firstTotal > 0; });
      },
      line: function () {
        var l = scoreLine(totalCorrect, totalFirst, CHANCE, null);
        l.retries = scoredRetries; l.recovered = scoredRecovered;
        if (scoredRetries) l.text += " Retries after replay are not scored (" + scoredRetries + " so far, " + scoredRecovered + " recovered).";
        l.byTask = byTask;
        return l;
      }
    };
  }

  return {
    SCHEMA: SCHEMA, CHANCE: CHANCE, Z95: Z95, LADDER_DAYS: LADDER_DAYS, MAX_BOX: MAX_BOX,
    SESSION_LEN: SESSION_LEN, WARMUP: WARMUP, NEW_PER_SESSION: NEW_PER_SESSION,
    TONE_CAP_SHARE: TONE_CAP_SHARE, MAX_TONE_RUN: MAX_TONE_RUN, MAX_TASK_RUN: MAX_TASK_RUN,
    TASKS: TASKS, TASK_WEIGHTS: TASK_WEIGHTS, TASK_LABELS: TASK_LABELS, TASK_CHANCE: TASK_CHANCE,
    MIN_TRIALS_FOR_CORRECTED: MIN_TRIALS_FOR_CORRECTED,
    wilson: wilson, guessCorrected: guessCorrected, isMastered: isMastered, scoreLine: scoreLine,
    newScheduler: newScheduler, ensureItems: ensureItems, recordFirstAttempt: recordFirstAttempt,
    priority: priority, overdueDays: overdueDays, elapsedDays: elapsedDays, intervalDays: intervalDays,
    isUnseen: isUnseen, buildSession: buildSession, summarise: summarise, tonePriors: tonePriors,
    toneOf: toneOf, dayOf: dayOf, serializedSize: serializedSize, refreshLeech: refreshLeech,
    createRun: createRun
  };
});
