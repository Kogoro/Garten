// Small in-memory sliding-window limiter. Old keys are swept, the number of keys is bounded.
export class Limiter {
  constructor({ windowMs, max, maxKeys = 20000 }) {
    this.windowMs = windowMs; this.max = max; this.maxKeys = maxKeys; this.hitsByKey = new Map();
    this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.sweeper.unref?.();
  }
  sweep(now = Date.now()) {
    for (const [k, list] of this.hitsByKey) { const live = list.filter((t) => now - t < this.windowMs); if (live.length) this.hitsByKey.set(k, live); else this.hitsByKey.delete(k); }
  }
  /** Records a hit. Returns false when the key is over its limit (the hit is then not recorded). */
  hit(key) {
    const now = Date.now();
    const list = (this.hitsByKey.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) { this.hitsByKey.set(key, list); return false; }
    list.push(now);
    this.hitsByKey.delete(key); this.hitsByKey.set(key, list); // most recent last
    if (this.hitsByKey.size > this.maxKeys) this.hitsByKey.delete(this.hitsByKey.keys().next().value); // drop the oldest key
    return true;
  }
  reset(key) { this.hitsByKey.delete(key); }
}

/** Express middleware: at most `max` requests per IP and window. */
export function ipLimit({ windowMs = 60_000, max = 120 } = {}) {
  const lim = new Limiter({ windowMs, max });
  return (req, res, next) => (lim.hit(req.ip || 'unknown') ? next() : res.status(429).json({ error: 'Too many requests – try again in a minute' }));
}
