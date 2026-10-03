/* ================================================================
 * logger.js — 带环形缓冲的日志
 *
 * 环形缓冲的作用：CDP / HUD 可以在事后把最近 300 条日志一次性取走，
 * 不必实时盯着 console。S1 的「零卡顿」验证依赖这个。
 * ================================================================ */
const Log = (() => {
  const TAG = '[响度归一]';
  const RING_MAX = 300;

  let debugOn = CONFIG.debug;
  const ring = [];

  function stringify(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function record(level, args) {
    ring.push({ t: Date.now(), level, msg: args.map(stringify).join(' ') });
    if (ring.length > RING_MAX) ring.shift();
  }

  return {
    setDebug(v) { debugOn = !!v; },
    isDebug() { return debugOn; },

    info(...a) { record('info', a); console.log(TAG, ...a); },
    warn(...a) { record('warn', a); console.warn(TAG, ...a); },
    error(...a) { record('error', a); console.error(TAG, ...a); },
    debug(...a) { record('debug', a); if (debugOn) console.log(TAG, '[dbg]', ...a); },

    /** 取走最近日志（不中断记录） */
    ring() { return ring.slice(); },
    /** 清空环形缓冲 */
    clear() { ring.length = 0; },
  };
})();
