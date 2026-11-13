// workout.js — .mrc/.erg file parsing, playback engine, audio cues, and CSV export
import {
  $,
  clamp,
  control,
  formatTime,
  ride,
  telemetry,
  workout,
} from "./state.js";
import { commands, sendTrainerCommand, setTarget } from "./trainer.js";
import { log, showModal } from "./ui.js";
import { currentFtp } from "./metrics.js";
import {
  playCountdownBeep,
  playIntervalChangeChime,
  playWorkoutCompleteChime,
} from "./audio.js";
import { drawPowerChart } from "./charts.js";

export function parseWorkoutFile(text, fileName) {
  const points = [];
  let unit = null;
  let inData = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("[")) {
      inData = upper.startsWith("[COURSE DATA]");
      continue;
    }
    if (inData) {
      const [minutes, value] = line.split(/[\s,;]+/).map(Number);
      if (
        Number.isFinite(minutes) &&
        Number.isFinite(value) &&
        minutes >= 0 &&
        value >= 0
      )
        points.push({ t: minutes * 60, v: value });
    } else if (/^MINUTES\s+PERCENT/.test(upper)) {
      unit = "percent";
    } else if (/^MINUTES\s+WATTS/.test(upper)) {
      unit = "watts";
    }
  }
  points.sort((a, b) => a.t - b.t);
  const duration = points.length ? points[points.length - 1].t : 0;
  if (points.length < 2 || duration <= 0) {
    throw new Error(
      'No usable [COURSE DATA] block was found. Each data line needs minutes and a target value, for example "5.00 80".',
    );
  }
  return {
    points,
    duration,
    unit: unit || (/\.erg$/i.test(fileName) ? "watts" : "percent"),
  };
}

export function workoutValueAt(time) {
  const points = workout.points;
  for (let i = 1; i < points.length; i++) {
    if (time < points[i].t) {
      const from = points[i - 1];
      const to = points[i];
      const ratio = clamp((time - from.t) / (to.t - from.t), 0, 1);
      return {
        value: from.v + (to.v - from.v) * ratio,
        segment: i,
        segmentEnd: to.t,
        nextValue: i + 1 < points.length ? points[i + 1].v : to.v,
      };
    }
  }
  const last = points[points.length - 1];
  return {
    value: last.v,
    segment: points.length,
    segmentEnd: workout.duration,
    nextValue: last.v,
  };
}

export function workoutTargetAt(time) {
  const ftp = currentFtp();
  const { value, segment, segmentEnd, nextValue } = workoutValueAt(time);
  const percent = workout.unit === "percent" ? value : (value / ftp) * 100;
  const watts = workout.unit === "percent" ? (value / 100) * ftp : value;
  return {
    segment,
    segmentEnd,
    percent,
    watts: Math.round(watts),
    resistance: clamp(Math.round(percent), 0, 100),
    isNextStepUp: nextValue >= value,
  };
}

export function applyWorkoutTarget() {
  if (!workout.points.length) return;
  const target = workoutTargetAt(workout.elapsed);
  const isErg = workout.mode === "erg";
  const value = isErg ? target.watts : target.resistance;
  setTarget(isErg ? "erg" : "resistance", value, "workout");
  const key = workout.mode + ":" + value;
  if (key === workout.lastSent) return;
  workout.lastSent = key;
  if (isErg)
    sendTrainerCommand(commands.erg(value), "Workout ERG " + value + " W");
  else
    sendTrainerCommand(
      commands.resistance(value),
      "Workout resistance " + value + " %",
    );
}

export function renderWorkout() {
  $("workoutCurrentTime").textContent = formatTime(workout.elapsed);
  $("workoutTotalTime").textContent = formatTime(workout.duration);
  if (workout.points.length) {
    const target = workoutTargetAt(workout.elapsed);
    $("workoutTargetWatts").textContent =
      workout.mode === "erg"
        ? target.watts + " W (" + Math.round(target.percent) + "%)"
        : target.resistance + " %";
  } else {
    $("workoutTargetWatts").textContent = "-- W";
  }
  drawPowerChart(currentFtp());
}

export function setWorkoutMode(mode, silent) {
  workout.mode = mode;
  workout.lastSent = "";
  $("btnModeErg").classList.toggle("toggle-button--active", mode === "erg");
  $("btnModeRes").classList.toggle("toggle-button--active", mode === "res");
  $("btnModeErg").setAttribute("aria-pressed", String(mode === "erg"));
  $("btnModeRes").setAttribute("aria-pressed", String(mode === "res"));
  $("workoutModeDisplay").textContent =
    mode === "erg" ? "(% FTP)" : "(0% - 100%)";
  if (!silent)
    log("Workout mode: " + $("workoutModeDisplay").textContent, "info");
  if (workout.playing) applyWorkoutTarget();
  renderWorkout();
}

