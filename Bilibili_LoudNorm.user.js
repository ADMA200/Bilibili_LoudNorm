// ==UserScript==
// @name         B站响度归一
// @name:en      Bilibili_LoudNorm
// @namespace    https://github.com/ADMA200/Bilibili_LoudNorm
// @version      1.1.1
// @description  全片响度归一：测量整段视频的响度并按需统一增益，拉齐 B 站连播音量（投稿 / 多P / 番剧影视）。不压缩原声、不干预播放器。
// @description:en Normalizes the loudness of a whole video with a single gain, so consecutive Bilibili videos play at a consistent volume. No compression, no player interference.
// @author       Moxia9527
// @license      MIT
// @homepageURL  https://github.com/ADMA200/Bilibili_LoudNorm
// @supportURL   https://github.com/ADMA200/Bilibili_LoudNorm/issues
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @exclude      https://www.bilibili.com/video/*/play/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      hdslb.com
// @connect      bilibili.com
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * B站响度归一 —— 源码与设计文档：https://github.com/ADMA200/Bilibili_LoudNorm
 */

(function () {
'use strict';

const CONFIG = {
  version: '1.1.1',
  stage: 'S3.3.1',

  /** 总开关 */
  enabled: true,

  debug: false,

  hud: false,

  forceSamplePath: false,

  /* ---- 响度档案（§4.4） ---- */

  profile: 'standard',

  profiles: {
    standard:  { label: '标准',   targetLufs: -14, maxBoostDb: 12, minGainDb: -60 },
    dynamic:   { label: '高动态', targetLufs: -24, maxBoostDb: 12, minGainDb: -60 },
    headphone: { label: '耳机',   targetLufs: -16, maxBoostDb: 12, minGainDb: -60 },
    speaker:   { label: '外放',   targetLufs: -11, maxBoostDb: 10, minGainDb: -60 },
    night:     { label: '深夜',   targetLufs: -20, maxBoostDb:  6, minGainDb: -60 },
    /** 拖动「目标响度 / 增益上下限」滑块时自动切到这一档（值由面板写入） */
    custom:    { label: '自定义', targetLufs: -14, maxBoostDb: 12, minGainDb: -24 },
  },

  /* ---- 增益安全 ---- */

  peakCeilingDb: -1.0,

  gainRampTau: 0.04,

  bypassHotkey: { key: 'b', shift: true, alt: false, ctrl: false, meta: false },

  bypassToast: true,

  /* ---- 抽样参数（§4.2） ---- */

  /** 均匀抽取的段数（每段约 5s → 默认共约 60s 音频） */
  sampleSegments: 12,

  progressive: true,
  /** 首批段数（从 12 段里等距挑，含首尾 → 依然覆盖 0%–100% 时间轴） */
  firstBatchSegments: 6,
  /** 精修后增益与初测差多少 dB 才值得动一下（小于它就不抖了） */
  refineMinDeltaDb: 0.5,

  firstBatchEagerAt: 4,

  concurrency: 6,

  requestGapMs: 80,
  /** 单次 Range 请求超时（init/sidx 这类小请求用它） */
  fetchTimeoutMs: 15000,

  segTimeoutMs: 5000,
  segRetry: 1,
  segRetryDelayMs: 250,

  minSegmentsToProceed: 3,

  decodeConcurrency: 2,

  lumChunkFrames: 240000,

  /** 首选音频档位：30232 ≈ 132kbps 中档，解码快、响度等价 */
  preferAudioId: 30232,
  /** 不参与归一的音频档位（杜比 / Hi-Res，解码器可能不支持） */
  excludeAudioIds: [30250, 30251, 30280],

  pgcApi: 'https://api.bilibili.com/pgc/player/web/playurl',
  pgcQn: 80,
  pgcFnval: 4048,

  pgcCacheTtlMs: 10 * 60 * 1000,

  pgcSkipCodes: [-403, -404, -688, -689],
  pgcAbortCodes: [-412],

  pgcStreamWaitMs: 8000,

  /** 是否显示设置面板（左侧边，Evolved 风格） */
  panel: true,
  /** 面板在「网页全屏 / 真全屏」时完全隐藏 */
  fullscreenHide: true,
  /** 目标响度滑块范围（LUFS） */
  targetRange: [-28, -8],
  /** 增益上限滑块范围（dB） */
  maxBoostRange: [0, 18],
  /** 增益下限滑块范围（dB，取负） */
  minGainRange: [0, -60],

  /* ---- 缓存（§9） ---- */

  cacheMaxEntries: 800,
  cacheTtlDays: 30,

  streamWaitToleranceSec: 3,

  streamWaitGraceSec: 20,
  /** 等切流时的回访间隔（毫秒）。靠它轮询，durationchange 事件也会立刻唤醒 */
  streamWaitRetryMs: 700,

  viewCacheTtlMs: 10 * 60 * 1000,

  /** video 元素发现轮询间隔。必须 setInterval 而非 rAF：后台标签页 rAF 会被冻结 */
  pollIntervalMs: 300,

  mutationDebounceMs: 250,
  /** 播放器容器选择器，新 → 旧按序尝试 */
  playerSelectors: [
    '.bpx-player-container',
    '.bpx-player-primary-area',
    '#bilibili-player',
    '.bilibili-player',
  ],
};

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

const Store = (() => {

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

  /* ---- LRU ---- */

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

  /* ---- 对外 ---- */

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

  /* ---- 设置持久化 ---- */

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

const Sidx = (() => {

  /** 读一个 box 头：{type, size, headerSize}；返回 null 表示越界 */
  function readBoxHeader(view, offset) {
    if (offset + 8 > view.byteLength) return null;

    const size32 = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );

    let size = size32;
    let headerSize = 8;

    if (size32 === 1) {
      // largesize：64 位
      const hi = view.getUint32(offset + 8);
      const lo = view.getUint32(offset + 12);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      // 延伸到缓冲区末尾
      size = view.byteLength - offset;
    }

    if (size < headerSize) return null;
    return { type, size, headerSize };
  }

  function parse(input, anchor) {
    if (!input) return null;
    const base = Number.isFinite(anchor) ? anchor : 0;
    const view = input instanceof DataView
      ? input
      : new DataView(input.buffer || input, input.byteOffset || 0, input.byteLength);

    // 扫描顶层 box，定位 sidx（正常情况下第一个就是）
    let off = 0;
    let found = -1;
    let guard = 0;
    while (off + 8 <= view.byteLength && guard++ < 64) {
      const h = readBoxHeader(view, off);
      if (!h) break;
      if (h.type === 'sidx') { found = off; break; }
      off += h.size;
    }
    if (found < 0) return null;

    const h = readBoxHeader(view, found);
    let p = found + h.headerSize;

    const version = view.getUint8(p);
    p += 4; // version(1) + flags(3)

    p += 4; // reference_ID
    const timescale = view.getUint32(p);
    p += 4;

    let earliest, firstOffset;
    if (version === 1) {
      earliest = view.getUint32(p) * 4294967296 + view.getUint32(p + 4);
      p += 8;
      firstOffset = view.getUint32(p) * 4294967296 + view.getUint32(p + 4);
      p += 8;
    } else {
      earliest = view.getUint32(p);
      p += 4;
      firstOffset = view.getUint32(p);
      p += 4;
    }

    p += 2; // reserved
    const count = view.getUint16(p);
    p += 2;

    if (!timescale) return null;

    const refs = [];
    let cursor = base + firstOffset;
    let t = earliest;

    for (let i = 0; i < count; i++) {
      if (p + 12 > view.byteLength) break;
      const sizeWithType = view.getUint32(p);
      const size = sizeWithType & 0x7fffffff; // 低 31 位
      // const refType = (sizeWithType >>> 31) & 1;  // 0=media 1=index
      const duration = view.getUint32(p + 4);
      p += 12;

      refs.push({
        index: i,
        t: t / timescale,
        duration: duration / timescale,
        size,
        offset: cursor,
      });

      cursor += size;
      t += duration;
    }

    return {
      version,
      timescale,
      earliestPresentationTime: earliest / timescale,
      firstOffset,
      anchor: base,
      refs,
      /** 索引区末尾 + 1 —— 与 Content-Length 比对可验证解析正确性 */
      endOffset: cursor,
    };
  }

  /** 检查一段字节是否以指定 box 类型开头（用于验证索引基准点选对了） */
  function startsWithBox(input, type) {
    if (!input || input.byteLength < 8) return false;
    const v = input instanceof DataView
      ? input
      : new DataView(input.buffer || input, input.byteOffset || 0, input.byteLength);
    const t = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    return t === type;
  }

  function verify(parsed, contentLength) {
    if (!parsed || !Number.isFinite(contentLength)) return { ok: null, reason: 'no-data' };
    const diff = parsed.endOffset - contentLength;
    return {
      ok: diff === 0,
      endOffset: parsed.endOffset,
      contentLength,
      diff,
    };
  }

  /** 均匀抽取 want 个段（首段必取，避免片头静场把响度拉低） */
  function pickEvenly(refs, want) {
    const n = refs.length;
    if (!n) return [];
    if (n <= want) return refs.map(r => r.index);
    if (want <= 1) return [0];

    const out = [];
    for (let i = 0; i < want; i++) {
      out.push(Math.round((i * (n - 1)) / (want - 1)));
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  function pickCoarse(picks, k) {
    const n = picks.length;
    if (!n || k <= 0) return [];
    if (k >= n) return picks.slice();

    const out = [];
    for (let i = 0; i < k; i++) {
      const pos = Math.round((i * (n - 1)) / (k - 1));
      out.push(picks[pos]);
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  return { parse, verify, pickEvenly, pickCoarse, startsWithBox, readBoxHeader };
})();

const Loudness = (() => {
  const OFFSET_691 = -0.691;
  const ABS_GATE_LUFS = -70;
  const REL_GATE_LU = 10;

  /* ---- K 加权滤波器 ---- */

  /** 高架滤波：G=+3.999843853973347 dB, fc=1681.974450955533 Hz, Q=0.7071752369554196 */
  function highShelfCoeffs(fs) {
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const fc = 1681.974450955533;

    const K = Math.tan(Math.PI * fc / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;

    return {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  }

  function highPassCoeffs(fs) {
    const Q = 0.5003270373238773;
    const fc = 38.13547087602444;

    const K = Math.tan(Math.PI * fc / fs);
    const a0 = 1 + K / Q + K * K;

    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  }

  function biquadInPlace(x, c) {
    const st = biquadState();
    biquadRange(x, 0, x.length, c, st);
  }

  /** IIR 的四个延迟单元。分块滤波必须把状态带过块边界，否则块间会有跳变 */
  function biquadState() { return { x1: 0, x2: 0, y1: 0, y2: 0 }; }

  function biquadRange(x, s, e, c, st) {
    let x1 = st.x1, x2 = st.x2, y1 = st.y1, y2 = st.y2;
    for (let i = s; i < e; i++) {
      const xi = x[i];
      const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = xi;
      y2 = y1; y1 = yi;
      x[i] = yi;
    }
    st.x1 = x1; st.x2 = x2; st.y1 = y1; st.y2 = y2;
  }

  function peakOf(x) {
    let p = 0;
    for (let i = 0; i < x.length; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      if (a > p) p = a;
    }
    return p;
  }

  function concatBuffers(scope, buffers) {
    const usable = (buffers || []).filter(b => b && b.length > 0);
    if (!usable.length) return null;

    const fs = usable[0].sampleRate;
    const channels = usable.reduce((m, b) => Math.min(m, b.numberOfChannels), Infinity);
    const total = usable.reduce((a, b) => a + b.length, 0);

    const out = scope.createBuffer(channels, total, fs);
    const fade = Math.min(Math.round(0.005 * fs), Math.floor(total / 8));

    let off = 0;
    for (const b of usable) {
      for (let c = 0; c < channels; c++) {
        const dst = out.getChannelData(c);
        const src = b.getChannelData(c);
        dst.set(src, off);

        // 首尾淡入淡出
        for (let i = 0; i < fade; i++) {
          const w = i / fade;
          dst[off + i] *= w;
          dst[off + b.length - 1 - i] *= w;
        }
      }
      off += b.length;
    }
    return out;
  }

  /* ---- 主入口 ---- */

  async function measure(audioBuffer, opts) {
    const o = opts || {};
    const t0 = Date.now();

    const fs = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const frames = audioBuffer.length;

    const hs = highShelfCoeffs(fs);
    const hp = highPassCoeffs(fs);

    const z = new Float64Array(frames + 1);
    let truePeakLinear = 0;

    const chunk = Math.max(1, Math.min(frames, Math.floor(CONFIG.lumChunkFrames) || frames));
    const wantYield = typeof o.onYield === 'function';
    let lastYield = Date.now();

    for (let ch = 0; ch < channels; ch++) {
      const src = audioBuffer.getChannelData(ch);
      const buf = new Float32Array(frames);
      buf.set(src);

      const st1 = biquadState();
      const st2 = biquadState();

      for (let s = 0; s < frames; s += chunk) {
        const e = Math.min(s + chunk, frames);

        // 未加权峰值（真峰值近似）——必须在加权改写之前扫
        let pk = 0;
        for (let i = s; i < e; i++) {
          const a = buf[i] < 0 ? -buf[i] : buf[i];
          if (a > pk) pk = a;
        }
        if (pk > truePeakLinear) truePeakLinear = pk;

        // K 加权（状态跨块延续，结果与一次性滤波逐位相同）
        biquadRange(buf, s, e, hs, st1);
        biquadRange(buf, s, e, hp, st2);

        for (let i = s; i < e; i++) {
          const v = buf[i];
          z[i] += v * v;
        }

        if (wantYield && Date.now() - lastYield > 8) {
          lastYield = Date.now();
          await o.onYield(ch);
        }
      }
    }

    /* 声道能量直接相加（不除以声道数）—— 见上面 z 的说明 */

    /* ---- 分块与门限 ---- */

    const blockLen = Math.round(0.4 * fs);
    const stepLen = Math.round(0.1 * fs);

    const blockEnergy = [];   // 每个块的 Σz / blockLen
    if (frames >= blockLen) {
      for (let s = 0; s + blockLen <= frames; s += stepLen) {
        let sum = 0;
        // 分片累加，避免超长循环阻塞
        for (let i = s; i < s + blockLen; i++) sum += z[i];
        blockEnergy.push(sum / blockLen);
      }
    }

    const lufsOf = (energy) => OFFSET_691 + 10 * Math.log10(energy > 0 ? energy : 1e-12);

    // d) 绝对门限
    const stage1 = blockEnergy.filter(e => lufsOf(e) >= ABS_GATE_LUFS);

    let integrated = null;
    let stage2 = [];
    if (stage1.length) {
      // e) 相对门限
      let sum = 0;
      for (let i = 0; i < stage1.length; i++) sum += stage1[i];
      const meanEnergy = sum / stage1.length;
      const gamma = lufsOf(meanEnergy) - REL_GATE_LU;

      stage2 = stage1.filter(e => lufsOf(e) >= gamma);
      const use = stage2.length ? stage2 : stage1;

      let sum2 = 0;
      for (let i = 0; i < use.length; i++) sum2 += use[i];
      integrated = lufsOf(sum2 / use.length);
    }

    const truePeakDb = 20 * Math.log10(truePeakLinear > 0 ? truePeakLinear : 1e-12);

    return {
      lufs: integrated === null ? null : +integrated.toFixed(2),
      truePeakDb: +truePeakDb.toFixed(2),
      truePeakLinear,
      blocks: blockEnergy.length,
      blocksAfterAbs: stage1.length,
      blocksAfterRel: stage2.length,
      frames,
      sampleRate: fs,
      channels,
      processedMs: Date.now() - t0,
    };
  }

  return {
    measure, concatBuffers, highShelfCoeffs, highPassCoeffs,
    biquadInPlace, biquadRange, biquadState,
  };
})();

const GainPlanner = (() => {

  function currentProfile() {
    return CONFIG.profiles[CONFIG.profile] || CONFIG.profiles.standard;
  }

  function plan(input) {
    const p = currentProfile();
    const targetLufs = p.targetLufs;

    const measured = input && input.measuredLufs;
    if (!Number.isFinite(measured)) {
      return {
        gainDb: 0, targetLufs, limited: false,
        limitReason: 'no-measurement', ceilingHeadroom: null, rawGainDb: null,
      };
    }

    const rawGainDb = targetLufs - measured;
    let gainDb = rawGainDb;
    let limited = false;
    let limitReason = null;
    let ceilingHeadroom = null;

    const tp = input.truePeakDb;
    if (Number.isFinite(tp)) {
      ceilingHeadroom = CONFIG.peakCeilingDb - tp;

      // 只夹「提升」的部分；衰减不受峰值约束
      const maxAllowedGain = Math.max(0, ceilingHeadroom);
      if (rawGainDb > maxAllowedGain) {
        gainDb = maxAllowedGain;
        limited = true;

        limitReason = ceilingHeadroom < 0
          ? '+0 dB（素材已过峰）'
          : `+${ceilingHeadroom.toFixed(1)} dB（防止爆音）`;
      }
    }

    const cap = Number.isFinite(p.maxBoostDb) ? p.maxBoostDb : 12;
    if (gainDb > cap) {
      gainDb = cap;
      limited = true;
      limitReason = `档案上限 +${cap} dB`;
    }

    const floor = Number.isFinite(p.minGainDb) ? p.minGainDb : -60;
    if (gainDb < floor) {
      gainDb = floor;
      limited = true;
      limitReason = `档案下限 ${floor} dB`;
    }

    return {
      gainDb: +gainDb.toFixed(2),
      targetLufs,
      limited,
      limitReason,
      ceilingHeadroom: ceilingHeadroom === null ? null : +ceilingHeadroom.toFixed(2),
      rawGainDb: +rawGainDb.toFixed(2),
    };
  }

  /** 预设档案列表，供 UI 用 */
  function listProfiles() {
    return Object.keys(CONFIG.profiles).map(k => Object.assign({ key: k }, CONFIG.profiles[k]));
  }

  return { plan, currentProfile, listProfiles };
})();

const StateReader = (() => {

  /** 页面上下文（Tampermonkey 沙箱下必须用 unsafeWindow 才能读到 B 站注入的全局量） */
  function page() {
    return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  }

  function query(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  function bvid() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (m) return m[1];
    const fromQuery = query('bvid');
    if (fromQuery && /^BV[0-9A-Za-z]+$/.test(fromQuery)) return fromQuery;
    return null;
  }

  function pIndex() {
    const n = parseInt(query('p') || '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function kind() {
    const p = location.pathname;
    if (/^\/video\//.test(p)) return 'video';
    if (/^\/list\//.test(p)) return 'video';
    if (/^\/bangumi\/play\//.test(p)) return 'pgc';
    return 'other';
  }

  function epId() {
    const m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
    if (m) return m[1];
    const q = query('ep_id');
    if (q && /^\d+$/.test(q)) return q;
    return null;
  }

  function seasonId() {
    const m = location.pathname.match(/\/bangumi\/play\/ss(\d+)/);
    if (m) return m[1];
    const q = query('season_id');
    if (q && /^\d+$/.test(q)) return q;
    return null;
  }

  /** 番剧 SSR 里的 arc（含 cid / bvid）—— 位置实测：__playinfo__.result.arc */
  function pgcArc() {
    try {
      const pi = page().__playinfo__;
      const r = pi && pi.result;
      return (r && r.arc) || null;
    } catch (e) { return null; }
  }

  let pgcRef = null;
  let pgcRefEp = null;

  function pgcFresh() {
    const ep = epId();
    if (!ep) return false;
    let obj = null;
    try { obj = page().__playinfo__ || null; } catch (e) { obj = null; }
    if (!obj || !obj.result) return false;
    if (obj !== pgcRef) { pgcRef = obj; pgcRefEp = ep; return true; }
    return pgcRefEp === ep;
  }

  /** SSR 里能拿到的时长（秒）—— 只在新鲜时采信（切集后那份属于上一个 ep） */
  function pgcSsrDuration(fresh) {
    if (!fresh) return null;
    try {
      const r = page().__playinfo__.result;
      const vi = r && r.video_info;
      const d = vi && vi.dash && Number.isFinite(vi.dash.duration) ? vi.dash.duration : null;
      if (d) return d;
      const tl = vi && Number.isFinite(vi.timelength) ? vi.timelength
        : (Number.isFinite(r.timelength) ? r.timelength : null);
      return Number.isFinite(tl) ? +(tl / 1000).toFixed(1) : null;
    } catch (e) { return null; }
  }

  function pgcKey() {
    const ep = epId();
    if (!ep) return null;
    const arc = pgcArc();
    const fresh = pgcFresh();
    return {
      kind: 'pgc',
      epId: ep,
      seasonId: seasonId(),
      cid: fresh && arc && Number.isFinite(arc.cid) ? arc.cid : null,
      bvid: fresh && arc && arc.bvid ? arc.bvid : null,
      p: 1,
      pageCount: null,
      title: null,
      duration: pgcSsrDuration(fresh),
      stateFresh: fresh,
    };
  }

  /** 统一入口：当前页面的分析目标（普通投稿 / 番剧） */
  function target() {
    const k = kind();
    if (k === 'pgc') return pgcKey();
    if (k === 'video') {
      const v = videoKey();
      return v ? Object.assign({ kind: 'video' }, v) : null;
    }
    return null;
  }

  function initialState() {
    try { return page().__INITIAL_STATE__ || null; } catch (e) { return null; }
  }

  function stateBvid(st) {
    if (!st) return null;
    if (typeof st.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(st.bvid)) return st.bvid;
    const vd = st.videoData;
    if (vd && typeof vd.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(vd.bvid)) return vd.bvid;
    return null;
  }

  function pageFresh() {
    const urlBv = bvid();
    if (!urlBv) return false;
    return stateBvid(initialState()) === urlBv;
  }

  function videoKey() {
    const bv = bvid();
    if (!bv) return null;

    const p = pIndex();
    const st = initialState();
    const fresh = stateBvid(st) === bv;

    let cid = null;
    let aid = null;
    let pageCount = null;
    let title = null;
    let duration = null;

    // 【关键】过期状态一律不采信 —— 里面的 cid/pages 属于上一个视频
    if (fresh) {
      const vd = st.videoData || null;
      const pages = vd && Array.isArray(vd.pages) ? vd.pages : null;

      if (pages && pages.length) {
        pageCount = pages.length;
        const cur = pages[p - 1] || pages[0];
        if (cur) {
          cid = cur.cid || null;
          duration = Number.isFinite(cur.duration) ? cur.duration : null;
          title = cur.part || null;
        }
      }

      if (!cid && Number.isFinite(st.cid)) cid = st.cid;
      if (!cid && Number.isFinite(vd && vd.cid)) cid = vd.cid;

      aid = Number.isFinite(st.aid) ? st.aid : (Number.isFinite(vd && vd.aid) ? vd.aid : null);
      if (!title && vd && vd.title) title = vd.title;
    }

    return {
      bvid: bv,
      p,
      cid: cid || null,
      aid: aid || null,
      pageCount,
      title,
      duration,
      stateFresh: fresh,
    };
  }

  /** 缓存 key：普通投稿 v:{bvid}:{cid}（cid 未知时退化为 p）；番剧 p:{ep_id} */
  function cacheKey(info) {
    if (!info) return null;
    if (info.kind === 'pgc') return info.epId ? `p:${info.epId}` : null;
    if (!info.bvid) return null;
    if (info.cid) return `v:${info.bvid}:${info.cid}`;
    return `v:${info.bvid}:p${info.p}`;
  }

  return {
    videoKey, cacheKey, page, query, pageFresh, stateBvid, bvid, pIndex,

    kind, epId, seasonId, pgcKey, pgcFresh, pgcArc, target,

    forgetPgc() { pgcRef = null; pgcRefEp = null; },
  };
})();

const PlayInfo = (() => {
  const API = 'https://api.bilibili.com/x/player/playurl';
  const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';

  /** 普通投稿的页型字段名统一是 camelCase，但仍做双读以防改版 */
  function pick(obj) {
    for (let i = 1; i < arguments.length; i++) {
      const k = arguments[i];
      if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return null;
  }

  function parseRange(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    return { start: +m[1], end: +m[2] };
  }

  function normalizeAudio(a) {
    const sb = pick(a, 'SegmentBase', 'segment_base') || {};
    const backup = pick(a, 'backupUrl', 'backup_url') || [];
    return {
      id: pick(a, 'id'),
      url: pick(a, 'baseUrl', 'base_url'),
      backup: Array.isArray(backup) ? backup : [],
      mimeType: pick(a, 'mimeType', 'mime_type') || 'audio/mp4',
      codecs: pick(a, 'codecs'),
      bandwidth: pick(a, 'bandwidth') || 0,
      initRange: parseRange(pick(sb, 'Initialization', 'initialization')),
      indexRange: parseRange(pick(sb, 'indexRange', 'index_range')),
    };
  }

  /** 挑音频轨：排除杜比/Hi-Res（解码器未必支持）→ 优先中档 → 否则码率最高 */
  function chooseAudio(list) {
    const usable = list.filter(a => a.url && a.initRange && a.indexRange);
    if (!usable.length) return null;

    const safe = usable.filter(a => CONFIG.excludeAudioIds.indexOf(a.id) < 0);
    const pool = safe.length ? safe : usable;

    const preferred = pool.find(a => a.id === CONFIG.preferAudioId);
    if (preferred) return preferred;

    return pool.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
  }

  function normalizeVolume(v) {
    if (!v) return null;
    const measured = pick(v, 'measured_i', 'measuredI');
    if (!Number.isFinite(measured)) return null;
    return {
      measuredI: measured,
      measuredLra: pick(v, 'measured_lra', 'measuredLra'),
      measuredTp: pick(v, 'measured_tp', 'measuredTp'),
      measuredThreshold: pick(v, 'measured_threshold', 'measuredThreshold'),
      targetI: pick(v, 'target_i', 'targetI'),
      targetOffset: pick(v, 'target_offset', 'targetOffset'),
      sceneArgs: pick(v, 'multi_scene_args', 'multiSceneArgs') || null,
    };
  }

  function num(v) { return Number.isFinite(v) ? v : null; }

  function isPreviewOf(result, vi, dash, durl, timelength) {
    if ((vi && vi.is_preview === 1) || result.is_preview === 1) return true;
    if (Number.isFinite(result.error_code) && result.error_code === -10403) return true;
    if (!dash && durl.length > 0) return true;
    if (durl.length && Number.isFinite(timelength) && Number.isFinite(durl[0] && durl[0].length)
      && durl[0].length < timelength - 1000) return true;
    const pd = result.play_check && result.play_check.play_detail;
    if (pd && pd !== 'PLAY_WHOLE') return true;
    return false;
  }

  function normalizePgc(result, origin) {
    if (!result) return null;
    const vi = result.video_info || null;

    const dash = (vi && vi.dash) || result.dash || null;
    const audios = dash && Array.isArray(dash.audio) ? dash.audio.map(normalizeAudio) : [];
    const audio = chooseAudio(audios);

    const durl = Array.isArray(result.durl) ? result.durl
      : (Array.isArray(result.durls) ? result.durls : []);
    const timelength = num(vi && vi.timelength) !== null ? num(vi.timelength) : num(result.timelength);

    const isDrm = !!(result.is_drm || (vi && vi.is_drm)
      || (dash && dash.drm_tech_type) || result.widevine_pssh);
    const isPreview = isPreviewOf(result, vi, dash, durl, timelength);

    let duration = dash && Number.isFinite(dash.duration) ? dash.duration : null;
    if (!duration && Number.isFinite(timelength)) duration = timelength / 1000;

    const arc = result.arc || null;

    return {
      origin,
      kind: 'pgc',
      audio,
      audios,
      duration,
      volumeMeta: normalizeVolume((vi && vi.volume) || result.volume),
      isDrm,
      isPreview,
      hasDurlOnly: !dash && durl.length > 0,
      quality: pick(vi || result, 'quality'),
      cid: arc && Number.isFinite(arc.cid) ? arc.cid : null,
      bvid: arc && arc.bvid ? arc.bvid : null,
      raw: result,
    };
  }

  function normalize(data, origin) {
    if (!data) return null;

    const dash = data.dash || null;
    const audios = dash && Array.isArray(dash.audio) ? dash.audio.map(normalizeAudio) : [];
    const audio = chooseAudio(audios);

    const hasDurlOnly = !dash && Array.isArray(data.durl) && data.durl.length > 0;
    const isDrm = !!(data.is_drm || (dash && dash.drm_tech_type) || data.widevine_pssh);
    const isPreview = data.is_preview === 1 || data.error_code === -10403;

    // 时长：dash.duration 优先（秒），退 timelength（毫秒）
    let duration = null;
    if (dash && Number.isFinite(dash.duration)) duration = dash.duration;
    else if (Number.isFinite(data.timelength)) duration = data.timelength / 1000;

    return {
      origin,
      audio,
      audios,
      duration,
      volumeMeta: normalizeVolume(data.volume),
      isDrm,
      isPreview,
      hasDurlOnly,
      quality: pick(data, 'quality'),
      /** 原始 data 对象引用 —— 作为「这份 playinfo 有没有被换过」的身份标识 */
      raw: data,
    };
  }

  /* ---- 取数：页面 ---- */

  /** 从页面读（零请求）。普通投稿吃 `.data`，番剧/影视吃 `.result`。 */
  function fromPage() {
    let pi = null;
    try {
      const p = StateReader.page();
      pi = p.__playinfo__ || null;
    } catch (e) { pi = null; }
    if (!pi) return null;

    if (pi.data) {
      const out = normalize(pi.data, 'page');
      if (out) out.raw = pi.data;
      return out;
    }
    if (pi.result) {
      const out = normalizePgc(pi.result, 'page');
      if (out) out.raw = pi.result;
      return out;
    }
    return null;
  }

  /* ---- 可信度：这份 playinfo 算不算数 ---- */

  /** 上一次被采信的 playinfo 对象引用 + 它对应的 key */
  let acceptedRef = null;
  let acceptedKey = null;

  function fmtSec(v) { return Number.isFinite(v) ? v.toFixed(1) : '?'; }

  function trustPlayinfo(page, info, key, videoEl) {
    if (!page) return { ok: false, why: '页面没有 __playinfo__' };

    const isPgc = page.kind === 'pgc';
    const sameObject = !!page.raw && page.raw === acceptedRef;

    if (sameObject && acceptedKey === key) return { ok: true, why: 'reuse-accepted' };
    if (sameObject) {
      // 同一个对象却换了 key（普通投稿切分P / 番剧切集）→ 它装的是别的目标的流
      return { ok: false, why: isPgc ? '同一个 __playinfo__ 对象换了集（切集后未刷新）' : '同一个 __playinfo__ 对象换了目标（切分P 后未刷新）' };
    }

    // ⚠️ 番剧页没有 __INITIAL_STATE__，不能用 bvid 交叉校验 →

    const fresh = isPgc ? StateReader.pgcFresh() : StateReader.pageFresh();
    if (fresh) return { ok: true, why: isPgc ? 'ssr-fresh(pgc)' : 'ssr-fresh' };

    const isReplaced = acceptedRef !== null && page.raw !== acceptedRef;
    const durOk = Number.isFinite(page.duration)
      && Number.isFinite(videoEl && videoEl.duration)
      && Math.abs(page.duration - videoEl.duration) <= 2;

    if (isReplaced && durOk) return { ok: true, why: 'replaced+duration-match' };

    return {
      ok: false,
      why: isReplaced
        ? `换过对象但时长不符（__playinfo__ ${fmtSec(page.duration)}s vs 播放器 ${fmtSec(videoEl && videoEl.duration)}s）`
        : `页面状态未刷新（__playinfo__ 时长 ${fmtSec(page.duration)}s，无替换证据）`,
    };
  }

  /* ---- 取数：接口兜底 ---- */

  const viewCache = new Map();

  async function fetchView(bvid) {
    const hit = viewCache.get(bvid);
    if (hit && Date.now() - hit.at < CONFIG.viewCacheTtlMs) return hit;

    const url = `${VIEW_API}?bvid=${encodeURIComponent(bvid)}`;
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`view HTTP ${res.status}`);

    const json = await res.json();
    if (!json || json.code !== 0 || !json.data) {
      throw new Error(`view code=${json && json.code} ${json && json.message || ''}`);
    }

    const pages = (Array.isArray(json.data.pages) ? json.data.pages : []).map(x => ({
      cid: x.cid,
      duration: Number.isFinite(x.duration) ? x.duration : null,
      part: x.part || null,
    }));

    const rec = {
      at: Date.now(),
      aid: json.data.aid || null,
      title: json.data.title || null,
      pages,
    };
    viewCache.set(bvid, rec);
    return rec;
  }

  async function resolveVideo(info) {
    const rec = await fetchView(info.bvid);
    if (!rec.pages.length) throw new Error('view 未返回分P 列表');

    const page = rec.pages[info.p - 1] || rec.pages[0];
    const out = {
      cid: page.cid || null,
      duration: page.duration,
      title: page.part || rec.title,
      pageCount: rec.pages.length,
      aid: rec.aid,
    };
    Log.info(`接口补全 · bvid=${info.bvid} p=${info.p}/${rec.pages.length} → cid=${out.cid} 时长=${fmtSec(out.duration)}s`);
    return out;
  }

  /** 兼容旧调用名 */
  async function resolveCid(info) {
    if (info && info.cid) return info.cid;
    return (await resolveVideo(info)).cid;
  }

  const pgcCache = new Map();

  /** 带错误码标记的错误：skip=跳过分析、fatal=立即停手不重试 */
  function pgcErr(code, msg, info) {
    const e = new Error(`pgc playurl code=${code} ${msg || ''}（ep_id=${info && info.epId}）`);
    e.code = code;
    if (CONFIG.pgcAbortCodes && CONFIG.pgcAbortCodes.indexOf(code) >= 0) e.fatal = true;
    if (CONFIG.pgcSkipCodes && CONFIG.pgcSkipCodes.indexOf(code) >= 0) e.skip = true;
    return e;
  }

  const PGC_RETRY_CODES = [-352, -799];

  async function pgcFetchOnce(info) {
    const url = `${CONFIG.pgcApi}?ep_id=${encodeURIComponent(info.epId)}`
      + `&qn=${CONFIG.pgcQn}&fnval=${CONFIG.pgcFnval}&fourk=1&platform=web`;

    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`pgc playurl HTTP ${res.status}`);

    const json = await res.json();
    const topCode = json && json.code;
    const result = json && json.result;

    // ⚠️ 错误码要看两处：顶层 code 与 result.error_code（试看时顶层是 0、真错误在后一处）
    const innerCode = result && Number.isFinite(result.error_code) ? result.error_code : null;

    if (topCode !== 0) throw pgcErr(topCode, json && json.message, info);
    if (innerCode !== null && innerCode !== 0 && innerCode !== -10403) {
      throw pgcErr(innerCode, result && result.message, info);
    }
    if (!result) throw new Error(`pgc playurl 无 result（code=${topCode} ${json && json.message || ''}）`);

    const norm = normalizePgc(result, 'api');
    pgcCache.set(info.epId, { at: Date.now(), val: norm });
    return norm;
  }

  async function fromPgcApi(info) {
    if (!info || !info.epId) throw new Error('缺少 ep_id，无法调 pgc playurl');

    const hit = pgcCache.get(info.epId);
    if (hit && Date.now() - hit.at < CONFIG.pgcCacheTtlMs) {
      Log.info(`番剧接口命中短缓存 · ep=${info.epId}`);
      return hit.val;
    }

    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await pgcFetchOnce(info);
      } catch (e) {
        last = e;
        if (e.fatal || e.skip) throw e;                       // 立即停手 / 跳过，不重试
        if (PGC_RETRY_CODES.indexOf(e.code) < 0) throw e;     // 其它错误码不重试
        Log.warn(`pgc playurl code=${e.code} → 退避重试（第 ${attempt + 1} 次）`);
        await new Promise(r => setTimeout(r, 300 + attempt * 400));
      }
    }
    throw last;
  }

  /** 回落：调接口取流 */
  async function fromApi(info) {
    if (info && info.kind === 'pgc') return fromPgcApi(info);

    if (!info || !info.bvid) throw new Error('缺少 bvid，无法调 playurl');
    if (!info.cid) throw new Error('缺少 cid，无法调 playurl');

    const url = `${API}?bvid=${encodeURIComponent(info.bvid)}&cid=${encodeURIComponent(info.cid)}`
      + '&platform=web&high_quality=1&fnval=4048&qn=80';

    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`playurl HTTP ${res.status}`);

    const json = await res.json();
    if (!json || json.code !== 0) {
      throw new Error(`playurl code=${json && json.code} ${json && json.message || ''}`
        + `（bvid=${info.bvid} cid=${info.cid}）`
        + `${json && json.code === -412 ? ' · IP 风控' : ''}`);
    }
    return normalize(json.data, 'api');
  }

  async function get(info, videoEl, key) {
    let staleIgnored = false;
    const page = fromPage();

    if (page) {
      const t = trustPlayinfo(page, info, key || (info && info.bvid), videoEl);

      if (t.ok && (page.audio || page.volumeMeta)) {
        acceptedRef = page.raw;
        acceptedKey = key || (info && info.bvid);
        Log.info(`取流来源：页面 __playinfo__（零请求，判据=${t.why}）· 元数据 ${page.volumeMeta ? '有' : '无'} · dash ${page.audio ? '有' : '无'}`);
        return { info: page, staleIgnored, why: t.why };
      }

      if (!t.ok) {
        staleIgnored = true;
        Log.warn(`页面 __playinfo__ 不可信 → 回落接口 · ${t.why}`);
      } else {
        Log.info('页面 __playinfo__ 可信但没有可用音频轨/元数据 → 回落接口');
      }
    } else {
      Log.info('页面没有 __playinfo__ → 直接走接口');
    }

    const api = await fromApi(info);
    Log.info(`取流来源：接口 playurl · 元数据 ${api && api.volumeMeta ? '有' : '无'} · dash ${api && api.audio ? '有' : '无'}`);
    return { info: api, staleIgnored, why: 'api' };
  }

  function forget() {
    acceptedRef = null;
    acceptedKey = null;
    pgcCache.clear();
    try { StateReader.forgetPgc(); } catch (e) { /* 忽略 */ }
  }

  return {
    get, fromPage, fromApi, normalize, normalizePgc, chooseAudio,
    resolveCid, resolveVideo, trustPlayinfo, forget,

    fromPgcApi,
  };
})();

const Sampler = (() => {

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---- 网络层 ---- */

  async function fetchRange(url, start, end, label, timeoutMs, retries) {
    const rangeValue = `bytes=${start}-${end}`;
    const expected = end - start + 1;
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : CONFIG.fetchTimeoutMs;
    const maxTries = 1 + (Number.isFinite(retries) ? Math.max(0, retries) : 0);

    const t0 = Date.now();

    const tryFetch = async () => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, budget);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Range: rangeValue },
          credentials: 'omit',
          cache: 'default',
          signal: ctrl ? ctrl.signal : undefined,
        });
        clearTimeout(timer);
        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.arrayBuffer();
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    };

    const tryGM = () => new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no-gm'));
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { Range: rangeValue, Referer: 'https://www.bilibili.com/' },
          responseType: 'arraybuffer',
          timeout: budget,
          onload: (r) => {
            if (r.status === 200 || r.status === 206) resolve(r.response);
            else reject(new Error(`GM HTTP ${r.status}`));
          },
          onerror: () => reject(new Error('GM 网络错误')),
          ontimeout: () => reject(new Error('GM 超时')),
        });
      } catch (e) { reject(e); }
    });

    let lastErr = null;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      let buf = null;
      let via = 'fetch';
      try {
        buf = await tryFetch();
      } catch (e) {
        if (typeof GM_xmlhttpRequest === 'function') {
          Log.warn(`Range 请求 fetch 失败（${e && e.message}），改走 GM_xmlhttpRequest 重试`);
          buf = await tryGM();
          via = 'gm';
        } else {
          lastErr = e;
          if (attempt < maxTries - 1) { await sleep(200); continue; }
          throw e;
        }
      }

      const ms = Date.now() - t0;
      Log.debug(`Range ${label} · ${rangeValue} · ${buf.byteLength}B / 期望 ${expected}B · ${ms}ms · ${via}`);
      return buf;
    }
    throw lastErr || new Error('Range 请求失败');
  }

  async function pacedPool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    let lastStart = 0;

    async function runner() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;

        const wait = lastStart + CONFIG.requestGapMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastStart = Date.now();

        out[i] = await worker(items[i], i);
      }
    }

    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, runner));
    return out;
  }

  /* ---- 准备：取索引 ---- */

  async function prepare(audio, onStage, anchorOverride) {
    const stage = onStage || function () {};

    if (!audio || !audio.url) throw new Error('缺少音频地址');
    if (!audio.initRange || !audio.indexRange) throw new Error('缺少 SegmentBase（init/index range）');

    stage('index');
    const t0 = Date.now();

    const at = { initMs: null, indexMs: null };
    const [initBuf, idxBuf] = await Promise.all([
      fetchRange(audio.url, audio.initRange.start, audio.initRange.end, 'init')
        .then(b => { at.initMs = Date.now() - t0; return b; }),
      fetchRange(audio.url, audio.indexRange.start, audio.indexRange.end, 'sidx')
        .then(b => { at.indexMs = Date.now() - t0; return b; }),
    ]);

    // sidx box 之后的第一个字节就是 first_offset 的基准点
    const anchor = Number.isFinite(anchorOverride) ? anchorOverride : (audio.indexRange.end + 1);
    const parsed = Sidx.parse(idxBuf, anchor);
    if (!parsed || !parsed.refs.length) throw new Error('sidx 解析失败');

    const picks = Sidx.pickEvenly(parsed.refs, CONFIG.sampleSegments);

    Log.info(`sidx 解析成功 · v${parsed.version} · timescale=${parsed.timescale} · ${parsed.refs.length} 段 · 单段 ${parsed.refs[0].duration.toFixed(3)}s · 基准点=${parsed.anchor} · 索引末尾 offset=${parsed.endOffset}`);

    return {
      initBuf,
      indexBytes: idxBuf.byteLength,
      parsed,
      refs: parsed.refs,
      picks,
      anchor,
      initMs: at.initMs,
      indexMs: at.indexMs,
      prepMs: Date.now() - t0,
    };
  }

  /* ---- 抽样：分批下载 ---- */

  function download(refs, audio, onStage, opts) {
    const o = opts || {};
    const label = o.label || 'seg';
    const total = refs.length;
    const wantAtLeast = Number.isFinite(o.wantAtLeast) ? Math.max(1, o.wantAtLeast) : 0;

    const out = new Array(total).fill(null);
    const perSeg = [];
    let done = 0;
    let dropped = 0;
    let okCount = 0;
    let earlyFired = false;

    const t0 = Date.now();

    let earlyResolve = null;
    const early = new Promise(res => { earlyResolve = res; });

    function pack() {
      const segs = out.filter(Boolean);
      const sorted = perSeg.slice().sort((a, b) => a - b);
      return {
        segs,
        requested: total,
        ok: segs.length,
        dropped,
        bytes: segs.reduce((a, s) => a + s.buf.byteLength, 0),
        seconds: segs.reduce((a, s) => a + s.duration, 0),
        /** 本批**申请**的音频总时长（含失败段）—— 覆盖率的分母 */
        requestedSeconds: refs.reduce((a, r) => a + r.duration, 0),
        wallMs: Date.now() - t0,
        slowestMs: sorted.length ? sorted[sorted.length - 1] : null,
        medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        /** 是否为「够用即开工」的那一版快照 */
        partial: false,
      };
    }

    const all = (async () => {
      await pacedPool(refs, CONFIG.concurrency, async (r, i) => {
        const s0 = Date.now();
        let buf = null;
        let err = null;
        let attempts = 0;

        for (let attempt = 0; attempt <= CONFIG.segRetry; attempt++) {
          attempts = attempt + 1;
          try {
            buf = await fetchRange(audio.url, r.offset, r.offset + r.size - 1,
              `${label}#${r.index}`, CONFIG.segTimeoutMs);
            err = null;
            break;
          } catch (e) {
            err = e;
            if (attempt < CONFIG.segRetry) {
              Log.warn(`第 ${r.index} 段失败（${(e && e.message) || e}）→ ${CONFIG.segRetryDelayMs}ms 后重试`);
              await sleep(CONFIG.segRetryDelayMs);
            }
          }
        }

        const ms = Date.now() - s0;
        if (buf) {
          out[i] = {
            index: r.index, t: r.t, duration: r.duration,
            size: r.size, buf, ms, attempts,
          };
          perSeg.push(ms);
          okCount++;

          if (wantAtLeast && !earlyFired && okCount >= wantAtLeast) {
            earlyFired = true;
            const snap = pack();
            snap.partial = true;
            Log.info(`抽样「够用即开工」· 已到 ${okCount}/${total} 段（阈值 ${wantAtLeast}）→ 先交给上层计算，其余继续在后台取`);
            earlyResolve(snap);
          }
        } else {
          dropped++;
          Log.warn(`第 ${r.index} 段彻底失败（${attempts} 次尝试）→ 跳过，本次抽样少一段：${(err && err.message) || err}`);
        }

        done++;
        if (typeof o.onProgress === 'function') o.onProgress(done, total, dropped);
      });
      return pack();
    })();

    // 兜底：一批都没凑够阈值（段太少 / 大面积失败）时，early 也得兑现
    all.then(r => earlyResolve(r), () => earlyResolve(pack()));

    return { early, all };
  }

  /** init + 单片段 → 一个可独立解码的 fMP4 */
  function fragmentBlob(initBuf, segBuf, mimeType) {
    return new Blob([initBuf, segBuf], { type: mimeType || 'audio/mp4' });
  }

  return { prepare, download, fragmentBlob, fetchRange, pacedPool };
})();

