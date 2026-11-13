// main.js — Application entry point, event wiring, and 1-second tick loop
import {
  $,
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
import { hideModal, log, showModal } from "./ui.js";
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
  parseWorkoutFile,
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
  currentFtp,
  renderPowerMetrics,
  resetPowerMetrics,
} from "./metrics.js";
import {
  loadIntervalsCredentials,
  saveIntervalsCredentials,
  uploadToIntervalsIcu,
} from "./intervals.js";

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
// EVENT WIRING
// ============================================================
$("btn-trainer").addEventListener("click", () => connectDevice("trainer"));
$("btn-hr").addEventListener("click", () => connectDevice("hr"));
$("btn-pedals").addEventListener("click", () => connectDevice("pedals"));
$("btn-demo").addEventListener("click", startDemo);

MODES.forEach((mode) =>
  $("tab-" + mode).addEventListener("click", () => selectModeTab(mode)),
);

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

Object.keys(presets).forEach((key) => {
  const editBtn = $(key + "EditBtn");
  if (editBtn)
    editBtn.addEventListener("click", () => togglePresetEditing(key));
});

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

$("workoutFileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) {
    loadWorkoutFile(file);
    drawPowerChart(); // <-- Add this line right here
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
$("btn-save-csv-workout").addEventListener("click", saveWorkoutCsv);
$("btn-upload-intervals").addEventListener("click", uploadToIntervalsIcu);
$("btn-save-intervals").addEventListener("click", saveIntervalsCredentials);
$("btn-sync-intervals-now").addEventListener("click", uploadToIntervalsIcu);

$("btnModeErg").addEventListener("click", () => setWorkoutMode("erg"));
$("btnModeRes").addEventListener("click", () => setWorkoutMode("res"));

$("ftpInput").addEventListener("input", () => {
  const entered = Number($("ftpInput").value);
  if (entered >= 50 && entered <= 600) store.set("ftp", entered);
  workout.lastSent = "";
  renderWorkout();
});

$("wPrimeInput").addEventListener("input", () => {
  const entered = Number($("wPrimeInput").value);
  if (entered >= 5000 && entered <= 50000) {
    store.set("wPrime", entered);
    if (telemetry.npSampleCount === 0) {
      telemetry.wPrimeBalance = entered;
      renderPowerMetrics();
    }
  }
});

HRV_WINDOWS.forEach((seconds) => {
  const winBtn = $("win-" + seconds);
  if (winBtn) winBtn.addEventListener("click", () => setHrvWindow(seconds));
});
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
$("diagnosticsPanel").addEventListener("toggle", () => {
  const output = $("terminalLog");
  if (output) output.scrollTop = output.scrollHeight;
});

$("modalDefaultBtn").addEventListener("click", hideModal);
$("notificationModal").addEventListener("click", (event) => {
  if (event.target === $("notificationModal")) hideModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideModal();
});
document.addEventListener("visibilitychange", keepScreenAwake);
window.addEventListener("resize", () => {
  drawPowerChart();
  drawWorkoutChart(currentFtp());
});

// ============================================================
// INITIAL RENDER & TICK LOOP
// ============================================================
const savedFtp = store.get("ftp", null);
if (typeof savedFtp === "number" && savedFtp >= 50 && savedFtp <= 600)
  $("ftpInput").value = savedFtp;

const savedWPrime = store.get("wPrime", null);
if (
  typeof savedWPrime === "number" &&
  savedWPrime >= 5000 &&
  savedWPrime <= 50000
)
  $("wPrimeInput").value = savedWPrime;

telemetry.wPrimeBalance = configuredWPrime();
loadIntervalsCredentials();

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
function tick() {
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
}

setInterval(tick, 1000);
