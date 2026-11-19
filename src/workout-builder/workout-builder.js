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
      <input data-f="dur" value="${fmt(s.dur)}" inputmode="numeric" aria-label="Duration">
      <input data-f="a" type="number" min="0" max="300" value="${s.a}" aria-label="Start percent FTP">
      <input data-f="b" type="number" min="0" max="300" value="${s.type === "ramp" ? s.b : s.a}" aria-label="End percent FTP"${s.type === "steady" ? " disabled" : ""}>
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
  $("#sTime").textContent =
    total >= 3600
      ? Math.floor(total / 3600) +
        ":" +
        String(Math.floor((total % 3600) / 60)).padStart(2, "0") +
        ":" +
        String(total % 60).padStart(2, "0")
      : fmt(total);
  $("#sAvg").textContent = Math.round(avg);
  $("#sTss").textContent = Math.round((total / 3600) * (np / 100) ** 2 * 100);

  const peak = Math.max(120, ...W.steps.map((s) => Math.max(s.a, s.b)));

  const ymax = Math.ceil((peak * 1.1) / 10) * 10;

  const X = (t) => (total ? (t / total) * 1000 : 0);
  const Y = (v) => 200 - (v / ymax) * 200;
  let d = "M0,200",
    t = 0,
    cues = "";
  W.steps.forEach((s) => {
    d += ` L${X(t)},${Y(s.a)}`;
    if (s.text || t > 0)
      cues += `<line x1="${X(t)}" x2="${X(t)}" y1="0" y2="200" stroke="${s.text ? "#fbbf24" : "#3a4a70"}" stroke-width="1.5" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
    t += s.dur;
    d += ` L${X(t)},${Y(s.type === "ramp" ? s.b : s.a)}`;
  });
  const line = d.replace("M0,200 L", "M");
  $("#chart").innerHTML =
    `<path d="${d} L1000,200 Z" fill="rgba(129,140,248,.2)"/>` +
    `<path d="${line}" fill="none" stroke="#818cf8" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    cues;

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

  let lt = 0,
    labels = "";
  const lab = (pct, txt, cls) =>
    `<div class="stp ${cls}" style="left:${pct}%">${txt}</div>`;

  W.steps.forEach((s) => {
    if (total) {
      const w = s.dur / total,
        l = (lt / total) * 100,
        r = ((lt + s.dur) / total) * 100;
      if (s.type === "ramp") {
        labels += lab(l, toW(s.a), "rs") + lab(r, toW(s.b), "re");
      } else if (w >= 0.04) labels += lab((l + r) / 2, toW(s.a), "mid");
    }
    lt += s.dur;
  });

  $("#labels").innerHTML = labels;

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
  if (f === "dur") {
    const d = parseDur(e.target.value);
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
  const s = W.steps[+row.dataset.i];
  if (e.target.dataset.f === "type") {
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
  if (!W.zonesEdited) {
    W.zones = defaultZones();
    renderZones();
  }
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
  const next = $(`[data-lo="${i + 1}"]`);
  if (next) next.textContent = v + 1;
  update();
});
$("#zonelist")?.addEventListener("change", () => {
  // Keep limits strictly ascending, then redraw
  W.zones.forEach((v, i) => {
    W.zones[i] = clamp(v, i ? W.zones[i - 1] + 1 : 1, 2000);
  });
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
renderZones();
renderRows();
