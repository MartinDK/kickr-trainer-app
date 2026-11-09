export const RR_MIN_MS = 300;
export const RR_MAX_MS = 2000;
export const RR_MAX_JUMP = 0.2;
export const RR_RESYNC_AFTER = 3;

export function parseHeartRate(dv) {
    const flags = dv.getUint8(0);
    let i = 1;
    const hr16 = (flags & 0x01) !== 0;
    const hr = hr16 ? dv.getUint16(i, true) : dv.getUint8(i);
    i += hr16 ? 2 : 1;
    const contactSupported = (flags & 0x04) !== 0;
    const contactDetected = (flags & 0x02) !== 0;
    if ((flags & 0x08) !== 0) i += 2;
    const rr = [];
    if ((flags & 0x10) !== 0) {
        while (i + 1 < dv.byteLength) {
            rr.push((dv.getUint16(i, true) / 1024) * 1000);
            i += 2;
        }
    }
    return { hr, contactSupported, contactDetected, rr };
}

export function computeHrv(rrBuffer, now, windowSeconds) {
    const win = rrBuffer.filter((p) => p.t >= now - windowSeconds * 1000);
    const n = win.length;
    if (n < 5) return { n, ready: false };
    const mean = win.reduce((s, p) => s + p.rr, 0) / n;
    const sdnn = Math.sqrt(win.reduce((s, p) => s + (p.rr - mean) ** 2, 0) / (n - 1));
    let sumSq = 0;
    let over50 = 0;
    let diffs = 0;
    for (let i = 1; i < n; i++) {
        if (win[i].afterGap) continue;
        const d = win[i].rr - win[i - 1].rr;
        sumSq += d * d;
        if (Math.abs(d) > 50) over50++;
        diffs++;
    }
    if (diffs < 3) return { n, ready: false };
    return {
        n,
        ready: true,
        mean,
        sdnn,
        rmssd: Math.sqrt(sumSq / diffs),
        pnn50: (over50 / diffs) * 100,
    };
}

export function computeDfaAlpha1(rrSeries) {
    if (!rrSeries || rrSeries.length < 16) return null;
    const mean = rrSeries.reduce((a, b) => a + b, 0) / rrSeries.length;
    const y = [];
    let cumsum = 0;
    for (let i = 0; i < rrSeries.length; i++) {
        cumsum += (rrSeries[i] - mean);
        y.push(cumsum);
    }
    const scales = [4, 5, 6, 7, 8, 9, 10, 12, 14, 16];
    const logScales = [];
    const logFn = [];
    for (let n of scales) {
        const numBoxes = Math.floor(y.length / n);
        if (numBoxes < 1) continue;
        let totalSqError = 0;
        for (let b = 0; b < numBoxes; b++) {
            const start = b * n;
            let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
            for (let i = 0; i < n; i++) {
                const val = y[start + i];
                sumX += i;
                sumY += val;
                sumXY += i * val;
                sumXX += i * i;
            }
            const denomX = (n * sumXX - sumX * sumX);
            if (denomX === 0) continue;
            const slope = (n * sumXY - sumX * sumY) / denomX;
            const intercept = (sumY - slope * sumX) / n;
            for (let i = 0; i < n; i++) {
                const fit = slope * i + intercept;
                const diff = y[start + i] - fit;
                totalSqError += diff * diff;
            }
        }
        const fn = Math.sqrt(totalSqError / (numBoxes * n));
        if (fn > 0 && Number.isFinite(fn)) {
            logScales.push(Math.log(n));
            logFn.push(Math.log(fn));
        }
    }
    if (logScales.length < 4) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const m = logScales.length;
    for (let i = 0; i < m; i++) {
        sumX += logScales[i];
        sumY += logFn[i];
        sumXY += logScales[i] * logFn[i];
        sumXX += logScales[i] * logScales[i];
    }
    const denomLog = (m * sumXX - sumX * sumX);
    if (denomLog === 0) return null;
    const alpha1 = (m * sumXY - sumX * sumY) / denomLog;
    return Number.isFinite(alpha1) ? alpha1 : null;
}
