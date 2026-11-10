import {
  loadDeviceIds,
  saveDeviceId,
  forgetDeviceId,
  loadFtp,
  saveFtp,
  loadPresets,
  savePresets,
} from "./storage/localStorage.js";
import {
  openDB,
  saveSessionToDB,
  getSavedSessionFromDB,
  clearSessionFromDB,
  recHasData,
} from "./storage/indexedDb.js";
import {
  computeHrv,
  computeDfaAlpha1,
  RR_MIN_MS,
  RR_MAX_MS,
  RR_MAX_JUMP,
  RR_RESYNC_AFTER,
} from "./telemetry/hrv.js";
import { drawPowerChart } from "./telemetry/chartPlotter.js";
import { parseMrc, toPctFtp, getTargetAtTime } from "./workout/mrcParser.js";
import { drawWorkoutThumbnail } from "./workout/workoutPlayer.js";
import {
  CYCLING_POWER_SERVICE_UUID,
  WAHOO_TRAINER_CHAR_UUID,
  UNLOCK_COMMAND,
  unlockTrainer,
  setTrainerResistance,
  hexLog,
  buildResistancePacket,
} from "./bluetooth/trainer.js";

import {
  connectHeartRateStrap,
  parseHeartRate,
} from "./bluetooth/heartRate.js";

import { PEDAL_FILTERS } from "./bluetooth/pedals.js";

const $ = (id) => document.getElementById(id);

// App Constants & State
const APP_VERSION = "v14";
const POWER_MEASUREMENT_UUID = 0x2a63;
const TRAINER_FILTERS = [{ namePrefix: "KICKR" }, { namePrefix: "Wahoo" }];

let tabSessionId = null;
let tabIdPersisted = true;
try {
  tabSessionId = sessionStorage.getItem("kickrTabSessionId");
} catch (e) {
  tabIdPersisted = false;
}
if (!tabSessionId) {
  tabSessionId =
    "tab_session_" +
    Date.now() +
    "_" +
    Math.random().toString(36).substring(2, 9);
  try {
    sessionStorage.setItem("kickrTabSessionId", tabSessionId);
  } catch (e) {
    tabIdPersisted = false;
  }
}

let liveChannel = null;
try {
  liveChannel = new BroadcastChannel("kickr-live");
  liveChannel.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "ping" && m.owner === tabSessionId)
      liveChannel.postMessage({ type: "pong", owner: tabSessionId });
  };
} catch (e) {}

function isTabAlive(owner) {
  return new Promise((resolve) => {
    if (!liveChannel || !owner) return resolve(false);
    const h = (e) => {
      const m = e.data;
      if (m && m.type === "pong" && m.owner === owner) {
        liveChannel.removeEventListener("message", h);
        resolve(true);
      }
    };
    liveChannel.addEventListener("message", h);
    liveChannel.postMessage({ type: "ping", owner });
    setTimeout(() => {
      liveChannel.removeEventListener("message", h);
      resolve(false);
    }, 400);
  });
}

let restoreCheckDone = false;
let restorePromptShown = false;
let saveErrorLogged = false;

setTimeout(() => {
  if (!restorePromptShown) restoreCheckDone = true;
}, 5000);

// Global Workout State
let workout = {
  points: [],
  durationMin: 0,
  elapsedSeconds: 0,
  state: "stopped",
  timer: null,
  ftp: 236,
  units: "percent",
  mode: "resistance",
  lastTargetValue: null,
  filename: "",
};

let workoutLoopId = null;
let workoutStartTime = 0;
let lastRecordedSecond = -1;

// Global Bluetooth & Telemetry State
let bluetoothDevice = null;
let gattServer = null;
let wahooCharacteristic = null;
let powerMeasurementCharacteristic = null;
let packetCounter = 0;

let ergWriteWatts = null;
let ergWriteTimer = null;
const ErgWriteDelay = 2000;

let resistancePending = null;
let resistanceBusy = false;

let pedalsDevice = null;
let hrDevice = null;

let totalStart = null;
let intervalStart = null;
let wakeLock = null;

const newPowerSource = () => ({
  buf: [],
  last: 0,
  crank: null,
  cadence: 0,
  cadAt: 0,
  balance: null,
});
const power = { trainer: newPowerSource(), pedals: newPowerSource() };

let windowSeconds = 120;
let rrBuffer = [];
let hrBuf = [];
let lastHr = null;
let lastHrAt = 0;
let pendingRr = [];
let sessionRows = [];
let latestCad = null;
let currentTarget = { mode: "", value: "" };
let hrSum = 0;
let hrCount = 0;
let lastGoodRr = null;
let consecutiveRejects = 0;
let pendingGap = false;
let rejectedCount = 0;

const connState = {
  trainer: "disconnected",
  hr: "disconnected",
  pedals: "disconnected",
};
const connName = { trainer: null, hr: null, pedals: null };
const knownDevice = { trainer: null, hr: null, pedals: null };
const wantConnected = { trainer: false, hr: false, pedals: false };
const reconnect = {
  trainer: { timer: null, attempts: 0, busy: false, gen: 0 },
  hr: { timer: null, attempts: 0, busy: false, gen: 0 },
  pedals: { timer: null, attempts: 0, busy: false, gen: 0 },
};

