/**
 * main.js — application entry point and event wiring.
 *
 * This file contains no feature logic of its own. It does three things:
 *   1. Wires DOM events (buttons, sliders, inputs, keyboard) to functions
 *      imported from the feature modules.
 *   2. Restores saved settings and does the first render on page load.
 *   3. Starts the 1 Hz tick loop that advances the ride and redraws the UI.
 *
 * Where to make changes (see ARCHITECTURE.md for the full map):
 *   - Trainer commands, targets, presets ........ trainer.js
 *   - Workout playback and files ................ workout.js
 *   - Bluetooth devices, live readouts .......... bluetooth.js
 *   - NP / TSS / W'bal ......................... metrics.js
 *   - HRV and DFA a1 ........................... hrv.js
 *   - Keyboard shortcuts ........................ shortcuts.js
 *   - Intervals.icu upload ...................... intervals.js
 *   - Cockpit tile helpers (bars, gauges) ....... cockpit.js
 *   - Shared state objects and constants ........ state.js
 */

// ============================================================
// IMPORTS
// ============================================================
import {
  $,
  FTP_RANGE,
  WPRIME_RANGE,
  HRV_WINDOWS,
  MODES,
  clamp,
  control,
  devices,
  presets,
  ride,
  sliders,
  store,
  telemetry,
  workout,
} from "./state.js";
import { initShortcuts } from "./shortcuts.js";
import { withBusy, hideModal, log, showModal } from "./ui/ui.js";
import { renderHrv } from "./hrv.js";
import { drawPowerChart } from "./charts.js";
import {
  commitManualTarget,
  renderPresets,
  renderSlider,
  selectModeTab,
  sendActiveTarget,
  setSendStatus,
  setTarget,
  showControlStatus,
  targetSummary,
  togglePresetEditing,
} from "./trainer.js";
import {
  advanceWorkout,
  loadWorkoutFile,
  pauseWorkout,
  playWorkout,
  renderWorkout,
  saveWorkoutCsv,
  setWorkoutMode,
  stopWorkout,
  skipToNextInterval,
} from "./workout.js";
import {
  connectDevice,
  generateDemoData,
  keepScreenAwake,
  recordHistorySample,
  renderDevice,
  renderLive,
  startDemo,
} from "./bluetooth.js";
import {
  configuredWPrime,
  renderPowerMetrics,
  resetPowerMetrics,
} from "./metrics.js";
import {
  loadIntervalsCredentials,
  saveIntervalsCredentials,
  uploadToIntervalsIcu,
} from "./intervals.js";

// ============================================================
// SMALL HELPERS
// ============================================================

/**
 * Sets the HRV analysis window and updates the window toggle buttons.
 * The window length controls how many seconds of RR intervals feed the
 * HRV metrics and DFA a1.
 * @param {number} seconds - One of HRV_WINDOWS.
 */
function setHrvWindow(seconds) {
  telemetry.hrvWindow = seconds;
  HRV_WINDOWS.forEach((option) => {
    const button = $("win-" + option);
    if (!button) return;
    button.classList.toggle("toggle-button--active", option === seconds);
    button.setAttribute("aria-pressed", String(option === seconds));
  });
  renderHrv(Date.now());
}

/**
 * Clears all ride data: timers, history, the full ride log (used for the
 * upload and CSV), RR/HRV state, and NP/TSS/W'bal. Does not touch the
 * workout or the trainer target.
 */
function resetRideData() {
  ride.seconds = 0;
  ride.intervalSeconds = 0;
  ride.startedAt = null;
  telemetry.history = [];
  telemetry.fullRideLog = [];
  telemetry.beats = [];
  telemetry.rejected = [];
  telemetry.lastGoodRr = null;
  telemetry.gapPending = false;
  telemetry.rejectStreak = 0;
  resetPowerMetrics();
  $("liveRrDisplay").textContent = "--";
  renderLive();
  log("Ride timers, power trend, NP/TSS/W'bal and HRV data reset.", "info");
}

// ============================================================
// EVENT WIRING: DEVICES
// ============================================================
$("btn-trainer").addEventListener("click", () => connectDevice("trainer"));
$("btn-hr").addEventListener("click", () => connectDevice("hr"));
$("btn-pedals").addEventListener("click", () => connectDevice("pedals"));
$("btn-demo").addEventListener("click", startDemo);

// ============================================================
// REUSABLE STEPPER CONTROL WIRING
// ============================================================

