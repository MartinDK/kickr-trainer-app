// shortcuts.js — keyboard bindings for trainer presets.
// Edit KEY_ROWS and MODE_CONFIG to change behaviour; no other file needs to change.
import { control } from "./state.js";
import { adjustPreset, selectPreset } from "./trainer.js";

// Physical key positions (event.code), so the 5x3 grid works on any keyboard layout.
// Column N in each row acts on preset N.
const KEY_ROWS = {
  up: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"],
  select: ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT"],
  down: ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG"],
};

// Keyed by the visible mode tab. Modes not listed here have no shortcuts.
const MODE_CONFIG = {
  resistance: { presetKey: "resistance", step: 1 },
  erg: { presetKey: "erg", step: 5 },
};

const BINDINGS = new Map();
for (const [action, codes] of Object.entries(KEY_ROWS)) {
  codes.forEach((code, index) => BINDINGS.set(code, { action, index }));
}

const TEXT_ENTRY =
  'textarea, select, [contenteditable="true"], ' +
  'input:not([type="range"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])';

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof Element && event.target.matches(TEXT_ENTRY))
    return;

  const binding = BINDINGS.get(event.code);
  const config = MODE_CONFIG[control.viewMode];
  if (!binding || !config) return;

  event.preventDefault();
  const { presetKey, step } = config;
  if (binding.action === "select") {
    if (!event.repeat) selectPreset(presetKey, binding.index);
  } else {
    adjustPreset(
      presetKey,
      binding.index,
      binding.action === "up" ? step : -step,
    );
  }
}

export function initShortcuts() {
  document.addEventListener("keydown", onKeyDown);
}