const LABELS = { trainer: "Trainer", hr: "HR Strap", pedals: "Pedals" };
const BTN_BASE =
  "w-full justify-center px-4 py-2 text-white text-xs font-semibold rounded-xl flex items-center space-x-2 transition-all ";
const BTN_STYLE = {
  disconnected:
    BTN_BASE + "bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700",
  connecting: BTN_BASE + "bg-slate-700 cursor-wait",
  connected: BTN_BASE + "bg-rose-600 hover:bg-rose-500 active:bg-rose-700",
};
const DOT_STYLE = {
  disconnected: "bg-slate-600",
  connecting: "bg-amber-500 animate-pulse",
  connected: "bg-emerald-500",
};

// Logging & Modals
function logMessage(text, type = "info") {
  const terminal = $("terminalLog");
  if (!terminal) return;
  const time = new Date().toLocaleTimeString();
  const div = document.createElement("div");

  let colorClass = "text-slate-300";
  if (type === "success") colorClass = "text-emerald-400 font-medium";
  if (type === "error") colorClass = "text-rose-400 font-medium";
  if (type === "tx") colorClass = "text-indigo-400";
  if (type === "rx") colorClass = "text-amber-300";

  div.className = `${colorClass} leading-relaxed`;
  const stamp = document.createElement("span");
  stamp.className = "text-slate-600";
  stamp.textContent = `[${time}]`;
  div.appendChild(stamp);
  div.appendChild(document.createTextNode(" " + text));
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;

  while (terminal.children.length > 500)
    terminal.removeChild(terminal.firstChild);
  packetCounter++;
  if ($("packetCountLabel"))
    $("packetCountLabel").innerText = `${packetCounter} packets TX/RX`;
}

function showModal(title, message, actions = null) {
  $("modalTitle").innerText = title;
  $("modalMessage").innerText = message;
  const modalActions = $("modalActions");
  modalActions.innerHTML = "";

  if (actions && actions.length) {
    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.className = action.class;
      btn.innerText = action.label;
      btn.onclick = action.onClick;
      modalActions.appendChild(btn);
    });
  } else {
    const btn = document.createElement("button");
    btn.className =
      "px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition-all";
    btn.innerText = "Got it";
    btn.onclick = closeModal;
    modalActions.appendChild(btn);
  }
  $("notificationModal").classList.remove("hidden");
}

function closeModal() {
  $("notificationModal").classList.add("hidden");
}

function hasSessionData() {
  return (
    sessionRows.length > 0 ||
    workout.elapsedSeconds > 0 ||
    workout.points.length > 0
  );
}

function autosave() {
  if (restoreCheckDone && hasSessionData()) {
    saveSessionToDB(
      {
        sessionRows,
        totalStart,
        intervalStart,
        workout: {
          points: workout.points,
          durationMin: workout.durationMin,
          elapsedSeconds: workout.elapsedSeconds,
          state: workout.state,
          ftp: workout.ftp,
          units: workout.units,
          mode: workout.mode,
          filename: workout.filename || "",
        },
      },
      tabSessionId,
    ).catch((err) => {
      if (!saveErrorLogged) {
        saveErrorLogged = true;
        logMessage(
          `Autosave failed (${err.message}). Session recovery won't work until this is fixed.`,
          "error",
        );
      }
    });
  }
}

// Preset Config
const presetCfg = {
  erg: {
    vals: [100, 150, 200, 250, 300],
    min: 50,
    max: 500,
    step: 5,
    unit: "W",
    el: "ergPresets",
    btn: "ergEditBtn",
    apply: (v) => setErgQuick(v),
  },
  resistance: {
    vals: [20, 30, 35, 40, 50],
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    el: "resistancePresets",
    btn: "resistanceEditBtn",
    apply: (v) => setResistanceQuick(v),
  },
};
const presetEdit = { erg: false, resistance: false };

function renderPresets(key) {
  const c = presetCfg[key];
  const el = $(c.el);
  if (!el) return;
  el.innerHTML = "";
  c.vals.forEach((v, i) => {
    if (presetEdit[key]) {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = c.min;
      inp.max = c.max;
      inp.step = c.step;
      inp.value = v;
      inp.className =
        "py-2 w-full bg-slate-950 border border-indigo-500/60 rounded-xl text-xs text-center text-slate-100 font-mono focus:outline-none focus:border-indigo-400";
      inp.addEventListener("change", () => {
        const n = Math.round(parseFloat(inp.value));
        c.vals[i] = Number.isFinite(n)
          ? Math.max(c.min, Math.min(c.max, n))
          : v;
        inp.value = c.vals[i];
        savePresets(presetCfg);
      });
      el.appendChild(inp);
    } else {
      const b = document.createElement("button");
      b.textContent = v + c.unit;
      b.className =
        "py-2.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 border border-slate-700/80 rounded-xl text-xs font-semibold text-slate-200 transition-all";
      b.addEventListener("click", () => c.apply(c.vals[i]));
      el.appendChild(b);
    }
  });
  if ($(c.btn)) $(c.btn).innerText = presetEdit[key] ? "Done" : "Edit presets";
}

function togglePresetEdit(key) {
  presetEdit[key] = !presetEdit[key];
  renderPresets(key);
}