const AudioEngine = (() => {
  let ctx = null;
  let masterGain = null;

  /** 已成功 createMediaElementSource 的元素（防重复调用抛 InvalidStateError） */
  const attached = new WeakSet();
  /** 尝试接管但失败的元素（如被 B 站杜比音效占用），不再重试以免刷屏 */
  const failed = new WeakSet();
  /** 因 ctx 未 running 而暂缓接管的元素，等用户手势后补上 */
  const pending = new Set();

  let gestureArmed = false;

  /** 当前**实际**施加的增益（dB）。分析未完成 / 未接管 / 旁路中时是 0 */
  let appliedGainDb = 0;

  let desiredGainDb = 0;

  /** 旁路开关：true = 听原声（不施加增益），分析照跑、结果照存 */
  let bypass = false;

  const stats = { attached: 0, failed: 0, deferred: 0, resumes: 0, gainSets: 0, bypassToggles: 0 };

  /* ---- 上下文 ---- */

  function ensureContext() {
    if (ctx) return ctx;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      Log.error('浏览器不支持 AudioContext，放弃接管');
      return null;
    }

    try {
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1.0; // 分析完成前保持原声
      masterGain.connect(ctx.destination);

      const base = typeof ctx.baseLatency === 'number' ? (ctx.baseLatency * 1000).toFixed(1) : '?';
      const out = typeof ctx.outputLatency === 'number' ? (ctx.outputLatency * 1000).toFixed(1) : '?';
      Log.info(`AudioContext 就绪 · state=${ctx.state} · rate=${ctx.sampleRate}Hz · baseLatency=${base}ms · outputLatency=${out}ms`);
    } catch (e) {
      Log.error('AudioContext 创建失败', e && e.message);
      ctx = null;
      masterGain = null;
    }
    return ctx;
  }

  async function ensureRunning() {
    if (!ctx) return false;
    if (ctx.state === 'running') return true;

    try {
      await ctx.resume();
      stats.resumes++;
    } catch (e) {
      Log.warn('ctx.resume() 被拒绝', e && e.message);
    }

    const ok = ctx.state === 'running';
    Log.debug(`ensureRunning → ${ctx.state}（${ok ? '可接管' : '暂不可接管'}）`);
    return ok;
  }

  /* ---- 接管 ---- */

  function isVideoEl(el) {
    // 用 tagName 而非 instanceof：userscript 沙箱下 instanceof 会因 realm 不同而失效
    return !!el && el.tagName === 'VIDEO';
  }

  function isAttached(el) { return attached.has(el); }

  async function tryAttach(el) {
    if (!isVideoEl(el)) return false;
    if (attached.has(el)) return true;
    if (failed.has(el)) return false;
    if (pending.has(el)) return false;

    const c = ensureContext();
    if (!c) return false;

    // 铁律 3：ctx 不 running 就绝不接管，否则必然静音
    if (c.state !== 'running') {
      const running = await ensureRunning();
      if (!running) {
        pending.add(el);
        stats.deferred++;
        Log.info('AudioContext 尚未 running → 暂缓接管（此刻保持原声，绝不静音）');
        armGestureHook();
        return false;
      }
    }

    return doAttach(el);
  }

  function doAttach(el) {
    try {
      const source = ctx.createMediaElementSource(el);
      source.connect(masterGain);
      attached.add(el);
      stats.attached++;

      const src = el.currentSrc || el.src || '(无)';
      Log.info(`✓ 已接管 video · 第 ${stats.attached} 次 · 当前增益 ${appliedGainDb}dB · src=${src.slice(0, 58)}`);
      return true;
    } catch (e) {
      failed.add(el);
      stats.failed++;
      // InvalidStateError：该元素已被别人 createMediaElementSource 过
      // （典型场景：B 站「音量均衡」已开启并占用了音频源）
      const hint = e && e.name === 'InvalidStateError' ? '该元素音频源已被占用，保持原声' : '保持原声';
      Log.warn(`接管失败（${e && e.name || '未知'}）→ ${hint}`);
      return false;
    }
  }

  /* ---- 增益 ---- */

  function setGainDb(db, opts) {
    const target = Number(db);
    if (!Number.isFinite(target)) return false;

    desiredGainDb = target;
    return applyGain(opts);
  }

  /** 把「实际该施加多少」算出来写进图里。旁路时一律按 0dB（原声） */
  function applyGain(opts) {
    const target = bypass ? 0 : desiredGainDb;

    const c = ensureContext();
    if (!c || !masterGain) return false;

    const linear = Math.pow(10, target / 20);
    const ramp = !(opts && opts.immediate === true);
    const tau = Number.isFinite(CONFIG.gainRampTau) ? CONFIG.gainRampTau : 0.04;

    try {
      if (ramp && c.state === 'running' && typeof masterGain.gain.setTargetAtTime === 'function') {
        const now = c.currentTime;
        const cur = masterGain.gain.value;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(cur, now);
        masterGain.gain.setTargetAtTime(linear, now, tau);
      } else {
        masterGain.gain.value = linear;
      }
      appliedGainDb = target;
      stats.gainSets++;
      Log.info(`→ 施加增益 ${target >= 0 ? '+' : ''}${target.toFixed(2)} dB（线性 ${linear.toFixed(4)}${ramp ? '，斜坡 ' + Math.round(tau * 3000) + 'ms' : '，立即'}${bypass ? ' · 旁路中' : ''}）`);
      return true;
    } catch (e) {
      Log.warn('设置增益失败（保持原声）', e && e.message);
      return false;
    }
  }

  function setBypass(v) {
    const next = !!v;
    if (next === bypass) return bypass;
    bypass = next;
    stats.bypassToggles++;
    applyGain();
    Log.info(bypass
      ? `旁路已开启 · 输出原声（0dB），归一结果仍记着 ${desiredGainDb >= 0 ? '+' : ''}${desiredGainDb.toFixed(2)}dB`
      : `旁路已关闭 · 恢复归一增益 ${desiredGainDb >= 0 ? '+' : ''}${desiredGainDb.toFixed(2)}dB`);
    return bypass;
  }

  function toggleBypass() { return setBypass(!bypass); }
  function isBypass() { return bypass; }

  /** 当前增益（线性值，用于验证真的写进了图里） */
  function getGainValue() {
    return masterGain ? masterGain.gain.value : null;
  }

  /** 当前**实际**增益（dB）—— 旁路中是 0 */
  function getAppliedGainDb() { return appliedGainDb; }

  /** 归一流程想要施加的增益（dB）—— 旁路中也保留原值 */
  function getDesiredGainDb() { return desiredGainDb; }

  /* ---- 手势与待接管队列 ---- */

  function armGestureHook() {
    if (gestureArmed) return;
    gestureArmed = true;

    const EVENTS = ['click', 'keydown', 'touchstart', 'pointerdown'];
    const onGesture = async () => {
      EVENTS.forEach(t => document.removeEventListener(t, onGesture, true));
      gestureArmed = false;
      Log.debug('捕获到用户手势');

      if (ctx) {
        try { await ctx.resume(); } catch (e) { /* 忽略 */ }
      }
      await drainPending();
    };

    EVENTS.forEach(t => document.addEventListener(t, onGesture, true));
    Log.debug('已注册一次性手势钩子（等待用户交互以解锁 AudioContext）');
  }

  async function drainPending() {
    if (!ctx || ctx.state !== 'running') return;
    if (pending.size === 0) return;

    const list = Array.from(pending);
    pending.clear();
    Log.debug(`补接管 ${list.length} 个暂缓元素`);

    for (const el of list) {
      await tryAttach(el);
    }
  }

  /* ---- 验证 ---- */

  async function probeSignal(durationMs = 600) {
    const c = ensureContext();
    if (!c || !masterGain) return { ok: false, reason: 'no-context' };
    if (c.state !== 'running') return { ok: false, reason: `ctx-${c.state}` };

    const analyser = c.createAnalyser();
    analyser.fftSize = 2048;
    masterGain.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    let sumSq = 0;
    let n = 0;

    const t0 = Date.now();
    await new Promise(resolve => {
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSq += v * v;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          n++;
        }
        if (Date.now() - t0 >= durationMs) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });

    try { masterGain.disconnect(analyser); } catch (e) { /* 忽略 */ }

    const rms = n ? Math.sqrt(sumSq / n) : 0;
    return {
      ok: true,
      samples: n,
      rms: +rms.toFixed(6),
      rmsDb: +(20 * Math.log10(rms || 1e-9)).toFixed(2),
      peak: +peak.toFixed(6),
      peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(2),
      ctxState: c.state,
      verdict: peak > 1e-4 ? '有信号' : '静默',
    };
  }

  /* ---- 对外 ---- */

  return {
    ensureContext,
    ensureRunning,
    tryAttach,
    isAttached,
    probeSignal,
    setGainDb,
    setBypass,
    toggleBypass,
    isBypass,
    getGainValue,
    getAppliedGainDb,
    getDesiredGainDb,
    getContextState() { return ctx ? ctx.state : null; },
    stats() {
      return Object.assign({}, stats, {
        pending: pending.size,
        bypass,
        desiredGainDb,
        appliedGainDb,
      });
    },
  };
})();

