const KEY = "trainingHub.builder";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s).replace(
    /[&"<>]/g,
    (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c],
  );
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const STARTER = {
  name: "New workout",
  ftp: 250,
  steps: [
    { type: "ramp", dur: 600, a: 45, b: 70, text: "Warm up easy" },
    { type: "steady", dur: 300, a: 95, b: 95, text: "First effort" },
    { type: "steady", dur: 300, a: 55, b: 55, text: "" },
    { type: "steady", dur: 300, a: 95, b: 95, text: "Second effort" },
    { type: "ramp", dur: 300, a: 60, b: 40, text: "Cool down" },
  ],
};

let W = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.steps) && s.steps.length) return s;
  } catch {}
  return structuredClone(STARTER);
})();

const fmt = (sec) =>
  Math.floor(sec / 60) + ":" + String(Math.round(sec % 60)).padStart(2, "0");
function parseDur(v) {
  v = String(v).trim();
  const m = v.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + Math.min(59, +m[2]);
  const n = parseFloat(v);
  return n > 0 ? Math.round(n * 60) : NaN;
}

function renderRows() {
  $("#rows").innerHTML = W.steps
    .map(
      (s, i) => `
    <div class="row" data-i="${i}">
      <span class="idx">${i + 1}</span>
      <select data-f="type" aria-label="Step type">
        <option value="steady"${s.type === "steady" ? " selected" : ""}>Steady</option>
        <option value="ramp"${s.type === "ramp" ? " selected" : ""}>Ramp</option>
      </select>
      <input data-f="min" type="number" min="0" max="999" value="${Math.floor(s.dur / 60)}" aria-label="Minutes">
      <input data-f="sec" type="number" min="0" value="${Math.round(s.dur % 60)}" aria-label="Seconds">
      <input data-f="a" type="number" min="0" max="300" value="${s.a}" aria-label="Start percent FTP">
      <input data-f="b" type="number" min="0" max="300" value="${s.type === "ramp" ? s.b : s.a}" aria-label="End percent FTP"${s.type === "steady" ? " disabled" : ""}>
      <span class="zsel">
        <select data-f="zone" data-end="0" aria-label="Start zone">${zoneOpts()}</select>
        <select data-f="zone" data-end="1" aria-label="End zone"${s.type === "steady" ? " disabled" : ""}>${zoneOpts()}</select>
      </span>
      <input data-f="text" value="${esc(s.text)}" placeholder="Message (optional)" maxlength="80" aria-label="Message">
      <span class="acts">
        <button data-act="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button data-act="down" aria-label="Move down"${i === W.steps.length - 1 ? " disabled" : ""}>↓</button>
        <button data-act="dup" aria-label="Duplicate">⧉</button>
        <button data-act="del" aria-label="Delete"${W.steps.length === 1 ? " disabled" : ""}>✕</button>
      </span>
    </div>`,
    )
    .join("");
  update();
}

