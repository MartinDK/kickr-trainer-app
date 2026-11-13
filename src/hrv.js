// hrv.js — HRV time-domain metrics and DFA alpha-1 calculation
import { $, average, telemetry } from "./state.js";

export function dfaAlpha1(intervals) {
  const count = intervals.length;
  if (count < 64) return null;
  const mean = average(intervals);
  const profile = new Array(count);
  let running = 0;
  for (let i = 0; i < count; i++) {
    running += intervals[i] - mean;
    profile[i] = running;
  }
  const logSizes = [];
  const logFluctuations = [];
  for (let size = 4; size <= 16; size++) {
    const boxes = Math.floor(count / size);
    let squaredResiduals = 0;
    for (let box = 0; box < boxes; box++) {
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumXX = 0;
      for (let k = 0; k < size; k++) {
        const y = profile[box * size + k];
        sumX += k;
        sumY += y;
        sumXY += k * y;
        sumXX += k * k;
      }
      const slope =
        (size * sumXY - sumX * sumY) / (size * sumXX - sumX * sumX);
      const intercept = (sumY - slope * sumX) / size;
      for (let k = 0; k < size; k++) {
        const residual = profile[box * size + k] - (intercept + slope * k);
        squaredResiduals += residual * residual;
      }
    }
    const fluctuation = Math.sqrt(squaredResiduals / (boxes * size));
    if (fluctuation > 0) {
      logSizes.push(Math.log(size));
      logFluctuations.push(Math.log(fluctuation));
    }
  }
  if (logSizes.length < 3) return null;
  const meanX = average(logSizes);
  const meanY = average(logFluctuations);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < logSizes.length; i++) {
    numerator += (logSizes[i] - meanX) * (logFluctuations[i] - meanY);
    denominator += (logSizes[i] - meanX) ** 2;
  }
  return numerator / denominator;
}

export function currentDfaAlpha1(now = Date.now()) {
  const cutoff = now - telemetry.hrvWindow * 1000;
  const intervals = telemetry.beats
    .filter((beat) => beat.t >= cutoff)
    .map((beat) => beat.rr);
  return dfaAlpha1(intervals);
}

export function renderHrv(now) {
  const horizon = now - 300000;
  telemetry.beats = telemetry.beats.filter((beat) => beat.t >= horizon);
  telemetry.rejected = telemetry.rejected.filter((t) => t >= horizon);
  const cutoff = now - telemetry.hrvWindow * 1000;
  const beats = telemetry.beats.filter((beat) => beat.t >= cutoff);
  const intervals = beats.map((beat) => beat.rr);

  let meanRr = null;
  let sdnn = null;
  let rmssd = null;
  if (intervals.length >= 2) {
    meanRr = average(intervals);
    sdnn = Math.sqrt(
      intervals.reduce((sum, rr) => sum + (rr - meanRr) ** 2, 0) /
        (intervals.length - 1),
    );
    const squaredDifferences = [];
    for (let i = 1; i < beats.length; i++) {
      if (!beats[i].afterGap)
        squaredDifferences.push((beats[i].rr - beats[i - 1].rr) ** 2);
    }
    if (squaredDifferences.length)
      rmssd = Math.sqrt(average(squaredDifferences));
  }
  const alpha1 = dfaAlpha1(intervals);

  $("rrCountDisplay").textContent = beats.length;
  $("rejectedDisplay").textContent = telemetry.rejected.filter(
    (t) => t >= cutoff,
  ).length;
  $("meanRrDisplay").textContent =
    meanRr === null ? "--" : Math.round(meanRr);
  $("sdnnDisplay").textContent = sdnn === null ? "--" : sdnn.toFixed(1);
  $("rmssdDisplay").textContent = rmssd === null ? "--" : rmssd.toFixed(1);
  $("lnRmssdDisplay").textContent =
    rmssd > 0 ? Math.log(rmssd).toFixed(2) : "--";
  $("dfaA1Display").textContent = alpha1 === null ? "--" : alpha1.toFixed(2);
}
