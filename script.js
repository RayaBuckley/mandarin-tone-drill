/*  mandarin-tone-drill - scoring, spaced scheduling and the audio path.
 *
 *  Scoring: only the FIRST attempt on a card counts. A replay-and-retry is recorded as a retry and can never
 *  move the score, because the old behaviour (retry counts as correct) inflated displayed accuracy.
 *  Scheduling: progression.js keeps per-card ladder state and picks the next card; this file owns the DOM.
 *  Tasks: four task types (tone, syllable, same-or-different pair, tone contour) are handed out per slot by
 *  progression.js; this file renders the matching answer area and plays the clips that task needs.
 *  Audio: one reused <audio> element, optional Web Audio gain from the verified loudness table, and the iOS
 *  playback audio session type. Every optional part fails open: playback still works with no gain and no API.
 */

const STORAGE_KEY = "mandarin-tone-settings-v3";
const LEGACY_STORAGE_KEYS = ["mandarin-tone-settings-v2"];
/* Archived in revision 4, and the list lives in progression.js so the scheduler and the app agree. */
const ARCHIVED_TASKS = window.MTDProgress.ARCHIVED_TASKS;
const PROGRESS_KEY = "mandarin-tone-scheduler-v1";
const DAILY_KEEP = 60;                 // daily new-card counters kept (days) before pruning

/* The result stays on screen long enough to read before anything moves: revision 4 removed the instant
   jump that made the screen feel jumpy. */
const ADVANCE_DELAY_MS = 750;
const REPEAT_DELAY_MS = 1500;

const ALL_TONES = [1, 2, 3, 4];

const TONE_COPY = { 1: "high", 2: "rising", 3: "dipping", 4: "falling" };
const TONE_SHORT = { 1: "high", 2: "rising", 3: "dip", 4: "falling" };
/* The two-clip task plays two clips, so it is the slowest card in the deck: keep the gap tight. */
const PAIR_GAP_MS = 220;               // silence between clip A and clip B of a pair trial
const PAIR_TAIL_MS = 120;
/* Tone 2 against tone 3 is the contrast learners miss most, so the pair task reaches for it first. */
const CONFUSABLE = [2, 3];

/* Tone marks for the syllable task. The bank uses plain ASCII pinyin (no u-umlaut), so the mark goes on the
   first of a, o, e, otherwise on the last vowel of the final. */
const TONE_MARKS = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù" };
function toneMarked(syllable, tone) {
  const s = String(syllable || "");
  if (!(tone >= 1 && tone <= 4)) return s;
  let at = -1;
  for (const vowel of ["a", "o", "e"]) {
    const found = s.indexOf(vowel);
    if (found >= 0) { at = found; break; }
  }
  if (at < 0) for (let k = s.length - 1; k >= 0; k -= 1) if ("iu".includes(s[k])) { at = k; break; }
  if (at < 0) return s;
  const marks = TONE_MARKS[s[at]];
  return marks ? s.slice(0, at) + marks[tone - 1] + s.slice(at + 1) : s;
}

/* The four contour shapes drawn inside the option buttons of the contour task. */
const CONTOUR_PATHS = {
  1: "M4 16 L44 14",
  2: "M4 26 L44 8",
  3: "M4 9 L18 26 L44 10",
  4: "M4 7 L44 27"
};

const EASY_FINALS = [
    "a",
    "e",
    "i",
    "u",
    "ai",
    "ei",
    "ao",
    "ou",
    "an",
    "ang",
    "o",
    "uo",
];


/*SETTINGS*/
const DEFAULT_SETTINGS = {
  tonesEnabled: [1, 2, 3, 4],
  repeatOnIncorrect: true,
  easyFinals: false,
  audioSpeed: 0.9,
  newPerSession: 5,                    // new cards handed out per session, chosen by the owner (was 3/day)
  tasksEnabled: window.MTDProgress.DEFAULT_TASKS.slice(),
  focusWeakTones: false                // lean the session towards the tone(s) the owner keeps missing
};
let ITEMS = [];

/* progression state - loaded before the settings object, because loadSettings validates task names against it */
const P = window.MTDProgress;

let settings = loadSettings();
let deck = [];
let currentItem = null;
let currentTone = 1;
let currentTask = "tone";               // task type of the card on screen
let currentSlot = null;                 // { id, task } taken from the session
let sequence = [];                     // the clips of a sequence card, in play order
let seqAskedAt = -1;                   // which clip the question is about (seq_target), decided after playback
let seqPicked = [];                    // tones tapped so far on a whole-sequence card
let pairPartner = null;                 // clip B of a pair trial (same syllable, another tone)
let pairToneA = 1;                      // the tone of clip A, which is the answer of that trial
let pairStep = 0;                       // 0 = clip A, 1 = clip B
let revealed = false;
let correct = 0;                       // kept for the old display path; the score now comes from the run
let total = 0;
let streak = 0;
let installRegistration = null;

let sched = loadScheduler();
let run = null;
let session = null;
let sessionIndex = 0;
let audioUnlocked = false;

/* Revision 4 moved the settings to a new key so the archived tone-number task cannot come back with an old
   stored value. An older profile is read once, its answers kept, and the archived task dropped. */
function loadSettings() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    let migrated = false;
    if (!raw) {
      for (const key of LEGACY_STORAGE_KEYS) {
        const older = localStorage.getItem(key);
        if (older) { raw = older; migrated = true; break; }
      }
    }
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const next = {
      tonesEnabled: Array.isArray(parsed.tonesEnabled) ? parsed.tonesEnabled.filter((n) => ALL_TONES.includes(n)) : DEFAULT_SETTINGS.tonesEnabled,
      repeatOnIncorrect: typeof parsed.repeatOnIncorrect === "boolean" ? parsed.repeatOnIncorrect : DEFAULT_SETTINGS.repeatOnIncorrect,
      easyFinals: typeof parsed.easyFinals === "boolean" ? parsed.easyFinals : DEFAULT_SETTINGS.easyFinals,
      audioSpeed: typeof parsed.audioSpeed === "number" && parsed.audioSpeed >= 0.1 ? parsed.audioSpeed : DEFAULT_SETTINGS.audioSpeed,
      newPerSession: typeof parsed.newPerSession === "number" && parsed.newPerSession >= 0
        ? Math.min(20, Math.round(parsed.newPerSession)) : DEFAULT_SETTINGS.newPerSession,
      tasksEnabled: (Array.isArray(parsed.tasksEnabled)
        ? parsed.tasksEnabled.filter((t) => P.TASKS.includes(t)) : DEFAULT_SETTINGS.tasksEnabled.slice())
        .filter((t) => !(migrated && ARCHIVED_TASKS.includes(t))),
      focusWeakTones: typeof parsed.focusWeakTones === "boolean" ? parsed.focusWeakTones : DEFAULT_SETTINGS.focusWeakTones
    };
    if (!next.tasksEnabled.length) next.tasksEnabled = DEFAULT_SETTINGS.tasksEnabled.slice();
    return next;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/*PERSISTED PROGRESSION*/