function update() {
  const total = W.steps.reduce((t, s) => t + s.dur, 0);
  const vals = [];
  W.steps.forEach((s) => {
    for (let k = 0; k < s.dur; k++)
      vals.push(s.a + (s.b - s.a) * ((k + 0.5) / s.dur));
  });
  let sum = 0,
    fourth = 0;
  vals.forEach((v, i) => {
    sum += v;
    if (i >= 30) sum -= vals[i - 30];
    fourth += (sum / Math.min(i + 1, 30)) ** 4;
  });
  const np = vals.length ? (fourth / vals.length) ** 0.25 : 0;
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  // Set a tile value; for tiles with a unit (<b>0<i>W</i></b>) only the text node changes
  const set = (id, v) => {
    const el = $(id);
    if (!el) return;
    const n = el.firstChild;
    if (el.children.length && n && n.nodeType === 3) n.nodeValue = v;
    else el.textContent = v;
  };

  // np and avg above are in % FTP, so convert to watts
  const avgW = (avg * W.ftp) / 100,
    npW = (np * W.ftp) / 100,
    IF = np / 100,
    tss = (total / 3600) * IF ** 2 * 100,
    kj = (avgW * total) / 1000,
    kcal = kj / (4.184 * 0.24); // ~24% gross efficiency, so kcal is about equal to kJ

  // Share of energy from carbohydrate rises with intensity
  const frac =
    IF < 0.55
      ? 0.35
      : IF < 0.75
        ? 0.5
        : IF < 0.9
          ? 0.7
          : IF < 1.05
            ? 0.85
            : 0.95;
  const carbs = (kcal * frac) / 4; // 4 kcal per gram

  // In-session carbohydrate guideline (g/h) by duration; intake = rate x hours
  const hrs = total / 3600;
  const [rLo, rHi] =
    total < 2700
      ? [0, 0]
      : total < 4500
        ? [0, 30]
        : total < 7200
          ? [30, 60]
          : [60, 90];
  const choLo = Math.round(rLo * hrs),
    choHi = Math.round(rHi * hrs);

  const hms =
    total >= 3600
      ? Math.floor(total / 3600) +
        ":" +
        String(Math.floor((total % 3600) / 60)).padStart(2, "0") +
        ":" +
        String(total % 60).padStart(2, "0")
      : fmt(total);

  set("#sTime", hms);
  set(
    "#sCount",
    W.steps.length + (W.steps.length === 1 ? " interval" : " intervals"),
  );
  set("#sAvg", Math.round(avg));
  set("#sAvgW", Math.round(avgW));
  set("#sNP", Math.round(npW));
  set("#sVI", avgW ? (npW / avgW).toFixed(2) : "1.00");
  set("#sIF", IF.toFixed(2));
  set("#sTss", Math.round(tss));
  set("#sTssH", total ? Math.round((tss / total) * 3600) : 0);
  set("#sKj", Math.round(kj));
  set("#sKcal", Math.round(kcal));
  set("#sCarb", Math.round(carbs));
  set("#sCho", choHi ? (choLo ? `${choLo}–${choHi}` : `≤${choHi}`) : "0");

  const peak = Math.max(120, ...W.steps.map((s) => Math.max(s.a, s.b)));

  const ymax = Math.ceil((peak * 1.1) / 10) * 10;

  const X = (t) => (total ? (t / total) * 1000 : 0);
  const Y = (v) => 200 - (v / ymax) * 200;

  // Per-interval layout: every step gets at least MINPX, the rest share what's left
  const MINPX = 30;
  const avail = Math.max(300, $(".chartscroll").clientWidth - 64); // 64 = zone gutter (4rem)
  const fixed = new Set();
  let px;
  for (;;) {
    const free = avail - fixed.size * MINPX;
    const freeDur = W.steps.reduce(
      (t, s, i) => (fixed.has(i) ? t : t + s.dur),
      0,
    );
    px = W.steps.map((s, i) =>
      fixed.has(i)
        ? MINPX
        : free > 0 && freeDur
          ? (s.dur / freeDur) * free
          : MINPX,
    );
    let grew = false;
    px.forEach((v, i) => {
      if (!fixed.has(i) && v < MINPX) {
        fixed.add(i);
        grew = true;
      }
    });
    if (!grew) break;
  }
  const chartW = px.reduce((a, b) => a + b, 0);
  const st = [],
    en = [];
  let acc = 0;
  px.forEach((v) => {
    st.push(acc / chartW);
    acc += v;
    en.push(acc / chartW);
  });
  $("#chartpad").style.minWidth = `${chartW + 64}px`;

  let d = "M0,200",
    t = 0,
    cues = "";

  W.steps.forEach((s, i) => {
    const x0 = st[i] * 1000,
      x1 = en[i] * 1000;
    d += ` L${x0},${Y(s.a)}`;
    if (s.text || i > 0)
      cues += `<line x1="${x0}" x2="${x0}" y1="0" y2="200" stroke="${s.text ? "#fbbf24" : "#3a4a70"}" stroke-width="1.5" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
    d += ` L${x1},${Y(s.type === "ramp" ? s.b : s.a)}`;
  });

  const line = d.replace("M0,200 L", "M");
  // Zone bands, clipped to the area under the profile.
  // Zone limits are stored in watts; the chart's y-axis is % FTP.
  let bands = "";
  if (Array.isArray(W.zones) && W.zones.length === 6) {
    const edges = [0, ...W.zones.map((w) => (w / W.ftp) * 100), ymax];
    ZONES.forEach((z, i) => {
      const lo = Math.min(edges[i], ymax),
        hi = Math.min(edges[i + 1], ymax);
      if (hi <= lo) return;
      bands += `<rect x="0" y="${Y(hi)}" width="1000" height="${Y(lo) - Y(hi) + 0.5}" fill="${z.c}"/>`;
    });
  }
  $("#chart").innerHTML =
    `<defs><clipPath id="zclip"><path d="${d} L1000,200 Z"/></clipPath></defs>` +
    `<g clip-path="url(#zclip)" opacity=".6">${bands}</g>` +
    `<path d="${line}" fill="none" stroke="#818cf8" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    cues;
  // Zone power ranges in the right-hand gutter
  let zl = "";
  if (Array.isArray(W.zones) && W.zones.length === 6) {
    const edges = [0, ...W.zones.map((w) => (w / W.ftp) * 100), Infinity];
    ZONES.forEach((z, i) => {
      const lo = Math.min(edges[i], ymax),
        hi = Math.min(edges[i + 1], ymax);

      if (i < 6 && ((hi - lo) / ymax) * 200 < 11) return;

      const txt = i === 0 ? 0 : W.zones[i - 1] + 1;

      zl += `<div class="zl" style="top:${(1 - lo / ymax) * 100}%;--zc:${z.c}">${txt}</div>`;
    });
  }
  $("#zlabels").innerHTML = zl;
  // Power scale: chart geometry is in % FTP, labels are in watts
  const toW = (p) => Math.round((p * W.ftp) / 100);
  const ymaxW = (ymax * W.ftp) / 100;
  const stepW = [10, 25, 50, 100, 200].find((s) => ymaxW / s <= 6) || 200;
  let grid = "";
  for (let v = stepW; v < ymaxW; v += stepW) {
    if (Math.abs(v - W.ftp) < stepW / 2) continue; // avoid clashing with FTP label
    grid += `<div class="ref" style="top:${(1 - v / ymaxW) * 100}%"><span>${v} W</span></div>`;
  }
  grid += `<div class="ref ftp" style="top:${(Y(100) / 200) * 100}%"><span>FTP ${W.ftp} W</span></div>`;
  $("#grid").innerHTML = grid;

  let labels = "";
  const lab = (pct, txt, cls) =>
    `<div class="stp ${cls}" style="left:${pct}%">${txt}</div>`;
  W.steps.forEach((s, i) => {
    const l = st[i] * 100,
      r = en[i] * 100;
    if (s.type === "ramp")
      labels += lab(l, toW(s.a), "rs") + lab(r, toW(s.b), "re");
    else labels += lab((l + r) / 2, toW(s.a), "mid");
  });

  $("#labels").innerHTML = labels;

  // Interval numbers on the chart, centred on each step
  let inums = "";
  W.steps.forEach((s, i) => {
    inums += `<div class="inum" style="left:${((st[i] + en[i]) / 2) * 100}%">${i + 1}</div>`;
  });
  $("#inums").innerHTML = inums;

  // Time markers under the chart, at interval boundaries
  const tfmt = (sec) =>
    sec >= 3600
      ? Math.floor(sec / 3600) +
        ":" +
        String(Math.floor((sec % 3600) / 60)).padStart(2, "0") +
        ":" +
        String(sec % 60).padStart(2, "0")
      : fmt(sec);
  const MINGAP = 44; // px between marker centres
  const bounds = [];
  let tt = 0;
  W.steps.forEach((s, i) => {
    bounds.push({ t: tt, x: st[i] * chartW });
    tt += s.dur;
  });
  bounds.push({ t: tt, x: chartW });
  const kept = [];
  bounds.forEach((b, i) => {
    const last = i === bounds.length - 1;
    if (last)
      while (kept.length > 1 && b.x - kept[kept.length - 1].x < MINGAP)
        kept.pop();
    else if (kept.length && b.x - kept[kept.length - 1].x < MINGAP) return;
    kept.push({ ...b, cls: i === 0 ? "first" : last ? "last" : "" });
  });
  $("#nums").innerHTML = kept
    .map(
      (b) =>
        `<div class="tm ${b.cls}" style="left:${(b.x / chartW) * 100}%">${tfmt(b.t)}</div>`,
    )
    .join("");
  $("#name").value !== W.name && ($("#name").value = W.name);
  try {
    localStorage.setItem(KEY, JSON.stringify(W));
  } catch {}
}

const rows = $("#rows");
rows.addEventListener("input", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const s = W.steps[+row.dataset.i],
    f = e.target.dataset.f;
  if (e.target.dataset.f === "zone") {
    const pct = zonePct(+e.target.value);
    if (e.target.dataset.end === "1") s.b = pct;
    else {
      s.a = pct;
      if (s.type === "steady") s.b = pct;
    }
    renderRows();
    return;
  }
  if (f === "min" || f === "sec") {
    const [m, sc] = row.querySelectorAll('[data-f="min"],[data-f="sec"]');
    const d =
      clamp(parseInt(m.value, 10) || 0, 0, 999) * 60 +
      clamp(parseInt(sc.value, 10) || 0, 0, 3599);
    if (d > 0) s.dur = d;
  } else if (f === "a" || f === "b") {
    const v = clamp(parseFloat(e.target.value) || 0, 0, 300);
    s[f] = v;
    if (s.type === "steady") s.b = v;
  } else if (f === "text") s.text = e.target.value.replace(/\t/g, " ");
  update();
});
rows.addEventListener("change", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const s = W.steps[+row.dataset.i],
    f = e.target.dataset.f;

  if (f === "zone") {
    const pct = zonePct(+e.target.value);
    if (e.target.dataset.end === "1") s.b = pct;
    else {
      s.a = pct;
      if (s.type === "steady") s.b = pct;
    }
    renderRows();
    return;
  }

  if (f === "min" || f === "sec") {
    // Normalise in place (90 s -> 1 min 30 s) without re-rendering, so Tab from Min to Sec keeps focus
    const [m, sc] = row.querySelectorAll('[data-f="min"],[data-f="sec"]');
    m.value = Math.floor(s.dur / 60);
    sc.value = Math.round(s.dur % 60);
    return;
  }

  if (f === "type") {
    s.type = e.target.value;
    if (s.type === "steady") s.b = s.a;
  }
  renderRows();
});
rows.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const i = +btn.closest(".row").dataset.i,
    a = btn.dataset.act,
    S = W.steps;
  if (a === "up" && i > 0) [S[i - 1], S[i]] = [S[i], S[i - 1]];
  if (a === "down" && i < S.length - 1) [S[i + 1], S[i]] = [S[i], S[i + 1]];
  if (a === "dup") S.splice(i + 1, 0, { ...S[i] });
  if (a === "del" && S.length > 1) S.splice(i, 1);
  renderRows();
});
$("#add").addEventListener("click", () => {
  const last = W.steps[W.steps.length - 1];
  W.steps.push({
    ...last,
    type: "steady",
    a: last.type === "ramp" ? last.b : last.a,
    b: last.type === "ramp" ? last.b : last.a,
    text: "",
  });
  renderRows();
});
$("#name").addEventListener("input", (e) => {
  W.name = e.target.value;
  update();
});