const Hud = (() => {
  let host = null;
  let root = null;
  let box = null;
  let enabled = !!CONFIG.hud;
  let timer = null;
  let latest = null;
  let bodyWatcher = null;

  const PHASE_TEXT = {
    idle: '空闲',
    reading: '读取页型信息',
    cache: '查缓存',
    fetching: '取流地址',
    init: '取初始化段',
    index: '取索引',
    segments: '抽样下载',
    decoding: '解码',
    analyzing: '算响度',
    waiting: '等待切流',
    active: '已生效',
    skipped: '跳过',
    error: '失败',
  };

  const HOST_CSS = [
    'all:initial',
    'display:block',
    'position:fixed !important',
    'left:12px', 'bottom:12px',
    'z-index:2147483647 !important',
    'pointer-events:none',
  ].join(';');

  function ensure() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'bili-loudness-hud-host';
    host.style.cssText = HOST_CSS;

    try {
      root = host.attachShadow({ mode: 'open' });
    } catch (e) {
      root = host;
    }

    const style = document.createElement('style');
    style.textContent = `
      .box {
        font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #e8e8e8;
        background: rgba(24,24,24,.88);
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 6px;
        padding: 7px 10px;
        min-width: 236px;
        backdrop-filter: blur(6px);
        box-shadow: 0 4px 12px rgba(0,0,0,.35);
        white-space: pre;
      }
      .hd { color: #fb7299; font-weight: 600; margin-bottom: 3px; }
      .k { color: #8a8a8a; }
      .v { color: #e8e8e8; }
      .ok { color: #7ed6a5; }
      .warn { color: #ffcc66; }
      .bad { color: #ff7a7a; }
    `;
    root.appendChild(style);

    box = document.createElement('div');
    box.className = 'box';
    root.appendChild(box);

    armMountRetry();
  }

  function mount() {
    if (!host) return true;
    if (host.parentNode) return true;

    const target = document.body || document.documentElement;
    if (!target) return false;

    target.appendChild(host);
    Log.debug(`HUD 已挂载 · parent=${target.tagName} · readyState=${document.readyState}`);

    // @run-at document-start 时 body 还不存在，只能先挂在 <html> 上。
    // 虽然 position:fixed 通常不受父元素影响，但万一宿主 <html> 被加了
    // transform / filter，fixed 的定位基准就会变。body 一出现就迁回去。
    if (target === document.documentElement) watchForBody();
    return true;
  }

  function watchForBody() {
    if (bodyWatcher) return;

    const move = () => {
      if (!document.body) return false;
      document.body.appendChild(host);
      Log.debug('HUD 已从 <html> 迁移到 <body>');
      return true;
    };
    if (move()) return;

    try {
      const ac = (typeof AbortController === 'function') ? new AbortController() : null;
      const obs = new MutationObserver(() => { if (move() && ac) ac.abort(); });
      obs.observe(document.documentElement,
        ac ? { childList: true, signal: ac.signal } : { childList: true });

      bodyWatcher = ac;
      // 兜底：6 秒还没等到 body 就放弃（正常情况下页面不该缺 body）
      if (ac) setTimeout(() => { if (bodyWatcher === ac) { ac.abort(); bodyWatcher = null; } }, 6000);
    } catch (e) { /* 忽略：迁不动就保持挂在 <html> */ }
  }

  /** 兜底补挂：每 250ms 试一次，6 秒后放弃（避免长驻定时器） */
  function armMountRetry() {
    if (mount()) return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (mount() || tries > 24) {
        clearInterval(t);
        if (tries > 24) Log.warn('HUD 挂载失败：始终找不到 body/documentElement');
      }
    }, 250);
  }

  function fmtDb(v, digits) {
    if (!Number.isFinite(v)) return '—';
    const d = digits === undefined ? 2 : digits;
    return `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  }

  function fmtLufs(v) {
    return Number.isFinite(v) ? v.toFixed(1) : '—';
  }

  function sec(v) {
    if (!Number.isFinite(v)) return null;
    return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
  }

  function render(s) {
    if (!s) return;

    const srcText = s.source === 'meta' ? '官方元数据'
      : s.source === 'sample' ? `本地抽样 · ${s.picked || '?'}段`
        : s.source === 'cache' ? '缓存'
          : '—';

    const limitText = s.limited ? ' · 已限幅' : '';

    let status = PHASE_TEXT[s.phase] || s.phase;
    if (s.phase === 'active') {
      status = `<span class="ok">已生效</span>`;
      // 渐进式：初测 = 第一批已落位，精修可能还在后台跑
      if (s.refined === false) status += ` <span class="warn">初测</span>`;
      else if (s.refined === true) status += ` <span class="k">已精修</span>`;
    } else if (s.phase === 'error') status = `<span class="bad">失败</span>`;
    else if (s.phase === 'skipped') status = `<span class="warn">跳过</span>`;
    else if (s.phase === 'waiting') status = `<span class="warn">等待切流</span>`;
    else if (s.phase === 'segments' && Number.isFinite(s.segDone)) {
      status = `${PHASE_TEXT.segments} <span class="k">${s.segDone}/${s.segTotal}</span>`;
    } else if (s.refining && (s.phase === 'decoding' || s.phase === 'analyzing')) {
      status += ` <span class="k">(精修)</span>`;
    }

    const ms = Number.isFinite(s.totalMs) ? `${(s.totalMs / 1000).toFixed(2)}s` : '';

    const lines = [
      `<span class="hd">B站响度归一 · ${CONFIG.stage} v${CONFIG.version}</span>`,
      `<span class="k">来源 </span><span class="v">${srcText}</span>`,
      `<span class="k">实测 </span><span class="v">${fmtLufs(s.measuredLufs)} LUFS</span>  <span class="k">TP</span> ${Number.isFinite(s.truePeakDb) ? s.truePeakDb.toFixed(1) : '—'}`,
      `<span class="k">目标 </span><span class="v">${fmtLufs(s.targetLufs)} LUFS</span>`,
      `<span class="k">增益 </span><span class="v">${fmtDb(s.gainDb)} dB</span>${limitText}`,
    ];

    // 抽样路径才有的细节：覆盖了多少音频、解码是否完整
    if (s.audioSeconds) {
      const ratio = Number.isFinite(s.decodeRatio) ? ` (${(s.decodeRatio * 100).toFixed(0)}%)` : '';
      lines.push(`<span class="k">抽样 </span><span class="v">${s.picked}/${s.sidxSegments} 段 · ${s.audioSeconds}s${ratio}</span>`);
    }

    if (s.bypass) {
      lines.push(`<span class="warn">旁路 听原声（归一 ${fmtDb(s.gainDb)}dB 未施加）</span>`);
    }

    lines.push(`<span class="k">状态 </span>${status}${ms ? ` <span class="k">·</span> ${ms}` : ''}`);

    const t = s.timing || {};
    const tp = [];
    const add = (label, v) => { const x = sec(v); if (x) tp.push(`${label}${x}`); };
    add('索引', t.prepMs);
    add('下载', t.sampleMs);
    add('解码', t.decodeMs);
    add('响度', t.lufsMs);
    add('精修', t.refineMs);
    if (tp.length && (s.phase === 'active' || s.phase === 'error')) {
      lines.push(`<span class="k">耗时 </span><span class="v">${tp.join(' ')}</span>`);
    }

    if (s.phase === 'error' || s.phase === 'skipped' || s.phase === 'waiting') {
      lines.push(`<span class="bad">${String(s.reason || '').slice(0, 60)}</span>`);
    }

    box.innerHTML = lines.join('\n');
  }

  function update(state) {
    latest = state;
    if (!enabled) return;
    ensure();
    if (!host) return;
    render(state);
    scheduleRefresh();
  }

  /** 阶段文字里的抽样进度需要 1Hz 刷新 */
  function scheduleRefresh() {
    if (timer) return;
    timer = setInterval(() => {
      if (!enabled || !latest) { clearInterval(timer); timer = null; return; }
      render(latest);
    }, 1000);
  }

  /* ---- toast ---- */

  /** toast 的宿主样式（与 HUD 同规则：all:initial 必须排最前） */
  const TOAST_CSS = [
    'all:initial',
    'display:block',
    'position:fixed !important',
    'left:12px',
    'bottom:76px',
    'z-index:2147483647 !important',
    'pointer-events:none',
  ].join(';');

  let toastHost = null;
  let toastBody = null;
  let toastTimer = null;

  function toast(text, ms) {
    try {
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.id = 'bili-loudness-toast-host';
        toastHost.style.cssText = TOAST_CSS;

        const shadow = toastHost.attachShadow ? toastHost.attachShadow({ mode: 'open' }) : toastHost;
        const st = document.createElement('style');
        st.textContent = `
          .t {
            font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            color: #fff;
            background: rgba(251,114,153,.94);
            border-radius: 6px;
            padding: 6px 12px;
            white-space: pre;
            box-shadow: 0 4px 14px rgba(0,0,0,.45);
          }
        `;
        shadow.appendChild(st);
        toastBody = document.createElement('div');
        toastBody.className = 't';
        shadow.appendChild(toastBody);
      }

      const target = document.body || document.documentElement;
      if (target && !toastHost.parentNode) target.appendChild(toastHost);
      toastBody.textContent = text;
    } catch (e) {
      Log.debug('toast 渲染失败（非致命）', e && e.message);
    }

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(removeToast, Number.isFinite(ms) ? ms : 1400);
  }

  function removeToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastHost && toastHost.parentNode) toastHost.parentNode.removeChild(toastHost);
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) {
      if (bodyWatcher) { try { bodyWatcher.abort(); } catch (e) { /* 忽略 */ } bodyWatcher = null; }
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null; root = null; box = null;
    } else {
      ensure();
      if (latest) render(latest);
    }
    Log.info('调试 HUD 已' + (enabled ? '开启' : '关闭'));
  }

  function isEnabled() { return enabled; }

  function rootNode() { return box; }

  function info() {
    if (!host) return { mounted: false, reason: 'HUD 尚未创建（enabled=' + enabled + '）', enabled };

    const cs = getComputedStyle(host);
    const rect = host.getBoundingClientRect();
    const inViewport = rect.right > 0 && rect.bottom > 0
      && rect.left < innerWidth && rect.top < innerHeight;

    let reason = null;
    if (!host.parentNode) reason = 'host 未挂进 DOM';
    else if (rect.width === 0 || rect.height === 0) reason = '尺寸为 0（内容未渲染）';
    else if (cs.display === 'none') reason = 'display:none';
    else if (cs.visibility === 'hidden') reason = 'visibility:hidden';
    else if (cs.position !== 'fixed') reason = `position 被改成 ${cs.position} —— all:initial 必须排在 cssText 最前`;
    else if (!inViewport) reason = '已渲染但落在视口外（定位被覆盖）';

    return {
      mounted: !!host.parentNode,
      enabled,
      parent: host.parentNode ? host.parentNode.tagName : null,
      shadow: root !== host,
      boxText: box ? String(box.textContent || '').slice(0, 200) : null,
      computed: {
        display: cs.display, position: cs.position, zIndex: cs.zIndex,
        left: cs.left, bottom: cs.bottom, visibility: cs.visibility, opacity: cs.opacity,
      },
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      viewport: { w: innerWidth, h: innerHeight },
      visible: reason === null,
      reason,
    };
  }

  return { update, setEnabled, isEnabled, info, rootNode, toast };
})();

const Panel = (() => {
  let host = null;
  let root = null;
  let varsStyle = null;
  let side = null;
  let tip = null;
  let statusPnl = null;
  let settingsPnl = null;

  let enabled = !!CONFIG.panel;
  let open = null;              // null | 'status' | 'settings'
  let fsHidden = false;
  let darkNow = null;

  let pollTimer = null;
  let bodyWatcher = null;
  let lastSnap = null;
  let docClick = null;

  const S = {};                 // 状态面板里各字段的引用
  const C = {};                 // 设置面板里各控件的引用

  /* ---- 全屏判定 ---- */

  function classHit(el) {
    if (!el) return false;
    const c = el.className;
    if (typeof c !== 'string' || !c) return false;
    return /(^|[\s-_])(web-?screen|web_?fullscreen|fullscreen|screen-?full|bpx-state-web-?full)/i.test(c);
  }

  function isFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    } catch (e) { /* 忽略 */ }

    if (classHit(document.body) || classHit(document.documentElement)) return true;

    let box = null;
    try { box = document.querySelector('.bpx-player-container') || document.querySelector('#bilibili-player'); } catch (e) { box = null; }
    if (classHit(box)) return true;

    // 几何兜底：容器铺满视口（留 2px 容差）
    if (box && box.getBoundingClientRect) {
      const r = box.getBoundingClientRect();
      if (r.width >= innerWidth - 2 && r.height >= innerHeight - 2 && innerWidth > 200) return true;
    }
    return false;
  }

  /* ---- 设置读写 ---- */

  /** 启动时把持久化的设置套回 CONFIG（必须在首次分析之前调用） */
  function load() {
    const s = Store.getSettings() || {};
    if (typeof s.enabled === 'boolean') CONFIG.enabled = s.enabled;
    if (s.custom && typeof s.custom === 'object') Object.assign(CONFIG.profiles.custom, s.custom);
    if (typeof s.profile === 'string' && CONFIG.profiles[s.profile]) CONFIG.profile = s.profile;
    return s;
  }

  function persist() {
    Store.setSettings({
      enabled: CONFIG.enabled,
      profile: CONFIG.profile,
      custom: {
        targetLufs: CONFIG.profiles.custom.targetLufs,
        maxBoostDb: CONFIG.profiles.custom.maxBoostDb,
        minGainDb: CONFIG.profiles.custom.minGainDb,
      },
    });
  }

  /** 设置变了 → 用缓存里的原始测量值立即重算（零下载零解码） */
  function reapply() {
    try {
      const p = Analyzer.reapply();
      if (p && p.catch) p.catch(e => Log.debug('重算失败', e && e.message));
    } catch (e) {
      Log.debug('重算异常', e && e.message);
    }
  }

  /* ---- 样式 ---- */

  const HOST_CSS = [
    'all:initial',
    'display:block',
    'position:fixed !important',
    'left:0', 'top:33.333vh',      /* ← 按钮列中点锚在这条线上（.btns 再上移半高） */
    'z-index:2147483647 !important',

    'pointer-events:none',
  ].join(';');

  const CSS = `
    .side {
      --rail: 58px;
      --shift: 28px;
      --btns-half: 63px;

      transform: translateX(calc(-1 * var(--shift)));
      transition: transform .3s cubic-bezier(.22,.61,.36,1);
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      pointer-events: none;
    }

    .side.bl-hide { display: none !important; }

    .btns {
      display: flex; flex-direction: column; gap: 26px;
      padding: 8px;
      position: relative;
      top: calc(-1 * var(--btns-half));
      pointer-events: auto;
    }

    .rd {
      width: 26px; height: 26px;
      padding: 8px;
      box-sizing: content-box;
      border-radius: 50%;
      border: 0;
      background: var(--btn-bg);
      color: var(--fg);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      position: relative;
      line-height: 0;
      transition: transform .2s, background .2s, color .2s;
      -webkit-appearance: none; appearance: none;
    }

    .rd svg { width: 26px; height: 26px; display: block; fill: currentColor; }

    .rd::after {
      content: ''; position: absolute;
      top: -20%; left: -20%; width: 140%; height: 140%;
      background: transparent;
    }

    .rdw { display: block; }
    .side .rdw:hover .rd,
    .side .rdw.bl-open .rd { transform: translateX(var(--shift)); }
    .rd:hover { background: #fff; color: #111; }
    .rdw:hover .rd:not(.bl-on) { background: #fff; color: #111; }
    .rd.bl-on { background: var(--theme); color: #fff; }
    .rd.bl-on:hover { color: #fff; }

    .tip {
      display: none;
      position: absolute;
      left: calc(var(--rail) + var(--shift));
      top: 0;
      transform: translateY(-50%);
      max-width: 168px;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--bd);
      background: var(--panel-bg);
      color: var(--fg);
      white-space: pre;
      box-shadow: 0 2px 8px rgba(0,0,0,.18);
      pointer-events: none;
    }
    .tip.bl-show { display: block; }

    .pnl {
      display: none;
      position: absolute;
      left: calc(var(--rail) + var(--shift));
      top: 0;
      width: 176px;
      box-sizing: border-box;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--bd);
      background: var(--panel-bg);
      color: var(--fg);
      box-shadow: 0 4px 12px 0 rgba(0,0,0,.05);
      pointer-events: auto;
    }
    .pnl.bl-show { display: block; }
    .pnl .hd {
      font-weight: 600;
      color: var(--theme);
      margin-bottom: 8px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .pnl .hd .x { cursor: pointer; color: var(--dim); font-weight: 400; padding: 0 2px; }
    .pnl .hd .x:hover { color: var(--theme); }

    .blk {
      background: var(--card-bg);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    .row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .row + .row { margin-top: 3px; }
    .k { color: var(--dim); flex: 0 0 auto; }
    .v { text-align: right; word-break: break-all; }
    .ok { color: #2eb872; } .warn { color: #e6a23c; } .bad { color: #f56c6c; }

    .btn {
      width: 100%;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--bd);
      background: var(--button-bg);
      color: var(--fg);
      font: inherit; cursor: pointer;
      -webkit-appearance: none; appearance: none;
    }
    .btn:hover { border-color: var(--theme); color: var(--theme); }
    .btn.bl-primary { background: var(--theme); border-color: transparent; color: #fff; }
    .btn.bl-primary:hover { color: #fff; filter: brightness(1.06); }

    .fld { margin-bottom: 8px; }
    .fld .lb { display: flex; align-items: baseline; justify-content: space-between; color: var(--dim); }
    .fld .lb b { color: var(--fg); font-weight: 600; }
    input[type=range] { width: 100%; margin: 2px 0 0; accent-color: var(--theme); }
    select {
      width: 100%; padding: 4px 6px; border-radius: 6px;
      border: 1px solid var(--bd); background: var(--button-bg); color: var(--fg);
      font: inherit;
    }
    .sw { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .sw input { accent-color: var(--theme); width: 16px; height: 16px; }
    .note { color: var(--dim); margin-top: 4px; }
    .hr { height: 1px; background: var(--bd); margin: 8px 0; }
  `;

  const VARS_LIGHT = '--theme:#fb7299;--fg:#18191c;--dim:#61666d;--panel-bg:#fff;--card-bg:#f6f7f8;--btn-bg:#ffffffaa;--button-bg:#fff;--bd:#8882;';
  const VARS_DARK = '--theme:#fb7299;--fg:#eee;--dim:#999;--panel-bg:#222;--card-bg:#282828;--btn-bg:#333a;--button-bg:#333;--bd:#8884;';

  /* ---- DOM ---- */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON = {
    /** 均衡器（三条竖线）—— 「当前状态 / 响度读数」 */
    status: 'M10,20H14V4H10V20M4,20H8V12H4V20M16,9V20H20V9H16Z',
    /** 齿轮 —— 「设置」，与 Evolved 的设置入口同款 */
    settings: 'M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z',
  };

  function icon(d) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  function row(parent, key, initValue) {
    const r = el('div', 'row');
    const k = el('span', 'k', key);
    const v = el('span', 'v', initValue);
    r.appendChild(k); r.appendChild(v);
    parent.appendChild(r);
    return v;
  }

  function field(parent, label, control, valueText) {
    const f = el('div', 'fld');
    const lb = el('div', 'lb');
    lb.appendChild(el('span', null, label));
    const b = el('b', null, valueText);
    lb.appendChild(b);
    f.appendChild(lb);
    f.appendChild(control);
    parent.appendChild(f);
    return b;
  }

  function buildStatus(el0) {
    const hd = el('div', 'hd');
    hd.appendChild(el('span', null, '当前状态'));
    const x = el('span', 'x', '✕');
    x.addEventListener('click', () => closeAll());
    hd.appendChild(x);
    el0.appendChild(hd);

    const top = el('div', 'blk');
    S.enabled = row(top, '功能', '—');
    S.sample = row(top, '采样', '—');
    S.source = row(top, '来源', '—');
    el0.appendChild(top);

    const mid = el('div', 'blk');
    S.measured = row(mid, '实测', '—');
    S.target = row(mid, '目标', '—');
    S.gain = row(mid, '增益', '—');
    S.limited = row(mid, '限幅', '—');
    S.page = row(mid, '页型', '—');
    el0.appendChild(mid);

    const bottom = el('div', 'blk');
    S.bypass = el('button', 'btn', '旁路（听原声）');
    S.bypass.addEventListener('click', () => {
      const on = Analyzer.toggleBypass();
      Hud.toast(on ? '旁路：听原声' : '恢复归一');
      /* ⚠️ 必须重新取快照 —— bypass 是「实时读」的字段，
       *    拿 render(lastSnap) 会把旧的 bypass 值画回去，按钮永远不翻面。 */
      render(Analyzer.snapshot());
    });
    bottom.appendChild(S.bypass);

    const note = el('div', 'note', '暂停音频归一，播放原始音频。');
    bottom.appendChild(note);

    bottom.appendChild(el('div', 'hr'));
    S.remeasure = el('button', 'btn', '重新测量本视频');
    S.remeasure.addEventListener('click', () => {

      Hud.toast('重新测量中…');
      Analyzer.reanalyze().then(r => {
        if (!r || !r.ok) Hud.toast('没有可测量的视频');
      });
    });
    bottom.appendChild(S.remeasure);
    bottom.appendChild(el('div', 'note', '丢弃本视频已保存的测量结果，重新测一遍。'));

    el0.appendChild(bottom);
  }

  function buildSettings(el0) {
    const hd = el('div', 'hd');
    hd.appendChild(el('span', null, '设置'));
    const x = el('span', 'x', '✕');
    x.addEventListener('click', () => closeAll());
    hd.appendChild(x);
    el0.appendChild(hd);

    /* 功能开关 */
    const blk1 = el('div', 'blk');
    const sw = el('label', 'sw');
    sw.appendChild(el('span', null, '启用响度归一'));
    C.enabled = document.createElement('input');
    C.enabled.type = 'checkbox';
    C.enabled.addEventListener('change', () => {
      setEnabled(C.enabled.checked);
      render(lastSnap);
    });
    sw.appendChild(C.enabled);
    blk1.appendChild(sw);
    el0.appendChild(blk1);

    /* 预设 */
    const blk2 = el('div', 'blk');
    blk2.appendChild(el('div', 'k', '预设'));
    C.profile = document.createElement('select');
    GainPlanner.listProfiles().forEach(p => {
      const o = document.createElement('option');
      o.value = p.key;
      o.textContent = `${p.label} ${p.targetLufs} LUFS`;
      C.profile.appendChild(o);
    });
    C.profile.addEventListener('change', () => {
      CONFIG.profile = C.profile.value;
      persist();
      reapply();
      syncControls();
      render(lastSnap);
    });
    blk2.appendChild(C.profile);
    el0.appendChild(blk2);

    /* 滑块 */
    const blk3 = el('div', 'blk');

    const tr = CONFIG.targetRange || [-28, -8];
    C.target = document.createElement('input');
    C.target.type = 'range';
    C.target.min = tr[0]; C.target.max = tr[1]; C.target.step = 0.5;
    C.targetVal = field(blk3, '目标', C.target, '—');

    const mr = CONFIG.maxBoostRange || [0, 18];
    C.maxBoost = document.createElement('input');
    C.maxBoost.type = 'range';
    C.maxBoost.min = mr[0]; C.maxBoost.max = mr[1]; C.maxBoost.step = 1;
    C.maxBoostVal = field(blk3, '上限', C.maxBoost, '—');

    const nr = CONFIG.minGainRange || [0, -60];
    C.minGain = document.createElement('input');
    C.minGain.type = 'range';
    C.minGain.min = nr[1]; C.minGain.max = nr[0]; C.minGain.step = 1;
    C.minGainVal = field(blk3, '下限', C.minGain, '—');

    const onSlide = () => {
      const cp = CONFIG.profiles.custom;
      cp.targetLufs = +C.target.value;
      cp.maxBoostDb = +C.maxBoost.value;
      cp.minGainDb = +C.minGain.value;
      CONFIG.profile = 'custom';
      C.profile.value = 'custom';
      C.targetVal.textContent = `${cp.targetLufs} LUFS`;
      C.maxBoostVal.textContent = `+${cp.maxBoostDb} dB`;
      C.minGainVal.textContent = `${cp.minGainDb} dB`;
      scheduleApply();
      render(lastSnap);
    };
    [C.target, C.maxBoost, C.minGain].forEach(r => {
      r.addEventListener('input', onSlide);
      r.addEventListener('change', () => { persist(); });
    });
    el0.appendChild(blk3);

    /* 缓存 */
    const blk4 = el('div', 'blk');
    blk4.appendChild(el('div', 'k', '缓存'));
    C.cacheInfo = el('div', 'v', '—');
    blk4.appendChild(C.cacheInfo);
    C.clear = el('button', 'btn', '清除缓存');
    C.clear.addEventListener('click', () => {
      Store.clear();
      Hud.toast('测量缓存已清空');
      syncControls();
      render(lastSnap);
    });
    blk4.appendChild(el('div', 'hr'));
    blk4.appendChild(C.clear);

    blk4.appendChild(el('div', 'note', '清除已保存的视频响度测量结果。'));
    el0.appendChild(blk4);
  }

  function ensure() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'bili-loudness-panel-host';
    host.style.cssText = HOST_CSS;

    try { root = host.attachShadow({ mode: 'open' }); } catch (e) { root = host; }

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    varsStyle = document.createElement('style');
    root.appendChild(varsStyle);

    side = el('div', 'side');
    root.appendChild(side);

    const btns = el('div', 'btns');

    /* 按钮内容是**图标**（不再是「状」「设」两个字），风格与 Evolved 侧边栏一致 */
    const bStatus = el('button', 'rd');
    bStatus.title = '当前状态';
    bStatus.setAttribute('aria-label', '当前状态');
    bStatus.appendChild(icon(ICON.status));
    bStatus.addEventListener('click', (ev) => { ev.stopPropagation(); togglePanel('status', bStatus); });
    bStatus.addEventListener('mouseenter', () => showTip(statusTip(), bStatus));
    bStatus.addEventListener('mouseleave', hideTip);

    const bSettings = el('button', 'rd');
    bSettings.title = '设置';
    bSettings.setAttribute('aria-label', '设置');
    bSettings.appendChild(icon(ICON.settings));
    bSettings.addEventListener('click', (ev) => { ev.stopPropagation(); togglePanel('settings', bSettings); });
    bSettings.addEventListener('mouseenter', () => showTip('设置', bSettings));
    bSettings.addEventListener('mouseleave', hideTip);

    const wStatus = el('div', 'rdw');
    wStatus.appendChild(bStatus);
    const wSettings = el('div', 'rdw');
    wSettings.appendChild(bSettings);

    btns.appendChild(wStatus);
    btns.appendChild(wSettings);
    side.appendChild(btns);

    S.btnStatus = bStatus;
    S.btnSettings = bSettings;
    S.wrapStatus = wStatus;
    S.wrapSettings = wSettings;

    tip = el('div', 'tip');
    side.appendChild(tip);

    statusPnl = el('div', 'pnl');
    buildStatus(statusPnl);
    side.appendChild(statusPnl);

    settingsPnl = el('div', 'pnl');
    buildSettings(settingsPnl);
    side.appendChild(settingsPnl);

    // 面板内的点击不要冒泡到页面（避免被 B 站自己的全局点击处理）
    side.addEventListener('click', (ev) => ev.stopPropagation());

    armMountRetry();
  }

  function mount() {
    if (!host) return true;
    if (host.parentNode) return true;
    const target = document.body || document.documentElement;
    if (!target) return false;
    target.appendChild(host);
    if (target === document.documentElement) watchForBody();
    return true;
  }

  function watchForBody() {
    if (bodyWatcher) return;
    const move = () => { if (!document.body) return false; document.body.appendChild(host); return true; };
    if (move()) return;
    try {
      const ac = (typeof AbortController === 'function') ? new AbortController() : null;
      const obs = new MutationObserver(() => { if (move() && ac) ac.abort(); });
      obs.observe(document.documentElement, ac ? { childList: true, signal: ac.signal } : { childList: true });
      bodyWatcher = ac;
      if (ac) setTimeout(() => { if (bodyWatcher === ac) { ac.abort(); bodyWatcher = null; } }, 6000);
    } catch (e) { /* 忽略 */ }
  }

  function armMountRetry() {
    if (mount()) return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (mount() || tries > 24) {
        clearInterval(t);
        if (tries > 24) Log.warn('面板挂载失败：找不到 body/documentElement');
      }
    }, 250);
  }

  /* ---- 交互 ---- */

  function showTip(text, btn) {
    if (!tip) return;
    tip.textContent = text;

    if (btn && btn.getBoundingClientRect && side) {
      const bq = btn.getBoundingClientRect();
      const sq = side.getBoundingClientRect();
      const mid = bq.top + bq.height / 2 - sq.top;
      if (Number.isFinite(mid)) tip.style.top = mid + 'px';
    }
    tip.classList.add('bl-show');
  }
  function hideTip() { if (tip) tip.classList.remove('bl-show'); }

  function statusTip() {
    const s = lastSnap || {};
    if (s.bypass) return `旁路中（听原声）\n归一 ${fmtDb(s.gainDb)}`;
    const g = Number.isFinite(s.gainDb) ? `增益 ${fmtDb(s.gainDb)}` : '增益 —';
    const l = Number.isFinite(s.measuredLufs) ? `实测 ${s.measuredLufs.toFixed(1)} LUFS` : '实测 —';
    return `${g}\n${l}`;
  }

  function togglePanel(which, btn) {
    open = (open === which) ? null : which;
    if (statusPnl) statusPnl.classList.toggle('bl-show', open === 'status');
    if (settingsPnl) settingsPnl.classList.toggle('bl-show', open === 'settings');

    if (side) side.classList.toggle('bl-pin', !!open);

    if (open && btn && btn.getBoundingClientRect && side) {
      const pnl = open === 'status' ? statusPnl : settingsPnl;
      const bq = btn.getBoundingClientRect();
      const sq = side.getBoundingClientRect();
      const t = bq.top - sq.top;
      if (pnl && Number.isFinite(t)) pnl.style.top = t + 'px';
    }

    if (S.wrapStatus) S.wrapStatus.classList.toggle('bl-open', open === 'status');
    if (S.wrapSettings) S.wrapSettings.classList.toggle('bl-open', open === 'settings');

    if (open) { syncControls(); render(lastSnap); }
    hideTip();
  }

  function closeAll() { if (open) togglePanel(open); }

  function ensureDocClick() {
    if (docClick) return;
    docClick = () => { if (open) closeAll(); };
    try { document.addEventListener('click', docClick); } catch (e) { docClick = null; }
  }

  function dropDocClick() {
    if (!docClick) return;
    try { document.removeEventListener('click', docClick); } catch (e) { /* 忽略 */ }
    docClick = null;
  }

  /* ---- 渲染 ---- */

  function fmtDb(v, d) {
    if (!Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(d === undefined ? 2 : d)} dB`;
  }

  const PHASE_TEXT = {
    idle: '空闲', cache: '查缓存', fetching: '取流中', segments: '抽样下载',
    decoding: '解码中', analyzing: '算响度', waiting: '等待切流',
    active: '已生效', skipped: '已跳过', error: '失败',
  };

  function sampleText(s) {
    if (!s) return '—';
    if (s.phase === 'segments' && Number.isFinite(s.segDone)) return `抽样中 ${s.segDone}/${s.segTotal}`;
    if (s.phase === 'decoding' || s.phase === 'analyzing') return s.refining ? '精修中…' : '计算中…';
    if (s.phase === 'cache' || s.phase === 'fetching' || s.phase === 'waiting') return PHASE_TEXT[s.phase] + '…';
    if (s.phase === 'active') {
      if (s.refined === false) return '初测完成 · 精修中';
      return '已完成';
    }
    if (s.phase === 'skipped') return '已跳过';
    if (s.phase === 'error') return '失败';
    return '空闲';
  }

  function sourceText(s) {
    if (!s) return '—';
    if (s.source === 'meta') return '官方元数据 · 免下载';
    if (s.source === 'sample') return `本地抽样 ${s.picked || '?'} 段`;
    if (s.source === 'cache') return '缓存';
    return '—';
  }

  function render(s) {
    lastSnap = s || lastSnap;
    const st = lastSnap || {};

    if (S.enabled) {
      S.enabled.innerHTML = CONFIG.enabled
        ? '<span class="ok">已开启</span>'
        : '<span class="warn">已关闭</span>';
    }
    if (S.sample) {
      const t = sampleText(st);
      const cls = st.phase === 'error' ? 'bad' : (st.phase === 'active' ? 'ok' : '');
      S.sample.innerHTML = cls ? `<span class="${cls}">${t}</span>` : t;
    }
    if (S.source) S.source.textContent = sourceText(st);

    if (S.measured) S.measured.textContent = Number.isFinite(st.measuredLufs) ? `${st.measuredLufs.toFixed(1)} LUFS` : '—';
    if (S.target) S.target.textContent = Number.isFinite(st.targetLufs) ? `${st.targetLufs.toFixed(1)} LUFS` : '—';
    if (S.gain) {
      const applying = CONFIG.enabled && !st.bypass;
      S.gain.innerHTML = `${fmtDb(st.gainDb)}`;
      if (Number.isFinite(st.truePeakDb)) S.gain.innerHTML += ` <span class="k">（TP ${st.truePeakDb.toFixed(1)}）</span>`;
      if (!applying) S.gain.innerHTML += ' <span class="warn">未施加</span>';
    }

    if (S.limited) S.limited.textContent = st.limited ? (st.limitReason || '已限幅') : '未限幅';
    if (S.page) {
      const kind = StateReader.kind();
      S.page.textContent = kind === 'pgc' ? '番剧 / 影视' : (kind === 'video' ? '普通投稿' : kind);
    }
    if (S.bypass) {
      S.bypass.textContent = st.bypass ? '关闭旁路' : '旁路（听原声）';
      S.bypass.className = 'btn' + (st.bypass ? ' bl-primary' : '');
    }

    if (C.cacheInfo) {
      const c = Store.stats();
      C.cacheInfo.textContent = `${c.entries}/${c.maxEntries} 条 · ${c.backend}`;
    }

    // 按钮点亮：功能开启 / 有结论
    if (S.btnStatus) S.btnStatus.classList.toggle('bl-on', !!(st.phase === 'active' && !st.bypass));
    if (S.btnSettings) S.btnSettings.classList.toggle('bl-on', !CONFIG.enabled);

    applyFullscreen();
    applyTheme();
  }

  function syncControls() {
    if (C.enabled) C.enabled.checked = !!CONFIG.enabled;
    if (C.profile) C.profile.value = CONFIG.profiles[CONFIG.profile] ? CONFIG.profile : 'standard';
    const p = GainPlanner.currentProfile();
    if (C.target) C.target.value = String(p.targetLufs);
    if (C.maxBoost) C.maxBoost.value = String(p.maxBoostDb);
    if (C.minGain) C.minGain.value = String(p.minGainDb);
    if (C.targetVal) C.targetVal.textContent = `${p.targetLufs} LUFS`;
    if (C.maxBoostVal) C.maxBoostVal.textContent = `+${p.maxBoostDb} dB`;
    if (C.minGainVal) C.minGainVal.textContent = `${p.minGainDb} dB`;
  }

  /* ---- 全屏隐藏 / 主题 ---- */

  function applyFullscreen() {
    if (!side) return;
    const hide = !!CONFIG.fullscreenHide && isFullscreen();
    if (hide === fsHidden) return;
    fsHidden = hide;
    side.classList.toggle('bl-hide', hide);
    Log.debug('面板全屏隐藏 = ' + hide);
  }

  function themeIsDark() {
    try {
      if (document.body && document.body.classList.contains('dark')) return true;
      if (document.documentElement.classList.contains('dark')) return true;
    } catch (e) { /* 忽略 */ }
    try { if (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) return true; } catch (e) { /* 忽略 */ }
    return false;
  }

  function applyTheme() {
    const d = themeIsDark();
    if (d === darkNow) return;
    darkNow = d;
    if (varsStyle) varsStyle.textContent = `:host{${d ? VARS_DARK : VARS_LIGHT}}`;
  }

  /* ---- 对外 ---- */

  function setEnabled(v) {
    Analyzer.setEnabled(!!v);
    persist();
    syncControls();
  }

  /** 周期刷新：状态用轮询拿（不侵入 analyzer），全屏与主题顺带一起查 */
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!enabled) return;
      render(Analyzer.snapshot());
    }, 600);
  }

  function init() {
    load();
    if (enabled) {
      ensure();
      mount();
      syncControls();
      render(Analyzer.snapshot());
      startPoll();
      ensureDocClick();

      // 全屏切换多半伴随 resize / class 变化，两种都监听，反应更快
      try { window.addEventListener('resize', applyFullscreen); } catch (e) { /* 忽略 */ }
      try {
        const ac = (typeof AbortController === 'function') ? new AbortController() : null;
        const obs = new MutationObserver(() => applyFullscreen());
        if (document.documentElement) {
          obs.observe(document.documentElement, ac
            ? { attributes: true, attributeFilter: ['class'], subtree: true, signal: ac.signal }
            : { attributes: true, attributeFilter: ['class'], subtree: true });
        }
      } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  function setPanelEnabled(v) {
    enabled = !!v;
    CONFIG.panel = enabled;
    if (!enabled) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (bodyWatcher) { try { bodyWatcher.abort(); } catch (e) { /* 忽略 */ } bodyWatcher = null; }
      dropDocClick();
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null; root = null; side = null; tip = null; varsStyle = null;
      statusPnl = null; settingsPnl = null;
      open = null;
    } else {
      ensure(); mount(); syncControls(); render(Analyzer.snapshot()); startPoll();
      ensureDocClick();
    }
    Log.info('设置面板已' + (enabled ? '开启' : '关闭'));
  }

  function isEnabled() { return enabled; }

  function info() {
    if (!host) return { mounted: false, enabled, reason: '面板未创建' };
    const cs = getComputedStyle(host);
    const rect = host.getBoundingClientRect();

    const btn = S.btnStatus;
    const bRect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;

    return {
      mounted: !!host.parentNode,
      enabled,
      open,
      parent: host.parentNode ? host.parentNode.tagName : null,
      fullscreenDetected: isFullscreen(),
      hiddenByFullscreen: fsHidden,
      shadow: root !== host,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      computed: { display: cs.display, position: cs.position, zIndex: cs.zIndex, top: cs.top },

      placement: {
        hostTop: host.style.top || null,
        btnSize: bRect ? [Math.round(bRect.width), Math.round(bRect.height)] : null,
        btnTop: bRect ? Math.round(bRect.top) : null,
        btnLeft: bRect ? Math.round(bRect.left) : null,
        iconCount: btn ? btn.querySelectorAll('svg').length : 0,
      },
      statusOpen: !!(statusPnl && statusPnl.classList.contains('bl-show')),
      settingsOpen: !!(settingsPnl && settingsPnl.classList.contains('bl-show')),
      tipShown: !!(tip && tip.classList.contains('bl-show')),
    };
  }

  function fsInfo() {
    let box = null;
    try { box = document.querySelector('.bpx-player-container') || document.querySelector('#bilibili-player'); } catch (e) { /* 忽略 */ }
    const r = box && box.getBoundingClientRect ? box.getBoundingClientRect() : null;
    return {
      detected: isFullscreen(),
      fullscreenElement: (() => { try { return document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.className || 'yes') : null; } catch (e) { return null; } })(),
      bodyClass: document.body ? document.body.className : null,
      htmlClass: document.documentElement.className,
      containerClass: box ? box.className : null,
      boxRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      viewport: [innerWidth, innerHeight],
      coversViewport: !!(r && r.width >= innerWidth - 2 && r.height >= innerHeight - 2),
      classHit: { body: classHit(document.body), html: classHit(document.documentElement), container: classHit(box) },
    };
  }

  let applyTimer = null;
  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { applyTimer = null; reapply(); }, 150);
  }

  return {
    init, render, syncControls, setEnabled, isEnabled, info, fsInfo,
    setPanelEnabled,
    toggle: (which) => togglePanel(which || 'status'),
    isOpen: () => open,

    setCustom(patch) {
      Object.assign(CONFIG.profiles.custom, patch || {});
      CONFIG.profile = 'custom';
      persist(); syncControls(); reapply(); render(lastSnap);
    },
  };
})();

