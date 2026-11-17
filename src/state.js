/**
 * state.js — shared state, constants, storage, and small helpers.
 *
 * Every other module imports from here. It has no logic of its own beyond
 * building the initial state, so it must not import from any other app file
 * (that would create a circular import).
 *
 * Contents, in order:
 *   1. DOM and math helpers ......... $, clamp, average, delay, formatters
 *   2. store ........................ saved settings (localStorage)
 *   3. Constants .................... Bluetooth IDs, modes, ranges, defaults
 *   4. Mutable state objects ........ devices, control, ride, workout,
 *                                     telemetry, demo, presets, sliders, runtime
 *
 * The state objects are plain mutable objects shared by reference. Modules
 * change them directly (for example `ride.seconds += 1`) and then call a
 * render function to update the screen. Nothing watches them for changes.
 *
 * Keep here: values that several modules must agree on.
 * Keep elsewhere: values used by one module (put those next to the code that
 * uses them).
 */

// ============================================================
// DOM AND MATH HELPERS
// ============================================================

/** Shorthand for document.getElementById. Returns null if the id is missing. */
export const $ = (id) => document.getElementById(id);

/** Limits `value` to the range min..max. */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Arithmetic mean. Returns null for an empty array (no data), matching how
 * missing readings are represented elsewhere. Check for null before
 * formatting the result or doing maths with it.
 */
export const average = (values) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

/** Promise that resolves after `ms` milliseconds. Use with await. */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Formats a grade as a signed percentage, for example "+2.5%" or "-1.0%". */
export const formatGrade = (grade) =>
  (grade >= 0 ? "+" : "") + grade.toFixed(1) + "%";

/**
 * The app's one time formatter. Formats seconds as mm:ss, or h:mm:ss from
 * one hour up (3700 s shows as "1:01:40"). Rounds to the nearest second and
 * treats negative values as 0. Import this instead of writing a local one.
 */
export const formatTime = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Converts a DataView to a space-separated hex string, for the Bluetooth log. */
export const toHex = (view) =>
  Array.from(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    (b) => b.toString(16).padStart(2, "0"),
  ).join(" ");

// ============================================================
// SETTINGS STORAGE
// ============================================================

/**
 * Saved settings, kept in localStorage as JSON under keys prefixed with
 * "trainingHub.". Never throws: if storage is blocked or the value is
 * corrupt, get() returns the fallback and set() does nothing (settings just
 * don't persist).
 *
 *   store.get("ftp", 250)       -> saved value, or 250
 *   store.set("ftp", 260)
 */
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem("trainingHub." + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("trainingHub." + key, JSON.stringify(value));
    } catch (err) {
      /* storage unavailable: settings just do not persist */
    }
  },
};

// ============================================================
// CONSTANTS
// ============================================================

// --- Bluetooth identifiers ---
/** Wahoo's proprietary control characteristic, used to send ERG/resistance/sim commands. */
export const WAHOO_CONTROL_UUID = "a026e005-0a7d-4ab3-97fa-f1500f9feb8b";
/** Standard Bluetooth service numbers. */
export const SERVICE = {
  cyclingPower: 0x1818,
  heartRate: 0x180d,
  battery: 0x180f,
};
/** Standard Bluetooth characteristic numbers. */
export const CHARACTERISTIC = {
  powerMeasurement: 0x2a63,
  heartRateMeasurement: 0x2a37,
  batteryLevel: 0x2a19,
};

// --- Trainer and chart ---
/** Wind coefficient sent to the trainer in sim mode. */
export const SIM_WIND_COEFFICIENT = 0.4;
/** How many seconds of samples telemetry.history keeps (the chart's rolling window). */
export const HISTORY_SECONDS = 300;
/** Trainer control modes. Each has a tab (tab-<mode>) and a panel (panel-<mode>). */
export const MODES = ["erg", "resistance", "level", "sim"];
/** Display names for the modes. */
export const MODE_NAMES = {
  erg: "ERG",
  resistance: "Resistance",
  level: "Level",
  sim: "Sim grade",
};
/** Selectable HRV analysis windows, in seconds. Each has a button (win-<seconds>). */
export const HRV_WINDOWS = [30, 60, 120, 300];
/** Factory preset values for the preset buttons (ERG in watts, resistance in %). */
export const DEFAULT_PRESETS = {
  erg: [100, 150, 200, 250, 300],
  resistance: [10, 30, 50, 70, 90],
};
/** Font for all canvas chart text. Change the size here to resize chart text. */
export const CANVAS_FONT =
  "13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// ============================================================
