// Safe localStorage wrapper. Private browsing / disabled storage must never
// crash the game, so every access is guarded and falls back to in-memory.
// All keys are namespaced "neondrift.*".

const PREFIX = 'neondrift.';
const memory = new Map();
let usable = null;

function storageUsable() {
  if (usable !== null) return usable;
  try {
    const k = PREFIX + '__probe';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    usable = true;
  } catch (e) {
    usable = false;
  }
  return usable;
}

export const storage = {
  get(key, fallback = null) {
    const k = PREFIX + key;
    try {
      if (storageUsable()) {
        const raw = window.localStorage.getItem(k);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      }
    } catch (e) { /* corrupted entry or blocked — fall through */ }
    return memory.has(k) ? memory.get(k) : fallback;
  },

  set(key, value) {
    const k = PREFIX + key;
    memory.set(k, value);
    try {
      if (storageUsable()) window.localStorage.setItem(k, JSON.stringify(value));
    } catch (e) { /* quota / blocked — memory copy already saved */ }
  },

  remove(key) {
    const k = PREFIX + key;
    memory.delete(k);
    try {
      if (storageUsable()) window.localStorage.removeItem(k);
    } catch (e) { /* ignore */ }
  },
};
