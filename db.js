const DB_NAME = "face_tagger_db";
const DB_VERSION = 2;          // bump per supportare faceDescriptor
const STORE = "items";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("ts", "ts");
        os.createIndex("name", "name");
      }
      // Migrazione: nulla da fare strutturalmente, il campo faceDescriptor
      // viene semplicemente aggiunto ai nuovi record.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listItems(limit = 200) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("ts");
    const req = idx.openCursor(null, "prev");
    const out = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && out.length < limit) {
        out.push(cur.value);
        cur.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Restituisce solo gli items che hanno un face descriptor salvato */
export async function listItemsWithDescriptor() {
  const all = await listItems(100000);
  return all.filter(it => it.faceDescriptor && it.faceDescriptor.length > 0);
}

export async function resetDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function exportAll() {
  const items = await listItems(100000);
  return items;
}

export async function importAll(items) {
  for (const it of items) {
    await addItem(it);
  }
  return true;
}