const Analyzer = (() => {
  let jobSeq = 0;
  let runningKey = null;
  let appliedKey = null;

  const computed = new Map();

  const state = {
    phase: 'idle',
    key: null,
    source: null,
    measuredLufs: null,
    truePeakDb: null,
    targetLufs: null,
    gainDb: 0,
    limited: false,
    limitReason: null,
    reason: null,
    picked: null,
    sidxSegments: null,
    sampledBytes: null,
    audioSeconds: null,
    decodeRatio: null,
    decodeFailed: null,
    /** 渐进式：结果是否已经过第二批精修 */
    refined: null,
    /** 精修是否真的改动了增益（差 < refineMinDeltaDb 就只更新记录） */
    refineMoved: null,
    refineDelta: null,
    timing: {},
    totalMs: null,
  };

  function snapshot() {
    return {
      phase: state.phase, key: state.key, source: state.source,
      measuredLufs: state.measuredLufs, truePeakDb: state.truePeakDb,
      targetLufs: state.targetLufs, gainDb: state.gainDb,
      limited: state.limited, limitReason: state.limitReason,
      reason: state.reason, picked: state.picked, sidxSegments: state.sidxSegments,
      sampledBytes: state.sampledBytes, audioSeconds: state.audioSeconds,
      decodeRatio: state.decodeRatio, decodeFailed: state.decodeFailed,
      refined: state.refined, refineMoved: state.refineMoved, refineDelta: state.refineDelta,
      timing: Object.assign({}, state.timing), totalMs: state.totalMs,
      appliedGainLinear: AudioEngine.getGainValue(),
      ctxState: AudioEngine.getContextState(),
      /* 旁路是实时读的 —— 它可以在分析结束之后被用户随手切 */
      bypass: AudioEngine.isBypass(),
      desiredGainDb: AudioEngine.getDesiredGainDb(),
      appliedGainDb: AudioEngine.getAppliedGainDb(),
    };
  }

  function push(phase, patch, reason) {
    state.phase = phase;
    if (patch) Object.assign(state, patch);
    if (reason !== undefined) state.reason = reason;
    Hud.update(snapshot());
  }

  /* ---- 解码与测量 ---- */

  function getOfflineCtor() {
    return window.OfflineAudioContext || window.webkitOfflineAudioContext || null;
  }

  async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    async function runner() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, runner));
    return out;
  }

  async function decodeAll(scope, initBuf, mimeType, segs, onProgress) {
    let failed = 0;
    let done = 0;
    const limit = Math.max(1, CONFIG.decodeConcurrency || 2);

    const out = await mapLimit(segs, limit, async (seg) => {
      let r = null;
      try {
        const blob = Sampler.fragmentBlob(initBuf, seg.buf, mimeType);
        const ab = await blob.arrayBuffer();
        r = { seg, buffer: await scope.decodeAudioData(ab) };
      } catch (e) {
        failed++;
        Log.warn(`第 ${seg.index} 段解码失败（跳过）· ${(e && e.message) || e}`);
      }
      done++;
      if (typeof onProgress === 'function') onProgress(done, segs.length, failed);
      return r;
    });

    const items = out.filter(Boolean);
    return { items, buffers: items.map(x => x.buffer), failed, requested: segs.length };
  }

  /** 合并 + 测量（K 加权 / 门限 / 真峰值） */
  async function measureMerged(scope, buffers) {
    const merged = Loudness.concatBuffers(scope, buffers);
    if (!merged) throw new Error('没有可用的解码结果');
    const m = await Loudness.measure(merged, {
      onYield: () => new Promise(r => setTimeout(r, 0)),
    });
    Log.info(`解码合并 · ${merged.duration.toFixed(1)}s · ${merged.length} 帧 · ${merged.sampleRate}Hz · ${merged.numberOfChannels}ch · 测量 ${m.processedMs}ms`);
    return { merged, m };
  }

  function ratioOf(gotSec, wantSec) {
    if (!Number.isFinite(wantSec) || wantSec <= 0) return null;
    return +(gotSec / wantSec).toFixed(3);
  }

  /* ---- 单次分析 ---- */

  async function analyzeKey(info, key, videoEl, myJob) {
    const t0 = Date.now();
    state.timing = {};
    state.totalMs = null;
    state.picked = null;
    state.sidxSegments = null;
    state.sampledBytes = null;
    state.audioSeconds = null;
    state.decodeRatio = null;
    state.decodeFailed = null;
    state.refined = null;
    state.refineMoved = null;
    state.refineDelta = null;

    /* 0. 换片先回中性，避免把上一个视频的增益带到新视频上 */
    appliedKey = null;
    AudioEngine.setGainDb(0);

    const stage = (ph, extra) => {
      if (jobSeq !== myJob) return;
      push(ph, extra || {});
    };

    /* 1. 缓存 */
    push('cache', { key: key, source: null, reason: null });
    const cached = Store.get(key);
    const cachedUsable = cached && Number.isFinite(cached.measuredLufs);

    /* 上次只跑完初测就被切走了（coarse 缓存）→ 先秒出，再往下走精修 */
    const needsRefine = !!(cachedUsable && cached.coarse && CONFIG.progressive);

    if (cachedUsable && !needsRefine) {
      const planned = GainPlanner.plan({ measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
      const record = {
        source: 'cache', measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb,
        sidxSegments: cached.sidxSegments, picked: cached.picked,
        sampledBytes: null, audioSeconds: cached.audioSeconds, decodeRatio: cached.decodeRatio,
        refined: cached.coarse ? false : true,
        timing: {},
      };
      computed.set(key, record);
      push('active', Object.assign({}, record, {
        targetLufs: planned.targetLufs, gainDb: planned.gainDb, limited: planned.limited,
        limitReason: planned.limitReason, reason: null, totalMs: Date.now() - t0,
      }));
      Log.info(`命中缓存 ${key} · 实测 ${cached.measuredLufs} LUFS（原来源 ${cached.source}）→ 增益 ${planned.gainDb}dB`);
      return;
    }

    if (needsRefine) {
      const planned0 = GainPlanner.plan({ measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb });
      AudioEngine.setGainDb(planned0.gainDb);
      appliedKey = key;
      push('active', {
        key, source: 'cache', measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb,
        targetLufs: planned0.targetLufs, gainDb: planned0.gainDb, limited: planned0.limited,
        limitReason: planned0.limitReason, reason: null, totalMs: Date.now() - t0,
        refined: false, picked: cached.picked, sidxSegments: cached.sidxSegments,
        audioSeconds: cached.audioSeconds, decodeRatio: cached.decodeRatio,
      });
      Log.info(`命中初测缓存 ${key}（${cached.measuredLufs} LUFS / ${cached.picked} 段）→ 先立即生效，再后台精修`);
    }

    /* 2. 取流 */
    push('fetching');
    const tFetch = Date.now();
    const got = await PlayInfo.get(info, videoEl, key);
    state.timing.fetchMs = Date.now() - tFetch;
    if (jobSeq !== myJob) return;

    const pi = got.info;
    if (!pi) throw new Error('取流失败：页面与接口都没有可用数据');
    if (pi.isDrm) { push('skipped', { reason: 'DRM 加密内容，放弃分析', targetLufs: GainPlanner.currentProfile().targetLufs }, 'DRM'); return; }
    if (pi.isPreview) { push('skipped', { reason: '试看片段，未完整解锁', targetLufs: GainPlanner.currentProfile().targetLufs }, '试看'); return; }
    if (pi.hasDurlOnly) { push('skipped', { reason: '仅返回 durl（未拿到 dash），无法抽样', targetLufs: GainPlanner.currentProfile().targetLufs }, 'durl'); return; }

    if (info.kind === 'pgc') {
      const alive = await waitElementDuration(videoEl, pi.duration, myJob);
      if (!alive) return;
    }

    let measuredLufs = null;
    let truePeakDb = null;
    let source = null;
    let planned = null;
    let refined = null;

    /* 3a. FastPath：B 站自己的响度元数据，零下载零解码 */
    if (!CONFIG.forceSamplePath && pi.volumeMeta && Number.isFinite(pi.volumeMeta.measuredI)) {
      measuredLufs = pi.volumeMeta.measuredI;
      truePeakDb = Number.isFinite(pi.volumeMeta.measuredTp) ? pi.volumeMeta.measuredTp : null;
      source = 'meta';
      planned = GainPlanner.plan({ measuredLufs, truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
      Log.info(`FastPath · B 站元数据 measured_i=${measuredLufs} LUFS · measured_tp=${truePeakDb} dBTP · target_i=${pi.volumeMeta.targetI}（零下载）`);
    } else {
      /* 3b. SamplePath：全片抽样 + 本地测量（渐进式两批） */
      if (!pi.audio) throw new Error('没有可用的 dash 音频轨，无法抽样');
      Log.info(`SamplePath · 音频 id=${pi.audio.id} · ${pi.audio.mimeType} · ${(pi.audio.bandwidth / 1000).toFixed(0)}kbps · id 优先级命中`);

      const tSample = Date.now();

      /* --- 取索引（init + sidx 并行） --- */
      let prep = await Sampler.prepare(pi.audio, stage);
      if (jobSeq !== myJob) return;

      state.sidxSegments = prep.refs.length;
      state.timing.initMs = prep.initMs;
      state.timing.indexMs = prep.indexMs;
      state.timing.prepMs = prep.prepMs;

      const coarsePicks = CONFIG.progressive
        ? Sidx.pickCoarse(prep.picks, CONFIG.firstBatchSegments)
        : prep.picks.slice();
      const restPicks = prep.picks.filter(i => coarsePicks.indexOf(i) < 0);

      const refsBy = (picks, p) => picks.map(i => p.refs[i]);

      const wantAtLeast = CONFIG.progressive
        ? Math.max(2, Math.min(
          Number.isFinite(CONFIG.firstBatchEagerAt) ? CONFIG.firstBatchEagerAt : 4,
          coarsePicks.length,
        ))
        : coarsePicks.length;

      const startBatch = (picks, p, label, extra) => Sampler.download(
        refsBy(picks, p), pi.audio, stage,
        Object.assign({
          label,
          wantAtLeast,
          onProgress: (d, t, drop) => {
            if (jobSeq !== myJob) return;
            push('segments', { picked: picks.length, segDone: d, segTotal: t, segDropped: drop, refining: !!(extra && extra.refining) });
          },
        }, extra || {}),
      );

      /* --- 第一批：够用就开工 --- */
      let h1 = startBatch(coarsePicks, prep, 'coarse');
      let first = await h1.early;
      if (jobSeq !== myJob) return;

      /* 自校验：正确基准点下，抽样段必须以 moof box 开头。
       * 若不然（B 站改版 / 非标准封装），退回绝对偏移重下这一批。 */
      const looksRight = b => !!b.segs.length && Sidx.startsWithBox(b.segs[0].buf, 'moof');
      if (!looksRight(first)) {
        Log.warn(`首批抽样不是以 moof 开头（基准点 ${prep.anchor} 可能不对）→ 回退到绝对偏移重下`);
        try {
          prep = await Sampler.prepare(pi.audio, stage, 0);
          if (jobSeq !== myJob) return;
          h1 = startBatch(coarsePicks, prep, 'coarse2');
          first = await h1.early;
          if (jobSeq !== myJob) return;
        } catch (e) {
          Log.warn(`回退重下也失败：${(e && e.message) || e}`);
        }
        if (!looksRight(first)) throw new Error('抽样段结构异常（不是 moof 起始），无法解码');
      }

      const need = Math.min(CONFIG.minSegmentsToProceed, coarsePicks.length);
      if (first.ok < need) {
        throw new Error(`抽样失败：只拿到 ${first.ok}/${first.requested} 段（低于下限 ${need}），本次放弃`);
      }

      const OfflineCtor = getOfflineCtor();
      if (!OfflineCtor) throw new Error('浏览器不支持 OfflineAudioContext');
      // 只借它的 decodeAudioData / createBuffer：B 站音频本来就是 48kHz，不触发重采样
      const scope = new OfflineCtor(1, 1, 48000);

      /* --- 解码 + 测量 + 立即落位（此时可能还有段在后台取，不等） --- */
      push('decoding', { picked: first.ok, audioSeconds: +first.seconds.toFixed(1) });
      const tDecode = Date.now();
      const d1 = await decodeAll(scope, prep.initBuf, pi.audio.mimeType, first.segs);
      if (jobSeq !== myJob) return;
      if (!d1.buffers.length) throw new Error('全部抽样段解码失败');
      state.timing.decodeMs = Date.now() - tDecode;
      state.decodeFailed = d1.failed;

      push('analyzing', { picked: first.ok });
      const r1 = await measureMerged(scope, d1.buffers);
      if (jobSeq !== myJob) return;
      state.timing.lufsMs = r1.m.processedMs;

      measuredLufs = r1.m.lufs;
      truePeakDb = r1.m.truePeakDb;
      source = 'sample';
      if (!Number.isFinite(measuredLufs)) throw new Error('响度计算无有效结果（可能全片静音）');

      planned = GainPlanner.plan({ measuredLufs, truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
      refined = false;

      /** 已经用过的段号 —— 后面补齐时靠它去重，绝不重复解码同一段 */
      const usedIdx = first.segs.map(s => s.index);

      state.timing.sampleMs = Date.now() - tSample;
      state.timing.firstMs = Date.now() - t0;
      state.timing.segSlowestMs = first.slowestMs;
      state.timing.segMedianMs = first.medianMs;
      state.totalMs = Date.now() - t0;
      state.picked = first.ok;
      state.sampledBytes = prep.initBuf.byteLength + first.bytes;
      state.audioSeconds = +first.seconds.toFixed(1);
      state.decodeRatio = ratioOf(first.seconds, first.requestedSeconds);

      Log.info(`✓ 初测落位 · ${first.ok}/${first.requested} 段${first.partial ? '（够用即开工，其余在后台）' : ''} · ${state.audioSeconds}s 音频 · 实测 ${measuredLufs} LUFS → 增益 ${planned.gainDb >= 0 ? '+' : ''}${planned.gainDb}dB · 首批耗时 ${state.timing.firstMs}ms（下载 ${first.wallMs}ms，最慢段 ${first.slowestMs}ms / 中位 ${first.medianMs}ms）`);

      const b1 = await h1.all;
      if (jobSeq !== myJob) return;

      const leftFromB1 = b1.segs.filter(s => usedIdx.indexOf(s.index) < 0);

      if (CONFIG.progressive && (restPicks.length || leftFromB1.length)) {
        const tRefine = Date.now();

        let b2 = { segs: [], ok: 0, bytes: 0, seconds: 0, requested: 0, requestedSeconds: 0, slowestMs: null, dropped: 0 };
        if (restPicks.length) {
          stage('segments', { picked: restPicks.length, segDone: 0, segTotal: restPicks.length, refining: true });
          const h2 = startBatch(restPicks, prep, 'fine', { refining: true, wantAtLeast: 0 });
          b2 = await h2.all;
          if (jobSeq !== myJob) return;
        }

        const more = leftFromB1.concat(b2.segs);

        if (more.length) {
          push('decoding', { refining: true });
          const d2 = await decodeAll(scope, prep.initBuf, pi.audio.mimeType, more);
          if (jobSeq !== myJob) return;

          if (d2.buffers.length) {
            push('analyzing', { refining: true });
            const r2 = await measureMerged(scope, d1.buffers.concat(d2.buffers));
            if (jobSeq !== myJob) return;

            const planned2 = GainPlanner.plan({ measuredLufs: r2.m.lufs, truePeakDb: r2.m.truePeakDb });
            const delta = Math.abs(planned2.gainDb - planned.gainDb);
            const moved = delta >= CONFIG.refineMinDeltaDb;

            if (moved) {
              AudioEngine.setGainDb(planned2.gainDb);
              appliedKey = key;
            }

            measuredLufs = r2.m.lufs;
            truePeakDb = r2.m.truePeakDb;
            planned = planned2;
            refined = true;

            const finalOk = first.ok + more.length;
            const finalRequested = first.requested + b2.requested;
            const finalSeconds = first.seconds + leftFromB1.reduce((a, s) => a + s.duration, 0) + b2.seconds;
            const finalRequestedSeconds = first.requestedSeconds + b2.requestedSeconds;

            state.refined = true;
            state.refineMoved = moved;
            state.refineDelta = +delta.toFixed(2);
            state.picked = finalOk;
            state.sampledBytes = prep.initBuf.byteLength + first.bytes
              + leftFromB1.reduce((a, s) => a + s.buf.byteLength, 0) + b2.bytes;
            state.audioSeconds = +finalSeconds.toFixed(1);
            state.decodeRatio = ratioOf(finalSeconds, finalRequestedSeconds);
            state.decodeFailed = d1.failed + d2.failed;
            state.timing.refineMs = Date.now() - tRefine;
            state.timing.totalMs = Date.now() - t0;
            state.timing.segSlowestMsFine = b2.slowestMs;
            state.totalMs = Date.now() - t0;

            Log.info(`✓ 精修完成 · ${finalOk}/${finalRequested} 段 · ${state.audioSeconds}s · 实测 ${measuredLufs} LUFS · 建议增益 ${planned2.gainDb >= 0 ? '+' : ''}${planned2.gainDb}dB（与初测差 ${delta.toFixed(2)}dB）→ ${moved ? '已重新落位' : '差异过小，增益不动'} · 补齐用 ${state.timing.refineMs}ms（首批尾巴 ${leftFromB1.length} 段 + 第二批 ${b2.segs.length} 段）`);
          } else {
            Log.warn('精修阶段没有可用的解码结果，保留初测结论');
          }
        } else {
          Log.warn('精修阶段一段都没补到（网络异常），保留初测结论');
        }
      }
    }

    /* 4. 收尾（FastPath 也在上面落了位；这里统一补状态与缓存） */
    if (!Number.isFinite(measuredLufs)) throw new Error('响度计算无有效结果（可能全片静音）');
    if (!planned) {
      planned = GainPlanner.plan({ measuredLufs, truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
    }

    /* 5. 写缓存（存原始测量值，换档案立即重算） */
    Store.set(key, {
      measuredLufs,
      truePeakDb,
      source,
      coarse: refined === false,
      sidxSegments: state.sidxSegments,
      picked: state.picked,
      audioSeconds: state.audioSeconds,
      decodeRatio: state.decodeRatio,
      pageDuration: Number.isFinite(videoEl && videoEl.duration) ? +videoEl.duration.toFixed(1) : null,
      targetLufsAtAnalysis: planned.targetLufs,
      analyzedAt: Date.now(),
    });

    const record = {
      source,
      measuredLufs,
      truePeakDb,
      sidxSegments: state.sidxSegments,
      picked: state.picked,
      sampledBytes: state.sampledBytes,
      audioSeconds: state.audioSeconds,
      decodeRatio: state.decodeRatio,
      refined,
      timing: Object.assign({}, state.timing),
    };
    computed.set(key, record);

    state.totalMs = Date.now() - t0;
    push('active', Object.assign({}, record, {
      targetLufs: planned.targetLufs,
      gainDb: planned.gainDb,
      limited: planned.limited,
      limitReason: planned.limitReason,
      reason: null,
    }));

    Log.info(`✓ 归一完成 · 来源=${source}${refined === null ? '' : (refined ? '·已精修' : '·初测')} · 实测 ${measuredLufs} LUFS → 目标 ${planned.targetLufs} LUFS · 增益 ${planned.gainDb >= 0 ? '+' : ''}${planned.gainDb}dB${planned.limited ? `（受限：${planned.limitReason}）` : ''} · 总耗时 ${state.totalMs}ms`);

    if (!Log.isDebug()) return;
    try {
      console.table({
        key, source,
        实测LUFS: measuredLufs, 真峰值dBTP: truePeakDb,
        目标LUFS: planned.targetLufs, 增益dB: planned.gainDb,
        限幅: planned.limited ? planned.limitReason : '否',
        sidx段数: state.sidxSegments, 抽样段数: state.picked,
        抽样MB: state.sampledBytes ? +(state.sampledBytes / 1048576).toFixed(2) : null,
        解码覆盖: state.decodeRatio === null ? '—' : `${(state.decodeRatio * 100).toFixed(0)}%`,
        取流ms: state.timing.fetchMs, 索引ms: state.timing.prepMs,
        首批下载ms: state.timing.sampleMs, 首批落位ms: state.timing.firstMs,
        精修ms: state.timing.refineMs, 总ms: state.totalMs,
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ---- 入口 ---- */

  function fmtSec(v) { return Number.isFinite(v) ? v.toFixed(1) : '?'; }

  let waiting = null;

  function clearWait() {
    if (waiting && waiting.timer) clearTimeout(waiting.timer);
    waiting = null;
  }

  /**
   * @returns {boolean} true = 已获准继续分析；false = 仍在等，调用方应立即 return
   */
  function waitForStream(key, expected, actual) {
    if (!waiting || waiting.key !== key) {
      clearWait();
      waiting = { key, since: Date.now(), timer: null };
    }

    const waited = (Date.now() - waiting.since) / 1000;

    // 宽限期：等太久了就不再拿时长卡着（播放器行为异常时，永久等待比短暂错配更糟）
    if (waited > CONFIG.streamWaitGraceSec) {
      Log.warn(`等播放器切流已 ${waited.toFixed(0)}s 仍未切（元素 ${fmtSec(actual)}s vs 目标 ${fmtSec(expected)}s）→ 不再等待，按当前页面信息继续`);
      clearWait();
      return true;
    }

    push('waiting', {
      key, source: null, measuredLufs: null, truePeakDb: null,
      targetLufs: GainPlanner.currentProfile().targetLufs, gainDb: null,
      reason: `等待播放器切流（元素 ${fmtSec(actual)}s → 目标 ${fmtSec(expected)}s，已等 ${waited.toFixed(0)}s）`,
    });

    if (!waiting.timer) {
      waiting.timer = setTimeout(() => {
        if (waiting) waiting.timer = null;
        maybeRun(Lifecycle.currentElement(), 'retry').catch(e => Log.debug('retry 异常', e && e.message));
      }, CONFIG.streamWaitRetryMs);
    }
    return false;
  }

  async function waitElementDuration(videoEl, expected, myJob) {
    if (!Number.isFinite(expected)) return true;

    const tol = CONFIG.streamWaitToleranceSec;
    const budget = Number.isFinite(CONFIG.pgcStreamWaitMs) ? CONFIG.pgcStreamWaitMs : 8000;
    const t0 = Date.now();

    for (;;) {
      if (jobSeq !== myJob) return false;

      const actual = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
      if (actual && Math.abs(actual - expected) <= tol) return true;

      if (Date.now() - t0 > budget) {
        Log.warn(`等播放器切集超时（元素 ${fmtSec(actual)}s vs 目标 ${fmtSec(expected)}s）→ 不再等待，按接口信息继续`);
        return true;
      }

      push('waiting', {
        key: state.key, source: null, measuredLufs: null, truePeakDb: null,
        targetLufs: GainPlanner.currentProfile().targetLufs, gainDb: null,
        reason: `等待播放器切集（元素 ${fmtSec(actual)}s → 目标 ${fmtSec(expected)}s，已等 ${((Date.now() - t0) / 1000).toFixed(0)}s）`,
      });
      await new Promise(r => setTimeout(r, CONFIG.streamWaitRetryMs));
    }
  }

  /**
   * 尝试分析当前 video。内部按 key 去重，可以放心高频调用。
   */
  async function maybeRun(videoEl, reason) {
    if (!CONFIG.enabled) return;
    if (!videoEl || videoEl.tagName !== 'VIDEO') return;

    const info = StateReader.target();
    if (!info) {
      if (state.phase === 'idle') push('skipped', { reason: '未识别到可分析的页面目标' }, '未识别到页面目标');
      return;
    }

    if (info.kind === 'pgc') {

      if (!info.epId) {
        if (state.phase === 'idle') {
          push('skipped', { reason: '番剧页未识别到 ep_id（可能是季落地页，尚未定集）' }, '未识别到 ep_id');
        }
        return;
      }
    } else {
      if (!info.bvid) {
        if (state.phase === 'idle') push('skipped', { reason: '未识别到 bvid' }, '未识别到 bvid');
        return;
      }

      if (!info.stateFresh || !info.cid) {
        try {
          Object.assign(info, await PlayInfo.resolveVideo(info));
        } catch (e) {
          const msg = `补全视频信息失败：${(e && e.message) || e}`;
          Log.warn(msg);
          push('error', {
            key: null, source: null, measuredLufs: null, gainDb: 0, reason: msg,
            targetLufs: GainPlanner.currentProfile().targetLufs,
          }, msg);
          return;
        }
      }
      if (!info.cid) return;
    }

    const key = StateReader.cacheKey(info);
    if (!key) return;

    /* 等播放器切流：元素时长对不上目标视频就先挂起，绝不把增益压到错的流上 */
    const expected = Number.isFinite(info.duration) ? info.duration : null;
    const actual = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
    if (expected && actual && Math.abs(expected - actual) > CONFIG.streamWaitToleranceSec) {
      Log.debug(`目标时长 ${fmtSec(expected)}s ≠ 元素时长 ${fmtSec(actual)}s → 先等播放器切流`);
      if (!waitForStream(key, expected, actual)) return;
    } else {
      clearWait();
    }

    // 同一任务已在跑 / 已生效 → 不重复
    if (key === runningKey) return;
    if (key === appliedKey) {
      // 回到同一视频（SPA 来回切 / loadedmetadata 二次触发）：
      // 优先用本会话算出来的结论复现（保住「来源」的真实语义），
      // 没有才退回读缓存。
      const known = computed.get(key);
      const source = (known && known.measuredLufs) || (Store.get(key) || {});
      if (Number.isFinite(source.measuredLufs)) {
        const planned = GainPlanner.plan({ measuredLufs: source.measuredLufs, truePeakDb: source.truePeakDb });
        AudioEngine.setGainDb(planned.gainDb);
        push('active', Object.assign({}, known || {
          source: 'cache',
          measuredLufs: source.measuredLufs,
          truePeakDb: source.truePeakDb,
          sidxSegments: source.sidxSegments,
          picked: source.picked,
        }, {
          key,
          targetLufs: planned.targetLufs, gainDb: planned.gainDb, limited: planned.limited,
          limitReason: planned.limitReason, reason: null, totalMs: 0,
        }));
        Log.debug(`复用已算结果 ${key}（来源 ${(known && known.source) || 'cache'}）· 增益 ${planned.gainDb}dB`);
      }
      return;
    }

    const myJob = ++jobSeq;
    runningKey = key;
    clearWait();

    Log.info(`开始分析 ${key}（触发：${reason || '未知'}）`);
    try {
      await analyzeKey(info, key, videoEl, myJob);
    } catch (e) {
      if (jobSeq === myJob) {
        if (e && e.skip) {

          AudioEngine.setGainDb(0);
          push('skipped', {
            key, source: null, gainDb: 0,
            targetLufs: GainPlanner.currentProfile().targetLufs,
            reason: (e && e.message) || String(e),
          }, '跳过');
          Log.warn(`跳过分析（保持原声）· ${(e && e.message) || e}`);
        } else if (appliedKey !== key) {
          // 铁律：失败只归零增益 + 更新状态，绝不干预播放
          AudioEngine.setGainDb(0);
          push('error', {
            key, source: null, gainDb: 0,
            targetLufs: GainPlanner.currentProfile().targetLufs,
            reason: (e && e.message) || String(e),
          });
          Log.warn(`分析失败（保持原声）· ${(e && e.message) || e}`);
        } else {
          // 已经有结论落位了（例如命中初测缓存后精修失败）——
          // 这时候把状态打成「失败」是误报：实际听感正常工作。
          Log.warn(`精修失败，保留已落位的结论 · ${(e && e.message) || e}`);
        }
      }
    } finally {
      if (jobSeq === myJob) runningKey = null;
    }
  }

  async function reanalyze() {
    const el = Lifecycle.currentElement();
    if (!el) return { ok: false, reason: 'no-video' };
    const info = StateReader.target();
    const key = info ? StateReader.cacheKey(info) : null;
    if (key) Store.remove(key);
    appliedKey = null;
    clearWait();
    PlayInfo.forget();   // 连「已采信过哪份 playinfo」的记忆一起清，强制重新判定
    await maybeRun(el, '手动');
    return { ok: true, state: snapshot() };
  }

  async function reapply() {
    const el = Lifecycle.currentElement();
    const info = StateReader.target();
    const key = info ? StateReader.cacheKey(info) : null;
    if (!key) return { ok: false, reason: 'no-key' };

    const cached = Store.get(key);
    if (!cached || !Number.isFinite(cached.measuredLufs)) {
      return await reanalyze();
    }

    const planned = GainPlanner.plan({ measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb });
    AudioEngine.setGainDb(planned.gainDb);
    appliedKey = key;
    push('active', {
      key, source: 'cache', measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb,
      targetLufs: planned.targetLufs, gainDb: planned.gainDb, limited: planned.limited,
      limitReason: planned.limitReason, reason: null, totalMs: 0,
      refined: cached.coarse ? false : true,
    });
    Log.info(`档案切换重算 · 实测 ${cached.measuredLufs} LUFS → 目标 ${planned.targetLufs} → 增益 ${planned.gainDb}dB（零下载）`);
    return { ok: true, state: snapshot(), el };
  }

  /* ---- 旁路 ---- */

  /** 旁路开关：不施加增益（听原声），但保留分析结果 —— 用于 A/B 对比 */
  function setBypass(v) {
    const on = AudioEngine.setBypass(v);
    push(state.phase, {});
    return on;
  }

  function toggleBypass() { return setBypass(!AudioEngine.isBypass()); }
  function isBypass() { return AudioEngine.isBypass(); }

  return {
    maybeRun,
    reanalyze,
    reapply,
    snapshot,
    setBypass,
    toggleBypass,
    isBypass,
    isEnabled() { return CONFIG.enabled; },
    setEnabled(v) {
      CONFIG.enabled = !!v;
      if (!v) { AudioEngine.setGainDb(0); push('idle', { gainDb: 0 }); }
      Log.info('响度归一已' + (v ? '启用' : '停用'));
    },
  };
})();

const Lifecycle = (() => {
  let lastEl = null;
  let lastHref = null;
  let pollTimer = null;
  let observer = null;
  let mutationDebounce = null;
  let started = false;

  const obs = { ticks: 0, elementSwaps: 0, attached: 0 };

  function isVideoEl(el) {
    return !!el && el.tagName === 'VIDEO';
  }

  /** 优先在播放器容器内找，找不到再全文档兜底 */
  function findVideo() {
    for (let i = 0; i < CONFIG.playerSelectors.length; i++) {
      let box = null;
      try { box = document.querySelector(CONFIG.playerSelectors[i]); } catch (e) { box = null; }
      if (box) {
        const v = box.querySelector('video');
        if (isVideoEl(v)) return v;
      }
    }
    const v = document.querySelector('video');
    return isVideoEl(v) ? v : null;
  }

  /* ---- 媒体事件 ---- */

  const MEDIA_EVENTS = ['loadedmetadata', 'durationchange', 'emptied', 'abort', 'error'];

  function onMediaEvent(ev) {
    const el = ev.target;
    if (ev.type === 'error') {
      const err = el.error;
      Log.warn(`video 报错 · code=${err && err.code} · ${err && err.message || ''}`);
      return;
    }
    const dur = Number.isFinite(el.duration) ? `${el.duration.toFixed(1)}s` : '?';
    Log.debug(`video 事件 ${ev.type} · duration=${dur} · readyState=${el.readyState}`);

    // 时长确定后是分析的最佳时机：此时 dash.duration 的时效性校验也有了依据
    if (ev.type === 'loadedmetadata' || ev.type === 'durationchange') {
      Analyzer.maybeRun(el, ev.type).catch(e => Log.debug('maybeRun 异常', e && e.message));
    }
  }

  function bindMediaEvents(el) {
    MEDIA_EVENTS.forEach(t => el.addEventListener(t, onMediaEvent));
  }

  function unbindMediaEvents(el) {
    MEDIA_EVENTS.forEach(t => el.removeEventListener(t, onMediaEvent));
  }

  /* ---- 主循环 ---- */

  async function tick(why) {
    obs.ticks++;
    const el = findVideo();
    if (!el) return;

    const href = location.href;
    const urlChanged = lastHref !== null && href !== lastHref;
    if (urlChanged) {
      Log.info(`路由变化 → 重新评估 · ${href.slice(0, 90)}`);
      lastHref = href;
    } else if (lastHref === null) {
      lastHref = href;
    }

    if (!urlChanged && el === lastEl && AudioEngine.isAttached(el)) return;

    const swapped = el !== lastEl;

    if (swapped) {
      const isFirst = lastEl === null;
      const prev = lastEl;
      lastEl = el;
      obs.elementSwaps++;

      if (!isFirst && prev) {
        // 只解绑事件；【绝不】disconnect 旧元素的音频源
        try { unbindMediaEvents(prev); } catch (e) { /* 忽略 */ }
        Log.info(`video 元素被替换（第 ${obs.elementSwaps} 次）· 旧元素交还 GC，不做任何音频断连`);
      } else {
        Log.info(`发现 video 元素（${why}）· src=${String(el.currentSrc || el.src || '').slice(0, 58)}`);
      }
      bindMediaEvents(el);
    }

    const ok = await AudioEngine.tryAttach(el);
    if (ok) obs.attached = AudioEngine.stats().attached;

    // 元素一变 或 路由一变就触发分析（内部按 key 去重，重复调用无副作用）
    if (swapped || urlChanged) {
      Analyzer.maybeRun(el, urlChanged ? '路由变化' : why).catch(e => Log.debug('maybeRun 异常', e && e.message));
    }
  }

  function scheduleTick(why) {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => {
      mutationDebounce = null;
      tick(why).catch(e => Log.error('tick 异常', e && e.message));
    }, CONFIG.mutationDebounceMs);
  }

  function whenBodyReady(fn) {
    if (document.body) return fn();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function start() {
    if (started) return;
    started = true;

    // 主力：定时轮询。不依赖 DOM ready，后台标签页也不会冻结（不像 rAF）
    pollTimer = setInterval(() => {
      tick('poll').catch(e => Log.error('tick 异常', e && e.message));
    }, CONFIG.pollIntervalMs);

    // 辅助：MutationObserver，仅用于「尽快」感知元素出现
    whenBodyReady(() => {
      try {
        observer = new MutationObserver(() => scheduleTick('mutation'));
        observer.observe(document.body, { childList: true, subtree: true });
        Log.debug('MutationObserver 已挂载到 document.body');
      } catch (e) {
        Log.warn('MutationObserver 挂载失败，仅依赖轮询', e && e.message);
      }
      tick('init').catch(e => Log.error('tick 异常', e && e.message));
    });

    Log.info(`Lifecycle 启动 · 轮询间隔 ${CONFIG.pollIntervalMs}ms`);
  }

  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (mutationDebounce) { clearTimeout(mutationDebounce); mutationDebounce = null; }
    if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } observer = null; }
    started = false;
    Log.info('Lifecycle 已停止');
  }

  return {
    start,
    stop,
    stats() { return Object.assign({}, obs); },
    currentElement() { return lastEl; },
  };
})();

const Main = (() => {

  /** Safari / WebKit：MSE 源在 MediaElementAudioSourceNode 上输出全 0，WebKit 至今未修 */
  function isWebKitOnly() {
    const ua = navigator.userAgent;
    return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
  }

  /** 页型判定收敛到 StateReader.kind()（video / pgc / other），避免两处各写一份 */
  function pageKind() {
    return StateReader.kind();
  }

  /* ---- 旁路 ---- */

  function hotkeyText() {
    const hk = CONFIG.bypassHotkey || {};
    return [hk.ctrl ? 'Ctrl' : null, hk.alt ? 'Alt' : null, hk.shift ? 'Shift' : null, String(hk.key || 'b').toUpperCase()]
      .filter(Boolean).join('+');
  }

  function gainText() {
    const g = Analyzer.snapshot().gainDb;
    return Number.isFinite(g) ? `${g >= 0 ? '+' : ''}${g.toFixed(2)}dB` : '—';
  }

  function toggleBypass() {
    const on = Analyzer.toggleBypass();
    const label = on
      ? `旁路：听原声（归一 ${gainText()} 暂不施加）`
      : `恢复归一：${gainText()}`;
    if (CONFIG.bypassToast) Hud.toast(label);
    Log.info(label);
    return on;
  }

  function registerHotkey() {
    const hk = CONFIG.bypassHotkey || {};
    const want = String(hk.key || 'b').toLowerCase();

    document.addEventListener('keydown', (ev) => {
      if (ev.repeat || ev.isComposing) return;
      if (String(ev.key || '').toLowerCase() !== want) return;
      if (!!hk.shift !== ev.shiftKey) return;
      if (!!hk.alt !== ev.altKey) return;
      if (!!hk.ctrl !== ev.ctrlKey) return;
      if (!!hk.meta !== ev.metaKey) return;

      // 别在输入框里抢按键（搜索框、评论框、发弹幕时按 B 不该切旁路）
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      toggleBypass();
    }, true);

    Log.info(`旁路快捷键已注册：${hotkeyText()}`);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('开关响度归一', () => {
        Analyzer.setEnabled(!Analyzer.isEnabled());
      });
      GM_registerMenuCommand(`旁路开关（对比原声 ${hotkeyText()}）`, () => {
        toggleBypass();
      });

      GM_registerMenuCommand('清空测量缓存', () => {
        Store.clear();
      });
    } catch (e) {
      Log.debug('菜单命令注册失败（非致命）', e && e.message);
    }
  }

  function buildStatus() {
    return {
      version: CONFIG.version,
      stage: CONFIG.stage,
      enabled: CONFIG.enabled,
      href: location.href,
      pageKind: pageKind(),
      target: StateReader.target(),
      profile: CONFIG.profile,
      analysis: Analyzer.snapshot(),
      bypass: Analyzer.isBypass(),
      audioEngine: AudioEngine.stats(),
      audioContext: AudioEngine.getContextState(),
      gainLinear: AudioEngine.getGainValue(),
      gainDesiredDb: AudioEngine.getDesiredGainDb(),
      gainAppliedDb: AudioEngine.getAppliedGainDb(),
      lifecycle: Lifecycle.stats(),
      cache: Store.stats(),
      video: (() => {
        const el = Lifecycle.currentElement();
        if (!el) return null;
        return {
          source: String(el.currentSrc || el.src || '').slice(0, 70),
          volume: el.volume,
          muted: el.muted,
          paused: el.paused,
          readyState: el.readyState,
          currentTime: +el.currentTime.toFixed(2),
          duration: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null,
          crossOrigin: el.crossOrigin,
        };
      })(),
    };
  }

  /** 暴露到页面上下文，供 CDP / DevTools 直接读 —— 验证接口 */
  function exposeDebugApi() {
    const target = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    target.__biliLoudness = {
      version: CONFIG.version,
      stage: CONFIG.stage,
      status: buildStatus,
      logs: () => Log.ring(),
      clearLogs: () => Log.clear(),

      /* 分析相关 */
      analysis: () => Analyzer.snapshot(),
      reanalyze: () => Analyzer.reanalyze(),
      setEnabled: (v) => Analyzer.setEnabled(v),
      setProfile: (k) => {
        if (!CONFIG.profiles[k]) return { ok: false, reason: '未知档案' };
        CONFIG.profile = k;
        // 换档案 → 用缓存里的原始测量值立即重算，零下载零解码
        return Analyzer.reapply();
      },
      listProfiles: () => GainPlanner.listProfiles(),
      forceSamplePath: (v) => {
        CONFIG.forceSamplePath = !!v;
        Log.info('强制抽样路径 = ' + CONFIG.forceSamplePath);
        return CONFIG.forceSamplePath;
      },

      /* 缓存 */
      cache: {
        stats: () => Store.stats(),
        list: () => Store.list(),
        clear: () => Store.clear(),
      },

      verifyIndex: async () => {
        const pi = PlayInfo.fromPage();
        if (!pi || !pi.audio) return { ok: false, reason: '页面没有可用 dash 音频轨' };
        const a = pi.audio;
        const anchor = a.indexRange.end + 1;

        const idxBuf = await Sampler.fetchRange(a.url, a.indexRange.start, a.indexRange.end, 'verify-idx');
        const parsed = Sidx.parse(idxBuf, anchor);
        if (!parsed) return { ok: false, reason: 'sidx 解析失败' };

        const end = parsed.endOffset;
        let justInside = null;
        let justOutside = null;
        try {
          const r1 = await fetch(a.url, { headers: { Range: `bytes=${end - 1}-` }, credentials: 'omit' });
          justInside = r1.status;
          if (r1.status === 206) await r1.arrayBuffer();
        } catch (e) { justInside = 'err'; }
        try {
          const r2 = await fetch(a.url, { headers: { Range: `bytes=${end}-` }, credentials: 'omit' });
          justOutside = r2.status;
          if (r2.status === 206) await r2.arrayBuffer();
        } catch (e) { justOutside = 'err'; }

        const ok = justInside === 206 && justOutside === 416;
        const picked = Sidx.pickEvenly(parsed.refs, CONFIG.sampleSegments);

        return {
          ok,
          reason: ok ? null : `内侧探测=${justInside}（期望 206）、越界探测=${justOutside}（期望 416）`,
          audioId: a.id,
          audioMime: a.mimeType,
          host: String(a.url).replace(/^https?:\/\//, '').split('/')[0],
          indexRange: a.indexRange,
          indexBytes: idxBuf.byteLength,
          anchor,
          firstOffset: parsed.firstOffset,
          segments: parsed.refs.length,
          timescale: parsed.timescale,
          segDuration: parsed.refs[0] ? +parsed.refs[0].duration.toFixed(3) : null,
          totalDuration: +parsed.refs.reduce((s, r) => s + r.duration, 0).toFixed(2),
          firstSegOffset: parsed.refs[0].offset,
          endOffset: end,
          probeInsideStatus: justInside,
          probeBeyondStatus: justOutside,
          pickedCount: picked.length,
          pickedPreview: picked.slice(0, 14),
        };
      },

      /* 音频与信号 */
      getGain: () => AudioEngine.getGainValue(),
      getGainDb: () => AudioEngine.getAppliedGainDb(),
      getDesiredGainDb: () => AudioEngine.getDesiredGainDb(),
      probeSignal: (ms) => AudioEngine.probeSignal(ms),

      setBypass: (v) => Analyzer.setBypass(v === undefined ? !Analyzer.isBypass() : v),
      toggleBypass: () => Analyzer.toggleBypass(),
      isBypass: () => Analyzer.isBypass(),

      /* 调试 / 诊断 */
      hud: (v) => Hud.setEnabled(v === undefined ? !Hud.isEnabled() : v),
      hudInfo: () => Hud.info(),
      setDebug: (v) => Log.setDebug(v),

      panel: (v) => Panel.setPanelEnabled(v === undefined ? !Panel.isEnabled() : v),
      panelInfo: () => Panel.info(),

      fsInfo: () => Panel.fsInfo(),
      panelToggle: (which) => { Panel.toggle(which); return Panel.isOpen(); },

      setCustom: (patch) => { Panel.setCustom(patch); return GainPlanner.currentProfile(); },
      settings: () => Store.getSettings(),

      config: (k, v) => {
        if (k === undefined) return Object.assign({}, CONFIG);
        if (v === undefined) return CONFIG[k];
        CONFIG[k] = v;
        Log.info(`CONFIG.${k} = ${JSON.stringify(v)}`);
        return CONFIG[k];
      },

      pageState: () => {
        const el = Lifecycle.currentElement();
        const pi = PlayInfo.fromPage();
        return {
          href: location.href,
          pageKind: pageKind(),
          target: StateReader.target(),

          stateFresh: StateReader.kind() === 'pgc' ? StateReader.pgcFresh() : StateReader.pageFresh(),
          reader: StateReader.videoKey(),
          pagePlayinfo: pi ? {
            kind: pi.kind || 'video',
            origin: pi.origin,
            duration: pi.duration,
            audioId: pi.audio ? pi.audio.id : null,
            audioMime: pi.audio ? pi.audio.mimeType : null,
            hasVolume: !!pi.volumeMeta,
            measuredI: pi.volumeMeta ? pi.volumeMeta.measuredI : null,
            measuredTp: pi.volumeMeta ? pi.volumeMeta.measuredTp : null,
            isPreview: !!pi.isPreview,
            isDrm: !!pi.isDrm,
            hasDurlOnly: !!pi.hasDurlOnly,
            cid: pi.cid || null,
            bvid: pi.bvid || null,
          } : null,
          video: el ? {
            duration: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null,
            readyState: el.readyState,
            paused: el.paused,
          } : null,
        };
      },

      /* 生命周期 */
      start: () => Lifecycle.start(),
      stop: () => Lifecycle.stop(),
    };
    Log.debug('调试接口已挂到 window.__biliLoudness');
  }

  function boot() {
    Log.info(`Bilibili_LoudNorm v${CONFIG.version} (${CONFIG.stage}) · ${location.href}`);

    if (isWebKitOnly()) {
      Log.warn('检测到 Safari/WebKit：MSE 音频源在该引擎上输出恒为 0（WebKit 未修复的已知 bug），已放弃接管，不影响原声播放');
      return;
    }

    const kind = pageKind();
    if (kind === 'other') {
      Log.info(`非目标页型（${kind}：${location.pathname}），不启动`);
      return;
    }

    const kindLabel = kind === 'pgc' ? '番剧/影视' : '普通投稿';
    Log.info(`页型 = ${kind}（${kindLabel}），启动接管 + 归一流程 · 档案=${GainPlanner.currentProfile().label}(${GainPlanner.currentProfile().targetLufs} LUFS)`);

    // ⚠️ 面板必须在 Lifecycle.start() 之前 init —— 它会把持久化的设置
    //    （开关 / 预设 / 自定义目标与上下限）套回 CONFIG，
    //    晚了第一轮分析就会用默认档跑，白等一次抽样。
    // ⚠️ 而且必须**兜住异常**：面板是 UI，核心是归一。UI 出错不该把

    //    ShadowRoot 没有 style 属性 → 面板样式写崩 → 整个功能没起来）。
    try {
      Panel.init();
    } catch (e) {
      Log.warn('设置面板初始化失败（不影响归一功能）', e && e.message);
      try { Panel.setPanelEnabled(false); } catch (e2) { /* 忽略 */ }
    }

    Lifecycle.start();
    registerMenu();
    registerHotkey();
    exposeDebugApi();
    if (CONFIG.hud) Hud.update(Analyzer.snapshot());
  }

  return { boot, buildStatus };
})();

Main.boot();

})();