// UI Binding Setup
function setupUiEvents() {
  ["erg", "resistance", "level", "sim"].forEach((tab) => {
    $(`tab-${tab}`).addEventListener("click", () => switchTab(tab));
  });
  $("btn-save-csv-workout").addEventListener("click", downloadCsv);
  $("ergSlider").addEventListener("input", (e) =>
    updateErgSlider(e.target.value),
  );
  $("ergEditBtn").addEventListener("click", () => togglePresetEdit("erg"));
  $("resistanceSlider").addEventListener("input", (e) =>
    updateResistanceSlider(e.target.value),
  );
  $("resistanceEditBtn").addEventListener("click", () =>
    togglePresetEdit("resistance"),
  );
  $("levelSlider").addEventListener("input", (e) =>
    updateLevelSlider(e.target.value),
  );
  $("gradeSlider").addEventListener("input", (e) =>
    updateGradeSlider(e.target.value),
  );
  $("btn-send-sim").addEventListener("click", sendSimCommand);
  $("workoutFileInput").addEventListener("change", handleWorkoutFileSelect);
  $("workoutPlayBtn").addEventListener("click", toggleWorkoutPlay);
  $("btn-stop-workout").addEventListener("click", stopWorkout);
  $("ftpInput").addEventListener("change", (e) => updateFtp(e.target.value));
  $("btnModeErg").addEventListener("click", () => setWorkoutMode("erg"));
  $("btnModeRes").addEventListener("click", () => setWorkoutMode("resistance"));

  [30, 60, 120, 300].forEach((s) => {
    $(`win-${s}`).addEventListener("click", () => setWindow(s));
  });

  $("btn-reset-telemetry").addEventListener("click", resetTelemetry);
  $("btn-trainer").addEventListener("click", toggleTrainer);
  $("btn-hr").addEventListener("click", toggleHr);
  $("btn-pedals").addEventListener("click", togglePedals);
  $("btn-clear-console").addEventListener("click", clearConsole);
  $("modalDefaultBtn").addEventListener("click", closeModal);
}

function switchTab(tabName) {
  ["erg", "resistance", "level", "sim"].forEach((t) => {
    $(`panel-${t}`).classList.add("hidden");
    $(`tab-${t}`).classList.remove("border-indigo-500", "text-white");
    $(`tab-${t}`).classList.add("border-transparent", "text-slate-400");
  });
  $(`panel-${tabName}`).classList.remove("hidden");
  $(`tab-${tabName}`).classList.add("border-indigo-500", "text-white");
  $(`tab-${tabName}`).classList.remove("border-transparent", "text-slate-400");
}

// Application Initialization
async function init() {
  setupUiEvents();
  workout.ftp = loadFtp();
  $("ftpInput").value = workout.ftp;
  loadPresets(presetCfg);
  renderPresets("erg");
  renderPresets("resistance");
  setWindow(120);

  Object.keys(LABELS).forEach((k) => setDeviceState(k, "disconnected"));
  setWorkoutMode("resistance");
  refreshTelemetry();

  setInterval(autosave, 3000);
  setInterval(recordSample, 1000);
  setInterval(refreshTelemetry, 500);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") autosave();
  });
  window.addEventListener("pagehide", autosave);
  window.addEventListener("resize", () => {
    drawPowerChart("powerChart", power, hrBuf, hrCount, hrSum, Date.now());
    drawWorkoutThumbnail("workoutThumbnailCanvas", workout);
  });

  await checkUnsavedSession();
  autoConnectKnownDevices();
}

// Dynamic Helpers & Connection Logic Placeholders
function setDeviceState(key, state, name) {
  connState[key] = state;
  connName[key] = state === "connected" ? name : null;
  $(`btn-${key}`).className = BTN_STYLE[state];
  $(`dot-${key}`).className = "w-2 h-2 rounded-full " + DOT_STYLE[state];
  $(`btnText-${key}`).innerText =
    (state === "connected" ? "Disconnect " : "Connect ") + LABELS[key];
  $(`name-${key}`).classList.toggle("hidden", state === "disconnected");
  $(`name-${key}`).innerText =
    state === "connected"
      ? name
      : state === "connecting"
        ? "Connecting..."
        : "";
  const names = Object.keys(connName)
    .filter((k) => connName[k])
    .map((k) => connName[k]);
  $("deviceNameLabel").innerText = names.length ? names.join(", ") : "None";
}

function clearConsole() {
  $("terminalLog").innerHTML = "";
  packetCounter = 0;
  $("packetCountLabel").innerText = "0 packets TX/RX";
  logMessage("Terminal cleared.", "info");
}

function setWindow(seconds) {
  windowSeconds = seconds;
  [30, 60, 120, 300].forEach((s) => {
    const on = s === seconds;
    const btn = $(`win-${s}`);
    btn.classList.toggle("border-indigo-500", on);
    btn.classList.toggle("bg-indigo-600/30", on);
    btn.classList.toggle("text-white", on);
    btn.classList.toggle("border-slate-700/80", !on);
    btn.classList.toggle("bg-slate-800", !on);
  });
  updateHrvDisplay(Date.now());
}