function loadScheduler() {
  const fresh = P.newScheduler(Date.now());
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== P.SCHEMA || typeof parsed.items !== "object") return fresh;
    parsed.daily = parsed.daily || {};
    return parsed;
  } catch {
    return fresh;
  }
}

function saveScheduler() {
  try {
    const day = P.dayOf(Date.now());
    Object.keys(sched.daily).forEach((k) => {
      if (day - Number(k) > DAILY_KEEP) delete sched.daily[k];
    });
    sched.updated = Date.now();
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(sched));
    return true;
  } catch (err) {
    setStatus("Progress could not be saved (storage full?). The drill still works.");
    return false;
  }
}

/*LOAD DATASET*/
async function loadDataset() {
  let metadata;
  try {
    const response = await fetch("./datasets/tones/metadata.json");
    if (!response.ok) throw new Error("HTTP " + response.status);
    metadata = await response.json();
    if (!Array.isArray(metadata) || !metadata.length) throw new Error("empty dataset");
  } catch (err) {
    setStatus("Could not load the tone bank (" + (err && err.message ? err.message : err) + "). Reload the page.");
    document.getElementById("promptMeta").textContent = "No data loaded.";
    return;
  }

  /* id is syllable+tone, which is also the clip name in the verified loudness table (a1, a2, ...) */
  ITEMS = metadata.map(item => ({
    id: `${item.syllable}${item.tone}`,
    syllable: item.syllable,
    initial: item.initial,
    final: item.final,
    tone: item.tone,
    audio: `./datasets/tones/${item.audio}`
  }));

  deck = buildDeck();
  P.ensureItems(sched, ITEMS.map((i) => i.id));
  run = P.createRun(sched, P.dayOf(Date.now()));
  saveScheduler();
  updateStats();          // the run exists now, so the score line shows its zero state instead of "no attempts yet"
  nextQuestion();
  renderProgress();
}


/*FILTER TO ENABLED TONES*/
function buildDeck() {
  return ITEMS.filter(item =>
    settings.tonesEnabled.includes(item.tone) && (!settings.easyFinals || EASY_FINALS.includes(item.final))
  );
}

/*What the card asks, and what the correct answer is for that task.*/
function taskPrompt(task) {
  return {
    tone: "Which tone did you hear?",
    syllable: "Which syllable did you hear?",
    pair: "Two clips, same syllable. Which tone was CLIP A?",
    contour: "Which shape matches the pitch you heard?",
    seq_target: "Three syllables, one after another. Listen to all of them.",
    seq_recall: "Three syllables, one after another. Hold all three tones."
  }[task] || "Which tone did you hear?";
}

/* ---------- sequence cards (revision 4) ----------
   Two task types play several clips back to back. seq_target asks about ONE of them, and which one is drawn
   AFTER the clips have played, so the question cannot be prepared for: the answer area waits, disabled, until
   the last clip is done. seq_recall asks for the whole sequence and checks it only when every position has a
   tone, so a mistake in the middle does not stop the flow. */
const SEQ_GAP_MS = 180;                // silence between two clips of a sequence
const SEQ_TAIL_MS = 120;

const SEQ_LEN = 3;

function sequenceLength() { return P.SEQ_LEN || 3; }

function pickSequenceExtras(item, want) {
  const used = {};
  used[item.syllable] = true;
  const pool = deck.filter((i) => i.id !== item.id && !used[i.syllable]);
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = [];
  for (const cand of shuffled) {
    if (picked.length >= want - 1) break;
    if (used[cand.syllable]) continue;
    used[cand.syllable] = true;
    picked.push(cand);
  }
  /* A deck too small to give three different syllables repeats what it has rather than dropping the task. */
  for (const cand of shuffled) {
    if (picked.length >= want - 1) break;
    if (picked.indexOf(cand) >= 0) continue;
    picked.push(cand);
  }
  return picked;
}

/* Build the play order. For seq_target the card of the slot is placed at the position the question will ask
   about; for seq_recall it goes first, and the whole sequence is the question. */
function buildSequence(item, task) {
  const want = sequenceLength();
  const clips = pickSequenceExtras(item, want).slice(0, Math.max(0, want - 1));
  if (!clips.length) return null;                     // a one-clip deck cannot make a sequence: fall back
  const order = [];
  if (task === "seq_target") {
    /* the position the question will ask about is drawn now and only revealed after the last clip */
    seqAskedAt = Math.floor(Math.random() * (clips.length + 1));
    let next = 0;
    for (let i = 0; i <= clips.length; i += 1) {
      if (i === seqAskedAt) { order.push(item); continue; }
      if (!clips[next]) break;
      order.push(clips[next]);
      next += 1;
    }
  } else {
    order.push(item);
    clips.forEach((c) => order.push(c));
    seqAskedAt = -1;
  }
  return order;
}

function sequenceTones() { return sequence.map((s) => String(s.tone)); }

/* The position chips. While the owner is answering they show what was tapped; once the card is checked they
   show the tapped tone next to a tick or a cross, which is what survives a grayscale screen. */
