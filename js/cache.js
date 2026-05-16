// js/cache.js — 内存缓存层，页面间共享数据
window.AppCache = (() => {
  const _data = new Map();
  const DEFAULT_TTL = 5 * 60 * 1000; // 5 分钟默认过期

  async function getOrFetch(key, fetchFn, ttl = DEFAULT_TTL) {
    const cached = _data.get(key);
    if (cached && (Date.now() - cached.ts) < ttl) {
      return cached.data;
    }
    const data = await fetchFn();
    _data.set(key, { data, ts: Date.now() });
    return data;
  }

  function get(key) {
    const cached = _data.get(key);
    return cached ? cached.data : null;
  }

  function set(key, data) {
    _data.set(key, { data, ts: Date.now() });
  }

  function invalidate(key) {
    if (key) {
      _data.delete(key);
    } else {
      _data.clear();
    }
  }

  function isFresh(key, ttl = DEFAULT_TTL) {
    const cached = _data.get(key);
    return cached && (Date.now() - cached.ts) < ttl;
  }

  return { getOrFetch, get, set, invalidate, isFresh };
})();
