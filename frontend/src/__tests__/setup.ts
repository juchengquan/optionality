/** jsdom here exposes `localStorage` as a bare object with no methods, so the real code
 *  silently degrades (correctly — a browser without storage just shows no movement) and the
 *  feature cannot be tested at all. This gives the tests a working Storage to exercise. */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
});
