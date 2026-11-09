import { toPctFtp, getTargetAtTime } from './mrcParser.js';

export function drawWorkoutThumbnail(canvasId, workout) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!workout.points.length) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(
            'Load an .mrc or .erg workout file to preview profile',
            w / 2,
            h / 2 + 4,
        );
        return;
    }

    const padL = 32, padR = 20, padT = 15, padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const maxTime = workout.durationMin;
    let maxVal = 100;
    workout.points.forEach((p) => (maxVal = Math.max(maxVal, toPctFtp(p.value, workout.units, workout.ftp))));
    const yMax = Math.ceil(maxVal / 25) * 25 + 25;

    const xOf = (t) => padL + (t / maxTime) * plotW;
    const yOf = (v) => padT + (1 - v / yMax) * plotH;

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    for (let v = 50; v <= yMax; v += 50) {
        const y = yOf(v);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillText(`${v}%`, padL - 4, y + 3);
    }

    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    workout.points.forEach((p) => ctx.lineTo(xOf(p.timeMin), yOf(toPctFtp(p.value, workout.units, workout.ftp))));
    ctx.lineTo(xOf(maxTime), yOf(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(99, 102, 241, 0.2)';
    ctx.fill();

    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    workout.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(xOf(p.timeMin), yOf(toPctFtp(p.value, workout.units, workout.ftp)));
        else ctx.lineTo(xOf(p.timeMin), yOf(toPctFtp(p.value, workout.units, workout.ftp)));
    });
    ctx.stroke();

    if (workout.state !== 'stopped') {
        const curMin = workout.elapsedSeconds / 60;
        const curX = xOf(curMin);
        ctx.strokeStyle = '#fb7185';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(curX, padT);
        ctx.lineTo(curX, h - padB);
        ctx.stroke();
    }
}
