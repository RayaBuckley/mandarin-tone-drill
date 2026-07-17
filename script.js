
const STORAGE_KEY = "mandarin-tone-settings-v2";
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

let settings = loadSettings();
let deck = buildDeck();
let currentItem = null;
let currentTone = 1;
let revealed = false;
let correct = 0;
let total = 0;
let streak = 0;
let installRegistration = null; 

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

/*LOAD DATASET*/
let ITEMS = [];
async function loadDataset() {
  const response = await fetch("./datasets/tones/metadata.json");
  const metadata = await response.json();

  ITEMS = metadata.map(item => ({
    id: `${item.syllable}-${item.tone}`,
    syllable: item.syllable,
    initial: item.initial,
    final: item.final,
    tone: item.tone,
    audio: `./datasets/tones/${item.audio}`
  }));

  deck = buildDeck();
  nextQuestion();
}

/*FILTER TO ENABLED TONES*/
function buildDeck() {
  return ITEMS.filter(item =>
    settings.tonesEnabled.includes(item.tone) && (!settings.easyFinals || EASY_FINALS.includes(item.final))
  );
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
function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function enabledTones() {
  return settings.tonesEnabled.slice().sort((a, b) => a - b);
}

function setStatus(text) {
  document.getElementById("statusText").textContent = text;
}

function updateStats() {
  document.getElementById("correctCount").textContent = String(correct);
  document.getElementById("totalCount").textContent = String(total);
  document.getElementById("streakCount").textContent = String(streak);
  document.getElementById("accuracyText").textContent = total ? `Accuracy ${Math.round((correct / total) * 100)}%` : "Accuracy --";
}

/*MOVE ONTO NEXT QUESTION - PICK NEXT WORD AND RESET STATE*/
function nextQuestion() {
  deck = buildDeck();
  if (!deck.length) {
    setStatus("No items available for the current settings.");
    return;
  }

  let next = null;
  if (deck.length === 1) {
    next = deck[0];
  } else {
    do {
      next = pickRandom(deck);
    } while (next === currentItem);
  }

  currentItem = next;
  currentTone = currentItem.tone;
  revealed = false;
  resetToneButtons();
  playCurrent();
  document.getElementById("promptMeta").textContent = "Press play to hear the next item.";
  setStatus("Listen carefully, then choose 1–4.");
}


let currentAudio = null;

function playCurrent() {
  if (!currentItem) return;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }

  currentAudio = new Audio(currentItem.audio);
  currentAudio.playbackRate = settings.audioSpeed;
  currentAudio.play();
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
    setStatus("Try again.");
    playCurrent();
  }, REPEAT_DELAY_MS);
}

function guess(answer) {
  if (revealed) return;
  revealed = true;
  total += 1;

  const correctBtn = document.getElementById(`tone${currentTone}`);
  const chosenBtn = document.getElementById(`tone${answer}`);

  if (answer === currentTone) {
    correct += 1;
    streak += 1;
    chosenBtn.classList.add("correct");
    setStatus(`Correct — tone ${currentTone}.`);
    updateStats();
    advanceAfterAnswer();
    return;
  }

  streak = 0;
  chosenBtn.classList.add("wrong");
  correctBtn.classList.add("correct");
  setStatus(`Wrong — tone ${currentTone}.`);
  updateStats();

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

  if (!settings.tonesEnabled.includes(currentTone)) {
    nextQuestion();
    playCurrent();
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
  nextQuestion();
  playCurrent();
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
  watchServiceWorkerUpdates();
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
        ...currentItem,
        comment,
        timestamp: new Date().toISOString()
    });

    alert("Thanks!");
}

async function downloadReports() {

    const blob = new Blob(
        [JSON.stringify(REPORTS, null, 2)],
        { type: "application/json" }
    );

    const a = document.createElement("a");

    a.href = URL.createObjectURL(blob);
    a.download = "comments.json";
    a.click();

    URL.revokeObjectURL(a.href);
}

init();