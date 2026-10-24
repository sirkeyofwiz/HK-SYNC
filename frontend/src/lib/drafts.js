// ---------- Drafts ----------
// A report being filled in is kept on this phone until it is sent or discarded, so a dead battery, a closed app or lost
// Wi-Fi never loses it. IndexedDB, not localStorage: a few photos would overflow localStorage's ~5 MB. One draft per
// report type for new reports, one per report being edited, per person signed in on the phone.
export const draftKey = (userId, type, editingId) => editingId ? `${userId}:edit:${editingId}` : `${userId}:new:${type}`;
export const draftStore = (mode, use) => new Promise((resolve, reject) => {
  const open = indexedDB.open('hk-sync', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('drafts');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => { const db = open.result; const tx = db.transaction('drafts', mode); const call = use(tx.objectStore('drafts')); tx.oncomplete = () => { db.close(); resolve(call.result); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); }; };
});
export const loadDraft = (key) => draftStore('readonly', (store) => store.get(key)).catch(() => null);
export const saveDraft = (key, draft) => draftStore('readwrite', (store) => store.put(draft, key));
export const dropDraft = (key) => (key ? draftStore('readwrite', (store) => store.delete(key)).catch(() => {}) : Promise.resolve());
export const draftTime = (ms) => { const date = new Date(ms); const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`; };