function renderSequenceSlots(values, graded) {
  /* One chip per position in the clip, empty until it is tapped: the owner should see three places to fill
     before the first tap, not a row that grows out of nothing. */
  const total = Math.max(sequence.length > 1 ? sequence.length : 0, values.length, SEQ_LEN);
  const chips = [];
  for (let i = 0; i < total; i++) {
    const v = values[i] || "";
    const verdict = graded ? graded[i] : "";
    const mark = verdict === "correct" ? "\u2713" : verdict === "wrong" ? "\u2717" : "";
    chips.push(`<div class="seq-slot${v ? " filled" : ""}${verdict ? " " + verdict : ""}" data-pos="${i + 1}">` +
      `<span class="slot-where">${i + 1}</span>` +
      `<span class="slot-value">${v || "-"}${mark ? `<span class="slot-mark">${mark}</span>` : ""}</span></div>`);
  }
  return `<div class="seq-slots">` + chips.join("") + `</div>`;
}

function bankOf(deckItems) {
  return deckItems.map((i) => ({ id: i.id, syllable: i.syllable, tone: i.tone }));
}

/*START A NEW 20-SLOT SESSION FROM THE SCHEDULER*/
function startSession() {
  const bank = bankOf(buildDeck());
  if (!bank.length) {
    session = { slots: [], relaxed: [], newAdmitted: 0, overCapNew: 0 };
    sessionIndex = 0;
    return session;
  }
  P.ensureItems(sched, bank.map((b) => b.id));
  const focus = settings.focusWeakTones ? P.weakestTones(sched, 5, 2) : [];
  session = P.buildSession(sched, bank, P.dayOf(Date.now()), {
    newPerSession: settings.newPerSession,
    tasks: settings.tasksEnabled,
    focusTones: focus
  });
  sessionIndex = 0;
  saveScheduler();
  return session;
}

/*SETTINGS*/

