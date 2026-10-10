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

const STORAGE_KEY = "mandarin-tone-settings-v2";
const PROGRESS_KEY = "mandarin-tone-scheduler-v1";
const DAILY_KEEP = 60;                 // daily new-card counters kept (days) before pruning

const ADVANCE_DELAY_MS = 50;
const REPEAT_DELAY_MS = 60;

const ALL_TONES = [1, 2, 3, 4];

const TONE_COPY = { 1: "high", 2: "rising", 3: "dipping", 4: "falling" };
const PAIR_GAP_MS = 320;               // silence between clip A and clip B of a same/different trial
const PAIR_TAIL_MS = 180;

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
  tasksEnabled: ["tone", "syllable", "pair", "contour"]
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
let pairPartner = null;                 // second clip of a same/different trial
let pairSame = false;                   // whether that trial keeps the tone
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

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      tonesEnabled: Array.isArray(parsed.tonesEnabled) ? parsed.tonesEnabled.filter((n) => ALL_TONES.includes(n)) : DEFAULT_SETTINGS.tonesEnabled,
      repeatOnIncorrect: typeof parsed.repeatOnIncorrect === "boolean" ? parsed.repeatOnIncorrect : DEFAULT_SETTINGS.repeatOnIncorrect,
      easyFinals: typeof parsed.easyFinals === "boolean" ? parsed.easyFinals : DEFAULT_SETTINGS.easyFinals,
      audioSpeed: typeof parsed.audioSpeed === "number" && parsed.audioSpeed >= 0.1 ? parsed.audioSpeed : DEFAULT_SETTINGS.audioSpeed,
      newPerSession: typeof parsed.newPerSession === "number" && parsed.newPerSession >= 0
        ? Math.min(20, Math.round(parsed.newPerSession)) : DEFAULT_SETTINGS.newPerSession,
      tasksEnabled: Array.isArray(parsed.tasksEnabled)
        ? parsed.tasksEnabled.filter((t) => P.TASKS.includes(t)) : DEFAULT_SETTINGS.tasksEnabled.slice()
    };
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
    pair: "Two clips, A then B. Same tone or different?",
    contour: "Which shape matches the pitch you heard?"
  }[task] || "Which tone did you hear?";
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
  session = P.buildSession(sched, bank, P.dayOf(Date.now()), {
    newPerSession: settings.newPerSession,
    tasks: settings.tasksEnabled
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

function contourSvg(tone) {
  return `<svg viewBox="0 0 48 32" aria-hidden="true" focusable="false">` +
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

/* Partner for the pair task. The two clips always differ in exactly one dimension: same syllable with another
   tone (answer "different"), or another syllable with the same tone (answer "same"). */
function pickPairPartner(item) {
  const pool = deck.filter((i) => i.id !== item.id);
  const sameSyllable = pool.filter((i) => i.syllable === item.syllable);
  const sameTone = pool.filter((i) => i.tone === item.tone);
  const wantDifferent = Math.random() < 0.5;
  const preferred = wantDifferent ? sameSyllable : sameTone;
  const fallback = wantDifferent ? sameTone : sameSyllable;
  const source = preferred.length ? preferred : fallback;
  if (!source.length) return null;
  return source[Math.floor(Math.random() * source.length)];
}

function renderAnswerArea() {
  const area = document.getElementById("answerArea");
  const title = document.getElementById("answerTitle");
  if (!area || !currentItem) return;
  if (title) title.textContent = { tone: "Which tone?", syllable: "Which syllable?", pair: "Same or different?", contour: "Which shape?" }[currentTask] || "Answer";

  if (currentTask === "pair" && pairPartner) {
    area.className = "pair-grid";
    area.innerHTML =
      `<button class="tone-btn choice-btn" data-value="same"><span class="choice-text">Same tone</span></button>` +
      `<button class="tone-btn choice-btn" data-value="different"><span class="choice-text">Different tones</span></button>`;
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

/*GUESSING*/
function setStatus(text) {
  document.getElementById("statusText").textContent = text;
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

  document.getElementById("correctCount").textContent = String(correct);
  document.getElementById("totalCount").textContent = String(total);
  document.getElementById("streakCount").textContent = String(streak);
}

/* Progress panel: what the scheduler is doing. */
function renderProgress() {
  const el = document.getElementById("progressLine");
  if (!el) return;
  const bank = bankOf(buildDeck());
  const day = P.dayOf(Date.now());
  const sum = P.summarise(sched, bank, day);
  const daily = sched.daily[String(day)] || { newAdmitted: 0, overCap: 0 };
  const slots = session ? session.slots.length : 0;
  el.textContent = `Session ${Math.min(sessionIndex, slots)}/${slots}` +
    ` · cards met ${sum.introduced}/${sum.total} (answered ${sum.seen})` +
    ` · waiting their turn ${sum.dueNow} · mastered ${sum.mastered} · leeches ${sum.leeches}` +
    ` · new cards today ${daily.newAdmitted || 0} (set per session, no daily cap)`;
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
  if (!ITEMS.length) {
    setStatus("Loading the tone bank...");
    return;
  }

  if (!session || sessionIndex >= session.slots.length) startSession();

  if (!session.slots.length) {
    setStatus("No items available for the current settings.");
    return;
  }

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

  /* the same/different task needs a partner clip; a two-tone deck cannot supply one, so fall back to tone */
  pairPartner = null;
  pairSame = false;
  if (currentTask === "pair") {
    pairPartner = pickPairPartner(item);
    if (!pairPartner) currentTask = "tone";
    else pairSame = pairPartner.tone === item.tone;
  }

  if (run) run.beginCard(currentItem.id, currentTask);
  renderAnswerArea();
  describeItem();
  renderProgress();

  const badge = document.getElementById("taskBadge");
  if (badge) badge.textContent = P.TASK_LABELS[currentTask] || "Which tone?";
  document.getElementById("promptMeta").textContent = currentTask === "pair"
    ? "Clip A, then clip B, with a short gap. Press play to hear them again."
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

function advanceAfterAnswer() {
  window.setTimeout(() => {
    clearReveal();
    nextQuestion();
  }, ADVANCE_DELAY_MS);
}

function repeatSameItem() {
  window.setTimeout(() => {
    revealed = false;
    setStatus("Try again - this replay does not count for your score.");
    renderAnswerArea();
    playCurrent();
  }, REPEAT_DELAY_MS);
}

function clearReveal() {
  document.querySelectorAll("#answerArea button").forEach((btn) => btn.classList.remove("correct", "wrong", "locked"));
}

/*What the card is asking for, and the one value that counts as right.*/
function correctValue(task) {
  if (task === "syllable") return currentItem.id;
  if (task === "pair") return pairSame ? "same" : "different";
  return String(currentTone);
}

function answerText(task) {
  if (task === "syllable") return toneMarked(currentItem.syllable, currentItem.tone);
  if (task === "pair") {
    if (!pairPartner) return "no partner clip";
    return pairSame
      ? `the same tone (${toneMarked(currentItem.syllable, currentItem.tone)} and ${toneMarked(pairPartner.syllable, pairPartner.tone)})`
      : `different tones (${toneMarked(currentItem.syllable, currentItem.tone)} and ${toneMarked(pairPartner.syllable, pairPartner.tone)})`;
  }
  if (task === "contour") return `shape ${currentTone} (${TONE_COPY[currentTone]})`;
  return `tone ${currentTone} (${TONE_COPY[currentTone]})`;
}

function answerChoice(btn) {
  if (revealed || !currentItem || !btn) return;          // null guard: a tap before the first card is ignored
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
    setStatus(result.first ? `Correct - ${answerText(currentTask)}.` : "Correct on the replay - this one does not count.");
  } else {
    streak = 0;
    btn.classList.add("wrong");
    const correctBtn = document.querySelector(`#answerArea button[data-value="${expected}"]`);
    if (correctBtn) correctBtn.classList.add("correct");
    setStatus(`Wrong - the answer was ${answerText(currentTask)}.`);
  }

  /* every button is locked once the card is answered, so a double tap cannot sneak in a second first answer */
  document.querySelectorAll("#answerArea button").forEach((b) => b.classList.add("locked"));
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
