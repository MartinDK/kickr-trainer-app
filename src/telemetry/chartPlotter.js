export function drawPowerChart(canvasId, power, hrBuf, hrCount, hrSum, now) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (
    canvas.width !== Math.round(w * dpr) ||
    canvas.height !== Math.round(h * dpr)
  ) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const SPAN = 300000;
  const padL = 36,
    padR = 34,
    padT = 10,
    padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const series = [
    {
      pts: power.trainer.buf.filter((b) => b.t >= now - SPAN),
      color: "#34d399",
      name: "KICKR",
    },
    {
      pts: power.pedals.buf.filter((b) => b.t >= now - SPAN),
      color: "#fbbf24",
      name: "Pedals",
    },
  ];
  let max = 0;
  series.forEach((s) => s.pts.forEach((b) => (max = Math.max(max, b.w))));
  const yMax = Math.max(100, Math.ceil(max / 50) * 50 + 50);
  const xOf = (t) => padL + ((t - (now - SPAN)) / SPAN) * plotW;
  const yOf = (v) => padT + (1 - v / yMax) * plotH;

  ctx.strokeStyle = "#1e293b";
  ctx.fillStyle = "#64748b";
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, yOf(v));
    ctx.lineTo(w - padR, yOf(v));
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(Math.round(v), padL - 6, yOf(v) + 3);
  }
  ctx.textAlign = "center";
  ["-5m", "-4m", "-3m", "-2m", "-1m", "now"].forEach((label, i) =>
    ctx.fillText(label, padL + (plotW * i) / 5, h - 5),
  );

  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  series.forEach((s, idx) => {
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    s.pts.forEach((b, i) => {
      if (i === 0 || b.t - s.pts[i - 1].t > 5000)
        ctx.moveTo(xOf(b.t), yOf(b.w));
      else ctx.lineTo(xOf(b.t), yOf(b.w));
    });
    ctx.stroke();
    ctx.fillStyle = s.color;
    ctx.textAlign = "left";
    ctx.fillText(s.name, padL + 8 + idx * 56, padT + 12);
  });
  const hp = hrBuf.filter((b) => b.t >= now - SPAN);
  ctx.fillStyle = "#fb7185";
  ctx.textAlign = "left";
  ctx.fillText("HR", padL + 8 + 2 * 56, padT + 12);
  const avgHr = hrCount ? hrSum / hrCount : null;
  if (hp.length || avgHr !== null) {
    const vals = hp.map((b) => b.hr);
    if (avgHr !== null) vals.push(avgHr);
    let lo = Math.floor(Math.min(...vals) / 10) * 10 - 10;
    let hi = Math.ceil(Math.max(...vals) / 10) * 10 + 10;
    if (hi - lo < 40) hi = lo + 40;
    const yH = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
    for (let i = 0; i <= 4; i++) {
      ctx.fillText(
        Math.round(lo + ((hi - lo) / 4) * i),
        w - padR + 4,
        yOf((yMax / 4) * i) + 3,
      );
    }
    ctx.strokeStyle = "#fb7185";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    hp.forEach((b, i) => {
      if (i === 0 || b.t - hp[i - 1].t > 5000) ctx.moveTo(xOf(b.t), yH(b.hr));
      else ctx.lineTo(xOf(b.t), yH(b.hr));
    });
    ctx.stroke();
    if (avgHr !== null) {
      const ya = yH(avgHr);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, ya);
      ctx.lineTo(w - padR, ya);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "left";
      ctx.fillText(`ride avg ${Math.round(avgHr)} bpm`, padL + 6, ya - 4);
    }
  }
}