function updateHrvDisplay(now) {
  const r = computeHrv(rrBuffer, now, windowSeconds);
  $("rrCountDisplay").innerText = r.n;
  $("rejectedDisplay").innerText = rejectedCount;
  const ids = ["rmssd", "sdnn", "meanRr", "lnRmssd"];
  if (!r.ready) {
    ids.forEach((id) => ($(`${id}Display`).innerText = "--"));
    $("dfaA1Display").innerText = "--";
    $("dfaA1Display").className =
      "text-xl font-extrabold text-indigo-400 font-mono";
    return;
  }
  $("rmssdDisplay").innerText = r.rmssd.toFixed(1);
  $("sdnnDisplay").innerText = r.sdnn.toFixed(1);
  $("meanRrDisplay").innerText = r.mean.toFixed(0);
  $("lnRmssdDisplay").innerText = Math.log(r.rmssd).toFixed(2);

  const winRr = rrBuffer
    .filter((p) => p.t >= now - windowSeconds * 1000)
    .map((p) => p.rr);
  const a1 = computeDfaAlpha1(winRr);
  if (a1 !== null && $("dfaA1Display")) {
    $("dfaA1Display").innerText = a1.toFixed(2);
    if (a1 >= 0.75) {
      $("dfaA1Display").className =
        "text-3xl font-extrabold text-emerald-400 font-mono";
    } else if (a1 >= 0.5) {
      $("dfaA1Display").className =
        "text-3xl font-extrabold text-amber-400 font-mono";
    } else {
      $("dfaA1Display").className =
        "text-3xl font-extrabold text-rose-400 font-mono";
    }
  } else if ($("dfaA1Display")) {
    $("dfaA1Display").innerText = "--";
    $("dfaA1Display").className =
      "text-3xl font-extrabold text-indigo-400 font-mono";
  }
}

function refreshTelemetry() {
  const now = Date.now();
  const t = power.trainer;
  const p = power.pedals;
  const tOn = connState.trainer === "connected";
  const pOn = connState.pedals === "connected";

  const avgW = (buf, ms) => {
    let sum = 0,
      n = 0;
    for (let i = buf.length - 1; i >= 0 && buf[i].t >= now - ms; i--) {
      sum += buf[i].w;
      n++;
    }
    return n ? sum / n : null;
  };

  const t3 = avgW(t.buf, 3000);
  const p3 = avgW(p.buf, 3000);
  const t30 = avgW(t.buf, 30000);
  const p30 = avgW(p.buf, 30000);
  const fmt = (v) => (v === null ? "--" : Math.round(v));
  const sgn = (v) => (v >= 0 ? "+" : "") + Math.round(v);

  $("trainerPowerDisplay").innerText = tOn ? fmt(t3 === null ? 0 : t3) : "--";
  $("trainerPowerSub").innerHTML = tOn
    ? `30s avg ${fmt(t30)} W`
    : "not connected";
  $("pedalPowerDisplay").innerText = pOn ? fmt(p3 === null ? 0 : p3) : "--";
  const bal =
    pOn && p.balance
      ? ` &middot; L/R ${p.balance.left.toFixed(0)}/${p.balance.right.toFixed(0)}`
      : "";
  $("pedalPowerSub").innerHTML = pOn
    ? `30s avg ${fmt(p3)} W${bal}`
    : "not connected";

  if (t3 !== null && p3 !== null) {
    $("deltaDisplay").innerText = sgn(p3 - t3);
    const pct =
      p3 >= 30 ? `${(((p3 - t3) / p3) * 100).toFixed(1)}% &middot; ` : "";
    const d30 = t30 !== null && p30 !== null ? sgn(p30 - t30) : "--";
    $("deltaSub").innerHTML = `${pct}30s avg ${d30} W`;
  } else {
    $("deltaDisplay").innerText = "--";
    $("deltaSub").innerHTML = "needs both devices";
  }

  let cad = null;
  let src = "";
  if (pOn && now - p.cadAt < 3000) {
    cad = p.cadence;
    src = "from pedals";
  } else if (tOn && now - t.cadAt < 3000) {
    cad = t.cadence;
    src = "from trainer";
  } else if (pOn || tOn) {
    cad = 0;
  }
  latestCad = cad;
  $("liveCadenceDisplay").innerText = cad === null ? "--" : Math.round(cad);
  $("cadenceSub").innerHTML = src || "&nbsp;";

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const p = (n) => String(n).padStart(2, "0");
    return (hh ? hh + ":" : "") + p(mm) + ":" + p(s % 60);
  };

  $("totalTimeDisplay").innerText = fmtClock(
    totalStart === null ? 0 : now - totalStart,
  );
  $("intervalTimeDisplay").innerText = fmtClock(
    intervalStart === null ? 0 : now - intervalStart,
  );
  drawPowerChart("powerChart", power, hrBuf, hrCount, hrSum, now);
}

function resetTelemetry() {
  power.trainer.buf = [];
  power.pedals.buf = [];
  hrBuf = [];
  hrSum = 0;
  hrCount = 0;
  totalStart = null;
  intervalStart = null;
  sessionRows = [];
  rrBuffer = [];
  lastGoodRr = null;
  consecutiveRejects = 0;
  pendingGap = false;
  rejectedCount = 0;
  updateHrvDisplay(Date.now());
  refreshTelemetry();
  clearSessionFromDB(tabSessionId);
  logMessage("Telemetry reset.", "info");
}