$("#ftp").addEventListener("input", (e) => {
  W.ftp = clamp(parseInt(e.target.value, 10) || 250, 50, 600);
  if (!W.zonesEdited) W.zones = defaultZones();
  else scaleZones();
  renderZones();
  update();
});

function build(kind) {
  const name = (W.name.trim() || "Workout").replace(/[\t\r\n]+/g, " ");
  const file =
    name
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "_") || "workout";
  const num = (v) =>
    kind === "erg"
      ? String(Math.round((v * W.ftp) / 100))
      : String(+v.toFixed(1));
  const data = [],
    text = [];
  let t = 0;
  W.steps.forEach((s) => {
    data.push(`${(t / 60).toFixed(2)}\t${num(s.a)}`);
    if (s.text) text.push(`${t}\t${s.text}\t${Math.min(10, s.dur)}`);
    t += s.dur;
    data.push(`${(t / 60).toFixed(2)}\t${num(s.type === "ramp" ? s.b : s.a)}`);
  });
  const out = [
    "[COURSE HEADER]",
    "VERSION = 2",
    "UNITS = ENGLISH",
    `DESCRIPTION = ${name}`,
    `FILE NAME = ${file}.${kind}`,
    ...(kind === "erg" ? [`FTP = ${W.ftp}`] : []),
    kind === "erg" ? "MINUTES\tWATTS" : "MINUTES\tPERCENT",
    "[END COURSE HEADER]",
    "[COURSE DATA]",
    ...data,
    "[END COURSE DATA]",
  ];
  if (text.length) out.push("[COURSE TEXT]", ...text, "[END COURSE TEXT]");
  return { file: `${file}.${kind}`, body: out.join("\r\n") + "\r\n" };
}
document.querySelectorAll("[data-export]").forEach((b) =>
  b.addEventListener("click", () => {
    const { file, body } = build(b.dataset.export);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }),
);
// Training zones (Coggan). hi = upper limit as % FTP; the last zone is open-ended.
const ZONES = [
  { n: "Z1", name: "Recovery", hi: 55, c: "#8793ad" },
  { n: "Z2", name: "Endurance", hi: 75, c: "#60a5fa" },
  { n: "Z3", name: "Tempo", hi: 90, c: "#4ade80" },
  { n: "Z4", name: "Threshold", hi: 105, c: "#fbbf24" },
  { n: "Z5", name: "VO2max", hi: 120, c: "#fb923c" },
  { n: "Z6", name: "Anaerobic", hi: 150, c: "#fb7185" },
  { n: "Z7", name: "Neuromuscular", hi: null, c: "#c084fc" },
];
const defaultZones = () =>
  ZONES.slice(0, 6).map((z) => Math.round((z.hi * W.ftp) / 100));

