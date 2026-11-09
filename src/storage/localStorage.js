const DEVICE_IDS_KEY = 'kickrDeviceIds';
const PRESETS_KEY = 'kickrPresets';
const FTP_KEY = 'kickrFtp';

export function loadDeviceIds() {
    try {
        return JSON.parse(localStorage.getItem(DEVICE_IDS_KEY)) || {};
    } catch (e) {
        return {};
    }
}

export function saveDeviceId(key, id) {
    try {
        const ids = loadDeviceIds();
        ids[key] = id;
        localStorage.setItem(DEVICE_IDS_KEY, JSON.stringify(ids));
    } catch (e) {}
}

export function forgetDeviceId(key) {
    try {
        const ids = loadDeviceIds();
        delete ids[key];
        localStorage.setItem(DEVICE_IDS_KEY, JSON.stringify(ids));
    } catch (e) {}
}

export function loadFtp() {
    try {
        const savedFtp = localStorage.getItem(FTP_KEY);
        if (savedFtp) {
            const parsed = parseInt(savedFtp);
            if (Number.isFinite(parsed)) return parsed;
        }
    } catch (e) {}
    return 236;
}

export function saveFtp(val) {
    try {
        localStorage.setItem(FTP_KEY, val);
    } catch (e) {}
}

export function loadPresets(defaultCfg) {
    try {
        const saved = JSON.parse(localStorage.getItem(PRESETS_KEY));
        Object.keys(defaultCfg).forEach((k) => {
            const v = saved && saved[k];
            if (Array.isArray(v) && v.length === 5 && v.every(Number.isFinite))
                defaultCfg[k].vals = v;
        });
    } catch (e) {}
}

export function savePresets(cfg) {
    try {
        localStorage.setItem(PRESETS_KEY, JSON.stringify({
            erg: cfg.erg.vals,
            resistance: cfg.resistance.vals,
        }));
    } catch (e) {}
}