function recordSample() {
  if (totalStart === null) return;
  const now = Date.now();
  const currentSecond =
    workout.state === "playing"
      ? workout.elapsedSeconds
      : Math.round((now - totalStart) / 1000);

  if (currentSecond === lastRecordedSecond) return;
  lastRecordedSecond = currentSecond;

  const fresh = (p) => now - (p.lastAt || 0) < 3000;
  const hrOk = connState.hr === "connected" && now - lastHrAt < 5000;
  const r = computeHrv(rrBuffer, now, windowSeconds);

  // Compute live DFA Alpha-1 for the current window
  const winRr = rrBuffer
    .filter((p) => p.t >= now - windowSeconds * 1000)
    .map((p) => p.rr);
  const dfaA1 = computeDfaAlpha1(winRr);

  // Determine primary power metric for standard FIT 'power' column
  const pedalW =
    connState.pedals === "connected" && fresh(power.pedals)
      ? power.pedals.last
      : "";
  const trainerW =
    connState.trainer === "connected" && fresh(power.trainer)
      ? power.trainer.last
      : "";
  const primaryPower = pedalW !== "" ? pedalW : trainerW;

  sessionRows.push(
    [
      new Date(now).toISOString(),
      currentSecond,
      Math.round((now - intervalStart) / 1000),
      currentTarget.mode,
      currentTarget.value,
      primaryPower,
      trainerW,
      pedalW,
      latestCad === null ? "" : Math.round(latestCad),
      hrOk ? lastHr : "",
      pendingRr.join(" "),
      r.ready ? r.rmssd.toFixed(1) : "",
      dfaA1 !== null ? dfaA1.toFixed(3) : "",
    ].join(","),
  );

  pendingRr = [];
}

function downloadCsv() {
  if (!sessionRows.length) {
    showModal(
      "Nothing to export",
      "Recording starts when power is detected. Pedal for a moment, then save again.",
    );
    return;
  }
  const head =
    "timestamp,elapsed_time,timer_time,target_mode,target_value,power,kickr_power,pedal_power,cadence,heart_rate,rr_interval,rmssd,dfa_alpha1";
  const blob = new Blob([[head, ...sessionRows].join("\n")], {
    type: "text/csv",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kickr-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  logMessage(
    `Exported ${sessionRows.length} rows to FIT-compatible CSV.`,
    "success",
  );
}

async function checkUnsavedSession() {
  const result = await getSavedSessionFromDB(tabSessionId);
  let saved = result.saved;
  if (saved && result.source === "latest" && saved.owner !== tabSessionId) {
    if (await isTabAlive(saved.owner)) {
      saved = null;
      result.source = "in use by another open tab";
    }
  }
  logMessage(
    `Training Hub ${APP_VERSION}. Session check: ` +
      (saved
        ? `found (${(saved.sessionRows || []).length} rows, source: ${result.source})`
        : `nothing to restore (${result.source})`),
    "info",
  );

  if (saved && recHasData(saved)) {
    restorePromptShown = true;
    showModal(
      "Resume Previous Session?",
      `An unsaved session was recovered (${(saved.sessionRows || []).length} records). Would you like to resume?`,
      [
        {
          label: "Discard Session",
          class:
            "px-4 py-2 bg-slate-800 text-slate-300 font-semibold text-xs rounded-xl",
          onClick: () => {
            clearSessionFromDB(tabSessionId);
            restoreCheckDone = true;
            closeModal();
          },
        },
        {
          label: "Resume Session",
          class:
            "px-5 py-2 bg-indigo-600 text-white font-semibold text-xs rounded-xl",
          onClick: () => {
            restoreSession(saved);
            restoreCheckDone = true;
            closeModal();
          },
        },
      ],
    );
  }
}

function restoreSession(saved) {
  sessionRows = saved.sessionRows || [];
  totalStart = saved.totalStart;
  intervalStart = saved.intervalStart;
  logMessage(
    `Restored previous session (${sessionRows.length} rows loaded).`,
    "success",
  );
}

async function autoConnectKnownDevices() {
  const ids = loadDeviceIds();
  if (
    !Object.keys(ids).length ||
    !navigator.bluetooth ||
    !navigator.bluetooth.getDevices
  )
    return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    ["trainer", "pedals", "hr"].forEach((key) => {
      const d = devices.find((x) => x.id === ids[key]);
      if (d) {
        knownDevice[key] = d;
        wantConnected[key] = true;
        setDeviceState(key, "connecting");
        logMessage(
          `${LABELS[key]}: auto-reconnecting to ${d.name || "saved device"}...`,
          "info",
        );
      }
    });
  } catch (e) {}
}

function updateErgSlider(val) {
  $("ergValueDisplay").innerText = val;
  setErgMode(parseInt(val));
}
function setErgQuick(watts) {
  $("ergSlider").value = watts;
  $("ergValueDisplay").innerText = watts;
  setErgMode(watts);
}
function setErgMode(watts) {
  currentTarget = { mode: "erg_w", value: watts };
  executeErgWrite(watts);
}
async function executeErgWrite(watts) {
  if (!wahooCharacteristic) {
    logMessage(
      `[Simulated TX] ERG Mode set to ${watts}W (Trainer not connected)`,
      "info",
    );
    return;
  }
  try {
    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);
    view.setUint8(0, 0x42);
    view.setUint16(1, watts, true);
    const payload = new Uint8Array(buffer);
    await wahooCharacteristic.writeValueWithResponse(payload);
    logMessage(`TX ERG Mode (${watts}W): ${hexLog(payload)}`, "tx");
  } catch (err) {
    logMessage(`ERG Write Error: ${err.message}`, "error");
  }
}

