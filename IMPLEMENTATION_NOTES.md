# Implementation notes: scoring, spacing, task types, and the audio path

Branch `feature/scoring-and-scheduler`, based on `756f137`. Nothing here was pushed anywhere, and no
audio file, licence file, or `datasets/tones/metadata.json` was touched (`git status datasets` is empty).

Revision 2 added what the owner asked for after testing revision 1 on the phone: the card order bug is
fixed (see section 3), the daily new-card cap is gone (section 4), and the session now mixes four task
types at random (section 5). Revision 3 answers his revision-2 feedback: the two-clip task is now "which
tone was CLIP A?" (section 10), every answer reveals the pinyin, tone name and pitch shape, and the
progress panel tracks per-tone accuracy with an optional weakest-tone focus.

## What changed, in one screen

| File | Change |
| --- | --- |
| `progression.js` | NEW. Scoring maths, per-card ladder state, the session builder (card order, variety rules, per-task weighting). No DOM access, so it can be unit tested under Node. |
| `script.js` | Rewritten. First attempts are the score; the scheduler picks every card and every task type; one reused `<audio>` element; optional Web Audio gain; iOS playback audio session. |
| `index.html` | Loads the two new scripts, shows the score line, the interval, the chance note, the session/progress line, a card state line, the task toggles and the new-cards slider. |
| `styles.css` | Styles for those lines, the answer grid, the pair buttons and the contour buttons. No layout change. |
| `sw.js` | `CACHE_NAME` v5 -> v6 (revision 1), v6 -> v7 (revision 2), v7 -> v8 (revision 3), with every fetched asset in `APP_SHELL`, including the gain table and both icons. |
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
* Where the ladder comes from: expanding intervals are the arrangement with the best evidence for verbal
  recall (Cepeda, Pashler, Vul, Wixted & Rohrer 2006, *Psychological Bulletin* 132, 354-380,
  doi:10.1037/0033-2909.132.3.354, checked against the Crossref API), and the spacing gain grows with the
  gap up to a point, which is why the ladder expands instead of repeating daily. The exact day values are a
  pragmatic choice, not a result from that paper.
* Mastery is deliberately strict: 20 consecutive first-attempt successes inside the last 40 attempts of
  that card. In any realistic run in the tests it stays 0, which is honest - mastering 1600 syllable-tone
  cards is not a week's work.

### Session shape (revision 2)

* The session is built slot by slot in three roles: **warm** (the weakest cards that are due), **new** (the
  unseen cards this session is allowed to hand out), then **fill** (the most urgent eligible card).
* Length is adaptive: `min(20, max(1, newPerSession + (distinct syllables in the seen pool)))`. A cold start
  is 5 cards; it grows towards 20 as the bank is learned. A session can never be shorter than the number of
  new cards it promised.
* The candidate list is the `TOP_K = 8` most urgent eligible cards (urgency = overdue days + a bonus for
  the tone that is currently rarest in the session), and the actual pick is **uniform random inside that
  list**, so two sessions on the same day do not repeat the same order.
* Hard rules, checked by `tests/run_tests.js` on the real 1600-card bank: one card per syllable per session,
  no two consecutive cards on the same syllable, no tone above 40% of slots, at most 2 cards in a row on the
  same tone, at most 2 in a row on the same task.
* When a rule cannot be satisfied the session is filled by a documented relaxation ladder instead of
  breaking down: seen strict -> seen tone cap -> seen tone run -> seen tone cap + run -> fresh card with
  `avoidSeen` -> seen syllable -> fresh with `avoidSeen` and the tone rules -> fresh with the syllable rule
  -> any repeat. **Relaxing a session-variety rule is preferred over spending an unasked-for new card**,
  because the new-card pace is the owner's dial, not the scheduler's. The session object reports `relaxed`,
  `overCapNew` (`newAdmitted`, `overCapNew`) and a per-slot `trace` for diagnosis.

### Simulation results (synthetic learner, `tests/simulate.js`)

New sampler against the old unspaced sampler:

| scenario | distinct cards | gap median | miss -> back: median | worst | accuracy | worst tone run | all 4 tones per session |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 30 days x 1 session (600 trials) new | 150 | 44 | **26** | 73 | 0.65 | 2 | 30/30 |
| same, old sampler | 513 | 128 | **163** | 501 | 0.63 | n/a | n/a |
| 30 days x 9 sessions (5,400 trials) new | 1350 | 370 | **36** | 603 | 0.57 | 2 | 270/270 |
| same, old sampler | 1547 | 760 | **733** | 4658 | 0.66 | n/a | n/a |
| 250 days x 1 session (5,000 trials) new | 1250 | 102 | **75** | 416 | 0.65 | 2 | 250/250 |
| same, old sampler | 1529 | 745 | **722** | 4658 | 0.61 | n/a | n/a |

The complaint that drove this work - a missed card coming back after hundreds of trials - is answered: the
median return after a miss is 17-56 trials instead of 163-733. Constraints hold in every run: the worst
tone share is 8 of 20 slots (the cap), and sessions never repeat a syllable inside a session.

Accuracy is slightly *lower* for the new sampler. That is an artefact of the synthetic learner: the
scheduler deliberately serves weak and overdue cards, and this fake learner only gains from spacing, so
its measured accuracy dips while its per-card state improves. It is not evidence about real learning.

Honest limits: with a 1600-card bank and 5 new cards per session, one session a day covers 1250 cards in
250 simulated days; the rest wait (worst overdue 110 days for a single card, 1118 cards overdue in total on
a 5,000-trial run - a backlog, not an error). Nine short sessions a day clears it. **The new-cards slider is
the dial**: raising it to 10 or 15 covers the bank sooner and makes each session longer, lowering it to 0
gives review-only sessions.

## 3. Card order: the bug the owner found on the phone

The owner's report was exact: "tone 1 in a row, then tone 2, then tone 3, never tone 4; I stopped listening
and picked the same option." That is what revision 1 did, and it was a real defect, not an impression.

* Root cause: the deck is stored **syllable-major, tone-minor** (`a1 a2 a3 a4 b1 b2 ...` in
  `metadata.json`), and revision 1's greedy picker took "the first card of each syllable" for its 20-slot
  session. The first 8 syllables of the deck each contributed their tone-1 card, the next 8 their tone-2
  card, and the session opened with eight tone-1 cards in a row. Day 0 was literally
  `1 1 1 1 1 1 1 1 2 2 2 2 2 2 2 2 3 3 3 3`: **tone 4 never appeared at all**, because the session ended
  before the picker reached it. Later days could run five cards on one tone.
* Fix: the picker is now role-based and variety-aware (see "Session shape" above) and the candidate list is
  shuffled by seeded RNG, so position in the deck has no influence. `MAX_TONE_RUN = 2` and
  `MAX_TASK_RUN = 2` are hard filters.
* Measured after the fix, seeded RNG `mulberry32(20261010)`: day 0 `1 2 3 4 3` (run 1), day 1
  `2 3 3 2 ...` (run 1), day 2 run 2, day 3 run 2, and **all four tones inside every one of the 550
  simulated sessions** (30-day, 270-session and 250-day runs). Worst tone run over every run: 2.
* Regression test: `tests/run_tests.js` asserts the owner's case directly - a cold-start session contains
  all four tones, no tone run above `MAX_TONE_RUN`, and no syllable twice - and refuses to pass if the
  session builder is ever reduced to a deck-order scan again.

## 4. Why the daily new-card cap is gone

The owner asked whether 3 new cards a day has scientific support. Honest answer: **the limit is a review
workload control, not a learning effect**, and the app had no workload to control.

