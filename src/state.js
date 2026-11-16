// state.js — Shared state, constants, storage, and DOM/math helpers
export const $ = (id) => document.getElementById(id);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const average = (values) =>
  values.reduce((sum, v) => sum + v, 0) / values.length;
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const formatGrade = (grade) =>
  (grade >= 0 ? "+" : "") + grade.toFixed(1) + "%";

export const formatTime = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  return (
    String(Math.floor(total / 60)).padStart(2, "0") +
    ":" +
    String(total % 60).padStart(2, "0")
  );
};

export const toHex = (view) =>
  Array.from(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    (b) => b.toString(16).padStart(2, "0"),
  ).join(" ");

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

export const WAHOO_CONTROL_UUID = "a026e005-0a7d-4ab3-97fa-f1500f9feb8b";
export const SERVICE = {
  cyclingPower: 0x1818,
  heartRate: 0x180d,
  battery: 0x180f,
};
export const CHARACTERISTIC = {
  powerMeasurement: 0x2a63,
  heartRateMeasurement: 0x2a37,
  batteryLevel: 0x2a19,
};
export const SIM_WIND_COEFFICIENT = 0.4;
export const HISTORY_SECONDS = 300;
export const MODES = ["erg", "resistance", "level", "sim"];
export const MODE_NAMES = {
  erg: "ERG",
  resistance: "Resistance",
  level: "Level",
  sim: "Sim grade",
};
export const HRV_WINDOWS = [30, 60, 120, 300];
export const DEFAULT_PRESETS = {
  erg: [100, 150, 200, 250, 300],
  resistance: [10, 30, 50, 70, 90],
};
export const CANVAS_FONT =
  "13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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

export const control = {
  viewMode: "erg",
  activeMode: "erg",
  sim: { weight: 75, crr: 0.004, grade: 0 },
  sendTimer: null,
  sendStatus: { text: "", tone: "idle" },
};

export const ride = {
  seconds: 0,
  intervalSeconds: 0,
  target: { kind: "erg", value: 150 },
  targetSource: "manual",
  startedAt: null,
};

export const FTP_RANGE = { min: 50, max: 350, fallback: 250 };
export const WPRIME_RANGE = { min: 5000, max: 50000, fallback: 19000 };

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
  ftp: FTP_RANGE.fallback,
  wPrime: WPRIME_RANGE.fallback,
};

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

export const demo = { heartRate: 105, beatClock: 0, nextRr: 570, rrDrift: 0 };

function loadPresets(key) {
  const fallback = DEFAULT_PRESETS[key];
  const saved = store.get("presets." + key, null);
  const valid =
    Array.isArray(saved) &&
    saved.length === fallback.length &&
    saved.every((v) => Number.isFinite(v));
  return valid ? saved : fallback.slice();
}

export const presets = {
  erg: { values: loadPresets("erg"), suffix: "W", editing: false },
  resistance: {
    values: loadPresets("resistance"),
    suffix: "%",
    editing: false,
  },
};

export const sliders = {};
["erg", "resistance", "level", "grade"].forEach((key) => {
  sliders[key] = {
    slider: $(key + "Slider"),
    display: $(key + "ValueDisplay"),
  };
});

export const runtime = {
  packetCount: 0,
  wakeLock: null,
};