function updateResistanceSlider(val) {
  $("resistanceValueDisplay").innerText = val;
  setResistanceMode(parseInt(val));
}
function setResistanceQuick(percent) {
  $("resistanceSlider").value = percent;
  $("resistanceValueDisplay").innerText = percent;
  setResistanceMode(percent);
}
async function setResistanceMode(percent) {
  currentTarget = { mode: "resistance_pct", value: percent };
  if (!wahooCharacteristic) {
    logMessage(
      `[Simulated TX] Resistance set to ${percent}% (Trainer not connected)`,
      "info",
    );
    return;
  }
  try {
    const { payload } = buildResistancePacket(percent);
    await wahooCharacteristic.writeValueWithResponse(payload);
    logMessage(`TX Resistance (${percent}%): ${hexLog(payload)}`, "tx");
  } catch (err) {
    logMessage(`Resistance Write Error: ${err.message}`, "error");
  }
}

function updateLevelSlider(val) {
  $("levelValueDisplay").innerText = val;
  setLevelMode(parseInt(val));
}
async function setLevelMode(level) {
  currentTarget = { mode: "level", value: level };
  if (!wahooCharacteristic) {
    logMessage(
      `[Simulated TX] Level Mode set to Level ${level} (Trainer not connected)`,
      "info",
    );
    return;
  }
  try {
    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);
    view.setUint8(0, 0x41);
    view.setUint16(1, level, true);
    const payload = new Uint8Array(buffer);
    await wahooCharacteristic.writeValueWithResponse(payload);
    logMessage(`TX Level Mode (Level ${level}): ${hexLog(payload)}`, "tx");
  } catch (err) {
    logMessage(`Level Write Error: ${err.message}`, "error");
  }
}

function updateGradeSlider(val) {
  const grade = parseFloat(val);
  $("gradeValueDisplay").innerText =
    (grade >= 0 ? "+" : "") + grade.toFixed(1) + "%";
}
async function sendSimCommand() {
  currentTarget = { mode: "sim_grade_pct", value: $("gradeSlider").value };
  logMessage(`[Simulated TX] Simulation parameters transmitted`, "info");
}

function updateWorkoutButtonStates(hasWorkout) {
  const loadLbl = $("workoutFileLabel");
  const playBtn = $("workoutPlayBtn");
  if (!loadLbl || !playBtn) return;

  if (hasWorkout) {
    loadLbl.className =
      "px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/80 text-slate-100 text-xs font-semibold rounded-lg cursor-pointer transition-all";
    playBtn.className =
      "px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition-all shadow-lg";
    playBtn.removeAttribute("disabled");
  } else {
    loadLbl.className =
      "px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 border border-indigo-500/80 text-white text-xs font-semibold rounded-lg cursor-pointer transition-all shadow-lg";
    playBtn.className =
      "px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-semibold rounded-lg transition-all cursor-not-allowed";
    playBtn.setAttribute("disabled", "true");
  }
}

function handleWorkoutFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const parsed = parseMrc(e.target.result);
    workout.points = parsed.points;
    workout.units = parsed.units;
    workout.durationMin = workout.points.length
      ? workout.points[workout.points.length - 1].timeMin
      : 0;
    workout.filename = file.name;
    $("workoutTitleDisplay").innerText =
      `${file.name} (${workout.points.length} pts)`;
    drawWorkoutThumbnail("workoutThumbnailCanvas", workout);

    // Highlight Play Workout & enable it
    updateWorkoutButtonStates(true);

    logMessage(`Loaded workout: ${file.name}`, "success");
  };
  reader.readAsText(file);
}

function stopWorkout() {
  workout.state = "stopped";
  workout.elapsedSeconds = 0;
  $("workoutPlayBtn").innerText = "Play Workout";
  drawWorkoutThumbnail("workoutThumbnailCanvas", workout);

  // Reset focus back to Load File
  updateWorkoutButtonStates(false);
}

function toggleWorkoutPlay() {
  if (!workout.points.length) {
    showModal(
      "No Workout Loaded",
      "Please load an .mrc or .erg workout file first.",
    );
    return;
  }
  if (workout.state === "playing") {
    pauseWorkout();
  } else {
    startWorkout();
  }
}

function startWorkout() {
  if (workout.state === "playing") return;

  const now = performance.now();
  if (workout.state === "stopped") {
    workout.elapsedSeconds = 0;
    workoutStartTime = now;
    if (totalStart === null) {
      totalStart = Date.now();
      intervalStart = totalStart;
    }
    lastRecordedSecond = -1;
  } else if (workout.state === "paused") {
    workoutStartTime = now - workout.elapsedSeconds * 1000;
  }

  workout.state = "playing";
  workout.lastTargetValue = null;

  $("workoutPlayBtn").innerText = "Pause Workout";
  $("workoutPlayBtn").className =
    "px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs rounded-xl transition-all shadow-lg";

  switchTab(workout.mode);

  function workoutTick() {
    if (workout.state !== "playing") return;

    const currentElapsedMs = performance.now() - workoutStartTime;
    const currentElapsedSec = Math.floor(currentElapsedMs / 1000);

    if (currentElapsedSec > workout.elapsedSeconds) {
      workout.elapsedSeconds = currentElapsedSec;

      if (workout.elapsedSeconds >= workout.durationMin * 60) {
        stopWorkout();
        logMessage("Workout completed!", "success");
        showModal(
          "Workout Complete",
          "Great job! The workout session has finished.",
        );
        return;
      }
      updateWorkoutTick();
    }
  }

  if (workoutLoopId) clearInterval(workoutLoopId);
  workoutLoopId = setInterval(workoutTick, 250);

  updateWorkoutTick();
  logMessage("Workout playback started.", "info");
}

