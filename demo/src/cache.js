// In-process cache with a Redis-shaped API, so tests run without a server.
const entries = new Map();

function cacheKey(...parts) {
  return parts.map((p) => String(p).replace(/:/g, '_')).join(':');
}

function cacheGet(key) {
  const entry = entries.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    entries.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  entries.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  return value;
}

function cacheDelete(key) {
  return entries.delete(key);
}

function invalidatePrefix(prefix) {
  let removed = 0;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
      removed++;
    }
  }
  return removed;
}

function withCache(key, ttlMs, compute) {
  const hit = cacheGet(key);
  if (hit !== null) {
    return hit;
  }
  return cacheSet(key, compute(), ttlMs);
}

module.exports = { cacheKey, cacheGet, cacheSet, cacheDelete, invalidatePrefix, withCache };