/**
 * Wires a number input with optional +/- buttons: clamps to the input's
 * min/max, restores a fallback on invalid text, and calls onCommit only
 * when the value actually changes.
 *
 * Commits happen on change, blur, Enter, and +/- clicks. The `last` guard
 * stops Enter followed by blur from committing the same value twice.
 *
 * @param {object}   options
 * @param {string}   options.inputId     - id of the number input.
 * @param {string}   options.incBtnId    - id of the "+" button (optional in DOM).
 * @param {string}   options.decBtnId    - id of the "-" button (optional in DOM).
 * @param {Function} options.getFallback - returns the value to restore on bad input.
 * @param {Function} options.onCommit    - called with the clamped number.
 */
function setupStepperInput({
  inputId,
  incBtnId,
  decBtnId,
  getFallback,
  onCommit,
}) {
  const input = $(inputId);
  const incBtn = $(incBtnId);
  const decBtn = $(decBtnId);

  if (!input) return;

  input.addEventListener("change", () => commit(input.value));

  // Reads the current value and limits from the input element each time,
  // so changes to min/max/step attributes are picked up automatically.
  const getBounds = () => ({
    val: parseInt(input.value, 10) || getFallback(),
    min: parseInt(input.min, 10) || 0,
    max: parseInt(input.max, 10) || Infinity,
    step: parseInt(input.step, 10) || 1,
  });

  let last = null; // last value passed to onCommit

  const commit = (rawVal) => {
    const { min, max } = getBounds();
    const parsed = parseInt(rawVal, 10);

    if (isNaN(parsed)) {
      input.value = getFallback();
      return;
    }

    const clamped = Math.max(min, Math.min(max, parsed));
    input.value = clamped;
    if (clamped === last) return; // nothing changed, skip (stops the Enter + blur double commit)
    last = clamped;
    onCommit(clamped);
  };
  if (incBtn) {
    incBtn.addEventListener("click", () => {
      const { val, max, step } = getBounds();
      commit(Math.min(max, val + step));
    });
  }

  if (decBtn) {
    decBtn.addEventListener("click", () => {
      const { val, min, step } = getBounds();
      commit(Math.max(min, val - step));
    });
  }

  input.addEventListener("blur", () => commit(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit(input.value);
      input.blur();
    }
  });
}

// ============================================================
// EVENT WIRING: RIDER SETTINGS (FTP, W')
// ============================================================

/**
 * Applies a new FTP: stores it, forces the workout to re-send %FTP-based
 * ERG targets, and redraws the workout and chart.
 * @param {number} n - FTP in watts.
 */
function applyFtp(n) {
  workout.ftp = n;
  store.set("ftp", n);
  workout.lastSent = ""; // forces ERG to re-send %FTP targets
  renderWorkout();
  drawPowerChart();
}

/**
 * Applies a new W' (anaerobic work capacity, in joules). W'bal is only
 * re-seeded before the ride has started, so changing W' mid-ride does not
 * reset the live balance.
 * @param {number} n - W' in joules.
 */
function applyWPrime(n) {
  workout.wPrime = n;
  store.set("wPrime", n);
  if (telemetry.npSampleCount === 0) {
    // only re-seed before the ride has started
    telemetry.wPrimeBalance = n;
    renderPowerMetrics();
  }
}

setupStepperInput({
  inputId: "ftpInput",
  incBtnId: "ftpIncBtn",
  decBtnId: "ftpDecBtn",
  getFallback: () => workout.ftp || 250,
  onCommit: applyFtp,
});

setupStepperInput({
  inputId: "wPrimeInput",
  incBtnId: "wPrimeIncBtn",
  decBtnId: "wPrimeDecBtn",
  getFallback: () => workout.wPrime || 19000,
  onCommit: applyWPrime,
});

// ============================================================
// EVENT WIRING: TRAINER CONTROL (mode tabs, sliders, presets, sim)
// ============================================================

// Mode tabs (ERG / resistance / level / sim): switch the visible panel only.
// They do not change what the trainer is doing until a value is committed.
MODES.forEach((mode) =>
  $("tab-" + mode).addEventListener("click", () => selectModeTab(mode)),
);

// Sliders: any slider move redraws its readout. Grade (sim) only shows a
// hint and waits for "Transmit Sim Parameters". All other sliders commit
// a manual target, which pauses any playing workout.
Object.keys(sliders).forEach((key) => {
  const slider = sliders[key].slider;
  if (!slider) return;
  slider.addEventListener("input", () => {
    renderSlider(key);
    if (key === "grade")
      showControlStatus(
        "Sim values changed. Press Transmit Sim Parameters to apply them.",
        "idle",
      );
    else commitManualTarget(key, pauseWorkout);
  });
});