function pauseWorkout() {
  if (workout.state !== "playing") return;
  workout.state = "paused";
  if (workoutLoopId) {
    clearInterval(workoutLoopId);
    workoutLoopId = null;
  }
  $("workoutPlayBtn").innerText = "Resume Workout";
  $("workoutPlayBtn").className =
    "px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition-all shadow-lg";
  logMessage("Workout paused.", "info");
}

function updateWorkoutTick() {
  const currentMin = workout.elapsedSeconds / 60;
  const rawValue = toPctFtp(
    getTargetAtTime(workout.points, currentMin),
    workout.units,
    workout.ftp,
  );
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const p = (n) => String(n).padStart(2, "0");
    return (hh ? hh + ":" : "") + p(mm) + ":" + p(s % 60);
  };

  if (workout.mode === "erg") {
    const targetWatts = Math.round(workout.ftp * (rawValue / 100));
    $("workoutCurrentTime").innerText = fmtClock(workout.elapsedSeconds * 1000);
    $("workoutTargetWatts").innerText = `${targetWatts} W`;
    $("workoutTargetPct").innerText = `${Math.round(rawValue)}% FTP`;

    if (
      workout.state === "playing" &&
      workout.lastTargetValue !== targetWatts
    ) {
      workout.lastTargetValue = targetWatts;
      setErgQuick(targetWatts);
    }
  } else {
    const targetPct = Math.max(0, Math.min(100, Math.round(rawValue)));
    $("workoutCurrentTime").innerText = fmtClock(workout.elapsedSeconds * 1000);
    $("workoutTargetWatts").innerText = `${targetPct}%`;
    $("workoutTargetPct").innerText = `${targetPct}% Res`;

    if (workout.state === "playing" && workout.lastTargetValue !== targetPct) {
      workout.lastTargetValue = targetPct;
      setResistanceQuick(targetPct);
    }
  }

  drawWorkoutThumbnail("workoutThumbnailCanvas", workout);
}

function updateFtp(val) {
  workout.ftp = parseInt(val) || 236;
  saveFtp(workout.ftp);
  drawWorkoutThumbnail("workoutThumbnailCanvas", workout);
}

function setWorkoutMode(newMode) {
  workout.mode = newMode;
  const isErg = newMode === "erg";

  $("btnModeErg").className = isErg
    ? "px-2.5 py-1 bg-indigo-600 text-white text-xs font-semibold rounded-lg transition-all"
    : "px-2.5 py-1 bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg transition-all";
  $("btnModeRes").className = !isErg
    ? "px-2.5 py-1 bg-indigo-600 text-white text-xs font-semibold rounded-lg transition-all"
    : "px-2.5 py-1 bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg transition-all";

  $("workoutModeDisplay").innerText = isErg ? "ERG (% FTP)" : "Resistance (%)";
  switchTab(isErg ? "erg" : "resistance");

  workout.lastTargetValue = null;
}

async function toggleTrainer() {
  if (connState.trainer === "connected") {
    // Disconnect logic
    try {
      if (gattServer && gattServer.connected) {
        gattServer.disconnect();
      }
    } catch (e) {}

    wahooCharacteristic = null;
    gattServer = null;
    bluetoothDevice = null;
    setDeviceState("trainer", "disconnected");
    wantConnected.trainer = false;
    logMessage("Disconnected from Wahoo KICKR.", "info");
    return;
  }

  setDeviceState("trainer", "connecting");
  wantConnected.trainer = true;

  try {
    logMessage("Requesting Wahoo KICKR via Web Bluetooth...", "info");

    // 1. Prompt user for device matching filters
    const device = await navigator.bluetooth.requestDevice({
      filters: TRAINER_FILTERS,
      optionalServices: [CYCLING_POWER_SERVICE_UUID, "fitness_machine"],
    });

    bluetoothDevice = device;
    saveDeviceId("trainer", device.id);

    device.addEventListener("gattserverdisconnected", () => {
      logMessage("Wahoo KICKR disconnected unexpectedly.", "error");
      wahooCharacteristic = null;
      gattServer = null;
      setDeviceState("trainer", "disconnected");

      // Attempt auto-reconnect if desired
    });

    logMessage(
      `Connecting to GATT server on ${device.name || "Trainer"}...`,
      "info",
    );
    gattServer = await device.gatt.connect();

    // 2. Discover Cycling Power / Fitness Machine service & characteristic
    const service = await gattServer.getPrimaryService(
      CYCLING_POWER_SERVICE_UUID,
    );
    wahooCharacteristic = await service.getCharacteristic(
      WAHOO_TRAINER_CHAR_UUID,
    );

    // 3. Unlock proprietary Wahoo opcodes
    logMessage("Unlocking Wahoo KICKR control channel...", "info");
    await unlockTrainer(wahooCharacteristic);

    // 4. Subscribe to power measurements if available
    try {
      powerMeasurementCharacteristic = await service.getCharacteristic(
        POWER_MEASUREMENT_UUID,
      );
      await powerMeasurementCharacteristic.startNotifications();
      powerMeasurementCharacteristic.addEventListener(
        "characteristicvaluechanged",
        handlePowerMeasurement,
      );
      logMessage(
        "Subscribed to live power telemetry notifications.",
        "success",
      );
    } catch (err) {
      logMessage(
        `Could not subscribe to power characteristic: ${err.message}`,
        "warning",
      );
    }

    setDeviceState("trainer", "connected", device.name || "KICKR Trainer");
    logMessage(
      `Successfully connected and initialized ${device.name || "KICKR"}!`,
      "success",
    );
  } catch (error) {
    setDeviceState("trainer", "disconnected");
    if (error.name === "NotFoundError") {
      logMessage("Device selection was cancelled by the user.", "warning");
    } else {
      logMessage(`Trainer connection error: ${error.message}`, "error");
    }
  }
}

