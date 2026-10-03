/* ================================================================
 * store.js — 测量结果缓存（GM_setValue 优先，localStorage 兜底）
 *
 * 缓存的是**原始测量值**（measuredLufs / truePeakDb），不是最终增益。
 * 好处：换档案/改目标响度时增益立即重算，不用重新下载分析。
 *
 * 带 LRU（超量淘汰最久未使用）与 TTL（默认 30 天）。
 *
 * 【S3.2.6 修正】此前有三处「名不副实」，都在这一个文件里：
 *   1. 只有 set() 会续期 → 淘汰实际按**最早写入**发生，是 FIFO 不是 LRU。
 *      现在 get() 命中也会把该条挪到队尾；已在队尾则不写索引，
 *      省掉 analyzer 一轮里对同一个 key 的反复落盘。
 *   2. TTL 过期只删数据、不摘索引 → 索引里留下悬空条目白占名额，
 *      要等它被 shift 到才顺手删（那时 delRaw 已是空操作）。
 *      现在过期时一并摘掉。
 *   3. 写入失败（localStorage 配额满）直接放弃 → 旧缓存也不会被清理，
 *      配额永远释放不出来，此后每条新测量都白跑。现在先淘汰最旧的一批
 *      腾出位置再重试一次。
 * ================================================================ */
const Store = (() => {
  /**
   * 命名空间带版本号 —— 改判定逻辑时**必须**升版本：
   * v1 时期页面状态过期会导致 key 错配，写进去的测量值属于别的视频，
   * 不升版本会一直命中脏缓存，修了也看不出效果。
   *   v1 → v2：新增页面状态新鲜度校验 / cid 改由接口兜底
   */
  const NS = 'blv2';
  const INDEX_KEY = `${NS}:__index`;

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function getRaw(key) {
    try {
      if (hasGM) {
        const v = GM_getValue(key);
        return (v === undefined || v === null || v === '') ? null : v;
      }
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    } catch (e) {
      Log.debug('读取缓存失败', key, e && e.message);
      return null;
    }
  }

  function setRaw(key, value) {
    try {
      if (hasGM) { GM_setValue(key, value); return true; }
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      Log.debug('写入缓存失败', key, e && e.message);
      return false;
    }
  }

  function delRaw(key) {
    try {
      if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
      else localStorage.removeItem(key);
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------ LRU */

  function readIndex() {
    const idx = getRaw(INDEX_KEY);
    return Array.isArray(idx) ? idx : [];
  }

  /** 写索引。失败 = 配额满，**返回 false 而不是抛**，交给调用方决定怎么补救 */
  function writeIndex(idx) {
    if (setRaw(INDEX_KEY, idx)) return true;
    Log.warn('缓存索引写入失败（存储配额可能已满）');
    return false;
  }

  /** 把某个**全 key** 从索引里摘掉（数据由调用方负责删）；返回是否真改了索引 */
  function dropFromIndex(fullKey) {
    const idx = readIndex();
    const rest = idx.filter(e => e && e.k !== fullKey);
    if (rest.length === idx.length) return false;
    writeIndex(rest);
    return true;
  }

  /** 淘汰最旧的 n 条（连数据一起删）；返回实际删掉了几条 */
  function evictOldest(n) {
    const idx = readIndex();
    if (!idx.length) return 0;

    const cut = Math.min(n, idx.length);
    const doomed = idx.slice(0, cut).filter(e => e && e.k);
    doomed.forEach(e => delRaw(e.k));
    writeIndex(idx.slice(cut));
    return doomed.length;
  }

  /**
   * 记一次「使用」：把 key 挪到队尾（= 最近使用），
   * 若因此超量，从队首（= 最久未使用）开始淘汰。
   */
  function touch(key) {
    const idx = readIndex().filter(e => e && e.k !== key);
    idx.push({ k: key, t: Date.now() });

    // 正常每次只写一条，所以 idx 最多到 max+1，这个 while 一般只跑一轮
    const evicted = [];
    while (idx.length > CONFIG.cacheMaxEntries) {
      const old = idx.shift();
      if (old && old.k) { delRaw(old.k); evicted.push(old.k); }
    }
    writeIndex(idx);
    if (evicted.length) Log.debug(`LRU 淘汰 ${evicted.length} 条缓存`);
  }

  /** 命中续期。已经在队尾就什么都不做 —— 否则每读一次都要写一遍索引 */
  function bump(key) {
    const idx = readIndex();
    const last = idx[idx.length - 1];
    if (last && last.k === key) return;
    touch(key);
  }

  /* ---------------------------------------------------- 对外 */

  function get(key) {
    const k = `${NS}:${key}`;
    const rec = getRaw(k);
    if (!rec || typeof rec !== 'object') return null;

    const ttl = CONFIG.cacheTtlDays * 86400000;
    if (ttl > 0 && rec.analyzedAt && Date.now() - rec.analyzedAt > ttl) {
      Log.debug(`缓存过期，丢弃 ${key}`);
      delRaw(k);
      dropFromIndex(k);   // 数据没了，索引项也得摘 —— 否则白占一个名额
      return null;
    }

    bump(k);              // 命中即续期：淘汰改按「最近使用」而非「最早写入」
    return rec;
  }

  function set(key, rec) {
    const k = `${NS}:${key}`;
    if (setRaw(k, rec)) { touch(k); return true; }

    /* 写入失败 —— 正常路径上只可能是 localStorage 配额满（GM 后端极少见）。
     * 早先这里直接 return：坏处是**旧缓存也不会被清理**，配额永远释放不出来，
     * 之后每条新测量都白跑。现在先淘汰最旧的一批腾位置，再重试一次。 */
    const freed = evictOldest(Math.max(1, Math.ceil(CONFIG.cacheMaxEntries * 0.1)));
    if (freed > 0 && setRaw(k, rec)) {
      touch(k);
      Log.warn(`缓存写入失败，淘汰 ${freed} 条最旧记录后重试成功`);
      return true;
    }
    Log.warn('缓存写入失败（存储配额已满），本次测量结果不落盘');
    return false;
  }

  /** 删单条（含索引项） */
  function remove(key) {
    const k = `${NS}:${key}`;
    delRaw(k);
    dropFromIndex(k);
  }

  function stats() {
    const idx = readIndex();
    return { entries: idx.length, maxEntries: CONFIG.cacheMaxEntries, backend: hasGM ? 'GM' : 'localStorage' };
  }

  function clear() {
    const idx = readIndex();
    idx.forEach(e => { if (e && e.k) delRaw(e.k); });
    writeIndex([]);
    Log.info(`缓存已清空（${idx.length} 条）`);
  }

  function list() {
    return readIndex().map(e => {
      const rec = getRaw(e.k);
      return { key: e.k, at: e.t, measuredLufs: rec && rec.measuredLufs, source: rec && rec.source };
    });
  }

  /* ------------------------------------------------------ 设置持久化 */

  /**
   * 面板设置（开关 / 预设 / 自定义目标与上下限）。
   *
   * ⚠️ 特意**不放进 LRU 索引**，也不参与 TTL：
   *    清除「测量缓存」是清测量结果，不该顺手把用户的设置也抹掉。
   */
  const SETTINGS_KEY = `${NS}:__settings`;

  function getSettings() {
    const s = getRaw(SETTINGS_KEY);
    return (s && typeof s === 'object') ? s : {};
  }

  function setSettings(patch) {
    const next = Object.assign(getSettings(), patch || {});
    setRaw(SETTINGS_KEY, next);
    return next;
  }

  return { get, set, remove, stats, clear, list, getSettings, setSettings };
})();