/*ANSWER AREA - one container, rebuilt for each task type*/
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function contourSvg(tone, cls) {
  return `<svg class="contour${cls ? " " + cls : ""}" viewBox="0 0 48 32" aria-hidden="true" focusable="false">` +
    `<path d="${CONTOUR_PATHS[tone] || CONTOUR_PATHS[1]}" fill="none" stroke="currentColor" ` +
    `stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

/* Options for the syllable task: same tone, and a minimal pair where the bank allows it (same final or same
   initial), so the answer cannot be reached by hearing the tone alone. */
function syllableOptions(item) {
  const sameTone = ITEMS.filter((i) => i.tone === item.tone && i.id !== item.id);
  const near = sameTone.filter((i) => i.final === item.final || i.initial === item.initial);
  const pool = near.length >= 3 ? near : sameTone;
  return shuffle([item, ...shuffle(pool).slice(0, 3)]);
}

/* Partner for the pair task: the same syllable with a different tone, so the only difference between the two
   clips is the pitch. Tones 2 and 3 are the pair learners confuse most, so a card on either of them is
   paired with the other one, and a card on tone 1 or 4 is paired with one of them. */
function pickPairPartner(item) {
  const pool = deck.filter((i) => i.id !== item.id && i.syllable === item.syllable && i.tone !== item.tone);
  if (!pool.length) return null;
  const wanted = CONFUSABLE.includes(item.tone)
    ? CONFUSABLE.filter((t) => t !== item.tone)
    : CONFUSABLE.slice();
  const preferred = pool.filter((i) => wanted.includes(i.tone));
  const source = preferred.length ? preferred : pool;
  return source[Math.floor(Math.random() * source.length)];
}

function renderAnswerArea() {
  const area = document.getElementById("answerArea");
  const title = document.getElementById("answerTitle");
  if (!area || !currentItem) return;
  if (title) title.textContent = { tone: "Which tone?", syllable: "Which syllable?", pair: "Which tone was clip A?",
    contour: "Which shape?", seq_target: "Listen to all three first", seq_recall: "Which three tones?" }[currentTask] || "Answer";

  if (currentTask === "seq_target" && sequence.length > 1) {
    /* The buttons are drawn but disabled: which of the clips the question is about is only decided after
       they have played, so there is nothing to answer yet. */
    area.className = "tone-grid listening";
    area.innerHTML = ALL_TONES.map((n) =>
      `<button class="tone-btn" data-value="${n}" disabled>${n}<small>${TONE_COPY[n]}</small></button>`
    ).join("");
  } else if (currentTask === "seq_recall" && sequence.length > 1) {
    area.className = "seq-area listening";
    area.innerHTML = renderSequenceSlots([]) +
      `<div class="tone-row">` + ALL_TONES.map((n) =>
        `<button class="tone-btn" data-value="${n}">${n}<small>${TONE_COPY[n]}</small></button>`
      ).join("") + `</div>`;
  } else if (currentTask === "pair" && pairPartner) {
    area.className = "tone-grid";
    area.innerHTML = ALL_TONES.map((n) =>
      `<button class="tone-btn choice-btn" data-value="${n}">${n}<small>${TONE_COPY[n]}</small></button>`
    ).join("");
  } else if (currentTask === "syllable") {
    area.className = "choice-grid";
    area.innerHTML = syllableOptions(currentItem).map((option) =>
      `<button class="tone-btn choice-btn" data-value="${option.id}"><span class="choice-text">${toneMarked(option.syllable, option.tone)}</span></button>`
    ).join("");
  } else if (currentTask === "contour") {
    area.className = "choice-grid";
    area.innerHTML = ALL_TONES.map((n) =>
      `<button class="tone-btn choice-btn contour-btn" data-value="${n}" aria-label="shape ${n}">${contourSvg(n)}</button>`
    ).join("");
  } else {
    area.className = "tone-grid";
    area.innerHTML = ALL_TONES.map((n) =>
      `<button class="tone-btn" id="tone${n}" data-value="${n}">${n}<small>${TONE_COPY[n]}</small></button>`
    ).join("");
  }

  area.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => answerChoice(btn));
  });
}

function updateToneSelectionUI() {
  ALL_TONES.forEach((n) => {
    const btn = document.getElementById(`selTone${n}`);
    const on = settings.tonesEnabled.includes(n);
    btn.classList.toggle("active", on);
  });

  document.getElementById("toneWarning").textContent = settings.tonesEnabled.length < 2
    ? "At least two tones must remain selected."
    : "";
}

function updateSwitchUI() {
  const repeatToggle = document.getElementById("repeatToggle");
  repeatToggle.classList.toggle("on", settings.repeatOnIncorrect);
  repeatToggle.setAttribute("aria-pressed", String(settings.repeatOnIncorrect));

  const easyFinalsToggle = document.getElementById("easyFinalsToggle");
  easyFinalsToggle.classList.toggle("on", settings.easyFinals);
  easyFinalsToggle.setAttribute("aria-pressed", String(settings.easyFinals));

  document.getElementById("modeBadge").textContent = settings.easyFinals ? "Easy finals" : "All families";

  const speedSlider = document.getElementById("speedSlider");
  const speedValue = document.getElementById("speedValue");
  speedSlider.value = String(settings.audioSpeed.toFixed(2));
  speedValue.textContent = `${settings.audioSpeed.toFixed(2)}x`;
}

function refreshModeSummary() {
  updateToneSelectionUI();
  updateSwitchUI();
}

/*SCREENS - the drill fits one phone viewport; settings and the reports live on their own screen.*/
function showScreen(name) {
  const drill = document.getElementById("screenDrill");
  const panel = document.getElementById("screenSettings");
  if (!drill || !panel) return;
  const toSettings = name === "settings";
  drill.hidden = toSettings;
  panel.hidden = !toSettings;
  if (toSettings) { renderProgress(); updateStats(); }
}

/*FEEDBACK - the verdict is carried by a mark and by brightness, so it reads in grayscale.*/
function setStatus(text, kind) {
  const box = document.getElementById("statusBox");
  const mark = document.getElementById("statusMark");
  const line = document.getElementById("statusText");
  if (line) line.textContent = text;
  if (box) {
    box.classList.toggle("ok", kind === "ok");
    box.classList.toggle("bad", kind === "bad");
  }
  if (mark) mark.textContent = kind === "ok" ? "\u2713" : kind === "bad" ? "\u2717" : "";
}

function markButton(btn, glyph) {
  if (!btn) return;
  const old = btn.querySelector(".mark");
  if (old) old.remove();
  const span = document.createElement("span");
  span.className = "mark";
  span.setAttribute("aria-hidden", "true");
  span.textContent = glyph;
  btn.appendChild(span);
}

/* The score line is first attempts only, with the Wilson interval and the chance note. */
function updateStats() {
  const line = run ? run.line() : { text: "No attempts yet.", corrected: null, retries: 0 };
  const scoreEl = document.getElementById("scoreLine");
  if (scoreEl) scoreEl.textContent = line.text;

  const accEl = document.getElementById("accuracyText");
  if (accEl) {
    accEl.textContent = line.corrected
      ? `Guess-corrected (not shown below 60 trials): ${(line.corrected.p * 100).toFixed(1)}% (95% CI ${(line.corrected.low * 100).toFixed(1)}-${(line.corrected.high * 100).toFixed(1)}%).`
      : `Guess-corrected score hidden until 60 first attempts (${run ? run.stats().firstTotal : 0} so far).`;
  }

  const taskEl = document.getElementById("taskLines");
  if (taskEl) {
    const lines = run ? run.taskLines() : [];
    taskEl.innerHTML = lines.length
      ? lines.map((line) => `<div>${line.text}</div>`).join("")
      : "<div>No answers yet. Each task type gets its own score line once it has been answered.</div>";
  }

  const barScore = document.getElementById("barScore");
  if (barScore) {
    const s = run ? run.stats() : null;
    barScore.textContent = s && s.firstTotal
      ? `First attempts: ${s.firstTotal} \u00b7 ${Math.round((s.firstCorrect / s.firstTotal) * 100)}%`
      : "No answers yet";
  }

  document.getElementById("correctCount").textContent = String(correct);
  document.getElementById("totalCount").textContent = String(total);
  document.getElementById("streakCount").textContent = String(streak);
}

/* Progress panel: what the scheduler is doing. */
function renderProgress() {
  const bank = bankOf(buildDeck());
  const day = P.dayOf(Date.now());
  const sum = P.summarise(sched, bank, day);
  const daily = sched.daily[String(day)] || { newAdmitted: 0, overCap: 0 };
  const slots = session ? session.slots.length : 0;
  const bar = document.getElementById("progressLine");
  if (bar) bar.textContent = `Session ${Math.min(sessionIndex, slots)}/${slots}`;
  const el = document.getElementById("progressDetail");
  if (!el) return;
  el.textContent = `Session ${Math.min(sessionIndex, slots)}/${slots}` +
    ` · cards met ${sum.introduced}/${sum.total} (answered ${sum.seen})` +
    ` · waiting their turn ${sum.dueNow} · mastered ${sum.mastered} · leeches ${sum.leeches}` +
    ` · new cards today ${daily.newAdmitted || 0} (set per session, no daily cap)`;

  /* per-tone first-attempt accuracy - this is what the focus switch reads, so it is shown either way */
  const toneEl = document.getElementById("toneLines");
  if (toneEl) {
    const stats = P.toneStats(sched);
    const parts = ALL_TONES.map((t) => {
      const s = stats[t];
      return `${t} ${s.n ? (s.p * 100).toFixed(0) + "% of " + s.n : "no data yet"}`;
    });
    const focus = session && session.focusTones && session.focusTones.length
      ? ` · focusing on tone ${session.focusTones.join(" and ")} this session` : "";
    toneEl.textContent = `Tone accuracy (first attempts): ${parts.join(" · ")}${focus}`;
  }
}

function describeItem() {
  const el = document.getElementById("itemMeta");
  if (!el || !currentItem) return;
  const e = sched.items[currentItem.id];
  if (!e || e.last === null) { el.textContent = "New card · box 0 of 7"; return; }
  const days = P.dayOf(Date.now()) - e.last;
  el.textContent = `Box ${e.box} of 7 · ladder ${P.LADDER_DAYS[Math.min(e.box, P.MAX_BOX)]} days` +
    ` · last seen ${days === 0 ? "today" : days + (days === 1 ? " day" : " days") + " ago"}` +
    ` · misses ${e.lapses}${e.leech ? " (leech)" : ""}`;
}

/*MOVE ONTO NEXT QUESTION - TAKE THE NEXT SLOT FROM THE SESSION*/
function nextQuestion() {
  cancelPendingAdvance();            // a manual Next supersedes the pending advance or repeat
  if (!ITEMS.length) {
    setStatus("Loading the tone bank...");
    return;
  }

  if (!session || sessionIndex >= session.slots.length) startSession();

  if (!session.slots.length) {
    setStatus("No items available for the current settings.");
    return;
  }

  clearReveal();                     // a skipped card must not leave its answer on screen
  const slot = session.slots[sessionIndex];
  sessionIndex += 1;

  const item = ITEMS.find((i) => i.id === slot.id);
  if (!item) {                       // card filtered out (settings changed mid-session): take the next slot
    nextQuestion();
    return;
  }

  currentSlot = slot;
  currentTask = P.TASKS.includes(slot.task) ? slot.task : "tone";
  currentItem = item;
  currentTone = item.tone;
  revealed = false;

  /* the two-clip task needs a partner clip of the same syllable; a one-tone deck cannot supply one */
  pairPartner = null;
  pairToneA = item.tone;
  if (currentTask === "pair") {
    pairPartner = pickPairPartner(item);
    if (!pairPartner) currentTask = "tone";        // a one-tone deck cannot make a pair: fall back
  }

  /* the sequence tasks need at least two clips; the deck is the only source, so a one-clip deck falls back */
  sequence = [];
  seqAskedAt = -1;
  seqPicked = [];
  if (isSequenceTask(currentTask)) {
    const order = buildSequence(item, currentTask);
    if (order && order.length > 1) sequence = order;
    else { currentTask = "tone"; seqAskedAt = -1; }
  }

  if (run) run.beginCard(currentItem.id, currentTask);
  const playBtn = document.getElementById("playBtn");
  if (playBtn) playBtn.textContent = "\u25b6 Play";
  renderAnswerArea();
  describeItem();
  renderProgress();

  const badge = document.getElementById("taskBadge");
  if (badge) badge.textContent = P.TASK_LABELS[currentTask] || "Which tone?";
  document.getElementById("promptMeta").textContent = currentTask === "pair"
    ? "Clip A, then clip B (same syllable, other tone). Press play to hear both again."
    : isSequenceTask(currentTask)
      ? `${sequence.length} syllables with a short pause between them. The question comes after the last one.`
      : "Press play to hear the item.";
  setStatus(taskPrompt(currentTask));
  playCurrent();
}

/*AUDIO - one reused element, optional Web Audio gain, iOS playback audio session*/
const audio = {
  el: null,
  ctx: null,
  gainsReady: false,
  gainFailed: false
};

/* iOS: the ring/silent switch mutes Web Audio while the audio session type is "auto" (measured on the
   owner's phone). "playback" keeps the drill audible with the switch on silent. Feature-detected, never
   allowed to throw, and it is a sticky GLOBAL property, so it is set again before each play. */
function setPlaybackSessionType() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== "playback") {
      navigator.audioSession.type = "playback";
    }
  } catch (err) { /* unsupported browser: nothing to do */ }
}

function audioContextCtor() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function ensureAudioElement() {
  if (!audio.el) {
    audio.el = new Audio();
    audio.el.preload = "auto";
  }
  return audio.el;
}

/* Called from the first real user gesture: resume the context (iOS refuses before a gesture) and load the
   verified loudness table. If any part is unavailable the drill keeps playing through the plain element. */
function unlockAudio() {
  audioUnlocked = true;
  setPlaybackSessionType();
  const Ctor = audioContextCtor();
  if (!Ctor) { audio.gainFailed = true; return; }
  try {
    if (!audio.ctx) audio.ctx = new Ctor();
    const resumed = audio.ctx.resume ? audio.ctx.resume() : Promise.resolve();
    Promise.resolve(resumed).then(() => {
      loadGainTable();
    }).catch(() => { audio.gainFailed = true; });
  } catch (err) {
    audio.gainFailed = true;
  }
}

function loadGainTable() {
  const N = window.MTDLoudnessNormalizer;
  if (!N || audio.gainsReady || audio.gainFailed) return;
  N.ready("./gain/gain_table_lite.json").then((n) => {
    audio.gainsReady = n > 0;
  }).catch(() => { audio.gainFailed = true; });
}

/* Apply the constant per-clip gain. Skipped unless the context is actually running, because attaching a
   media element to a suspended context would silence it. A missing clip id plays at 0 dB. */
function applyClipGain(item) {
  const N = window.MTDLoudnessNormalizer;
  if (!N || audio.gainFailed || !audio.gainsReady || !audio.ctx || audio.ctx.state !== "running") return null;
  try {
    return N.apply(audio.el, item.id);
  } catch (err) {
    audio.gainFailed = true;             // one failure is enough: fall back for the rest of the session
    return null;
  }
}

let pairTimer = null;
let pairToken = 0;

function playClip(item) {
  const el = ensureAudioElement();
  try {
    el.pause();
  } catch (err) { /* nothing playing */ }

  el.src = item.audio;
  el.playbackRate = settings.audioSpeed;
  applyClipGain(item);

  const started = el.play();
  if (started && typeof started.catch === "function") {
    started.catch((err) => {
      /* iOS blocks a play that is not tied to a gesture; the Play button re-arms it */
      setStatus("Tap Play to start the audio.");
    });
  }
}

/* The same/different task plays two clips. Clip B starts when clip A ends, with a fixed gap, and a timer
   covers the case where the ended event never arrives (still-loading metadata, or a blocked play). */
function playCurrent() {
  if (!currentItem) return;
  setPlaybackSessionType();

  pairToken += 1;
  const token = pairToken;
  if (pairTimer) { clearTimeout(pairTimer); pairTimer = null; }

  if (isSequenceTask(currentTask) && sequence.length > 1) { playSequence(token); return; }

  playClip(currentItem);
  if (currentTask !== "pair" || !pairPartner) return;

  const el = ensureAudioElement();
  let fired = false;
  const startSecond = () => {
    if (fired || token !== pairToken) return;
    fired = true;
    el.removeEventListener("ended", startSecond);
    pairTimer = null;
    playClip(pairPartner);
  };
  el.addEventListener("ended", startSecond);
  const seconds = Number.isFinite(el.duration) && el.duration > 0 ? el.duration / settings.audioSpeed : 0.9;
  pairTimer = window.setTimeout(startSecond, (seconds * 1000) + PAIR_GAP_MS + PAIR_TAIL_MS);
}

/* Play the clips of a sequence card back to back, then hand over to the question. */
function playSequence(token) {
  const el = ensureAudioElement();
  let index = 0;

  /* Each clip gets its own one-shot guard, so the ended event and the fallback timer cannot both start the
     next clip, and a cancelled chain (a new card, a replay) stops where it is. */
  const step = () => {
    if (token !== pairToken) return;
    if (pairTimer) { window.clearTimeout(pairTimer); pairTimer = null; }
    if (index >= sequence.length) { onSequencePlayed(); return; }
    const clip = sequence[index];
    index += 1;
    playClip(clip);

    let done = false;
    const next = () => {
      if (done || token !== pairToken) return;
      done = true;
      el.removeEventListener("ended", next);
      step();
    };
    el.addEventListener("ended", next);
    const seconds = Number.isFinite(el.duration) && el.duration > 0 ? el.duration / settings.audioSpeed : 0.9;
    pairTimer = window.setTimeout(next, (seconds * 1000) + SEQ_GAP_MS + SEQ_TAIL_MS);
  };

  step();
}

/* The clips are done: only now does the question appear, which is the point of the seq_target task. */
function onSequencePlayed() {
  const area = document.getElementById("answerArea");
  const title = document.getElementById("answerTitle");
  if (currentTask === "seq_target") {
    const where = seqAskedAt + 1;
    if (title) title.textContent = `Which tone was syllable ${where}?`;
    if (area) {
      area.classList.remove("listening");
      area.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
    setStatus(`Now answer: which tone was syllable ${where} of ${sequence.length}?`);
  } else {
    if (title) title.textContent = "Which three tones, in order?";
    if (area) area.classList.remove("listening");
    setStatus("Tap a tone for each syllable, in order. Nothing is checked until all three are set.");
  }
  const btn = document.getElementById("playBtn");
  if (btn) btn.textContent = "\u25b6 Play again";
}

function isSequenceTask(task) { return task === "seq_target" || task === "seq_recall"; }

/* The result now stays up for a beat, so a manual tap on Next has to win against the pending timer:
   without this, tapping Next quickly advanced two cards. */
let advanceTimer = null;
let repeatTimer = null;

function cancelPendingAdvance() {
  if (advanceTimer) { window.clearTimeout(advanceTimer); advanceTimer = null; }
  if (repeatTimer) { window.clearTimeout(repeatTimer); repeatTimer = null; }
}

function advanceAfterAnswer() {
  cancelPendingAdvance();
  advanceTimer = window.setTimeout(() => {
    advanceTimer = null;
    clearReveal();
    nextQuestion();
  }, ADVANCE_DELAY_MS);
}

function repeatSameItem() {
  cancelPendingAdvance();
  repeatTimer = window.setTimeout(() => {
    repeatTimer = null;
    revealed = false;
    setStatus("Try again - this replay does not count for your score.");
    renderAnswerArea();
    playCurrent();
  }, REPEAT_DELAY_MS);
}

function clearReveal() {
  document.querySelectorAll("#answerArea button").forEach((btn) => {
    btn.classList.remove("correct", "wrong", "locked");
    const mark = btn.querySelector(".mark");
    if (mark) mark.remove();
  });
  const area = document.getElementById("answerArea");
  if (area) area.classList.remove("answered", "listening");
  document.querySelectorAll(".seq-slot").forEach((slot) => slot.classList.remove("correct", "wrong"));
  const box = document.getElementById("revealBox");
  if (box) { box.classList.remove("shown"); box.innerHTML = ""; }
}

/*A tap on a whole-sequence card fills the next position. Nothing is checked until every position has a tone,
  which is what keeps a wrong tap in the middle from stopping the flow.*/
function pickSequenceTone(btn) {
  if (seqPicked.length >= sequence.length) return;
  const value = String(btn.dataset.value);
  seqPicked.push(value);
  const area = document.getElementById("answerArea");
  if (area) {
    area.innerHTML = renderSequenceSlots(seqPicked) +
      `<div class="tone-row">` + ALL_TONES.map((n) =>
        `<button class="tone-btn${seqPicked.includes(String(n)) ? " picked" : ""}" data-value="${n}">${n}<small>${TONE_COPY[n]}</small></button>`
      ).join("") + `</div>`;
    area.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => answerChoice(b)));
  }
  setStatus(`Position ${seqPicked.length} of ${sequence.length} set.`, "");
  if (seqPicked.length >= sequence.length) submitSequence();
}

/*The whole-sequence answer, checked once, at the end.*/
function submitSequence() {
  revealed = true;
  total += 1;
  const expected = sequenceTones();
  const chosen = seqPicked.slice();
  const wasCorrect = chosen.join(",") === expected.join(",");
  const result = run ? run.answer(wasCorrect, currentTask) : { first: true };

  /* redraw the chips with the verdict on them, so each position carries its own tick or cross */
  const areaEl = document.getElementById("answerArea");
  const graded = expected.map((t, i) => (chosen[i] === t ? "correct" : "wrong"));
  if (areaEl) {
    areaEl.innerHTML = renderSequenceSlots(chosen, graded) +
      `<div class="tone-row">` + ALL_TONES.map((n) =>
        `<button class="tone-btn picked" data-value="${n}">${n}<small>${TONE_COPY[n]}</small></button>`
      ).join("") + `</div>`;
  }

  if (wasCorrect) {
    correct += 1;
    streak += 1;
    setStatus(`Correct - the three tones were ${expected.join("-")}.`, "ok");
  } else {
    streak = 0;
    setStatus(`Wrong - the three tones were ${expected.join("-")}.`, "bad");
  }

  const area = document.getElementById("answerArea");
  if (area) area.classList.add("answered");
  area && area.querySelectorAll("button").forEach((b) => { b.classList.add("locked"); b.disabled = true; });
  renderReveal(wasCorrect);
  updateStats();
  if (result.first) { saveScheduler(); renderProgress(); }

  /* A whole-sequence card is not repeated on a wrong answer and does not jump away either: the sequence is
     shown, and the next card waits for the owner's tap so the flow is never broken mid-thought. */
  if (wasCorrect) { advanceAfterAnswer(); } else { cancelPendingAdvance(); }
}

/*What the card is asking for, and the one value that counts as right.*/
function correctValue(task) {
  if (task === "syllable") return currentItem.id;
  if (task === "pair") return String(pairToneA);      // the question is about clip A only
  if (task === "seq_target" && sequence.length > 1) return sequence[seqAskedAt].tone;
  if (task === "seq_recall") return sequenceTones().join(",");
  return String(currentTone);
}

function answerText(task) {
  if (task === "seq_target" && sequence.length > 1) {
    const asked = sequence[seqAskedAt];
    return `syllable ${seqAskedAt + 1} was ${toneMarked(asked.syllable, asked.tone)} (tone ${asked.tone}, ${TONE_COPY[asked.tone]})`;
  }
  if (task === "seq_recall" && sequence.length > 1) {
    return "the three tones were " + sequenceTones().join("-") + " (" +
      sequence.map((s, i) => `${i + 1} ${TONE_COPY[s.tone]}`).join(", ") + ")";
  }
  if (task === "syllable") return toneMarked(currentItem.syllable, currentItem.tone);
  if (task === "pair") {
    if (!pairPartner) return `tone ${pairToneA}`;
    return `clip A was ${toneMarked(currentItem.syllable, pairToneA)} (tone ${pairToneA}, ${TONE_COPY[pairToneA]}),` +
           ` clip B was ${toneMarked(pairPartner.syllable, pairPartner.tone)} (tone ${pairPartner.tone}, ${TONE_COPY[pairPartner.tone]})`;
  }
  if (task === "contour") return `shape ${currentTone} (${TONE_COPY[currentTone]})`;
  return `tone ${currentTone} (${TONE_COPY[currentTone]})`;
}

/* The sentence under the answer buttons. The two-clip task answers about clip A, so its sentence names both
   clips instead of doubling up on "the answer was". */
function statusSentence(wasCorrect) {
  const prefix = wasCorrect ? "Correct - " : "Wrong - ";
  if (currentTask === "pair" && pairPartner && currentItem) {
    return prefix + `clip A was ${toneMarked(currentItem.syllable, pairToneA)} (tone ${pairToneA}, ${TONE_COPY[pairToneA]}),` +
           ` clip B was ${toneMarked(pairPartner.syllable, pairPartner.tone)} (tone ${pairPartner.tone}, ${TONE_COPY[pairPartner.tone]}).`;
  }
  return prefix + (wasCorrect ? "" : "the answer was ") + answerText(currentTask) + ".";
}

/* The reveal panel: after every answer the card is shown the way the owner likes to see it - the syllable in
   tone-marked pinyin, the tone name, and the pitch shape - plus a replay button that does not score. */
function revealCard(item, tone, label) {
  if (!item) return "";
  return `<div class="reveal-row"><span class="reveal-label">${label}</span>` +
    `<span class="reveal-pinyin">${toneMarked(item.syllable, tone)}</span>` +
    `<span class="reveal-tone">tone ${tone} · ${TONE_COPY[tone]}</span>${contourSvg(tone, "reveal-contour")}</div>`;
}

function renderReveal(wasCorrect) {
  const box = document.getElementById("revealBox");
  if (!box || !currentItem) return;
  /* A correct answer needs no reveal: the tapped button is already labelled, and restating the answer was
     the flash the owner saw. The panel is for the card that got away. */
  if (wasCorrect) { box.classList.remove("shown"); box.innerHTML = ""; return; }
  const rows = [];
  if (isSequenceTask(currentTask) && sequence.length > 1) {
    /* one compact row: the three clips in order, with the asked position marked when there is one */
    const pinyin = sequence.map((s, i) => {
      const mark = currentTask === "seq_target" && i === seqAskedAt ? "\u25b8 " : "";
      return mark + toneMarked(s.syllable, s.tone);
    }).join(" \u00b7 ");
    const tones = sequenceTones().join("-");
    rows.push(`<div class="reveal-row compact"><span class="reveal-label">clips</span>` +
      `<span class="reveal-pinyin">${pinyin}</span><span class="reveal-tone">tones ${tones}</span></div>`);
  } else if (currentTask === "pair" && pairPartner) {
    rows.push(revealCard(currentItem, pairToneA, "clip A"));
    rows.push(revealCard(pairPartner, pairPartner.tone, "clip B"));
  } else {
    rows.push(revealCard(currentItem, currentTone, currentTask === "syllable" ? "syllable" : "the sound"));
  }
  box.innerHTML = rows.join("") + `<button id="revealReplay" class="mini-btn" type="button">Hear it again</button>`;
  box.classList.add("shown");
  const replay = document.getElementById("revealReplay");
  if (replay) replay.addEventListener("click", () => { playCurrent(); });
}

function answerChoice(btn) {
  if (revealed || !currentItem || !btn) return;          // null guard: a tap before the first card is ignored
  if (currentTask === "seq_recall") { pickSequenceTone(btn); return; }
  revealed = true;
  total += 1;

  const chosen = String(btn.dataset.value);
  const expected = correctValue(currentTask);
  const wasCorrect = chosen === expected;
  const result = run ? run.answer(wasCorrect, currentTask) : { first: true };

  if (wasCorrect) {
    correct += 1;
    streak += 1;
    btn.classList.add("correct");
    markButton(btn, "\u2713");
    setStatus(result.first ? "Correct." : "Correct on the replay - this one does not count.", "ok");
  } else {
    streak = 0;
    btn.classList.add("wrong");
    markButton(btn, "\u2717");
    const correctBtn = document.querySelector(`#answerArea button[data-value="${expected}"]`);
    if (correctBtn) { correctBtn.classList.add("correct"); markButton(correctBtn, "\u2713"); }
    setStatus(statusSentence(false), "bad");
  }

  /* every button is locked once the card is answered, so a double tap cannot sneak in a second first answer */
  const area = document.getElementById("answerArea");
  if (area) area.classList.add("answered");
  document.querySelectorAll("#answerArea button").forEach((b) => b.classList.add("locked"));
  renderReveal(wasCorrect);
  updateStats();

  if (result.first) {
    saveScheduler();
    renderProgress();
  }
  if (!wasCorrect && settings.repeatOnIncorrect) {
    repeatSameItem();
  } else {
    advanceAfterAnswer();
  }
}