export function playWorkout() {
  if (!workout.points.length) return;
  if (workout.elapsed >= workout.duration) workout.elapsed = 0;
  clearTimeout(control.sendTimer);
  workout.playing = true;
  workout.lastSent = "";
  workout.lastCountdownSec = -1;
  workout.segment = workoutValueAt(workout.elapsed).segment;
  ride.intervalSeconds = 0;
  $("workoutPlayBtn").textContent = "Pause Workout";
  playIntervalChangeChime(true);
  log(
    "Workout running from " +
      formatTime(workout.elapsed) +
      " (" +
      (workout.mode === "erg" ? "ERG" : "resistance") +
      " mode).",
    "success",
  );
  applyWorkoutTarget();
  renderWorkout();
}

export function pauseWorkout(reason) {
  workout.playing = false;
  $("workoutPlayBtn").textContent = "Resume Workout";
  log(
    reason || "Workout paused at " + formatTime(workout.elapsed) + ".",
    "warning",
  );
}

export function stopWorkout() {
  workout.playing = false;
  workout.elapsed = 0;
  workout.segment = -1;
  workout.lastCountdownSec = -1;
  $("workoutPlayBtn").textContent = "Play Workout";
  renderWorkout();
}

export function advanceWorkout(elapsedSeconds) {
  if (!workout.playing) return;
  const prevInfo = workoutValueAt(workout.elapsed);
  workout.elapsed = Math.min(
    workout.duration,
    workout.elapsed + elapsedSeconds,
  );
  const currInfo = workoutValueAt(workout.elapsed);

  // 3-2-1 countdown audio cue before segment boundary
  const secondsRemaining = Math.ceil(currInfo.segmentEnd - workout.elapsed);
  if (
    secondsRemaining >= 1 &&
    secondsRemaining <= 3 &&
    secondsRemaining !== workout.lastCountdownSec &&
    workout.elapsed < workout.duration
  ) {
    workout.lastCountdownSec = secondsRemaining;
    playCountdownBeep();
  }

  if (currInfo.segment !== workout.segment) {
    workout.segment = currInfo.segment;
    workout.lastCountdownSec = -1;
    ride.intervalSeconds = 0;
    if (workout.elapsed < workout.duration) {
      playIntervalChangeChime(currInfo.value >= prevInfo.value);
    }
  }

  applyWorkoutTarget();
  if (workout.elapsed >= workout.duration) {
    workout.playing = false;
    $("workoutPlayBtn").textContent = "Play Workout";
    playWorkoutCompleteChime();
    log("Workout complete. The trainer stays on the last target.", "success");
  }
  renderWorkout();
}

export async function loadWorkoutFile(file) {
  try {
    const parsed = parseWorkoutFile(await file.text(), file.name);
    Object.assign(workout, parsed, {
      name: file.name,
      elapsed: 0,
      playing: false,
      segment: -1,
      lastSent: "",
      lastCountdownSec: -1,
    });
    $("workoutTitleDisplay").textContent =
      file.name +
      " · " +
      formatTime(parsed.duration) +
      " · " +
      (parsed.unit === "percent" ? "% FTP" : "watts");
    const playButton = $("workoutPlayBtn");
    playButton.disabled = false;
    playButton.textContent = "Play Workout";
    playButton.classList.replace("button--secondary", "button--primary");
    $("workoutFileLabel").classList.replace(
      "button--primary",
      "button--secondary",
    );
    log(
      "Loaded workout " +
        file.name +
        ": " +
        parsed.points.length +
        " points, " +
        formatTime(parsed.duration) +
        ", values in " +
        (parsed.unit === "percent" ? "% FTP" : "watts") +
        ".",
      "success",
    );
  } catch (err) {
    log("Could not read " + file.name + ": " + err.message, "error");
    showModal("Could not read workout", err.message);
  }
  renderWorkout();
}

export function saveWorkoutCsv() {
  if (!telemetry.fullRideLog.length) {
    showModal(
      "Nothing to save yet",
      "Connect a device or start demo data to record ride telemetry before saving CSV.",
    );
    return;
  }
  const header =
    "elapsed_seconds,formatted_time,pedal_power_w,trainer_power_w,target_power_w,normalized_power_w,tss,w_prime_bal_j,heart_rate_bpm,dfa_a1";
  const rows = telemetry.fullRideLog.map((row) =>
    [
      row.elapsedSeconds,
      row.formattedTime,
      row.pedals ?? "",
      row.trainer ?? "",
      row.target ?? "",
      row.np ?? "",
      row.tss !== null ? row.tss.toFixed(1) : "",
      row.wPrimeBal !== null ? Math.round(row.wPrimeBal) : "",
      row.hr ?? "",
      row.dfaA1 !== null ? row.dfaA1.toFixed(2) : "",
    ].join(","),
  );
  const blob = new Blob([header + "\n" + rows.join("\n") + "\n"], {
    type: "text/csv",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = workout.name
    ? workout.name.replace(/\.[^.]+$/, "") + "_ride"
    : "training_hub_ride_" + new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = baseName + ".csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  log(
    "Ride telemetry exported as CSV (" +
      telemetry.fullRideLog.length +
      " rows).",
    "success",
  );
}
