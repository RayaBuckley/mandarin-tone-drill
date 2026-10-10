# Implementation notes: scoring, spacing, and the audio path

Branch `feature/scoring-and-scheduler`, based on `756f137`. Nothing here was pushed anywhere, and no
audio file, licence file, or `datasets/tones/metadata.json` was touched (`git status datasets` is empty).

## What changed, in one screen

| File | Change |
| --- | --- |
| `progression.js` | NEW. Scoring maths, per-card ladder state, session builder. No DOM access, so it can be unit tested under Node. |
| `script.js` | Rewritten. First attempts are the score; the scheduler picks every card; one reused `<audio>` element; optional Web Audio gain; iOS playback audio session. |
| `index.html` | Loads the two new scripts, shows the score line, the interval, the chance note, the session/progress line, and a card state line. |
| `styles.css` | Styles for those lines. No layout change. |
| `sw.js` | `CACHE_NAME` v5 -> v6 and every fetched asset added to `APP_SHELL`, including the gain table and both icons. |
| `gain/gain_table_lite.json` | NEW. 1900 clips x one constant gain in dB, from the verified loudness work. |
| `gain/apply_gain_webaudio.js` | NEW. The verified gain hook, re-pointed at `./gain/gain_table_lite.json`. |
| `icon-192.png`, `icon-512.png` | NEW. `manifest.webmanifest` already pointed at these two files, which did not exist, so a Home-Screen install had no icon. |
| `tests/run_tests.js` | NEW. 70 assertions over the scoring and scheduler maths. |
| `tests/simulate.js` | NEW. Learner simulation, new sampler against the old one. |
| `tests/smoke_cdp.js` | NEW. Headless smoke test that drives the real page over the DevTools protocol. |

## 1. Scoring

Only the **first** attempt on a card counts. The old behaviour scored every attempt, so a wrong answer
followed by a replay could show 100%.

* Score line: `First attempts: 61.0% (95% CI 47.0%-73.5%, n=20). Chance is 25%.`
* The interval is a Wilson score interval at 95%, which is the right one for small samples. Twelve of
  twenty gives [38.7%, 78.1%]; nine of twenty has a lower bound of 25.8% (above chance, barely), eight of
  twenty gives 21.9% (not above chance). The app therefore never claims a score above chance from a single
  session, because the interval is on screen next to the number.
* Chance is stated as 25% (four tones), and the number scales if the owner narrows the tone set.
* A **guess-corrected** score (the one the research brief suggested for real use) is computed but stays
  hidden until 60 first attempts, because subtracting chance from a 20-trial sample is noise. The app says
  how many attempts are still needed instead of showing a meaningless number.
* Replays are recorded as retries and can never raise the score. `tests/run_tests.js` asserts that
  "wrong then replay" leaves the score exactly where it was, and the smoke test checks the same in the
  browser (`n=3` after three answers, then `n=1` in the next sitting).

## 2. Spacing

`progression.js` keeps one small entry per card: box, last day, reps, lapses, recent first-attempt flags,
leech flag, and the day the card was first shown.

* Ladder: `1, 3, 7, 16, 35, 75, 160, 365` days (boxes 0-7). A correct first attempt moves up one box, a
  wrong one drops two boxes and returns at the shorter interval.
* Leech: three misses inside thirty days halves the interval and flags the card, so it gets more contact
  without a special UI.
* Mastery is deliberately strict: 20 consecutive first-attempt successes inside the last 40 attempts of
  that card. In any realistic run in the tests it stays 0, which is honest - mastering 1600 syllable-tone
  cards is not a week's work.
* Session shape, 20 slots: 2 warm-ups (weakest due cards), 3 new cards, then priority fill. Hard rules:
  no two consecutive cards on the same syllable, at most one card per syllable per session, no tone above
  40% of slots, unseen cards enter at priority 3.0 and are admitted only through the daily cap.
* When a rule cannot be satisfied, the session is filled by a documented relaxation ladder instead of
  breaking down: seen strict -> new cards -> seen tone cap -> new tone cap -> seen syllable -> new syllable
  -> repeat. The session object reports `relaxed` and `overCapNew`, and the progress line shows it.
* A card that was shown but not answered is not re-admitted as "new", otherwise every session would
  re-spend the daily cap (this was a real bug in the first version, caught by the simulation).

### Simulation results (synthetic learner, `tests/simulate.js`)

New sampler against the old unspaced sampler:

| scenario | distinct cards | gap median | miss -> back: median | worst | accuracy |
| --- | --- | --- | --- | --- | --- |
| 30 days x 1 session (600 trials) new | 116 | 38 | **19** | 120 | 0.61 |
| same, old sampler | 513 | 128 | **163** | 501 | 0.63 |
| 30 days x 9 sessions (5,400 trials) new | 122 | 22 | **17** | 160 | 0.61 |
| same, old sampler | 1547 | 760 | **733** | 4658 | 0.66 |
| 250 days x 1 session (5,000 trials) new | 776 | 116 | **56** | 366 | 0.57 |
| same, old sampler | 1529 | 745 | **722** | 4658 | 0.61 |

The complaint that drove this work - a missed card coming back after hundreds of trials - is answered: the
median return after a miss is 17-56 trials instead of 163-733. Constraints hold in every run: the worst
tone share is 8 of 20 slots (the cap), and sessions never repeat a syllable inside a session.

Accuracy is slightly *lower* for the new sampler. That is an artefact of the synthetic learner: the
scheduler deliberately serves weak and overdue cards, and this fake learner only gains from spacing, so
its measured accuracy dips while its per-card state improves. It is not evidence about real learning.

Honest limits: with a 1600-card bank and a 3-new-cards-a-day cap, full coverage takes well over a year.
At one session a day, 250 simulated days leave 562 cards overdue (worst 55 days) - a backlog, not an
error. Nine short sessions a day clears it. If the owner wants faster coverage the cap is the dial.

## 3. Audio path

* One `<audio>` element is reused for all cards, created on demand. If anything optional fails, the
  element plays normally: missing table, missing Web Audio, a suspended context, or a thrown error all fall
  back to plain playback. The first failure disables gain for the rest of the session rather than retrying
  on every card.
* Gains are applied at playback only. No file is re-encoded, no dynamics processing anywhere, and the gain
  table is the verified one (constant gain per clip, floored, never rounded up).
* iOS: `navigator.audioSession.type = "playback"` is set feature-detected on the first user gesture and
  again before every play. Without it, Web Audio on iOS is treated as ambient and the ring/silent switch
  mutes the drill - measured on the owner's phone. `play()` failures are caught and turn into a short
  "Tap Play to start the audio." message instead of a silent dead button.
* The gain is applied only when the audio context is actually running, because attaching a media element to
  a suspended context would silence it.
* The clip id used for the gain lookup is `syllable + tone` (`a1`, `a2`, ...), and `loadDataset` now builds
  ids that way. The old code built `a-1`, which would never have matched the table. All 1600 deck clips
  resolve (checked against `datasets/tones/metadata.json`).
* `sw.js` is bumped to v6 and lists the new files, so an installed Home-Screen copy actually picks up the
  new code and the gain table.

## 4. Evidence

* `node tests/run_tests.js` -> **70 passed, 0 failed** (Wilson bounds, guess-correction gating, ladder,
  drops, leech, session constraints on the real 1600-card bank, degenerate 2-card deck, serialised size).
* `node tests/simulate.js` -> the table above; full detail in `tests/sim_results.json`.
* `node tests/smoke_cdp.js` -> **23 passed, 0 failed** against the real page in headless Chromium
  (started with `--mute-audio`): no console errors, both new scripts load, the score line carries the
  interval and the chance note, three answers score `n=3`, the scheduler writes to localStorage, a reload
  restores 3 attempted cards, the guess-corrected number stays hidden, and a second sitting starts from
  zero while card history survives. The audio path is checked end to end: after a gesture the gain table is
  live in the page, the app asks the hook for a gain when it plays a card, and the value it applies equals
  the table (clip `ai1` -> -9.501 dB, read back from the file). An unknown clip id falls back to 0 dB.
* The smoke test drives a headless Chromium through the DevTools protocol with Node's built-in WebSocket
  client, so it needs no Playwright install (`MTD_CHROME`, `MTD_BASE_URL` override the paths).
* State size: the full bank with 60 days of history serialises to ~165 KiB, small enough for
  `localStorage` on iOS (tested limit is megabytes).

## 5. What was deliberately not done

* No existing content was removed or replaced: the dataset, the 300-sentence pack, the tone selection, the
  speed slider, the repeat switch, the error report and export are all still there.
* No dynamics processing, no re-encoding, no gain baked into any file.
* No new network calls at runtime; everything is static and offline-first.
* No A/B or listening pages - the owner asked to stop that work and give feedback later.
* `tests/_diag.js` is a scratch diagnostic and is left out of the patch.

## 6. Owner-visible risks

* A Home-Screen copy must be reloaded once for the v6 cache to take over; the existing update pill handles it.
* The gain table's lite map has 1900 keys (1600 syllable cards + 300 sentence clips). The app reads it
  whole at load after the first gesture (~33 KB), which is fine offline and cached.
* Accuracy display is honestly low at the start: the interval is wide by design. It narrows as attempts
  accumulate, and the guess-corrected number appears at 60.