function toggleTone(tone) {
  const selected = settings.tonesEnabled.includes(tone);

  if (selected) {
    if (settings.tonesEnabled.length <= 2) {
      document.getElementById("toneWarning").textContent = "At least two tones must remain selected.";
      return;
    }
    settings.tonesEnabled = settings.tonesEnabled.filter((n) => n !== tone);
  } else {
    settings.tonesEnabled = [...settings.tonesEnabled, tone];
  }

  document.getElementById("toneWarning").textContent = "";
  saveSettings();
  refreshModeSummary();
  startSession();                      // the deck changed: rebuild the session from the scheduler
  nextQuestion();
}

function toggleTask(task) {
  const selected = settings.tasksEnabled.includes(task);

  if (selected) {
    if (settings.tasksEnabled.length <= 1) {
      document.getElementById("taskWarning").textContent = "At least one task type must stay on.";
      return;
    }
    settings.tasksEnabled = settings.tasksEnabled.filter((t) => t !== task);
  } else {
    settings.tasksEnabled = [...settings.tasksEnabled, task];
  }

  const warning = document.getElementById("taskWarning");
  if (warning) warning.textContent = "";
  saveSettings();
  updateTaskUI();
  startSession();                      // the task mix changed: rebuild the session
  nextQuestion();
}