* The Anki manual describes the setting as workload management, not as a retention optimum
  (<https://docs.ankiweb.net/deck-options.html>, fetched 2026-10-10): *"Studying new cards will temporarily
  increase the number of reviews you need to do a day, as newly-learned material needs to be repeated a
  number of times before the delay between repetitions can increase appreciably. If you are consistently
  learning 20 new cards a day, you can expect your daily reviews to be roughly about 200 cards/day. You can
  decrease the reviews required by introducing fewer new cards each day until your review burden decreases."*
* That burden comes from the review queue: 20 new cards a day in Anki become ~200 reviews a day. This drill
  has no such queue - the session length is capped at 20 slots and a card's next appearance is scheduled by
  the ladder, so more new cards make each session longer (up to the cap), not a backlog of due reviews.
* The companion evidence file searched Anki, SuperMemo and Mnemosyne documentation plus OpenAlex,
  Crossref, Semantic Scholar, Europe PMC, ERIC and arXiv, and **found no controlled study that treats "new
  items per day" as the manipulated variable with retention as the outcome**. Spacing research varies the
  *interval* and the number of sessions, not the daily admission rate. Nor does any vendor document claim a
  scientifically optimal number: Anki's own worked example uses 20/day, SuperMemo's model treats new items
  as ~5% of study time, and Mnemosyne has no such setting.
* The honest position is therefore: the cap is a workload habit borrowed from Anki's advice, and the app
  should expose it as a dial instead of enforcing it.
* What revision 2 does instead: the daily counter is gone (`sched.daily` survives for display only), the
  dashboard says "new cards today N (set per session, no daily cap)", and the settings slider
  **New cards per session, 0-20** (default 5) controls the pace. `NEW_PER_SESSION` is never spent twice:
  a card that was shown but not answered is recorded as introduced, so it cannot be re-admitted as new.
  Sessions stay honest when the owner asks for more than the bank can support: `overCapNew` reports the
  cards that had to be admitted over budget (0 in every simulated run) instead of silently exceeding it.

## 5. Task types (the owner asked for more variety inside a session)

Four task types, all from the same 1600-clip deck, with **randomised selection inside the session**:

| task | question | choices | chance |
| --- | --- | --- | --- |
| `tone` | Which tone is this? | 4 tone names, with the contour described in words | 25% |
| `syllable` | Which syllable is this? | 4 near-syllables that all share the **same tone** (minimal pairs first: `a3 an3 en3 pen3`) | 25% |
| `pair` | Same tone or different? | 2 buttons; two clips that differ in **exactly one dimension** (same syllable + different tone -> "different", different syllable + same tone -> "same") | 50% |
| `contour` | Which tone shape is this? | 4 inline SVG contour shapes (no image files, no network) | 25% |

* Weights `TASK_WEIGHTS = {tone: 0.40, syllable: 0.25, pair: 0.20, contour: 0.15}` with a **1.4x bonus for
  the least-used type in the current session**, so a 20-card session contains all four types instead of a
  random clump; `MAX_TASK_RUN = 2` forbids a third card of the same type in a row. Measured mix over 30
  sessions (`tests/simulate.js`): `{tone: 184, syllable: 146, pair: 127, contour: 113}`.
* Why randomised rather than blocked: blocked practice flatters performance during practice and loses on
  retention and transfer; interleaving and high-variability training are the more durable arrangements for
  perceptual categories (Rohrer & Taylor 2007, doi:10.1007/s11251-007-9015-8; Kornell & Bjork 2008,
  doi:10.1111/j.1467-9280.2008.02127.x; the high-variability phonetic-training literature, e.g. Logan,
  Lively & Pisoni 1991, doi:10.1121/1.1894649 - bibliographic details checked against the Crossref API,
  which needs no key). The full citation set with links is in the companion file
  `evidence/cap-and-interleaving-evidence.md` (delivered next to the patch, not inside the repo);
  the task order is randomised **within** a session and the per-task scores are reported separately, so a
  bad week on one task cannot hide in the total.
* Per-task scoring: every task keeps its own first-attempt count and its own Wilson interval, and the
  chance note follows the task (25% for tone/syllable/contour, 50% for same/different). The overall line
  stays, with the retry and recovered counts beside it.
* Pair-task details, because a wrong design makes the task unanswerable: the two clips are always from the
  same deck and never the same file, the second is played after the first ends (with a 300 ms gap and a
  timer backstop), and if no legal partner exists the card falls back to the `tone` task rather than showing
  two identical clips. The pair is never chosen so that both dimensions change.
* Weak spots in the evidence, stated plainly (from the companion file): the interleaving advantage is
  **material-dependent** - the 2019 meta-analysis (Brunmair & Richter, doi:10.1037/bul0000209) finds
  g = 0.42 overall but *blocking* wins for word lists (g = -0.39), and a preregistered perceptual-learning
  study with auditory, olfactory, gustatory and tactile categories found no significant interleaving effect
  in any single experiment (Abel 2023, doi:10.1111/cogs.13270). Nobody has run the blocked-vs-mixed
  comparison on **tone categories** specifically, so task mixing in this app is a design choice with
  indirect support, not a settled result. What the owner can rely on: mixing is at worst neutral for
  discrimination-style material, it stops the "same question 20 times" rut, and the per-task score lines
  make the effect visible to him rather than assert it.
* Session length has its own evidence: very long single sessions are not better than short ones and can
  slow learning ("less is more", Molloy et al. 2012, doi:10.1371/journal.pone.0036929), and gains
  consolidate across sleep (Fenn et al. 2003, doi:10.1038/nature01951). The 5-20 card session and the
  day-scale ladder fit that, and one very long session is not a shortcut.
* The task toggles in the settings let any type be switched off; `buildSession` takes the filtered list, so
  a session built while `pair` is off never contains one.
* The syllable task uses tone-marked pinyin (first of `a`/`o`/`e`, else the last vowel of the syllable,
  which is the standard placement rule), and every label is generated from the id, so no new data file and
  no `sw.js` cache entry per task was needed.

## 6. Audio path

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
* `sw.js` is bumped to **v7** (v6 was revision 1's bump) and lists every asset the page fetches. The fetch
  handler is cache-first, so a Home-Screen copy would otherwise load the previous `script.js` next to the
  new `index.html`; revision 2 changed no fetched file *names*, but every one of them changed content, and
  the cache name carries the version.

## 7. Evidence

* `node tests/run_tests.js` -> **93 passed, 0 failed** (Wilson bounds, guess-correction gating, ladder,
  drops, leech, session constraints on the real 1600-card bank, the owner's tone-order regression, seeded
  reproducibility, two sessions on one day, a 200-day mature bank, per-task scoring, degenerate decks,
  serialised size).
* `node tests/simulate.js` -> the table above; full detail in `tests/sim_results.json`.
* `node tests/smoke_cdp.js` -> **54 passed, 0 failed** against the real page in headless Chromium
  (started with `--mute-audio`): no console errors, both new scripts load, the score line carries the
  interval and the chance note, three answers score `n=3`, the scheduler writes to localStorage, a reload
  restores 3 attempted cards, the guess-corrected number stays hidden, and a second sitting starts from
  zero while card history survives. The audio path is checked end to end: after a gesture the gain table is
  live in the page, the app asks the hook for a gain when it plays a card, and the value it applies equals
  the table (clip `a1` -> -11.737 dB, clip `ou2` -> -4.567 dB, each read back from the file). An unknown
  clip id falls back to 0 dB. The task UI is checked card by card: the answer area matches the task badge,
  the pair task really plays two clips that differ in exactly one dimension, the syllable task offers four
  same-tone near-syllables with tone marks, three or more task types appear in a 12-card walk, no tone run
  exceeds 2, all four tones appear, the settings survive a reload, and every button locks once answered.
* The smoke test drives a headless Chromium through the DevTools protocol with Node's built-in WebSocket
  client, so it needs no Playwright install (`MTD_CHROME`, `MTD_BASE_URL` override the paths).
* State size: the full bank with 60 days of history serialises to ~165 KiB, small enough for
  `localStorage` on iOS (tested limit is megabytes).

## 10. Revision 3: the two-clip task, the answer reveal, and weak-tone focus

Owner feedback after testing revision 2 on the phone: the pinyin (syllable) task is the best part because
it ties sounds to spellings, and contour diagrams as answer options beat "1-4" numbers; the same/different
pair task felt a bit easy and slowed the pace. Revision 3 answers that.

### The pair task is now "which tone was CLIP A?"

* Two clips, same syllable, two different tones; the answer area is the four tone buttons. Chance drops
  from 50% (same/different) to 25%, and the question has to be held in memory while clip B plays.
* The partner is picked for difficulty: a card on tone 2 or 3 is paired with the other one of that pair,
  because 2 against 3 is the contrast learners miss most; a card on tone 1 or 4 is paired with 2 or 3.
* The pace complaint is answered twice over: the gap between the clips is 220 ms (was 320 ms plus a 180 ms
  tail), and the task now carries the smallest share of the session (weight 0.15, was 0.20).
* Task weights are tone 0.30, syllable 0.30, contour 0.25, pair 0.15, and every task type now states a
  25% chance. A one-tone deck cannot build a pair, so that card falls back to the plain tone task.

### The reveal panel

Every answer now shows the card the way the owner likes to see it: the syllable in tone-marked pinyin, the
tone name, and the pitch-shape diagram, with a "Hear it again" button that does not score. The pair task
reveals both clips, and its status line names both ("Wrong - clip A was é (tone 2, rising), clip B was ě
(tone 3, dipping).").

### Per-tone tallies and the weakest-tone focus

* The scheduler state now carries a first-attempt tally per tone, shown as `Tone accuracy (first attempts):
  1 50% of 2 · 2 0% of 4 · ...` under the progress line.
* A new settings switch, "Focus my weakest tones" (default off), leans the session towards the two tones
  with the lowest first-attempt accuracy (at least 5 attempts each). It is a score bonus only, so the
  variety rules, the 40% tone cap and the two-card tone-run limit still hold; a focus session cannot become
  a block of one tone. The switch says which tones it would use, or that it needs data first.

### Other

* The reveal panel is cleared when a card is skipped with Next, so a stale answer cannot sit under a new card.
* `CACHE_NAME` v7 -> v8 (every changed file keeps its name, so the content change is what needs the bump).

### Verification (revision 3)

* Applied with `git apply --binary` to a pristine clone of `756f137`; `diff -r --exclude=.git` against the
  work tree: identical. `datasets` 1,605 files, 0 sha256 mismatches, 53,618,473 bytes; the real repo is
  still clean at `756f137`.
* `node tests/run_tests.js`: 511 passed, 0 failed (per-tone tallies, the weakest-tone pick, and a focus
  run against a plain run from identical scheduler states: 60% of slots on the weak tones without focus,
  80% with it, with every variety rule still checked on all 80 sessions).
* `node tests/smoke_cdp.js` against the applied clone (headless Chromium, `--mute-audio`): 64 passed,
  0 failed. It walks 12 cards through the real UI and checks the new behaviour: the pair card plays two
  clips of the same syllable with different tones, offers 1-4, and names both clips in the status line and
  the reveal; every reveal carries tone-marked pinyin, a tone name and a contour diagram plus the replay
  button; the per-tone line renders; the focus switch toggles, saves and labels itself.
* `node tests/simulate.js`: 30-day task mix `{tone:165, pair:113, syllable:144, contour:148}`, worst tone
  run 2, worst task run 2, no relaxed sessions, no over-cap new cards.

## 8. What was deliberately not done

* No existing content was removed or replaced: the dataset, the 300-sentence pack, the tone selection, the
  speed slider, the repeat switch, the error report and export are all still there.
* No dynamics processing, no re-encoding, no gain baked into any file.
* No new network calls at runtime; everything is static and offline-first.
* No A/B or listening pages - the owner asked to stop that work and give feedback later.
* `tests/_diag.js`, `tests/_shot.js` and the diagnostic printers under `evidence/tools/` are scratch and
  are left out of the patch.

## 9. Owner-visible risks

* A Home-Screen copy must be reloaded once for the v8 cache to take over; the existing update pill handles it.
  If the owner sees the old UI after applying the patch, that is the cache, not the code.
* The gain table's lite map has 1900 keys (1600 syllable cards + 300 sentence clips). The app reads it
  whole at load after the first gesture (~33 KB), which is fine offline and cached.
* Accuracy display is honestly low at the start: the interval is wide by design. It narrows as attempts
  accumulate, and the guess-corrected number appears at 60. The per-task lines make the small-sample noise
  visible rather than hidden; each task needs 60 first attempts of its own before its guess-corrected
  number appears.
* The pair task is the only task that plays two clips per card, so it takes roughly twice as long; its
  weight is the lowest of the four for that reason (0.15 in revision 3).
* The weakest-tone focus needs 5 first attempts on at least two tones before it can pick tones; until then
  the switch says "needs data" and the session runs normally.