// +/- step buttons next to sliders. Markup contract:
//   data-step-for="<slider id>"  data-step="<signed number>"
// Clicking sets the slider within its range and fires its "input" event,
// so the handler above does the rest.
document.querySelectorAll("[data-step-for]").forEach((button) => {
  button.addEventListener("click", () => {
    const slider = $(button.dataset.stepFor);
    if (!slider) return;
    slider.value = clamp(
      Number(slider.value) + Number(button.dataset.step),
      Number(slider.min),
      Number(slider.max),
    );
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
});

// "Edit presets" / "Save presets" buttons, one per preset group.
Object.keys(presets).forEach((key) => {
  const editBtn = $(key + "EditBtn");
  if (editBtn)
    editBtn.addEventListener("click", () => togglePresetEditing(key));
});

// Editing sim weight or Crr only shows a hint; nothing is sent until the
// transmit button is pressed.
["simWeightInput", "simCrrInput"].forEach((id) => {
  const el = $(id);
  if (el) {
    el.addEventListener("input", () =>
      showControlStatus(
        "Sim values changed. Press Transmit Sim Parameters to apply them.",
        "idle",
      ),
    );
  }
});

// Transmit sim parameters: validate, pause any workout, store the sim
// settings, make sim the active mode, restart the interval timer, send.
$("btn-send-sim").addEventListener("click", () => {
  const weight = Number($("simWeightInput").value);
  const crr = Number($("simCrrInput").value);
  if (!(weight >= 30 && weight <= 150) || !(crr >= 0.001 && crr <= 0.02)) {
    showModal(
      "Check sim parameters",
      "Weight must be between 30 and 150 kg, and rolling resistance between 0.001 and 0.02.",
    );
    return;
  }
  if (workout.playing)
    pauseWorkout(
      "Sim transmit: workout paused. Press Resume Workout to hand control back.",
    );
  clearTimeout(control.sendTimer);
  control.sim = {
    weight,
    crr,
    grade: Number(sliders.grade.slider.value),
  };
  control.activeMode = "sim";
  ride.intervalSeconds = 0;
  sendActiveTarget();
});

// ============================================================
// EVENT WIRING: WORKOUT
// ============================================================

// Load a workout file. The input is cleared afterwards so choosing the
// same file again still fires "change".
$("workoutFileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) {
    loadWorkoutFile(file);
    drawPowerChart();
  }
  event.target.value = "";
});
$("workoutPlayBtn").addEventListener("click", () =>
  workout.playing ? pauseWorkout() : playWorkout(),
);
$("btn-stop-workout").addEventListener("click", () => {
  stopWorkout();
  log("Workout stopped and rewound.", "info");
});
$("btnNextInterval").addEventListener("click", skipToNextInterval);

// ============================================================
// EVENT WIRING: EXPORT AND INTERVALS.ICU
// ============================================================

// withBusy disables the button and shows "Uploading..." immediately, so
// the click gives instant feedback while the file is built and sent.
const uploadBtn = $("btn-upload-intervals");
uploadBtn.addEventListener("click", () =>
  withBusy(uploadBtn, "Uploading...", uploadToIntervalsIcu),
);
$("btn-save-csv-workout").addEventListener("click", saveWorkoutCsv);
$("btn-save-intervals").addEventListener("click", saveIntervalsCredentials);
// NOTE: this second upload button calls the uploader directly, without
// withBusy, so it gives no busy feedback and allows double clicks.
$("btn-sync-intervals-now").addEventListener("click", uploadToIntervalsIcu);

// Workout display mode (ERG watts vs resistance %).
$("btnModeErg").addEventListener("click", () => setWorkoutMode("erg"));
$("btnModeRes").addEventListener("click", () => setWorkoutMode("res"));

// ============================================================
// EVENT WIRING: HRV, DIAGNOSTICS, MODAL, WINDOW
// ============================================================

// One toggle button per HRV window length.
HRV_WINDOWS.forEach((seconds) => {
  const winBtn = $("win-" + seconds);
  if (winBtn) winBtn.addEventListener("click", () => setHrvWindow(seconds));
});

// Reset asks for confirmation first; the modal's action button runs the reset.
$("btn-reset-telemetry").addEventListener("click", () => {
  showModal(
    "Reset ride data?",
    "This clears the ride timers, NP/TSS/W'bal, the power trend and the collected RR intervals.",
    { label: "Reset", run: resetRideData },
  );
});