// DEVICES
// ============================================================

/**
 * The three Bluetooth devices. Static settings are defined here; runtime
 * fields are added just below.
 *   role      label shown in the UI and log
 *   service   Bluetooth service the device is found by
 *   demoName  name shown when demo mode stands in for the device
 *   battery   id of the battery readout element, or null if none
 */
export const devices = {
  trainer: {
    role: "Trainer",
    service: SERVICE.cyclingPower,
    demoName: "KICKR (demo)",
    battery: null,
  },
  hr: {
    role: "HR strap",
    service: SERVICE.heartRate,
    demoName: "Polar H10 (demo)",
    battery: "batteryHr",
  },
  pedals: {
    role: "Pedals",
    service: SERVICE.cyclingPower,
    demoName: "Assioma (demo)",
    battery: "batteryPedals",
  },
};

// Runtime fields added to every device:
//   state    "idle" | "connected" (other values may be set by bluetooth.js)
//   demo     true when demo data stands in for the device
//   device   the Web Bluetooth device object once paired
//   control  the Wahoo control characteristic (trainer only)
//   name     display name once connected
//   closing  true while a disconnect is in progress
Object.values(devices).forEach((d) =>
  Object.assign(d, {
    state: "idle",
    demo: false,
    device: null,
    control: null,
    name: "",
    closing: false,
  }),
);

// ============================================================
// TRAINER CONTROL STATE
// ============================================================

/**
 * What the control panel is doing.
 *   viewMode    the mode tab being looked at (keyboard shortcuts follow this)
 *   activeMode  the mode last sent to the trainer
 *   sim         sim parameters: rider+bike weight (kg), rolling resistance, grade (%)
 *   sendTimer   pending debounce timer for sending a manual change
 *   sendStatus  last status line shown under the controls
 */
export const control = {
  viewMode: "erg",
  activeMode: "erg",
  sim: { weight: 75, crr: 0.004, grade: 0 },
  sendTimer: null,
  sendStatus: { text: "", tone: "idle" },
};

// ============================================================
// RIDE STATE
// ============================================================

/**
 * The current ride.
 *   seconds          ride clock (advances only while a device is connected)
 *   intervalSeconds  time since the last target/segment change; drives the
 *                    interval tile. Reset on segment change, manual commit,
 *                    and sim transmit.
 *   target           what the trainer is told to do: { kind, value }.
 *                    kind is one of MODES; for "erg" the value is watts.
 *   targetSource     "manual" or "workout"
 *   startedAt        start time in ms (null until the ride starts), used for
 *                    timestamps in the Intervals.icu upload
 */
export const ride = {
  seconds: 0,
  intervalSeconds: 0,
  target: { kind: "erg", value: 150 },
  targetSource: "manual",
  startedAt: null,
};

// Allowed ranges for rider settings. `fallback` is used when nothing valid is saved.
export const FTP_RANGE = { min: 50, max: 350, fallback: 250 };
export const WPRIME_RANGE = { min: 5000, max: 50000, fallback: 19000 }; // joules

// ============================================================
// WORKOUT STATE
// ============================================================

/**
 * The loaded workout and its playback position.
 *   points            [{ t, v }]: time in seconds and target value
 *   unit              what `v` means (default "percent", as a share of FTP)
 *   name              file name of the loaded workout
 *   duration          total length in seconds
 *   elapsed           playback position in seconds
 *   playing           true while playing
 *   mode              display mode, "erg" or "res" (see setWorkoutMode)
 *   segment           index of the current segment (-1 = none yet)
 *   lastSent          key of the last target sent to the trainer; set to ""
 *                     to force it to be sent again (done when FTP changes)
 *   lastCountdownSec  last second for which a 3-2-1 beep played (-1 = none)
 *   ftp, wPrime       rider settings, kept in sync by applyFtp/applyWPrime in main.js
 */
export const workout = {
  points: [],
  unit: "percent",
  name: "",
  duration: 0,
  elapsed: 0,
  playing: false,
  mode: "erg",
  segment: -1,
  lastSent: "",
  lastCountdownSec: -1,
  messages: [], // [{ t, text, duration }] in seconds, from [COURSE TEXT]
  ftp: FTP_RANGE.fallback,
  wPrime: WPRIME_RANGE.fallback,
};

