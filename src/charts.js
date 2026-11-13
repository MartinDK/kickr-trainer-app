import {
  $,
  CANVAS_FONT,
  HISTORY_SECONDS,
  average,
  clamp,
  telemetry,
  workout,
} from "./state.js";

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

function drawCanvasMessage(ctx, width, height, message) {
  ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, width / 2, height / 2);
}
export function drawPowerChart() {
  const surface = prepareCanvas($("powerChart"));
  if (!surface) return;
  const { ctx, width, height } = surface;
  const history = telemetry.history;
  const powerValues = history
    .flatMap((sample) => [sample.trainer, sample.pedals, sample.target])
    .filter((value) => value !== null);
  const hrValues = history
    .map((sample) => sample.hr)
    .filter((value) => value !== null);

  const padLeft = 38;
  const padRight = 38;
  const padTop = 10;
  const padBottom = 20;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const topPower = Math.max(
    200,
    Math.ceil(
      (Math.max(
        200,
        ...(powerValues.length ? powerValues : [0]),
        ...(workout.points.length ? workout.points.map((p) => p.v) : [0]),
      ) *
        1.1) /
        50,
    ) * 50,
  );
  const topHr = Math.max(
    160,
    Math.ceil(
      (Math.max(100, ...(hrValues.length ? hrValues : [0])) * 1.1) / 20,
    ) * 20,
  );

  // Time windowing: Full workout duration if loaded, otherwise 5-min rolling window
  const hasWorkout =
    workout.points && workout.points.length > 0 && workout.duration > 0;
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

  // Time mapping function across the chart width
  const mapTimeX = (time) => {
    if (viewDuration <= 0) return padLeft;
    return padLeft + ((time - startTime) / viewDuration) * plotWidth;
  };

  // Map history telemetry samples to chart X coordinates
  const x = (index) => {
    if (hasWorkout) {
      const sampleTime = currentElapsed - (history.length - 1 - index);
      return mapTimeX(sampleTime);
    } else {
      return (
        padLeft +
        plotWidth -
        (history.length - 1 - index) * (plotWidth / (HISTORY_SECONDS - 1))
      );
    }
  };

  const yPower = (value) =>
    padTop + plotHeight - (clamp(value, 0, topPower) / topPower) * plotHeight;

  const yHr = (value) =>
    padTop + plotHeight - (clamp(value, 0, topHr) / topHr) * plotHeight;

  // 1. Draw Workout Profile Background Preview (Full workout duration scale)
  if (hasWorkout) {
    ctx.save();
    ctx.beginPath();
    let pathStarted = false;

    workout.points.forEach((point) => {
      const wx = mapTimeX(point.t);
      const wy = yPower(point.v);
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
        const wy = yPower(point.v);
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

  ctx.font = CANVAS_FONT;

  // Grid lines & Power Axis (Left)
  ctx.fillStyle = "#94a3b8";
  ctx.strokeStyle = "rgba(51, 65, 85, 0.55)";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const value = (topPower / 4) * i;
    const lineY = Math.round(yPower(value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, lineY);
    ctx.lineTo(width - padRight, lineY);
    ctx.stroke();
    ctx.fillText(Math.round(value) + "W", padLeft - 6, lineY);
  }

  // Heart Rate Axis (Right)
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const value = (topHr / 4) * i;
    const lineY = Math.round(yHr(value)) + 0.5;
    ctx.fillStyle = "#f43f5e";
    ctx.fillText(Math.round(value) + "bpm", width - padRight + 6, lineY);
  }

  // Time Axis Formatting Helper
  const formatTime = (secs) => {
    const m = Math.floor(Math.max(0, secs) / 60);
    const s = Math.floor(Math.max(0, secs) % 60);
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const remM = m % 60;
      return `${h}:${remM.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Time Axis Labels
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

  // Live Telemetry Series Drawer
  const drawSeries = (key, color, dashed, useHrAxis = false) => {
    if (!history.length) return;
    let penDown = false;
    ctx.beginPath();
    history.forEach((sample, index) => {
      const value = sample[key];
      if (value === null) {
        penDown = false;
        return;
      }
      const chartY = useHrAxis ? yHr(value) : yPower(value);
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

  drawSeries("target", "#818cf8", true, false);
  drawSeries("trainer", "#34d399", false, false);
  drawSeries("pedals", "#fbbf24", false, false);
  drawSeries("hr", "#f43f5e", false, true);

  // Average Heart Rate reference line
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
}