function setNewPerSession(value) {
  const clamped = Math.max(0, Math.min(20, Math.round(value)));
  settings.newPerSession = clamped;
  const out = document.getElementById("newPerSessionValue");
  if (out) out.textContent = String(clamped);
  saveSettings();
  startSession();                      // takes effect from the next card, not mid-session
}

function toggleFocusWeakTones() {
  settings.focusWeakTones = !settings.focusWeakTones;
  saveSettings();
  updateTaskUI();
  startSession();                      // the next card follows the new focus
  nextQuestion();
}

function updateTaskUI() {
  P.TASKS.forEach((task) => {
    const btn = document.getElementById(`task_${task}`);
    if (!btn) return;
    const on = settings.tasksEnabled.includes(task);
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  const slider = document.getElementById("newPerSessionSlider");
  if (slider) slider.value = String(settings.newPerSession);
  const out = document.getElementById("newPerSessionValue");
  if (out) out.textContent = String(settings.newPerSession);
  const focus = document.getElementById("focusWeakTones");
  if (focus) {
    focus.classList.toggle("active", !!settings.focusWeakTones);
    focus.setAttribute("aria-pressed", String(!!settings.focusWeakTones));
    const st = P.toneStats(sched);
    const weak = P.weakestTones(sched, 5, 2);
    const label = weak.length ? `Focus my weakest tones (now ${weak.join(" and ")})` : "Focus my weakest tones (needs data)";
    focus.textContent = label;
  }
}

function toggleRepeatOnIncorrect() {
  settings.repeatOnIncorrect = !settings.repeatOnIncorrect;
  saveSettings();
  refreshModeSummary();
}

function toggleEasyFinals() {
  settings.easyFinals = !settings.easyFinals;
  saveSettings();
  refreshModeSummary();
  deck = buildDeck();
  startSession();
  nextQuestion();
}

function setAudioSpeed(value) {
  const clamped = Math.max(0.1, Math.min(1.05, value));
  settings.audioSpeed = clamped;
  document.getElementById("speedValue").textContent = `${clamped.toFixed(2)}x`;
  saveSettings();
}

function reloadForUpdate() {
  if (installRegistration?.waiting) {
    installRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
  window.location.reload();
}

function watchServiceWorkerUpdates() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.ready.then((registration) => {
    installRegistration = registration;
    registration.update();

    if (registration.waiting) {
      document.getElementById("updatePill").classList.add("show");
    }

    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          document.getElementById("updatePill").classList.add("show");
        }
      });
    });
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });
}

