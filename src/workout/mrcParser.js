export function parseMrc(fileContent) {
    const lines = fileContent.split(/\r?\n/);
    let inDataSection = false;
    const points = [];
    let units = 'percent';

    for (let line of lines) {
        line = line.trim();
        if (
            !line ||
            line.startsWith('//') ||
            line.startsWith(';#') ||
            line.startsWith(';')
        )
            continue;

        const upperLine = line.toUpperCase();
        const unitMatch = upperLine.match(/^MINUTES\s+(PERCENT|WATTS)/);
        if (unitMatch) {
            units = unitMatch[1] === 'WATTS' ? 'watts' : 'percent';
            continue;
        }
        if (upperLine.includes('[COURSE DATA]')) {
            inDataSection = true;
            continue;
        } else if (upperLine.startsWith('[')) {
            inDataSection = false;
            continue;
        }

        if (inDataSection) {
            const parts = line.split(/[\s,]+/);
            if (parts.length >= 2) {
                const timeMin = parseFloat(parts[0]);
                const value = parseFloat(parts[1]);
                if (Number.isFinite(timeMin) && Number.isFinite(value)) {
                    points.push({ timeMin, value });
                }
            }
        }
    }
    return { points, units };
}

export function toPctFtp(raw, units, ftp = 236) {
    return units === 'watts' ? (raw / (ftp || 236)) * 100 : raw;
}

export function getTargetAtTime(points, currentMin) {
    if (!points.length) return 0;
    if (currentMin <= points[0].timeMin) return points[0].value;
    if (currentMin >= points[points.length - 1].timeMin)
        return points[points.length - 1].value;

    let idx = 0;
    while (idx < points.length - 1 && points[idx + 1].timeMin <= currentMin) {
        idx++;
    }

    const p1 = points[idx];
    const p2 = points[idx + 1];

    if (!p2 || p1.timeMin === p2.timeMin) return p1.value;
    const fraction = (currentMin - p1.timeMin) / (p2.timeMin - p1.timeMin);
    return p1.value + fraction * (p2.value - p1.value);
}