// Edited zones scale with FTP, measured from the FTP they were last edited at
function rebaseZones() {
  W.zonesBase = { ftp: W.ftp, zones: [...W.zones] };
}
function scaleZones() {
  const b = W.zonesBase;
  if (b && b.zones.length === 6)
    W.zones = b.zones.map((w) => Math.round((w * W.ftp) / b.ftp));
}

function renderZones() {
  if (!$("#zonelist")) return;
  const Z = W.zones;
  $("#zonelist").innerHTML = ZONES.map((z, i) => {
    const lo = i === 0 ? 0 : Z[i - 1] + 1;
    const range =
      i < 6
        ? `<span data-lo="${i}">${lo}</span>–<input data-z="${i}" type="number" min="1" max="2000" value="${Z[i]}" aria-label="${z.n} upper limit in watts">`
        : `<span data-lo="${i}">${lo}</span>+`;
    return `<div class="zone" style="--zc:${z.c}"><b>${z.n}</b><span class="zn">${z.name}</span><span class="zr">${range}</span></div>`;
  }).join("");
}

$("#zonelist")?.addEventListener("input", (e) => {
  if (e.target.dataset.z === undefined) return;
  const i = +e.target.dataset.z,
    v = parseInt(e.target.value, 10);
  if (!(v >= 0)) return;
  W.zones[i] = v;
  W.zonesEdited = true;
  rebaseZones();
  const next = $(`[data-lo="${i + 1}"]`);
  if (next) next.textContent = v + 1;
  update();
});
$("#zonelist")?.addEventListener("change", () => {
  // Keep limits strictly ascending, then redraw
  W.zones.forEach((v, i) => {
    W.zones[i] = clamp(v, i ? W.zones[i - 1] + 1 : 1, 2000);
  });
  rebaseZones();
  renderZones();
  update();
});
$("#zreset")?.addEventListener("click", () => {
  W.ftp = clamp(parseInt($("#ftp").value, 10) || W.ftp, 50, 600);
  W.zones = defaultZones();
  W.zonesEdited = false;
  renderZones();
  update();
});
// Default FTP comes from the training app, which saves it under this key.
const appFtp = (() => {
  try {
    const n = Number(JSON.parse(localStorage.getItem("trainingHub.ftp")));
    return n >= 50 && n <= 600 ? n : null;
  } catch {
    return null;
  }
})();

