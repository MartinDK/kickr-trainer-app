const DB_NAME = 'KickrTrainingHubSessions';
const STORE_NAME = 'sessions';
let dbInstance = null;
const LATEST_KEY = 'latest';

export function recHasData(r) {
    if (!r) return false;
    const w = r.workout;
    return (
        (r.sessionRows && r.sessionRows.length > 0) ||
        !!(w && (w.elapsedSeconds > 0 || (w.points && w.points.length > 0)))
    );
}

export function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    const finish = (db, resolve) => {
        dbInstance = db;
        db.onclose = () => { dbInstance = null; };
        db.onversionchange = () => {
            db.close();
            dbInstance = null;
        };
        resolve(db);
    };
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME);
        req.onerror = (e) => reject(e.target.error);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = (e) => {
            const db = e.target.result;
            if (db.objectStoreNames.contains(STORE_NAME)) {
                finish(db, resolve);
                return;
            }
            const nextVersion = db.version + 1;
            db.close();
            const req2 = indexedDB.open(DB_NAME, nextVersion);
            req2.onerror = (ev) => reject(ev.target.error);
            req2.onupgradeneeded = (ev) => {
                const d = ev.target.result;
                if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME);
            };
            req2.onsuccess = (ev) => finish(ev.target.result, resolve);
        };
    });
}

export async function saveSessionToDB(data, tabSessionId) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const stateData = { ...data, timestamp: Date.now(), owner: tabSessionId };
            store.put(stateData, tabSessionId);
            store.put(stateData, LATEST_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch (err) {
        console.error('Failed to autosave session to IndexedDB:', err);
        throw err;
    }
}

export async function getSavedSessionFromDB(tabSessionId) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(tabSessionId);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                if (recHasData(req.result)) {
                    resolve({ saved: req.result, source: 'tab' });
                    return;
                }
                const req2 = store.get(LATEST_KEY);
                req2.onerror = () => reject(req2.error);
                req2.onsuccess = () => {
                    const l = req2.result;
                    if (recHasData(l) && Date.now() - l.timestamp < 12 * 3600 * 1000)
                        resolve({ saved: l, source: 'latest' });
                    else resolve({ saved: null, source: 'none' });
                };
            };
        });
    } catch (err) {
        return { saved: null, source: 'error' };
    }
}

export async function clearSessionFromDB(tabSessionId) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(tabSessionId);
            store.delete(LATEST_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.error('Failed to clear session from IndexedDB:', err);
    }
}
