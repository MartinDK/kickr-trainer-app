// charts.js — HTML5 Canvas rendering for Power/HR trend & Workout thumbnail
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

export function drawWorkoutChart(ftpValue) {
  const surface = prepareCanvas($("workoutThumbnailCanvas"));
  if (!surface) return;
  const { ctx, width, height } = surface;
  if (!workout.points.length) {
    drawCanvasMessage(
      ctx,
      width,
      height,
      "Load a .mrc or .erg file to preview the workout",
    );
    return;
  }
  const pad = 10;
  const points = workout.points;
  const refFtp = workout.unit === "percent" ? 100 : ftpValue;
  const top =
    Math.max(...points.map((point) => point.v), refFtp) * 1.1 || 1;
  const x = (time) => pad + (time / workout.duration) * (width - pad * 2);
  const y = (value) => height - pad - (value / top) * (height - pad * 2);

  ctx.beginPath();
  ctx.moveTo(x(points[0].t), height - pad);
  points.forEach((point) => ctx.lineTo(x(point.t), y(point.v)));
  ctx.lineTo(x(workout.duration), height - pad);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, pad, 0, height - pad);
  fill.addColorStop(0, "rgba(99, 102, 241, 0.5)");
  fill.addColorStop(1, "rgba(99, 102, 241, 0.08)");
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) =>
    index
      ? ctx.lineTo(x(point.t), y(point.v))
      : ctx.moveTo(x(point.t), y(point.v)),
  );
  ctx.strokeStyle = "#818cf8";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  const ftpY = Math.round(y(refFtp)) + 0.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, ftpY);
  ctx.lineTo(width - pad, ftpY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = CANVAS_FONT;
  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("FTP", width - pad - 2, ftpY - 2);

  const progressX = x(workout.elapsed);
  ctx.fillStyle = "rgba(251, 191, 36, 0.12)";
  ctx.fillRect(pad, pad, progressX - pad, height - pad * 2);
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(progressX, pad);
  ctx.lineTo(progressX, height - pad);
  ctx.stroke();
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

  if (!powerValues.length && !hrValues.length) {
    drawCanvasMessage(
      ctx,
      width,
      height,
      "Connect a trainer, pedals or HR strap to see chart",
    );
    return;
  }

  const padLeft = 38;
  const padRight = 38;
  const padTop = 10;
  const padBottom = 20;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const topPower = Math.max(
    200,
    Math.ceil(
      (Math.max(200, ...(powerValues.length ? powerValues : [0])) * 1.1) / 50,
    ) * 50,
  );
  const topHr = Math.max(
    160,
    Math.ceil(
      (Math.max(100, ...(hrValues.length ? hrValues : [0])) * 1.1) / 20,
    ) * 20,
  );

  const x = (index) =>
    padLeft +
    plotWidth -
    (history.length - 1 - index) * (plotWidth / (HISTORY_SECONDS - 1));

  const yPower = (value) =>
    padTop + plotHeight - (clamp(value, 0, topPower) / topPower) * plotHeight;

  const yHr = (value) =>
    padTop + plotHeight - (clamp(value, 0, topHr) / topHr) * plotHeight;

  ctx.font = CANVAS_FONT;

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

  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const value = (topHr / 4) * i;
    const lineY = Math.round(yHr(value)) + 0.5;
    ctx.fillStyle = "#f43f5e";
    ctx.fillText(Math.round(value) + "bpm", width - padRight + 6, lineY);
  }

  ctx.fillStyle = "#94a3b8";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText("-5 min", padLeft, height - 4);
  ctx.textAlign = "right";
  ctx.fillText("now", width - padRight, height - 4);

  const drawSeries = (key, color, dashed, useHrAxis = false) => {
    let penDown = false;
    ctx.beginPath();
    history.forEach((sample, index) => {
      const value = sample[key];
      if (value === null) {
        penDown = false;
        return;
      }
      const chartY = useHrAxis ? yHr(value) : yPower(value);
      if (penDown) ctx.lineTo(x(index), chartY);
      else ctx.moveTo(x(index), chartY);
      penDown = true;
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