if (appFtp) W.ftp = appFtp;
$("#ftp").value = W.ftp = clamp(parseInt(W.ftp, 10) || 250, 50, 600);
if (!W.zonesEdited || !Array.isArray(W.zones) || W.zones.length !== 6) {
  W.zones = defaultZones();
  W.zonesEdited = false;
}
if (W.zonesEdited) {
  if (W.zonesBase) scaleZones();
  else rebaseZones();
}
renderZones();

const zoneOpts = () =>
  ZONES.map((z, i) => `<option value="${i}">${z.n}</option>`).join("");

// Zone index for a % FTP value, using the current (editable) watt limits
function zoneOf(pct) {
  const w = (pct * W.ftp) / 100;
  const i = W.zones.findIndex((hi) => w <= hi);
  return i === -1 ? 6 : i;
}

// % FTP at the middle of a zone's watt range (Z7 is open-ended, so use 115% of the Z6 limit)
function zonePct(i) {
  const Z = W.zones;
  const lo = i === 0 ? 0 : Z[i - 1] + 1;
  const mid = i < 6 ? (lo + Z[i]) / 2 : Z[5] * 1.15;
  return clamp(Math.round((mid / W.ftp) * 100), 0, 300);
}

function syncZoneSelects() {
  if (!Array.isArray(W.zones)) return;
  document.querySelectorAll("#rows .row").forEach((row) => {
    const s = W.steps[+row.dataset.i];
    const [a, b] = row.querySelectorAll('[data-f="zone"]');
    if (!s) return;
    if (a) a.value = zoneOf(s.a);
    if (b) b.value = zoneOf(s.type === "ramp" ? s.b : s.a);
  });
}

