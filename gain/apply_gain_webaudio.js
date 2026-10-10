/*! apply_gain_webaudio.js
 *  Per-clip loudness normalisation for mandarin-tone-drill.
 *
 *  WHAT IT DOES
 *    Sets ONE constant gain per clip, looked up in loudness gain_table.json, so that all clips play
 *    at the same loudness (ITU-R BS.1770-4 integrated loudness, target -21.0 LUFS).
 *    Audio path:  HTMLAudioElement -> MediaElementAudioSourceNode -> GainNode -> AudioContext.destination
 *
 *  WHAT IT DOES NOT DO
 *    - it never touches the decoded samples, the MP3 files, or the server;
 *    - it applies NO dynamic compression / limiting / per-syllable levelling. The gain is constant for the
 *      whole clip, so the dynamics INSIDE a clip are bit-for-bit the recorded ones.
 *
 *  USAGE (app patch, 3 lines)
 *    At start-up:   await MTDLoudnessNormalizer.ready("./datasets/loudness/gain_table.json");
 *    Per clip:      const info = MTDLoudnessNormalizer.apply(currentAudio, currentItem.audio);
 *    Optional tap:  const analyser = MTDLoudnessNormalizer.tap(currentAudio);   // debug level meter
 *
 *  CAUTION  Creating a MediaElementAudioSourceNode MOVES the element's audio into the Web Audio graph:
 *    if the graph is not connected to destination you get silence. That is done once per element here.
 *    Chrome/Safari start an AudioContext "suspended" until a user gesture: apply() calls resume(),
 *    and apply() is called from the click handler that starts playback, so that is satisfied.
 */
(function (global) {
  "use strict";

  var DEFAULT_TABLE_URL = "./gain/gain_table_lite.json";   /* shipped with the app: flat clip id -> gain_db */
  var MISSING_GAIN_DB = 0.0;     // unknown clip id -> no change (fail safe, never louder)

  var gains = null;              // Map<clipId, {db, capped}>
  var ctx = null;
  var graphs = new WeakMap();    // HTMLAudioElement -> {src, gain, analyser}

  function audioContext() {
    if (!ctx) {
      var C = global.AudioContext || global.webkitAudioContext;
      ctx = new C();
    }
    return ctx;
  }

  /* "datasets/tones/audio/a1.mp3?v=2" -> "a1" */
  function clipId(url) {
    var m = String(url).split("?")[0].split("#")[0].match(/([^/]+)\.(mp3|wav|ogg|m4a|flac)$/i);
    return m ? m[1] : null;
  }

  function dBToLinear(db) { return Math.pow(10, db / 20); }

  /* Load the shipped table. Accepts either the full table or a flat {id: gain_db} object. */
  function ready(tableUrl, fetchOptions) {
    tableUrl = tableUrl || DEFAULT_TABLE_URL;
    return fetch(tableUrl, fetchOptions || { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("gain table HTTP " + r.status); return r.json(); })
      .then(function (json) {
        gains = new Map();
        if (json && json.packs) {
          Object.keys(json.packs).forEach(function (pid) {
            var clips = (json.packs[pid] || {}).clips || {};
            Object.keys(clips).forEach(function (id) {
              gains.set(id, { db: Number(clips[id].gain_db) || 0, capped: !!clips[id].capped,
                              lufs: clips[id].lufs_integrated, peak: clips[id].true_peak_dbfs });
            });
          });
        } else {
          Object.keys(json || {}).forEach(function (id) {
            var v = json[id];
            gains.set(id, { db: Number(v && v.gain_db !== undefined ? v.gain_db : v) || 0, capped: false });
          });
        }
        return gains.size;
      });
  }

  /* Build the source -> gain -> destination chain once for this element. */
  function attach(el) {
    var g = graphs.get(el);
    if (g) return g;
    var c = audioContext();
    var src = c.createMediaElementSource(el);
    var gain = c.createGain();
    gain.gain.value = 1.0;
    src.connect(gain);
    gain.connect(c.destination);
    g = { src: src, gain: gain, ctx: c, analyser: null };
    graphs.set(el, g);
    return g;
  }

  /* Apply the table gain for this clip. Returns what was applied (for logging/tests). */
  function apply(el, urlOrId) {
    var g = attach(el);
    var id = urlOrId && /\.(mp3|wav|ogg|m4a|flac)$/i.test(urlOrId) ? clipId(urlOrId) : (urlOrId || null);
    var rec = (gains && id) ? gains.get(id) : null;
    var db = rec ? rec.db : MISSING_GAIN_DB;
    g.gain.gain.value = dBToLinear(db);      // one constant value: no ramps, no dynamics
    if (g.ctx.state === "suspended") { g.ctx.resume(); }
    return { clip_id: id, gain_db: db, gain_linear: dBToLinear(db),
             capped: !!(rec && rec.capped), known: !!rec };
  }

  /* Optional parallel AnalyserNode, for a level meter / automated checks. Not needed for playback. */
  function tap(el, fftSize) {
    var g = attach(el);
    if (!g.analyser) {
      var a = g.ctx.createAnalyser();
      a.fftSize = fftSize || 2048;
      g.gain.connect(a);
      g.analyser = a;
    }
    return g.analyser;
  }

  /* Read the current output level of the graph: peak and RMS of the LAST fftSize samples only.
   That RMS is a short-time value (one ~43 ms window at fftSize 2048 / 48 kHz) and on speech it is much
   higher than the RMS of a whole sentence, because the window often lands on a loud vowel. For an overall
   level, accumulate the squared samples over your whole observation window. */
  function level(el) {
    var a = tap(el);
    var buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    var peak = 0.0, sum = 0.0;
    for (var i = 0; i < buf.length; i++) {
      var v = buf[i] < 0 ? -buf[i] : buf[i];
      if (v > peak) peak = v;
      sum += buf[i] * buf[i];
    }
    return { peak: peak, rms: Math.sqrt(sum / buf.length), state: (graphs.get(el) || {}).ctx
             ? graphs.get(el).ctx.state : "none" };
  }

  global.MTDLoudnessNormalizer = {
    ready: ready, apply: apply, tap: tap, level: level,
    clipId: clipId, dBToLinear: dBToLinear,
    get gains() { return gains; },
    get context() { return ctx; }
  };
})(typeof window !== "undefined" ? window : this);
