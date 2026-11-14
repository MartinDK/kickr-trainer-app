// audio.js — Synthesized Web Audio API cues (zero external sound files needed)
import { $ } from "./state.js";

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function isAudioEnabled() {
  const toggle = $("audioCuesToggle");
  return toggle ? toggle.checked : true;
}

function playTone(freq, durationSec, type = "sine", gainPeak = 0.18, delaySec = 0) {
  if (!isAudioEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime + delaySec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + durationSec + 0.02);
}

// Crisp short tick for 3, 2, 1 seconds before a workout step change
export function playCountdownBeep() {
  playTone(660, 0.11, "sine", 0.15, 0);
}

// Rising two-tone chime when stepping UP in power, falling chime when stepping DOWN
export function playIntervalChangeChime(isStepUp = true) {
  if (isStepUp) {
    playTone(523.25, 0.14, "triangle", 0.22, 0);     // C5
    playTone(783.99, 0.24, "triangle", 0.24, 0.12);  // G5
  } else {
    playTone(659.25, 0.14, "triangle", 0.2, 0);      // E5
    playTone(440.0, 0.24, "triangle", 0.2, 0.12);    // A4
  }
}

// Three-note fanfare on workout completion
export function playWorkoutCompleteChime() {
  playTone(523.25, 0.14, "triangle", 0.22, 0);     // C5
  playTone(659.25, 0.14, "triangle", 0.22, 0.13);  // E5
  playTone(1046.5, 0.35, "triangle", 0.25, 0.26);  // C6
}
