// trainer.js — Wahoo control commands, modes, sliders, and presets
import {
  $,
  MODES,
  MODE_NAMES,
  SIM_WIND_COEFFICIENT,
  clamp,
  control,
  devices,
  formatGrade,
  presets,
  ride,
  sliders,
  store,
  workout,
} from "./state.js";
import { countPacket, log } from "./ui.js";

const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];

export const commands = {
  erg: (watts) => [0x42, ...u16(Math.round(watts))],
  resistance: (percent) => [
    0x40,
    ...u16(Math.round((1 - percent / 100) * 16383)),
  ],
  level: (level) => [0x41, level & 0xff],
  simMode: (weightKg, crr, windCoefficient) => [
    0x43,
    ...u16(Math.round(weightKg * 100)),
    ...u16(Math.round(crr * 1000)),
    ...u16(Math.round(windCoefficient * 1000)),
  ],
  simGrade: (gradePercent) => [
    0x46,
    ...u16(Math.round(((clamp(gradePercent / 100, -1, 1) + 1) * 65535) / 2)),
  ],
};

let writeChain = Promise.resolve();

export function writeControlBytes(bytes) {
  const characteristic = devices.trainer.control;
  const data = Uint8Array.from(bytes);
  const run = () =>
    characteristic.properties.write ||
    !characteristic.properties.writeWithoutResponse
      ? characteristic.writeValueWithResponse(data)
      : characteristic.writeValueWithoutResponse(data);
  const result = writeChain.then(run);
  writeChain = result.catch(() => {});
  return result;
}

export function showControlStatus(text, tone) {
  const status = $("controlStatus");
  if (!status) return;
  status.textContent = text;
  status.className = "control-status control-status--" + tone;
}

export function setSendStatus(text, tone) {
  control.sendStatus = { text, tone };
  showControlStatus(text, tone);
}

export function sendTrainerCommand(bytes, summary) {
  const trainer = devices.trainer;
  if (trainer.state !== "connected") {
    setSendStatus(
      "Trainer not connected. " + summary + " will be sent when it connects.",
      "idle",
    );
    return false;
  }
  if (!trainer.demo && !trainer.control) {
    setSendStatus(
      "This trainer does not expose the Wahoo control characteristic, so it cannot be controlled from here.",
      "warn",
    );
    return false;
  }
  countPacket();
  log(
    "TX " +
      summary +
      " [" +
      bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ") +
      "]",
    "data",
  );
  if (trainer.demo) {
    setSendStatus("Demo trainer: " + summary, "ok");
    return true;
  }
  writeControlBytes(bytes).then(
    () => setSendStatus("On trainer: " + summary, "ok"),
    (err) => {
      log("Write failed: " + err.message, "error");
      setSendStatus(
        "The trainer did not accept " + summary + ". See the Bluetooth log.",
        "warn",
      );
    },
  );
  return true;
}

export function formatTargetValue(kind, value) {
  if (kind === "erg") return value + " W";
  if (kind === "resistance") return value + " %";
  if (kind === "sim") return formatGrade(value);
  return String(value);
}

export function targetSummary() {
  return (
    MODE_NAMES[ride.target.kind] +
    " " +
    formatTargetValue(ride.target.kind, ride.target.value)
  );
}

export function setTarget(kind, value, source = "manual") {
  ride.target = { kind, value };
  ride.targetSource = source;
  const fromWorkout = source === "workout";
  const labels = {
    erg: fromWorkout ? "Workout target" : "ERG target",
    resistance: fromWorkout ? "Workout resistance" : "Resistance",
    level: "Level",
    sim: "Sim grade",
  };
  $("targetModeLabel").textContent = labels[kind];
  $("targetDisplay").textContent = formatTargetValue(kind, value);
  renderModeTabs();
}

export function renderModeTabs() {
  MODES.forEach((mode) => {
    const tab = $("tab-" + mode);
    if (!tab) return;
    const selected = mode === control.viewMode;
    tab.classList.toggle("mode-tab-button--active", selected);
    tab.classList.toggle(
      "mode-tab-button--on-trainer",
      ride.targetSource === "manual" && mode === control.activeMode,
    );
    tab.setAttribute("aria-pressed", String(selected));
    $("panel-" + mode).classList.toggle("is-hidden", !selected);
  });
}

export function selectModeTab(mode) {
  control.viewMode = mode;
  renderModeTabs();
  if (ride.targetSource === "manual" && mode === control.activeMode) {
    showControlStatus(control.sendStatus.text, control.sendStatus.tone);
  } else {
    const how =
      mode === "sim"
        ? "press Transmit Sim Parameters"
        : "change a value on this tab";
    showControlStatus(
      "Target stays " + targetSummary() + " until you " + how + ".",
      "idle",
    );
  }
}