// Slow down trackpad/wheel stepping on focused number fields
const WHEEL_PX = 60; // scroll distance per step; raise it to slow things down
const WKEY = "trainingHub.builder.wheelInvert";
let wheelAcc = 0;
let wheelFlip = null; // null = auto, true/false = user choice
try {
  const v = localStorage.getItem(WKEY);
  if (v === "1") wheelFlip = true;
  else if (v === "0") wheelFlip = false;
} catch {}

const wheelInv = $("#wheelInv");
if (wheelInv) {
  wheelInv.checked = !!wheelFlip;
  wheelInv.addEventListener("change", () => {
    wheelFlip = wheelInv.checked;
    try {
      localStorage.setItem(WKEY, wheelFlip ? "1" : "0");
    } catch {}
  });
}

document.addEventListener(
  "wheel",
  (e) => {
    const el = e.target;
    if (
      !(el instanceof HTMLInputElement) ||
      el.type !== "number" ||
      document.activeElement !== el
    )
      return;
    e.preventDefault();

    // Auto mode: Safari reports natural scrolling; flip so it feels intuitive
    if (
      wheelFlip === null &&
      e.webkitDirectionInvertedFromDevice !== undefined
    ) {
      wheelInv && (wheelInv.checked = e.webkitDirectionInvertedFromDevice);
    }
    const flip =
      wheelFlip !== null
        ? wheelFlip
        : e.webkitDirectionInvertedFromDevice === true;

    wheelAcc += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
    const steps = Math.trunc(wheelAcc / WHEEL_PX);
    if (!steps) return;
    wheelAcc -= steps * WHEEL_PX;
    const step = parseFloat(el.step) || 1;
    const lo = el.min !== "" ? +el.min : -Infinity;
    const hi = el.max !== "" ? +el.max : Infinity;
    const dir = flip ? 1 : -1;
    el.value = clamp((parseFloat(el.value) || 0) + dir * steps * step, lo, hi);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  { passive: false },
);
renderRows();

const GEN = {
  endurance: { pct: 65 },
  threshold: { pct: 95, reps: 2, rep: 1200, rest: 300, restPct: 55 },
  vo2: { pct: 115, reps: 5, rep: 180, rest: 180, restPct: 50 },
  ftpRamp: { warmW: 120, startW: 140, stepW: 20, stepSec: 60, stopAtPct: 170 },
  aet: { startPct: 60, stepPct: 5, blocks: 8, blockSec: 300 },
};
const LABELS = {
  endurance: "Endurance",
  threshold: "Threshold",
  vo2: "VO2",
  ftpRamp: "FTP ramp",
  aet: "AeT step test",
};
const warm = (sec, a = 45, b = 70) => ({
  type: "ramp",
  dur: sec,
  a,
  b,
  text: "Warm up easy",
});
const cool = (sec) => ({
  type: "ramp",
  dur: sec,
  a: 55,
  b: 35,
  text: "Cool down",
});
const hold = (dur, p, text = "") => ({ type: "steady", dur, a: p, b: p, text });

function intervals(g, label, warmSec, coolSec) {
  const s = [warm(warmSec)];
  for (let i = 0; i < g.reps; i++) {
    s.push(hold(g.rep, g.pct, `${label} ${i + 1} of ${g.reps}`));
    if (i < g.reps - 1) s.push(hold(g.rest, g.restPct));
  }
  return [...s, cool(coolSec)];
}

const TEMPLATES = {
  endurance: (mins) => [
    warm(600),
    hold(mins * 60 - 900, GEN.endurance.pct),
    cool(300),
  ],
  threshold: () => intervals(GEN.threshold, "Threshold", 900, 600),
  vo2: () => intervals(GEN.vo2, "VO2", 900, 600),
  ftpRamp: (mins, ftp) => {
    const g = GEN.ftpRamp;
    const pct = (w) => +((w / ftp) * 100).toFixed(1);
    const s = [warm(720, pct(Math.min(g.warmW, g.startW)), pct(g.startW))];
    for (let w = g.startW; w <= (ftp * g.stopAtPct) / 100; w += g.stepW)
      s.push(
        hold(
          g.stepSec,
          pct(w),
          w === g.startW ? "Ramp starts: go until you can't" : "",
        ),
      );
    return [...s, cool(480)];
  },
  aet: () => {
    const g = GEN.aet,
      s = [warm(600, g.startPct - 10, g.startPct)];
    for (let i = 0; i < g.blocks; i++)
      s.push(
        hold(
          g.blockSec,
          g.startPct + i * g.stepPct,
          i ? "" : "Hold cadence steady",
        ),
      );
    return [...s, cool(300)];
  },
};

$("#tplGo").addEventListener("click", () => {
  const type = $("#tplType").value;
  const mins = clamp(parseInt($("#tplMins").value, 10) || 60, 20, 240);
  if (!confirm("Replace all current steps?")) return;
  W.steps = TEMPLATES[type](mins, W.ftp);
  W.goal = type;
  if (!W.name.trim() || W.name === "New workout") W.name = LABELS[type];
  renderRows();
});
const syncMins = () => {
  $("#tplMins").disabled = $("#tplType").value !== "endurance";
};
$("#tplType").addEventListener("change", syncMins);
syncMins();