$("btn-clear-console").addEventListener("click", () => {
  $("terminalLog").replaceChildren();
  log("Console cleared.");
});
// Scroll the log to the newest line whenever the diagnostics panel opens or closes.
$("diagnosticsPanel").addEventListener("toggle", () => {
  const output = $("terminalLog");
  if (output) output.scrollTop = output.scrollHeight;
});

// Modal: the default button, clicking the backdrop, and Escape all close it.
$("modalDefaultBtn").addEventListener("click", hideModal);
$("notificationModal").addEventListener("click", (event) => {
  if (event.target === $("notificationModal")) hideModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideModal();
});

// Re-acquire the screen wake lock when the tab becomes visible again.
document.addEventListener("visibilitychange", keepScreenAwake);

// Canvas charts size themselves from their displayed size, so redraw on resize.
window.addEventListener("resize", () => {
  drawPowerChart();
  // drawWorkoutChart(currentFtp());
});

// ============================================================
// INITIAL RENDER & TICK LOOP
// ============================================================

// Apply the allowed ranges to the FTP and W' inputs.
$("ftpInput").min = FTP_RANGE.min;
$("ftpInput").max = FTP_RANGE.max;
$("wPrimeInput").min = WPRIME_RANGE.min;
$("wPrimeInput").max = WPRIME_RANGE.max;

/**
 * Loads a numeric setting from the store, falling back to an older
 * localStorage key, then to the range's fallback value. A value is only
 * accepted if it is a finite number inside the range.
 * @param {string} name      - Key in the store.
 * @param {string} legacyKey - Old localStorage key to try if the store has nothing valid.
 * @param {{min:number,max:number,fallback:number}} range
 * @returns {number}
 */
function loadSetting(name, legacyKey, range) {
  const valid = (n) => Number.isFinite(n) && n >= range.min && n <= range.max;
  let n = Number(store.get(name, null));
  if (!valid(n)) {
    try {
      n = parseInt(localStorage.getItem(legacyKey), 10);
    } catch {
      n = NaN;
    }
  }
  return valid(n) ? n : range.fallback;
}

// Restore saved rider settings. Writing them back to the store migrates
// values that came from the legacy localStorage keys.
workout.ftp = loadSetting("ftp", "user_ftp", FTP_RANGE);
workout.wPrime = loadSetting("wPrime", "user_wprime", WPRIME_RANGE);
store.set("ftp", workout.ftp);
store.set("wPrime", workout.wPrime);
$("ftpInput").value = workout.ftp;
$("wPrimeInput").value = workout.wPrime;
telemetry.wPrimeBalance = configuredWPrime();

loadIntervalsCredentials();

// First render of every control and readout.
Object.keys(sliders).forEach(renderSlider);
Object.keys(presets).forEach(renderPresets);
Object.keys(devices).forEach(renderDevice);

setHrvWindow(telemetry.hrvWindow);
setWorkoutMode("erg", true);
setTarget("erg", Number(sliders.erg.slider.value));
setSendStatus(
  "Trainer not connected. " +
    targetSummary() +
    " will be sent when it connects.",
  "idle",
);
renderLive();
renderWorkout();

if (!navigator.bluetooth) {
  log(
    "Web Bluetooth is not available in this browser. Demo data can be used instead.",
    "warning",
  );
}

let lastTickAt = Date.now();

/**
 * The 1 Hz heartbeat. Order matters:
 *   1. Work out real elapsed time since the last tick (clamped to 0-90 s,
 *      so a backgrounded tab can't cause a huge jump).
 *   2. If any device is connected, advance the ride clock and interval
 *      clock. (Both only run while something is connected.)
 *   3. Advance the workout (may change the target and reset the interval clock).
 *   4. Generate demo data, if demo mode is on.
 *   5. Record a history sample (feeds the chart and the upload/CSV log).
 *   6. Render all live readouts.
 * Errors are caught so one bad tick can't stop the loop.
 */
function tick() {
  try {
    const now = Date.now();
    const elapsedSeconds = clamp((now - lastTickAt) / 1000, 0, 90);
    lastTickAt = now;
    if (Object.values(devices).some((d) => d.state === "connected")) {
      ride.seconds += elapsedSeconds;
      ride.intervalSeconds += elapsedSeconds;
    }
    advanceWorkout(elapsedSeconds);
    generateDemoData(now);
    recordHistorySample(now, elapsedSeconds);
    renderLive(now);
  } catch (err) {
    console.error("tick failed", err);
  }
}

// Start keyboard shortcuts once, then start the loop.
initShortcuts();
setInterval(tick, 1000);
