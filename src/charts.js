/**
 * charts.js — canvas drawing for the Live Telemetry chart.
 *
 * Exports one function, drawPowerChart(), which redraws the whole chart from
 * scratch each call (called from renderLive every tick, and on window resize
 * and after workout/FTP changes).
 *
 * What the chart shows:
 *   - Left axis (W):   Kickr power, pedal power, and the ERG/workout target.
 *   - Right axis (bpm): heart rate, plus a dashed average-HR reference line.
 *   - Optional workout profile drawn behind the live lines, with a playhead.
 *
 * Two time modes:
 *   - No workout loaded: a rolling window of the last HISTORY_SECONDS
 *     (labelled "-5 min" to "now"). The newest sample sits at the right edge.
 *   - Workout loaded: the x-axis spans the whole workout, so the live lines
 *     fill in from left to right as you ride. Past the end of the workout,
 *     the window scrolls and keeps the same width.
 *
 * Where to make changes:
 *   - Text size and typeface ...... CANVAS_FONT in state.js (one place)
 *   - Margins around the plot ..... padLeft / padRight / padTop / padBottom
 *   - Line colours and dashes ..... the drawSeries(...) calls near the bottom
 *   - Axis ranges and rounding .... topPower / topHr
 *   - Number of grid lines ........ the two `for (let i = 0; i <= 4; ...)` loops
 *
 * Data it reads (all from state.js):
 *   telemetry.history   rolling per-second samples (last HISTORY_SECONDS), used
 *                       when no workout is loaded:
 *                       { trainer, pedals, target, hr } (null = no reading)
 *   telemetry.fullRideLog  every sample of the ride, used when a workout is
 *                       loaded. Needs elapsedSeconds, trainer, pedals, target, hr.
 *   workout.points      array of { t, v }: time in seconds and target watts
 *   workout.duration    total workout length in seconds
 *   workout.elapsed     current playback position in seconds
 */
import {
  $,
  CANVAS_FONT,
  HISTORY_SECONDS,
  activeWorkoutMessage,
  average,
  clamp,
  formatTime,
  telemetry,
  workout,
} from "./state.js";

/**
 * Sizes a canvas to its displayed size (times the device pixel ratio, so
 * text and lines stay sharp on high-DPI screens), resets the drawing
 * transform, and clears it. After this call, all drawing coordinates are in
 * CSS pixels, so a 12px font is 12 real CSS pixels.
 *
 * @param {HTMLCanvasElement|null} canvas
 * @returns {{ctx: CanvasRenderingContext2D, width: number, height: number}|null}
 *          null if the canvas is missing or currently has no size (hidden).
 */