export function sendActiveTarget() {
  const mode = control.activeMode;
  if (mode === "sim") {
    const { weight, crr, grade } = control.sim;
    setTarget("sim", grade);
    if (
      sendTrainerCommand(
        commands.simMode(weight, crr, SIM_WIND_COEFFICIENT),
        "Sim " + weight + " kg, Crr " + crr,
      )
    ) {
      sendTrainerCommand(
        commands.simGrade(grade),
        "Sim grade " + formatGrade(grade),
      );
    }
    return;
  }
  const value = Number(sliders[mode].slider.value);
  setTarget(mode, value);
  sendTrainerCommand(commands[mode](value), targetSummary());
}

export function commitManualTarget(mode, onPauseWorkout) {
  if (workout.playing && onPauseWorkout) {
    onPauseWorkout(
      "Manual change: workout paused. Press Resume Workout to hand control back.",
    );
  }
  control.activeMode = mode;
  setTarget(mode, Number(sliders[mode].slider.value));
  clearTimeout(control.sendTimer);
  control.sendTimer = setTimeout(() => {
    ride.intervalSeconds = 0;
    sendActiveTarget();
  }, 200);
}

export function renderSlider(key) {
  const { slider, display } = sliders[key];
  if (!slider || !display) return;
  const value = Number(slider.value);
  const min = Number(slider.min);
  const max = Number(slider.max);
  display.textContent = key === "grade" ? formatGrade(value) : String(value);
  slider.style.setProperty(
    "--slider-fill",
    ((value - min) / (max - min)) * 100 + "%",
  );
  if (presets[key]) markActivePreset(key);
}

export function renderPresets(key) {
  const preset = presets[key];
  const slider = sliders[key].slider;
  const grid = $(key + "Presets");
  if (!grid || !slider) return;
  grid.replaceChildren();
  preset.values.forEach((value, index) => {
    if (preset.editing) {
      const wrapper = document.createElement("div");
      wrapper.className = "preset-input-wrapper";

      const input = document.createElement("input");
      input.type = "number";
      input.className = "preset-input";
      input.value = value;
      input.min = slider.min;
      input.max = slider.max;
      input.step = slider.step;
      input.inputMode = "numeric";
      input.setAttribute(
        "aria-label",
        "Preset " + (index + 1) + " in " + preset.suffix,
      );
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") togglePresetEditing(key);
      });

      const stepper = document.createElement("div");
      stepper.className = "preset-stepper";

      const btnUp = document.createElement("button");
      btnUp.type = "button";
      btnUp.tabIndex = -1;
      btnUp.innerHTML = "&#9650;";
      btnUp.addEventListener("click", () => {
        input.stepUp();
        input.dispatchEvent(new Event("input"));
      });

      const btnDown = document.createElement("button");
      btnDown.type = "button";
      btnDown.tabIndex = -1;
      btnDown.innerHTML = "&#9660;";
      btnDown.addEventListener("click", () => {
        input.stepDown();
        input.dispatchEvent(new Event("input"));
      });

      stepper.appendChild(btnUp);
      stepper.appendChild(btnDown);

      wrapper.appendChild(input);
      wrapper.appendChild(stepper);
      grid.appendChild(wrapper);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preset-button";
      button.textContent = value + preset.suffix;
      button.addEventListener("click", () => {
        slider.value = value;
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      grid.appendChild(button);
    }
  });
  markActivePreset(key);
}

export function markActivePreset(key) {
  const preset = presets[key];
  if (preset.editing) return;
  const current = Number(sliders[key].slider.value);
  Array.from($(key + "Presets").children).forEach((button, index) => {
    button.classList.toggle(
      "preset-button--active",
      preset.values[index] === current,
    );
  });
}
export function togglePresetEditing(key) {
  const preset = presets[key];
  const slider = sliders[key].slider;

  if (preset.editing) {
    const step = Number(slider.step) || 1;

    const inputs = $(key + "Presets").querySelectorAll("input");
    preset.values = Array.from(inputs).map((input, index) => {
      const entered = Number(input.value);
      if (input.value === "" || !Number.isFinite(entered))
        return preset.values[index];
      return clamp(
        Math.round(entered / step) * step,
        Number(slider.min),
        Number(slider.max),
      );
    });

    store.set("presets." + key, preset.values);
    log("Presets saved for " + key + ": " + preset.values.join(", "), "info");
  }

  preset.editing = !preset.editing;
  const editButton = $(key + "EditBtn");
  editButton.textContent = preset.editing ? "Save presets" : "Edit presets";
  editButton.classList.toggle("button--primary", preset.editing);
  editButton.classList.toggle("button--ghost", !preset.editing);

  renderPresets(key);

  // Make sure we focus an input if it exists after rendering
  if (preset.editing) {
    const firstInput = $(key + "Presets").querySelector("input");
    if (firstInput) firstInput.focus();
  }
}
