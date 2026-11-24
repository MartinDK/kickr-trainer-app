// Helpers for the new cockpit elements. Your existing code can keep setting
// pedalPowerDisplay, trainerPowerDisplay, topHrDisplay etc. exactly as before.

import { $, clamp, formatTime } from "../state.js";

// Interval: shows REMAINING time and a progress bar of how much has elapsed.
// Pass null for totalSeconds in an unstructured ride to fall back to a lap timer.
function updateInterval(elapsedSeconds, totalSeconds, label) {
  if (totalSeconds == null) {
    $("intervalLabel").textContent = "Lap time";
    $("intervalTimeDisplay").textContent = formatTime(elapsedSeconds);
    $("intervalProgressFill").style.width = "0%";
    $("intervalSub").textContent = "no interval";
    $("intervalSub").classList.add("metric-note");
    return;
  }
  const remaining = Math.max(0, totalSeconds - elapsedSeconds);
  $("intervalLabel").textContent = label ?? "Interval remaining";
  $("intervalTimeDisplay").textContent = formatTime(Math.ceil(remaining));
  $("intervalProgressFill").style.width =
    `${clamp(elapsedSeconds / totalSeconds, 0, 1) * 100}%`;
  $("intervalSubNote").textContent = `of `;
  $("intervalSub").textContent = `${formatTime(totalSeconds)}`;
  $("intervalSub").classList.add("metric-value");
}

// Target deviation bar: full scale is +/- 20% of target (change SPAN to taste).
function updateTargetDeviation(actualW, targetW) {
  const SPAN = 0.2;
  const fill = $("targetBarFill");
  const label = $("targetDeviation");
  if (actualW == null || !targetW) {
    fill.style.width = "0%";
    label.textContent = "-- vs target";
    return;
  }
  const diff = Math.round(actualW - targetW);
  const dev = clamp(diff / (targetW * SPAN), -1, 1);
  const half = Math.abs(dev) * 50;
  fill.style.left = `${dev < 0 ? 50 - half : 50}%`;
  fill.style.width = `${half}%`;
  label.textContent = `${diff > 0 ? "+" : ""}${diff} W`;
}

// DFA a1 gauge: scale 0.25 -> 1.25, so AnT 0.50 = 25% and AeT 0.75 = 50%.
function updateDfa(value) {
  const marker = $("dfaMarker");
  const zone = $("dfaZone");
  const note = $("dfaZoneNote");
  if (value == null || Number.isNaN(value)) {
    marker.classList.add("is-hidden");
    $("dfaA1Display").textContent = "--";
    zone.textContent = "--";
    note.textContent = "no data";
    return;
  }
  marker.classList.remove("is-hidden");
  marker.style.left = `${clamp((value - 0.25) / 1.5, 0.02, 0.98) * 100}%`;
  $("dfaA1Display").textContent = value.toFixed(2);

  if (value > 0.75) {
    zone.textContent = "Easy";
    note.textContent = "below AeT";
  } else if (value >= 0.5) {
    zone.textContent = "Moderate";
    note.textContent = "AeT to AnT";
  } else {
    zone.textContent = "Hard";
    note.textContent = "past AnT";
  }
}

// Close the info panel when clicking elsewhere
document.addEventListener("click", (e) => {
  document.querySelectorAll(".dfa-info[open]").forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});
// W'bal bar: turns orange below 25%.
function updateWPrimeBal(balKj, maxKj) {
  $("wPrimeBalDisplay").textContent = balKj.toFixed(1);
  $("wPrimeMaxDisplay").textContent = maxKj.toFixed(1);
  const frac = clamp(balKj / maxKj, 0, 1);
  $("wPrimeBalFill").style.width = `${frac * 100}%`;
  document
    .querySelector(".progress-bar--wbal")
    .classList.toggle("is-low", frac < 0.25);
}

export {
  formatTime,
  updateInterval,
  updateTargetDeviation,
  updateDfa,
  updateWPrimeBal,
};