async function init() {
  showScreen("drill");
  refreshModeSummary();
  updateTaskUI();
  updateStats();
  renderProgress();
  watchServiceWorkerUpdates();

  /* One-time unlock on the first gesture: audio session type, context resume, gain table. Capture phase and
     a click fallback, so this runs before a button's own handler and the very first card can carry its gain. */
  ["pointerdown", "touchstart", "keydown", "click"].forEach((evt) => {
    window.addEventListener(evt, () => { if (!audioUnlocked) unlockAudio(); }, { once: true, capture: true, passive: true });
  });

  await loadDataset();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then((registration) => {
        installRegistration = registration;
        registration.update();
      })
      .catch((err) => console.error("Service worker registration failed:", err));
  });
}

const REPORTS = [];
/*ERRORS*/
async function reportAnError() {

    const comment = prompt(
        "Describe the problem:"
    );

    if (!comment) return;

    REPORTS.push({
        ...(currentItem || {}),
        box: currentItem && sched.items[currentItem.id] ? sched.items[currentItem.id].box : null,
        comment,
        timestamp: new Date().toISOString()
    });

    alert("Thanks!");
}

/* One export for the owner: the error reports plus the full scheduler state, so progress is inspectable. */
function exportPayload() {
    const day = P.dayOf(Date.now());
    const bank = bankOf(buildDeck());
    return {
        exportedAt: new Date().toISOString(),
        schema: P.SCHEMA,
        settings: { ...settings },
        session: session ? { day: session.day, slots: session.slots.length, newAdmitted: session.newAdmitted, overCapNew: session.overCapNew, relaxed: session.relaxed, tasks: session.slots.map((s) => s.task) } : null,
        sessionSummary: P.summarise(sched, bank, day),
        tonePriors: P.tonePriors(sched, bank),
        score: run ? run.line().text : null,
        scoreByTask: run ? run.taskLines().map((l) => l.text) : null,
        firstAttempts: run ? run.stats() : null,
        scheduler: sched,
        reports: REPORTS
    };
}

async function downloadReports() {

    const blob = new Blob(
        [JSON.stringify(exportPayload(), null, 2)],
        { type: "application/json" }
    );

    const a = document.createElement("a");

    a.href = URL.createObjectURL(blob);
    a.download = "mandarin-tone-drill-export.json";
    document.body.appendChild(a);          // the anchor has to be in the document to be clickable
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/*start*/init();
