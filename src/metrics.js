// metrics.js — Real-time Normalized Power (NP), TSS, and W' Balance (Skiba model)
import { $, average, clamp, ride, telemetry, workout } from "./state.js";
import { updateWPrimeBal } from "./ui/cockpit.js";

export function currentFtp() {
  return workout.ftp;
}

export function configuredWPrime() {
  return workout.wPrime;
}

export function resetPowerMetrics() {
  telemetry.rolling30sPower = [];
  telemetry.npFourthPowerSum = 0;
  telemetry.npSampleCount = 0;
  telemetry.normalizedPower = null;
  telemetry.tss = 0;
  telemetry.wPrimeBalance = configuredWPrime();
}

/**
 * Updates NP, TSS, and W'bal once per second using primary power source
 * (Assioma pedals preferred when connected, falling back to KICKR trainer).
 */
export function updatePowerMetrics(watts, elapsedSeconds = 1) {
  const ftp = currentFtp();
  const wPrimeMax = configuredWPrime();

  // Keep W'bal initialised properly before first sample
  if (telemetry.npSampleCount === 0 && telemetry.wPrimeBalance > wPrimeMax) {
    telemetry.wPrimeBalance = wPrimeMax;
  }

  if (watts === null || !Number.isFinite(watts)) return;

  // 1. Normalized Power (30-second rolling average ^ 4)
  telemetry.rolling30sPower.push(watts);
  if (telemetry.rolling30sPower.length > 30) {
    telemetry.rolling30sPower.shift();
  }
  const avg30 = average(telemetry.rolling30sPower);
  telemetry.npFourthPowerSum += avg30 ** 4;
  telemetry.npSampleCount += 1;
  telemetry.normalizedPower = Math.pow(
    telemetry.npFourthPowerSum / telemetry.npSampleCount,
    0.25,
  );

  // 2. Training Stress Score (TSS)
  // TSS = (sec * NP * IF) / (FTP * 3600) * 100, where IF = NP / FTP
  if (ftp > 0 && ride.seconds > 0) {
    const intensityFactor = telemetry.normalizedPower / ftp;
    telemetry.tss =
      ((ride.seconds * telemetry.normalizedPower * intensityFactor) /
        (ftp * 3600)) *
      100;
  }

  // 3. W' Balance (Skiba 2015 differential / exponential recovery model)
  // Above FTP: linear depletion (P - FTP) * dt
  // Below FTP: exponential recovery toward W'_max with tau_W' = 546 * e^(-0.01 * D_CP) + 316
  if (watts > ftp) {
    telemetry.wPrimeBalance = Math.max(
      0,
      telemetry.wPrimeBalance - (watts - ftp) * elapsedSeconds,
    );
  } else {
    const dCp = ftp - watts;
    const tau = 546 * Math.exp(-0.01 * dCp) + 316;
    const recovery =
      (wPrimeMax - telemetry.wPrimeBalance) *
      (1 - Math.exp(-elapsedSeconds / tau));
    telemetry.wPrimeBalance = clamp(
      telemetry.wPrimeBalance + recovery,
      0,
      wPrimeMax,
    );
  }
}
export function renderPowerMetrics() {
  const tssEl = $("tssDisplay");
  const npEl = $("npDisplay");

  if (tssEl) tssEl.textContent = telemetry.tss.toFixed(1);
  if (npEl) {
    npEl.textContent =
      telemetry.normalizedPower !== null
        ? Math.round(telemetry.normalizedPower)
        : "--";
  }

  const wMax = configuredWPrime();
  const bal = clamp(telemetry.wPrimeBalance, 0, wMax);
  updateWPrimeBal(bal / 1000, wMax / 1000);
}