// Live BLE power packet parser callback
function handlePowerMeasurement(event) {
  const value = event.target.value;
  const now = Date.now();

  // Standard Cycling Power Measurement Characteristic parser (0x2A63)
  const flags = value.getUint16(0, true);
  let offset = 2;
  const instantPower = value.getInt16(offset, true);
  offset += 2;

  power.trainer.buf.push({ t: now, w: instantPower });
  power.trainer.last = instantPower;
  power.trainer.lastAt = now;

  // Trim buffer older than 60s
  while (power.trainer.buf.length && power.trainer.buf[0].t < now - 60000) {
    power.trainer.buf.shift();
  }
}

let hrCharacteristic = null;
async function toggleHr() {
  if (connState.hr === "connected") {
    try {
      if (hrDevice && hrDevice.gatt.connected) {
        hrDevice.gatt.disconnect();
      }
    } catch (e) {}

    hrCharacteristic = null;
    hrDevice = null;
    setDeviceState("hr", "disconnected");
    wantConnected.hr = false;

    // Clear UI display on disconnect
    if ($("liveHrDisplay")) $("liveHrDisplay").innerText = "--";
    if ($("liveRrDisplay")) $("liveRrDisplay").innerText = "--";
    if ($("heartRateSub")) $("heartRateSub").innerText = "not connected";
    if ($("batteryHr")) $("batteryHr").innerText = "Battery: --";

    logMessage("Disconnected from Heart Rate strap.", "info");
    return;
  }

  setDeviceState("hr", "connecting");
  wantConnected.hr = true;

  const result = await connectHeartRateStrap(logMessage);

  if (result) {
    hrDevice = result.device;
    hrCharacteristic = result.hrChar;

    hrDevice.addEventListener("gattserverdisconnected", () => {
      logMessage("Heart Rate strap disconnected unexpectedly.", "error");
      hrCharacteristic = null;
      setDeviceState("hr", "disconnected");
      if ($("liveHrDisplay")) $("liveHrDisplay").innerText = "--";
      if ($("liveRrDisplay")) $("liveRrDisplay").innerText = "--";
      if ($("heartRateSub")) $("heartRateSub").innerText = "disconnected";
    });

    hrCharacteristic.addEventListener("characteristicvaluechanged", (event) => {
      const data = parseHeartRate(event.target.value);
      const now = Date.now();
      lastHr = data.hr;
      lastHrAt = now;

      // 1. Update UI display elements
      if ($("liveHrDisplay")) {
        $("liveHrDisplay").innerText = data.hr;
      }
      if (data.rrIntervals.length > 0 && $("liveRrDisplay")) {
        $("liveRrDisplay").innerText =
          data.rrIntervals[data.rrIntervals.length - 1];
      }

      // 2. Push HR data points into hrBuf for the chart plotter
      hrBuf.push({ t: now, hr: data.hr });

      // Keep hrBuf trimmed to the last 5 minutes (matching SPAN in chartPlotter)
      while (hrBuf.length && hrBuf[0].t < now - 300000) {
        hrBuf.shift();
      }

      // 3. Track running sum for ride average calculations
      hrSum += data.hr;
      hrCount++;

      // 4. Push RR intervals into your HRV buffer
      data.rrIntervals.forEach((rr) => {
        rrBuffer.push({ t: now, rr });
      });

      // 5. Refresh statistical display metrics
      updateHrvDisplay(now);
    });

    // Explicitly update device state to trigger the connected button style and name label
    setDeviceState("hr", "connected", hrDevice.name || "Polar H10");

    if (result.batteryLevel !== null && $("batteryHr")) {
      $("batteryHr").innerText = `Battery: ${result.batteryLevel}%`;
    }

    logMessage(
      `Connected to ${hrDevice.name || "Polar H10"} successfully!`,
      "success",
    );
  } else {
    setDeviceState("hr", "disconnected");
    if ($("heartRateSub")) $("heartRateSub").innerText = "connection failed";
  }
}
function togglePedals() {
  logMessage(
    "Pedals connect clicked (requires Web Bluetooth user prompt).",
    "info",
  );
}

document.addEventListener("DOMContentLoaded", init);