function prepareCanvas(canvas) {
  if (!canvas) return null;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/**
 * Draws a message banner (for example a workout text cue) on a dark pill so
 * it stays readable over the chart lines. Text is squeezed to fit maxWidth.
 */
function drawBanner(ctx, text, centerX, y, maxWidth) {
  ctx.font = CANVAS_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = Math.min(ctx.measureText(text).width + 24, maxWidth);
  ctx.fillStyle = "rgba(13, 20, 36, 0.85)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(centerX - w / 2, y - 14, w, 28, 8);
  else ctx.rect(centerX - w / 2, y - 14, w, 28);
  ctx.fill();
  ctx.fillStyle = "#e8edf7";
  ctx.fillText(text, centerX, y, w - 24);
}

/**
 * Redraws the live telemetry chart. Safe to call at any time: it returns
 * quietly if the canvas is missing or hidden.
 */
export function drawPowerChart() {
  const surface = prepareCanvas($("powerChart"));
  if (!surface) return;
  const { ctx, width, height } = surface;
  const hasWorkout =
    workout.points && workout.points.length > 0 && workout.duration > 0;

  // Which samples to plot.
  //   Workout loaded: the full ride log, so the live lines cover the whole
  //                   workout. telemetry.history is capped at HISTORY_SECONDS
  //                   and would only fill the last five minutes.
  //   No workout:     the rolling five-minute history.
  const history = hasWorkout ? telemetry.fullRideLog : telemetry.history;

  // fullRideLog rows can hold undefined for missing readings, history uses null.
  const isReading = (value) => value !== null && value !== undefined;

  // Workout points are in % FTP for .mrc files and watts for .erg files.
  // The chart's power axis is in watts, so convert before plotting.
  const toWatts = (v) =>
    workout.unit === "percent" ? (v * workout.ftp) / 100 : v;

  // Resistance mode: the workout profile is a percentage, so it is drawn on
  // its own percent scale instead of the watts axis.
  const pctMode = hasWorkout && workout.mode === "res";
  const toPct = (v) =>
    workout.unit === "percent" ? v : (v / workout.ftp) * 100;

  // Collect every power and HR reading so the axes can be scaled to fit.
  const powerValues = history
    .flatMap((sample) =>
      pctMode
        ? [sample.trainer, sample.pedals]
        : [sample.trainer, sample.pedals, sample.target],
    )
    .filter(isReading);
  const hrValues = history
    .map((sample) => sample.hr)
    .filter(isReading);

  // ----------------------------------------------------------
  // Layout: space reserved around the plot for axis labels.
  // padRight must be wide enough for the longest HR label (for
  // example "160bpm") at the current CANVAS_FONT size, or the
  // label is clipped at the canvas edge.
  // ----------------------------------------------------------
  const padLeft = 45;
  const padRight = 60;
  const padTop = 10;
  const padBottom = 20;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // ----------------------------------------------------------
  // Axis ranges.
  // Each axis runs from a fixed minimum up to a top value, split into four
  // equal steps (five grid lines). The top is the highest reading (or
  // workout target) plus 10%, with a floor, rounded up so the step size is
  // a round number (multiple of 10 W, or 5 bpm).
  // Readings below the minimum are drawn on the bottom line.
  // ----------------------------------------------------------
  const minPower = 70;
  const minHr = 40;

  const niceTop = (min, peak, floor, stepRound) =>
    min +
    4 *
      Math.ceil((Math.max(peak * 1.1, floor) - min) / 4 / stepRound) *
      stepRound;

  const peakPower = Math.max(
    200,
    ...powerValues,
    ...(pctMode ? [] : workout.points.map((p) => toWatts(p.v))),
  );
  const peakHr = Math.max(100, ...hrValues);

  const topPower = niceTop(minPower, peakPower, 200, 10);
  const topHr = niceTop(minHr, peakHr, 160, 5);

  // ----------------------------------------------------------
  // Time window.
  // With a workout: show the full workout, from 0 to its duration. Once
  // playback passes the end, slide the window so it keeps the same width.
  // Without a workout: show the last HISTORY_SECONDS ending now.
  // ----------------------------------------------------------
  // (hasWorkout is defined near the top of the function.)
  const viewDuration = hasWorkout ? workout.duration : HISTORY_SECONDS;
  const currentElapsed = workout.elapsed || 0;

  let startTime, endTime;
  if (hasWorkout) {
    if (currentElapsed <= viewDuration) {
      startTime = 0;
      endTime = viewDuration;
    } else {
      // Scrolled mode: keep window size equal to workout duration once past the end
      endTime = currentElapsed;
      startTime = currentElapsed - viewDuration;
    }
  } else {
    endTime = currentElapsed;
    startTime = Math.max(0, endTime - HISTORY_SECONDS);
  }

  // ----------------------------------------------------------
  // Coordinate mapping helpers (data value -> canvas pixel).
  // ----------------------------------------------------------

  // Workout time in seconds -> x pixel.
  const mapTimeX = (time) => {
    if (viewDuration <= 0) return padLeft;
    return padLeft + ((time - startTime) / viewDuration) * plotWidth;
  };

  // History sample index -> x pixel. Assumes one sample per second, with
  // the newest sample (last index) at "now".
  //   workout mode: placed on the workout timeline.
  //   rolling mode: placed from the right edge, spaced evenly.
  const x = (index) => {
    if (hasWorkout) {
      // Anchor the newest sample to the current workout position, and place
      // earlier samples by how many ride seconds before it they were recorded.
      const newest = history[history.length - 1].elapsedSeconds;
      const sampleTime = currentElapsed - (newest - history[index].elapsedSeconds);
      return mapTimeX(sampleTime);
    } else {
      return (
        padLeft +
        plotWidth -
        (history.length - 1 - index) * (plotWidth / (HISTORY_SECONDS - 1))
      );
    }
  };

  // Power (W) and heart rate (bpm) -> y pixel. Values are clamped to the
  // axis range so nothing is drawn outside the plot.
  const yPower = (value) =>
    padTop +
    plotHeight -
    ((clamp(value, minPower, topPower) - minPower) / (topPower - minPower)) *
      plotHeight;

  const yHr = (value) =>
    padTop +
    plotHeight -
    ((clamp(value, minHr, topHr) - minHr) / (topHr - minHr)) * plotHeight;

  // Percent scale for resistance mode: 0 to at least 100%, with 10% headroom.
  const peakPct = Math.max(100, ...workout.points.map((p) => toPct(p.v)));
  const topPct = Math.ceil((peakPct * 1.1) / 10) * 10;
  const yPct = (value) =>
    padTop + plotHeight - (clamp(value, 0, topPct) / topPct) * plotHeight;

  // Workout profile y position: percent scale in resistance mode, watts otherwise.
  const yProfile = (v) => (pctMode ? yPct(toPct(v)) : yPower(toWatts(v)));

  // ----------------------------------------------------------
  // 1. Workout profile (drawn first so live lines sit on top).
  //    A filled shape under the target line, an outline, and a vertical
  //    playhead at the current playback position.
  // ----------------------------------------------------------
  if (hasWorkout) {
    ctx.save();
    ctx.beginPath();
    let pathStarted = false;

    workout.points.forEach((point) => {
      const wx = mapTimeX(point.t);
      const wy = yProfile(point.v);
      if (!pathStarted) {
        ctx.moveTo(wx, padTop + plotHeight);
        ctx.lineTo(wx, wy);
        pathStarted = true;
      } else {
        ctx.lineTo(wx, wy);
      }
    });

    if (pathStarted) {
      ctx.lineTo(mapTimeX(workout.duration), padTop + plotHeight);
      ctx.closePath();

      const fill = ctx.createLinearGradient(0, padTop, 0, padTop + plotHeight);
      fill.addColorStop(0, "rgba(99, 102, 241, 0.2)");
      fill.addColorStop(1, "rgba(99, 102, 241, 0.03)");
      ctx.fillStyle = fill;
      ctx.fill();

      // Outline stroke for target profile
      ctx.beginPath();
      let strokeStarted = false;
      workout.points.forEach((point) => {
        const wx = mapTimeX(point.t);
        const wy = yProfile(point.v);
        if (!strokeStarted) {
          ctx.moveTo(wx, wy);
          strokeStarted = true;
        } else {
          ctx.lineTo(wx, wy);
        }
      });
      ctx.strokeStyle = "rgba(99, 102, 241, 0.45)";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.stroke();

      // Live playhead indicator line showing current workout progress
      if (currentElapsed >= 0 && currentElapsed <= workout.duration) {
        const playheadX = mapTimeX(currentElapsed);
        ctx.strokeStyle = "rgba(251, 191, 36, 0.8)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, padTop);
        ctx.lineTo(playheadX, padTop + plotHeight);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // All text below uses this font. To change text size, edit CANVAS_FONT
  // in state.js rather than setting sizes here.
  ctx.font = CANVAS_FONT;

  // ----------------------------------------------------------
  // 2. Grid lines and the power axis (left). Five lines, minPower to topPower.
  //    The +0.5 offset keeps 1px lines crisp.
  // ----------------------------------------------------------
  ctx.fillStyle = "#94a3b8";
  ctx.strokeStyle = "rgba(51, 65, 85, 0.55)";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const value = minPower + ((topPower - minPower) / 4) * i;
    const lineY = Math.round(yPower(value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, lineY);
    ctx.lineTo(width - padRight, lineY);
    ctx.stroke();
    ctx.fillText(Math.round(value) + "W", padLeft - 6, lineY);
  }

  // ----------------------------------------------------------
  // 3. Heart rate axis (right). Labels only; the grid lines above are
  //    shared with the power axis. Rose colour matches the HR series.
  // ----------------------------------------------------------
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const value = minHr + ((topHr - minHr) / 4) * i;
    const lineY = Math.round(yHr(value)) + 0.5;
    ctx.fillStyle = "#f43f5e";
    ctx.fillText(Math.round(value) + "bpm", width - padRight + 6, lineY);
  }

  // ----------------------------------------------------------
  // 3b. Resistance mode: percent labels for the workout profile, drawn inside
  //     the plot at the left edge in the profile's indigo, with faint dashed
  //     guide lines. The watts axis on the left stays as it is.
  // ----------------------------------------------------------
  if (pctMode) {
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(129, 140, 248, 0.3)";
    ctx.fillStyle = "#818cf8";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (let pct = 50; pct <= topPct; pct += 50) {
      const lineY = Math.round(yPct(pct)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padLeft, lineY);
      ctx.lineTo(width - padRight, lineY);
      ctx.stroke();
      ctx.fillText(pct + "%", padLeft + 4, lineY - 2);
    }
    ctx.restore();
  }

  // ----------------------------------------------------------
  // 4. Time axis labels: window start on the left, window end on the right.
  // ----------------------------------------------------------
  ctx.fillStyle = "#94a3b8";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(
    hasWorkout ? formatTime(startTime) : "-5 min",
    padLeft,
    height - 4,
  );
  ctx.textAlign = "right";
  ctx.fillText(
    hasWorkout ? formatTime(endTime) : "now",
    width - padRight,
    height - 4,
  );

  // ----------------------------------------------------------
  // 5. Live series.
  // drawSeries draws one line from history[sample][key].
  //   - A null reading lifts the pen, so gaps show as gaps instead of
  //     lines joining across missing data.
  //   - Points outside the plot area are skipped (and also lift the pen).
  //   - useHrAxis switches the y mapping from watts to bpm.
  // ----------------------------------------------------------
  const drawSeries = (key, color, dashed, useHrAxis = false, yMap = null) => {
    if (!history.length) return;
    let penDown = false;
    ctx.beginPath();
    history.forEach((sample, index) => {
      const value = sample[key];
      if (!isReading(value)) {
        penDown = false;
        return;
      }
      const chartY = yMap
        ? yMap(value)
        : useHrAxis
          ? yHr(value)
          : yPower(value);
      const chartX = x(index);
      if (chartX >= padLeft && chartX <= width - padRight) {
        if (penDown) ctx.lineTo(chartX, chartY);
        else ctx.moveTo(chartX, chartY);
        penDown = true;
      } else {
        penDown = false;
      }
    });
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.5 : 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Series order is draw order (later lines sit on top). Colours match the
  // cockpit tiles: indigo target, emerald Kickr, amber pedals, rose HR.
  drawSeries("target", "#818cf8", true, false, pctMode ? yPct : null);
  drawSeries("trainer", "#34d399", false, false);
  drawSeries("pedals", "#fbbf24", false, false);
  drawSeries("hr", "#f43f5e", false, true);

  // ----------------------------------------------------------
  // 6. Average heart rate: dashed rose line across the plot, with a label
  //    just above it. Averages every HR reading in the stored history.
  // ----------------------------------------------------------
  const avgHr = hrValues.length ? average(hrValues) : null;
  if (avgHr !== null) {
    const avgY = Math.round(yHr(avgHr)) + 0.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(244, 63, 94, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, avgY);
    ctx.lineTo(width - padRight, avgY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = CANVAS_FONT;
    ctx.fillStyle = "#f43f5e";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("Avg " + Math.round(avgHr) + " bpm", padLeft + 6, avgY - 2);
  }

  // ----------------------------------------------------------
  // 7. Workout message banner (from the file's [COURSE TEXT] section),
  //    drawn last so it sits on top of everything else.
  // ----------------------------------------------------------
  const msg = activeWorkoutMessage(currentElapsed);
  if (msg) {
    drawBanner(ctx, msg.text, padLeft + plotWidth / 2, padTop + 16, plotWidth);
  }
}