/** The workout message showing at `elapsed` seconds, or null. */
export const activeWorkoutMessage = (elapsed) =>
  (workout.messages ?? []).find(
    (m) => elapsed >= m.t && elapsed < m.t + m.duration,
  ) ?? null;

// ============================================================
// TELEMETRY STATE
// ============================================================

/**
 * Live sensor data and derived metrics.
 *
 * Raw sensor data (written by bluetooth.js):
 *   power         recent power readings per source: { trainer: [], pedals: [] }
 *   crank         last crank data per source (for cadence calculation)
 *   cadence       latest cadence per source
 *   heartRate     latest HR reading, { bpm, at } (null if none yet)
 *
 * Heart rate variability (see hrv.js):
 *   beats         recent RR intervals: [{ t, rr, afterGap }]
 *   rejected      timestamps of rejected (artifact) beats
 *   lastGoodRr, gapPending, rejectStreak   state for the artifact filter
 *   hrvWindow     analysis window in seconds (one of HRV_WINDOWS)
 *
 * Recorded history:
 *   history       rolling samples for the chart, last HISTORY_SECONDS:
 *                 { trainer, pedals, target, hr }
 *   fullRideLog   every sample of the ride, used by the chart in workout
 *                 mode, the CSV export and the Intervals.icu upload. Rows
 *                 include elapsedSeconds, pedals, trainer, target, np, tss,
 *                 wPrimeBal, hr, cadence, dfaA1.
 *
 * Power analytics (written by metrics.js):
 *   rolling30sPower, npFourthPowerSum, npSampleCount, normalizedPower,
 *   tss, wPrimeBalance (joules)
 */
export const telemetry = {
  power: { trainer: [], pedals: [] },
  crank: { trainer: null, pedals: null },
  cadence: { trainer: null, pedals: null },
  heartRate: null,
  beats: [],
  rejected: [],
  lastGoodRr: null,
  gapPending: false,
  rejectStreak: 0,
  hrvWindow: 120,
  history: [],
  fullRideLog: [],
  // Power analytics (NP, TSS, W'bal)
  rolling30sPower: [],
  npFourthPowerSum: 0,
  npSampleCount: 0,
  normalizedPower: null,
  tss: 0,
  wPrimeBalance: WPRIME_RANGE.fallback,
};

/** Simulated sensor state used by demo mode (see generateDemoData in bluetooth.js). */
export const demo = { heartRate: 105, beatClock: 0, nextRr: 570, rrDrift: 0 };

// ============================================================
// PRESETS AND SLIDERS
// ============================================================

/**
 * Loads saved preset values for a group, falling back to the defaults if
 * nothing is saved or the saved list is the wrong length or has non-numbers.
 * Returns a copy, so editing never changes DEFAULT_PRESETS.
 */
function loadPresets(key) {
  const fallback = DEFAULT_PRESETS[key];
  const saved = store.get("presets." + key, null);
  const valid =
    Array.isArray(saved) &&
    saved.length === fallback.length &&
    saved.every((v) => Number.isFinite(v));
  return valid ? saved : fallback.slice();
}

/**
 * Preset button groups. Only erg and resistance have presets.
 *   values   the preset numbers (saved under "presets.<key>")
 *   suffix   unit text shown on the buttons
 *   editing  true while the group's row is in edit mode
 */
export const presets = {
  erg: { values: loadPresets("erg"), suffix: "W", editing: false },
  resistance: {
    values: loadPresets("resistance"),
    suffix: "%",
    editing: false,
  },
};

/**
 * Slider elements and their value readouts, looked up once at load.
 * Note the key is "grade" for the sim slider, but the mode is "sim".
 * Each entry reads ids <key>Slider and <key>ValueDisplay; an entry's
 * elements are null if that id is missing from the HTML.
 */
export const sliders = {};
["erg", "resistance", "level", "grade"].forEach((key) => {
  sliders[key] = {
    slider: $(key + "Slider"),
    display: $(key + "ValueDisplay"),
  };
});

// ============================================================
// RUNTIME
// ============================================================

/** Misc runtime values: packets counted for the Bluetooth log, and the screen wake lock. */
export const runtime = {
  packetCount: 0,
  wakeLock: null,
};
