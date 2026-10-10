/*  mandarin-tone-drill - scoring, spaced scheduling and the audio path.
 *
 *  Scoring: only the FIRST attempt on a card counts. A replay-and-retry is recorded as a retry and can never
 *  move the score, because the old behaviour (retry counts as correct) inflated displayed accuracy.
 *  Scheduling: progression.js keeps per-card ladder state and picks the next card; this file owns the DOM.
 *  Audio: one reused <audio> element, optional Web Audio gain from the verified loudness table, and the iOS
 *  playback audio session type. Every optional part fails open: playback still works with no gain and no API.
 */

const STORAGE_KEY = "mandarin-tone-settings-v2";
const PROGRESS_KEY = "mandarin-tone-scheduler-v1";
const DAILY_KEEP = 60;                 // daily new-card counters kept (days) before pruning

const ADVANCE_DELAY_MS = 50;
const REPEAT_DELAY_MS = 60;

const ALL_TONES = [1, 2, 3, 4];

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
  audioSpeed: 0.9
};
let ITEMS = [];

let settings = loadSettings();
let deck = [];
let currentItem = null;
let currentTone = 1;
let revealed = false;
let correct = 0;                       // kept for the old display path; the score now comes from the run
let total = 0;
let streak = 0;
let installRegistration = null;

/* progression state */
const P = window.MTDProgress;
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
      audioSpeed: typeof parsed.audioSpeed === "number" && parsed.audioSpeed >= 0.1 ? parsed.audioSpeed : DEFAULT_SETTINGS.audioSpeed
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
  session = P.buildSession(sched, bank, P.dayOf(Date.now()));
  sessionIndex = 0;
  saveScheduler();
  return session;
}

/*SETTINGS*/
function resetToneButtons() {
  ALL_TONES.forEach((n) => {
    const btn = document.getElementById(`tone${n}`);
    btn.classList.remove("correct", "wrong");
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
    ` · new today ${daily.newAdmitted || 0}/${P.NEW_PER_DAY}` +
    (daily.overCap ? ` (+${daily.overCap} over cap to fill the first sessions)` : "");
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

  const id = session.slots[sessionIndex];
  sessionIndex += 1;

  const item = ITEMS.find((i) => i.id === id);
  if (!item) {                       // card filtered out (settings changed mid-session): take the next slot
    nextQuestion();
    return;
  }

  currentItem = item;
  currentTone = currentItem.tone;
  revealed = false;
  resetToneButtons();
  if (run) run.beginCard(currentItem.id);
  playCurrent();
  document.getElementById("promptMeta").textContent = "Press play to hear the next item.";
  setStatus("Listen carefully, then choose 1-4.");
  describeItem();
  renderProgress();
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

function playCurrent() {
  if (!currentItem) return;
  setPlaybackSessionType();

  const el = ensureAudioElement();

  try {
    el.pause();
  } catch (err) { /* nothing playing */ }

  el.src = currentItem.audio;
  el.playbackRate = settings.audioSpeed;
  applyClipGain(currentItem);

  const started = el.play();
  if (started && typeof started.catch === "function") {
    started.catch((err) => {
      /* iOS blocks a play that is not tied to a gesture; the Play button re-arms it */
      setStatus("Tap Play to start the audio.");
    });
  }
}

function advanceAfterAnswer() {
  window.setTimeout(() => {
    resetToneButtons();
    nextQuestion();
  }, ADVANCE_DELAY_MS);
}

function repeatSameItem() {
  window.setTimeout(() => {
    resetToneButtons();
    revealed = false;
    setStatus("Try again - this replay does not count for your score.");
    playCurrent();
  }, REPEAT_DELAY_MS);
}

function guess(answer) {
  if (revealed || !currentItem) return;          // null guard: a tap before the first card is ignored
  revealed = true;
  total += 1;

  const correctBtn = document.getElementById(`tone${currentTone}`);
  const chosenBtn = document.getElementById(`tone${answer}`);

  const result = run ? run.answer(answer === currentTone) : { first: true };
  const wasCorrect = answer === currentTone;

  if (wasCorrect) {
    correct += 1;
    streak += 1;
    chosenBtn.classList.add("correct");
    setStatus(result.first ? `Correct - tone ${currentTone}.` : `Correct on the replay - this one does not count.`);
    updateStats();
    if (result.first) {
      saveScheduler();
      renderProgress();
      advanceAfterAnswer();
    } else {
      advanceAfterAnswer();
    }
    return;
  }

  streak = 0;
  chosenBtn.classList.add("wrong");
  correctBtn.classList.add("correct");
  setStatus(`Wrong - tone ${currentTone}.`);
  updateStats();
  if (result.first) {
    saveScheduler();
    renderProgress();
  }

  if (settings.repeatOnIncorrect) {
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
        session: session ? { day: session.day, slots: session.slots.length, newAdmitted: session.newAdmitted, overCapNew: session.overCapNew, relaxed: session.relaxed } : null,
        sessionSummary: P.summarise(sched, bank, day),
        tonePriors: P.tonePriors(sched, bank),
        score: run ? run.line().text : null,
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
