// ==UserScript==
// @name         B站响度归一
// @name:en      Bilibili_LoudNorm
// @namespace    https://github.com/ADMA200/Bilibili_LoudNorm
// @version      1.1.0
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
 * 构建产物 —— 请勿直接编辑，改动请改 src/ 后重新运行 node build.mjs
 * 构建模块：config.js, logger.js, store.js, sidx.js, loudness.js, gain-planner.js, state-reader.js, playinfo.js, sampler.js, audio-engine.js, hud.js, panel.js, analyzer.js, lifecycle.js, main.js
 */

(function () {
'use strict';

/* ============================== config.js ============================== */
/* ================================================================
 * config.js — 全局配置
 *
 * 单一来源：build.mjs 从这里提取版本号写进 UserScript header。
 * ================================================================ */
const CONFIG = {
  version: '1.1.0',
  stage: 'S3.3.0',   // S3.3.0 = 状态面板加「重新测量本视频」；油猴菜单去掉四个调试入口

  /** 总开关 */
  enabled: true,

  /**
   * 调试日志：**默认关闭**（S3.3.0 起）。
   *
   * 只控制 `Log.debug()`（内部细节行）；`Log.info / warn / error` 不受影响。
   * 原先默认开、靠油猴菜单的调试日志开关去关 —— S3.3.0 把那四个调试菜单项删了，
   * 用户就没有关它的入口了，于是默认值一并改为 false，保持「开箱即静」。
   * 需要时控制台：`__biliLoudness.setDebug(true)`。
   */
  debug: false,

  /**
   * 调试 HUD：**默认关闭**（S3.2.1 起）。
   *
   * S2 期间默认开是为了直观看到每一步；S3.2 有了左侧面板后，HUD 展示的
   * 「来源 / 实测 / 目标 / 增益 / 状态」与「状态」面板**完全重复**，
   * 而且常驻在左下角挡视线。
   *
   * 关掉不影响：`Hud.toast()` 是独立宿主，旁路提示 / 清缓存反馈照常显示。
   * 需要时控制台 `__biliLoudness.hud(true)` 临时打开（S3.3.0 起油猴菜单里不再有这个开关）。
   */
  hud: false,

  /**
   * 【仅调试】强制走抽样路径，忽略 B 站官方元数据。
   * 用途：拿有元数据的视频当标尺 —— 我们的测量结果应当与 B 站自己的
   * measured_i 吻合，这是验证本地测量精度的最直接办法。
   */
  forceSamplePath: false,

  /* ------------------------------------------------ 响度档案（§4.4） */

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

  /* ------------------------------------------------------ 增益安全 */

  /**
   * 削波余量上限：允许的最大提升 = peakCeilingDb − 实测真峰值。
   * 例：真峰值 −2.0 dBTP、余量 −1.0 dB → 最多只能提 +1.0 dB。
   * S2 不加 WaveShaper 软限幅 —— 靠这条预算从源头保证不削波，
   * 比事后压限更透明（详见 docs）。
   */
  peakCeilingDb: -1.0,

  /**
   * setTargetAtTime 的时间常数（秒）。4τ ≈ 120ms「音量落位」的过渡，
   * 避免切换瞬间「咔」一声的跳变。
   */
  gainRampTau: 0.04,

  /* ------------------------------------------------------ 旁路（S2.2） */

  /**
   * 旁路开关：一键在「归一后」与「原声」之间来回切，用来做 A/B 对比。
   * 旁路 ≠ 停用 —— 分析照跑、结果照存，只是**不施加增益**，
   * 所以切回来是瞬时的（不用重新等抽样）。
   *
   * 默认 Shift+B。B 站自己的快捷键里 b 没有绑定，实测不冲突。
   * ⚠️ 监听里**不调用 preventDefault**（构建守卫禁止，也没有必要）——
   *    我们只是"顺便看一眼"按键，不拦截页面行为。
   */
  bypassHotkey: { key: 'b', shift: true, alt: false, ctrl: false, meta: false },
  /** 切换时弹一个 1.4s 的小提示（HUD 关着时也能看见反馈） */
  bypassToast: true,

  /* ---------------------------------------------------- 抽样参数（§4.2） */

  /** 均匀抽取的段数（每段约 5s → 默认共约 60s 音频） */
  sampleSegments: 12,

  /**
   * 【S2.2 渐进式】是否分两批抽样。
   *
   * 起因：实测发现抽样时长不稳定（有时要等 6s 以上）。归因是**木桶效应** ——
   * 12 段全部到齐才肯解码，于是「最慢那一段」决定了整体耗时（慢段可能来自
   * CDN 冷连接、与播放器抢带宽、偶发重传）。
   *
   * 改法：先抽「覆盖全片但更稀疏」的 firstBatchSegments 段 → 立刻解码测量并落位
   * （首次可用时间 ≈ 原来的 1/2~1/3），剩下的段后台补齐后精修。
   * 精修结果与初测增益差 ≥ refineMinDeltaDb 才重新落位，避免听感上无意义的抖动。
   */
  progressive: true,
  /** 首批段数（从 12 段里等距挑，含首尾 → 依然覆盖 0%–100% 时间轴） */
  firstBatchSegments: 6,
  /** 精修后增益与初测差多少 dB 才值得动一下（小于它就不抖了） */
  refineMinDeltaDb: 0.5,

  /**
   * 【S2.2 够用即开工】首批抽到几段就立刻开算，不等剩下的。
   *
   * 这才是真正杀掉「有时得等 6s 以上」的那一刀：原来一批 6 段全到齐才开工，
   * 只要有一段卡住（慢 CDN / 与播放器抢带宽 / 重传），整条链路就干等它。
   * 现在够 4 段就走，剩下的在后台继续取。
   *
   * 为什么是 4：4 段 ≈ 19s 音频，已接近 BS.1770 对短节目「至少 10s」的建议，
   * 且等距分布在 0%–100% 时间轴上，初测偏差通常在 1 LU 内（精修会纠正）。
   * 再往下调会更快，但初测太糙反而更容易触发精修重落位，得不偿失。
   */
  firstBatchEagerAt: 4,

  /** 并发上限（HTTP/2 下同域名多路复用，6 并发不会再撞连接数限制） */
  concurrency: 6,
  /** 两次请求发起之间的最小间隔，防 -799 限流 */
  requestGapMs: 80,
  /** 单次 Range 请求超时（init/sidx 这类小请求用它） */
  fetchTimeoutMs: 15000,

  /**
   * 单段抽样请求的超时与重试。
   * 比 fetchTimeoutMs 短得多 —— 一段只有 ~55KB，正常 100ms 内就回来了；
   * 卡住 5s 基本等于这条路不通，重试一次比死等 15s 划算。
   */
  segTimeoutMs: 5000,
  segRetry: 1,
  segRetryDelayMs: 250,

  /**
   * 至少要拿到几段才继续算。
   * 低于它就承认「这次网络太差」，报错重来 —— 比拿 1 段音频硬算出一个
   * 偏 5 LU 的响度、再把错误的增益扣到用户头上要好得多。
   */
  minSegmentsToProceed: 3,

  /** 逐段解码的并发（decodeAudioData 内部本就是串行的，给 2 足够重叠 I/O） */
  decodeConcurrency: 2,

  /**
   * 响度计算的分块粒度（帧）。每算这么多帧让出一次主线程，
   * 避免在页面上糊一个几百毫秒的长任务（会连带影响播放器 UI 与弹幕）。
   * 240000 帧 @48kHz = 5s 音频 —— 60s 抽样约 12 次让步，开销可忽略。
   */
  lumChunkFrames: 240000,

  /** 首选音频档位：30232 ≈ 132kbps 中档，解码快、响度等价 */
  preferAudioId: 30232,
  /** 不参与归一的音频档位（杜比 / Hi-Res，解码器可能不支持） */
  excludeAudioIds: [30250, 30251, 30280],

  /* ------------------------------------------------ 番剧 / 影视（S3.1） */

  /**
   * 番剧回落接口。⚠️ 与普通投稿的 `x/player/playurl` 完全不同：
   *   - 入口参数是 `ep_id`（不是 bvid+cid）
   *   - 不回 data 而是回 `result`
   *   - 不需要 wbi 签名、不需要 Referer【实测】
   *
   * 【实测·重要】两条路的 dash 位置**不一样**，必须多路径兜：
   *   SSR  `__playinfo__.result.video_info.dash`
   *   接口 `result.dash`（扁平）
   * 而且接口这条**永远不含响度元数据**（元数据只在 SSR 那一份），
   * 所以「切集后想拿元数据」是拿不到的，只能走抽样。
   */
  pgcApi: 'https://api.bilibili.com/pgc/player/web/playurl',
  pgcQn: 80,
  pgcFnval: 4048,

  /**
   * 番剧接口结果的内存缓存时长。
   * 同一 ep 在一次会话里被反复触发（durationschange / 路由抖动）时零请求。
   */
  pgcCacheTtlMs: 10 * 60 * 1000,

  /**
   * 番剧接口的分派策略（错误码在**两处**都要看：
   * 顶层 `code` 与 `result.error_code` —— 试看时顶层是 0、真错误藏在后者）。
   *
   *   -403 权限不足 / -404 资源不存在 / -688 地区限制 / -689 版权限制 → 跳过分析（保持原声）
   *   -412 IP 风控 → **立即停手，不重试**（越试越糟）
   */
  pgcSkipCodes: [-403, -404, -688, -689],
  pgcAbortCodes: [-412],

  /**
   * 番剧「切集等流」的有界等待（毫秒）。
   *
   * 与普通投稿的 streamWaitGraceSec(20s) 分开设：普通投稿的等待发生在
   * **取流之前**（还没花任何成本），可以宽一点；而番剧这里已经取到了流信息，
   * 只是等播放器把 `<video>` 换到新集 —— 这个动作正常 1–3s，超过 8s 基本
   * 说明判据不成立（例如清晰度切换导致的时长微差），再等下去只会白拖。
   */
  pgcStreamWaitMs: 8000,

  /* -------------------------------------------------- 设置面板（S3.2） */

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

  /* ---------------------------------------------------------- 缓存（§9） */

  cacheMaxEntries: 800,
  cacheTtlDays: 30,

  /* ------------------------------------------- 页面状态新鲜度（S2.1 新增） */

  /**
   * 「元素时长 vs 目标视频时长」的容差（秒）。
   * 超过它 = 播放器还没切到新流，此时施加增益会把新视频的响度压到旧视频上，
   * 所以宁可先不动、等切流完成（见 analyzer 的 waiting 阶段）。
   */
  streamWaitToleranceSec: 3,
  /**
   * 等切流的宽限期（秒）。超过它就不再拿时长卡着 ——
   * 真实浏览器里切流一般 1–3s，但万一播放器行为异常，永久等待会让功能彻底失效，
   * 这比「短暂错配」更糟。宽限期后照常分析，只是记一条 warn。
   */
  streamWaitGraceSec: 20,
  /** 等切流时的回访间隔（毫秒）。靠它轮询，durationchange 事件也会立刻唤醒 */
  streamWaitRetryMs: 700,
  /** view 接口结果的内存缓存时长（毫秒）。同一视频切分P 靠它零请求 */
  viewCacheTtlMs: 10 * 60 * 1000,

  /* ---------------------------------------------------- 生命周期（S1 沿用） */

  /** video 元素发现轮询间隔。必须 setInterval 而非 rAF：后台标签页 rAF 会被冻结 */
  pollIntervalMs: 300,
  /** DOM 变动后触发一次检查的防抖延迟 */
  mutationDebounceMs: 250,
  /** 播放器容器选择器，新 → 旧按序尝试 */
  playerSelectors: [
    '.bpx-player-container',
    '.bpx-player-primary-area',
    '#bilibili-player',
    '.bilibili-player',
  ],
};

/* ============================== logger.js ============================== */
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

/* ============================== store.js ============================== */
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

/* ============================== sidx.js ============================== */
/* ================================================================
 * sidx.js — fMP4 分段索引解析（纯函数，无副作用）
 *
 * B 站音频是单文件 fMP4：
 *     ftyp → moov(含 mvex/trex) → sidx → [moof+mdat]×N
 * SegmentBase.indexRange 直接给出 sidx 的字节区间，所以我们只要
 * 拿几 KB 就能知道整条时间轴上每一段的位置与长度。
 *
 * 关键点：不全量下载音频，却能覆盖整片时间轴 —— 只要几 KB 索引，
 * 就知道每一段在哪、有多长。
 *
 * 结构（ISO/IEC 14496-12 §8.16.3）：
 *   box header(8|16) + version(1) flags(3) reference_ID(4)
 *   timescale(4) earliest_presentation_time(v0:4 / v1:8)
 *   first_offset(v0:4 / v1:8) reserved(2) reference_count(2)
 *   然后每条 reference 12 字节：
 *     type(1bit) + referenced_size(31bit) | subsegment_duration(4) | SAP(4)
 * ================================================================ */
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

  /**
   * 解析 sidx。
   *
   * ⚠️ anchor 是**必须**传对的那个坑：ISO/IEC 14496-12 规定
   *    first_offset 的基准点是「sidx box 之后的第一个字节」，不是文件头。
   *    若按 anchor=0 解析，B 站音频每一段都会整体前移「ftyp+free+moov+sidx」的长度
   *    （实测该视频是 1482 字节），抓到的字节全错位 —— 表现为只有第 0 段能解码
   *    （它恰好含完整 init+sidx+moof+mdat），其余全部报 Unable to decode audio data。
   *
   * @param {ArrayBuffer|Uint8Array} input 从 indexRange 拿到的字节（起点应就是 sidx box）
   * @param {number} [anchor=0] 索引基准点（文件内绝对偏移），通常传 indexRange.end + 1
   * @returns {null | {version, timescale, earliestPresentationTime, firstOffset, anchor, refs}}
   *          refs[i] = { index, t, duration, size, offset }
   *          offset 是**文件内绝对字节偏移**，t / duration 单位秒
   */
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

  /**
   * 自校验：Σ size + firstOffset 是否等于整文件长度。
   * S0 实测 B 站音频满足此式（43 段 × 5s 精确吻合 Content-Length）。
   */
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

  /**
   * 从一个**已经均匀**的抽取结果里，再等距挑出 k 个（含首尾）。
   *
   * 用途：渐进式抽样的第一批。既要「段数少、来得快」，又要
   * 「依然覆盖整条时间轴」—— 直接取前 k 个会让第一批只覆盖前半段，
   * 片尾音量就无从判断了。等距子集（0、25%、50%、75%、100%）两头都摸得到。
   *
   * @param {number[]} picks 已排序的段号
   * @param {number} k 想要几个
   * @returns {number[]} 段号的子集（升序）
   */
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

/* ============================== loudness.js ============================== */
/* ================================================================
 * loudness.js — ITU-R BS.1770 集成响度 + 真峰值
 *
 * 用途：拿到「拼接后的抽样音频」→ 算出整片响度（LUFS）。
 * 因为抽样是均匀覆盖整条时间轴的，这个值可以代表全片。
 *
 * 实现要点（对齐 BS.1770-4 / EBU R128）：
 *   a) K 加权 = 高架(+4dB@1682Hz) → 高通(38Hz)，系数按实际采样率现算
 *   b) 分块 400ms / 步长 100ms（75% 重叠）
 *   c) 块响度 l_j = -0.691 + 10·log10( Σ_i G_i · z_ij )
 *   d) 绝对门限：丢弃 l_j < -70 LUFS
 *   e) 相对门限：Γ = 保留块能量均值(dB) − 10，再筛一遍
 *   f) 集成响度 = -0.691 + 10·log10( Σz / N )
 *   g) 真峰值 = 未加权 PCM 的最大绝对值（不做过采样，留 1dB 余量够用）
 *
 * 系数采用 pyloudnorm / De Man 那套「按采样率现算」的写法，
 * 与 BS.1770 参考系数的偏差约 0.25dB —— 对「拉齐音量」完全够用。
 * ================================================================ */
const Loudness = (() => {
  const OFFSET_691 = -0.691;
  const ABS_GATE_LUFS = -70;
  const REL_GATE_LU = 10;

  /* ------------------------------------------------- K 加权滤波器 */

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

  /**
   * 高通滤波：fc=38.13547087602444 Hz, Q=0.5003270373238773
   *
   * ⚠️ 分子**不除以 a0**（b = [1, -2, 1]）—— 这不是笔误，BS.1770-4 的高通
   *    就是这么一个「整体带 +0.043dB 增益」的形式。若按常规归一化（除以 a0），
   *    实测响度会系统性偏低 0.043dB，与 B 站元数据对不上。
   *    单元测试用标准表里的 48kHz 系数逐频点比对来钉住这件事。
   */
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

  /**
   * 直接 I 型双二阶，原地过滤。
   * 返回过滤后的峰值（顺带把「未加权真峰值」也扫出来，省一遍遍历）。
   */
  function biquadInPlace(x, c) {
    const st = biquadState();
    biquadRange(x, 0, x.length, c, st);
  }

  /** IIR 的四个延迟单元。分块滤波必须把状态带过块边界，否则块间会有跳变 */
  function biquadState() { return { x1: 0, x2: 0, y1: 0, y2: 0 }; }

  /**
   * 对 x[s, e) 做一次原地双二阶，状态从 st 续上、算完写回 st。
   *
   * 为什么要有「分块」版本（S2.2）：60s 立体声有 576 万个采样点，
   * 一趟滤波 + 累加就是几百毫秒的**不可中断**长任务 —— 页面正开着 B 站，
   * 主线程被占住会连带影响播放器 UI 与弹幕。切块后每块之间让一次主线程，
   * 结果与一次性滤波**逐位相同**（状态连续，不是重新起头）。
   */
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

  /**
   * 把多段解码结果拼成一条连续 PCM（供 measure 使用）。
   *
   * 段落之间做 5ms 淡入淡出：抽样段在原片里是连续的，但抽出来是彼此不相邻的
   * 片段，硬拼会在边界产生跳变。淡入淡出对集成响度的影响远小于 0.01dB
   * （5ms / 5000ms），但能让波形干净。
   *
   * @param {BaseAudioContext} scope 用来 createBuffer 的上下文
   * @param {AudioBuffer[]} buffers
   */
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

  /* ---------------------------------------------------- 主入口 */

  /**
   * @param {AudioBuffer} audioBuffer 解码后的抽样音频
   * @param {{onYield?: Function}} [opts]
   * @returns {Promise<{lufs, truePeakDb, truePeakLinear, blocks, blocksAfterAbs, blocksAfterRel, frames, sampleRate, channels, processedMs}>}
   */
  async function measure(audioBuffer, opts) {
    const o = opts || {};
    const t0 = Date.now();

    const fs = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const frames = audioBuffer.length;

    const hs = highShelfCoeffs(fs);
    const hp = highPassCoeffs(fs);

    /** 逐采样能量累加器（已 K 加权）
     *
     * ⚠️ BS.1770 对多声道是**求和**不是平均：l_j = -0.691 + 10·log10(Σ_i G_i·z_ij)，
     *    环绕声权重 G 为 {L:1, R:1, C:1.41, Ls/Rs:1.41}。
     *    同一信号同时放进左右两声道，测得响度比单声道**高 3.01dB** —— 这是标准的
     *    规定行为（也是 mono→stereo 上混会让测量响度上升的原因）。
     *    早期版本按 numberOfChannels 做了平均，结果所有立体声素材系统性偏低 3dB，
     *    与 B 站官方元数据对不上。单元测试专门钉死这条。
     */
    const z = new Float64Array(frames + 1);
    let truePeakLinear = 0;

    /**
     * 分块粒度：每块相当于 CONFIG.lumChunkFrames 帧（默认 5s 音频）。
     * 但**不是每块都让线程** —— 只有距上次让步超过 8ms 才让，
     * 否则小块素材上会被 setTimeout 的调度开销反噬（本来 60ms 算完，
     * 硬生生被几百次让步拖成 300ms）。
     */
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

    /* ------------------------------------------------ 分块与门限 */

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

/* ============================== gain-planner.js ============================== */
/* ================================================================
 * gain-planner.js — 响度 → 增益（纯计算）
 *
 *   gain_dB = 目标响度 − 实测响度
 *
 * 然后受三重约束：
 *   ① 削波预算（只限制**提升**，不强制衰减）
 *   ② 档案上限 profile.maxBoostDb
 *   ③ 档案下限 profile.minGainDb
 *
 * ⚠️ 关于①，与方案文档 §4.4 的原始写法有一处**有意修正**：
 *    原文写的是 maxBoost_dB = 峰值余量 − 实测真峰值，然后
 *    final_gain = clamp(gain, -INF, maxBoost_dB)。
 *    那样写会把「上限」当成「最大增益」，于是当素材本身已经过峰
 *    （真峰值 > 0 dBTP，在响度压缩过的素材里很常见）时，
 *    maxBoost 变成负数，一个本该 +4.7dB 的素材会被压成 −1.8dB ——
 *    结果比原声还小 1.8dB，离目标越来越远。
 *
 *    实测反例：BV1muab6rEbA 实测 −18.69 LUFS、真峰值 +0.79 dBTP。
 *    按原文：gain = −1.79dB → 输出 −20.5 LUFS（目标 −14，差 6.5 LU）。
 *    按修正：gain = 0dB      → 输出 −18.69 LUFS（不引入新削波，也不倒扣音量）。
 *
 *    所以削波预算只做一件事：**算出来要提多少，最多提到不越天花板为止**。
 *    衰减永远放行 —— 衰减只会让峰值更低，不可能造成削波。
 * ================================================================ */
const GainPlanner = (() => {

  function currentProfile() {
    return CONFIG.profiles[CONFIG.profile] || CONFIG.profiles.standard;
  }

  /**
   * @param {{measuredLufs: number|null, truePeakDb: number|null}} input
   * @returns {{gainDb, targetLufs, limited, limitReason, ceilingHeadroom, rawGainDb}}
   */
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
        /* 〔S3.2.5〕这句话会**直接显示在面板上**，所以不写「削波预算 / dBTP / 余量」这些
         * 只有音频人才懂的量 —— 统一成「提多少 + 为什么」两段式：
         *   · 有余量  → `+1.7 dB（防止爆音）`
         *   · 已过峰  → `+0 dB（素材已过峰）`   ← 提到 0，即「一点都不提」
         * 真峰值没丢：console.table 有独立的「真峰值dBTP」列，日志里紧跟「实测 → 目标」。
         * 〔格式〕数值与单位之间**一律一个空格**（`+1.7 dB` / `+0 dB` / `+6 dB` / `-60 dB`），
         * 与面板其它 dB 读数（panel.js 的 fmt）保持一致。 */
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

/* ============================== state-reader.js ============================== */
/* ================================================================
 * state-reader.js — 取 bvid / cid / p（普通投稿分支）
 *
 * ⚠️ 关键实测（2026-10-02，见 probe/raw/bls3_fail.json）：
 *   __INITIAL_STATE__ 是 **首屏那一份**。B 站 SPA 导航
 *   （点右侧推荐视频 / 切分P）之后它**不会重新注入** ——
 *   实测 URL 已经是 BV11b411L7mg，而 __INITIAL_STATE__.bvid 仍是
 *   第一个视频的 BV1GJ411x7h7，cid 仍是上一个视频的 137649199。
 *
 *   后果非常硬：拿「旧 cid」配「新 bvid」调 playurl 会直接
 *       code=-404 message=啥都木有 hasDash=false
 *   也就是用户看到的「获取失败」。
 *
 *   所以：**从 __INITIAL_STATE__ 取任何东西之前，必须先用 bvid 校验新鲜度**。
 *   过期就一律不采信，交给 PlayInfo.resolveVideo() 走 view 接口补。
 *
 * 普通投稿的 cid 有两个来源：
 *   - 单 P：__INITIAL_STATE__.cid（顶层直取）
 *   - 多 P：__INITIAL_STATE__.videoData.pages[p-1].cid
 * 多 P 时以 pages[p-1] 为准 —— 它跟着 URL 的 ?p= 走，顶层 cid 不保证同步。
 * ================================================================ */
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

  /* -------------------------------------------------- 页型（S3.1） */

  /**
   * 页型判定。
   *   video —— 普通投稿 /video/* 与合集 /list/*（同一套取数链路）
   *   pgc   —— 番剧 / 影视 / 电视剧 / 纪录片 / 国创 / 综艺，全部在 /bangumi/play/* 下
   *            （实测：靠 season_type 区分，1番剧 2电影 3纪录片 4国创 5电视剧 7综艺）
   *   other —— 其余（含课程 cheese/play/*，已明确不做）
   */
  function kind() {
    const p = location.pathname;
    if (/^\/video\//.test(p)) return 'video';
    if (/^\/list\//.test(p)) return 'video';
    if (/^\/bangumi\/play\//.test(p)) return 'pgc';
    return 'other';
  }

  /**
   * 番剧集号 ep_id。三个来源：
   *   /bangumi/play/ep308426              → 308426（最常见）
   *   /bangumi/play/ss12345?ep_id=308426  → query 里的
   *   /bangumi/play/ss12345               → 只有 season，没有集 → 返回 null（尚未定集，跳过）
   */
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

  /**
   * 番剧页的新鲜度判定。
   *
   * ⚠️ 番剧页**没有 __INITIAL_STATE__**（实测 0 次），所以没法像普通投稿那样
   *    拿 bvid 与 URL 交叉校验。改用「**对象身份 + ep_id 配对**」：
   *      - B 站重新注入了一份 __playinfo__（换了对象）→ 认新鲜，把当前 URL 的
   *        ep_id 记在它名下；
   *      - 还是同一个对象、但 URL 的 ep_id 已经变了 → 这就是**切集后没刷新**的
   *        旧数据（S2.1 已证实 SPA 导航不重注入），判过期。
   *
   *    与 playinfo 里普通投稿的 acceptedRef 同思路，只是配对键从 bvid 换成 ep_id。
   */
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

  /**
   * 番剧页的当前分析目标。
   *
   * key 用 `p:{ep_id}`，**刻意不带 cid**：ep_id 与 cid 是 1:1 的，
   * 而回落接口（pgc playurl）**只需要 ep_id**（实测不需要 cid）。
   * 不带 cid 反而更稳 —— 不会因为「首屏有 cid、切集后拿不到 cid」
   * 而分裂出两个指向同一集的缓存条目。
   */
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

  /**
   * __INITIAL_STATE__ 里声明的 bvid。
   * 只有 bvid 能用来做交叉校验（aid 无法与 URL 直接比对）。
   * 取不到就返回 null —— 调用方必须把「取不到」当成「不可信」，
   * 宁可多一次接口请求，也不要把别的视频的 cid 安上来。
   */
  function stateBvid(st) {
    if (!st) return null;
    if (typeof st.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(st.bvid)) return st.bvid;
    const vd = st.videoData;
    if (vd && typeof vd.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(vd.bvid)) return vd.bvid;
    return null;
  }

  /**
   * 页面注入的 SSR 状态是不是「当前 URL 这个视频」的。
   *
   * SPA 导航后为 false —— 这一条是整个 S2.1 修复的地基：
   * __INITIAL_STATE__ 与 __playinfo__ 同源（同一次 SSR 注入），
   * 它过期就意味着那份 __playinfo__ 也过期。
   */
  function pageFresh() {
    const urlBv = bvid();
    if (!urlBv) return false;
    return stateBvid(initialState()) === urlBv;
  }

  /**
   * @returns {null | {bvid, p, cid, aid, pageCount, title, duration, stateFresh}}
   *          stateFresh=false 时 cid 必为 null —— 上层应走接口补全
   */
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
    /* S3.1 番剧 */
    kind, epId, seasonId, pgcKey, pgcFresh, pgcArc, target,
    /** 调试用：重置番剧新鲜度记忆 */
    forgetPgc() { pgcRef = null; pgcRefEp = null; },
  };
})();

/* ============================== playinfo.js ============================== */
/* ================================================================
 * playinfo.js — 取音频地址 + 官方响度元数据
 *
 * 普通投稿（/video/* · /list/*）：
 *   FastPath  : __playinfo__.data.volume 有 measured_i
 *               → 零下载零解码，直接用 B 站自己测的响度
 *   SamplePath: 没元数据 → 拿 dash.audio 的地址交给 sampler 抽样
 *
 * 番剧 / 影视 / 电视剧（/bangumi/play/*，S3.1 新增）：
 *   FastPath  : __playinfo__.result.video_info.volume（snake_case）
 *   SamplePath: __playinfo__.result.video_info.dash（**不是 result.dash**）
 *   回落接口  : pgc/player/web/playurl?ep_id= → result.dash（扁平，且**无元数据**）
 *   ⚠️ 两条路的 dash 位置不同、audio 字段命名也不同（SSR 全 snake_case、
 *      接口 camel+snake 并存）—— normalizePgc 里多路径兜住。
 *
 * ⚠️ 关键实测事实（§2.7.2）：`x/player/playurl` 接口返回的 data 里
 *    **不含** volume 字段，它是播放器/SSR 额外注入到 __playinfo__ 的。
 *    所以元数据只能从页面读，接口读不到 —— 这也决定了降级顺序。
 *    （番剧同理：元数据只在 SSR，切集后拿不到 → 只能抽样）
 *
 * ⚠️ 【S2.1 核心修复】__playinfo__ 与 __INITIAL_STATE__ 同源，
 *    都是**首屏那一份**，SPA 导航后不会重新注入。
 *    实测：点推荐视频跳到 BV11b411L7mg 后，
 *      __INITIAL_STATE__.bvid 仍是 BV1GJ411x7h7
 *      __playinfo__.data.dash.duration 仍是上一个视频的 213s
 *    若直接采信，就会「把上一个视频的响度算到新视频头上」；
 *    更糟的是拿旧 cid 去调接口 → -404（详见 state-reader 顶部注释）。
 *    因此新增 trustPlayinfo()：不新鲜就一律不采信，回落接口。
 *    番剧没有 __INITIAL_STATE__ 可校验 → 用「对象身份 + ep_id 配对」判新鲜度。
 * ================================================================ */
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

  /* -------------------------------------------------- 番剧 / 影视（S3.1） */

  /**
   * 试看判定（任一命中即视为「未完整解锁」）：
   *   is_preview===1 / error_code===-10403 / 有回退流无 dash /
   *   回退流长度 < timelength / play_check.play_detail !== "PLAY_WHOLE"
   *
   * ⚠️ 回退流的字段名两条路不同：SSR 叫 `durl`、接口叫 `durls`（实测）。
   */
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

  /**
   * 番剧/影视：把 `result` 归一化成与普通投稿一致的结构。
   *
   * 【实测·关键】两条路的 dash 位置**不同**，必须多路径兜：
   *   SSR  `__playinfo__.result.video_info.dash`   （且 audio 全 snake_case）
   *   接口 `pgc/player/web/playurl` → `result.dash`（扁平）
   * 少兜一条就会「番剧页首屏能认、切集后认不出」这种半死状态。
   *
   * 响度元数据只在 SSR 有没有（接口永远没有）——
   * 所以番剧的 FastPath 只在**首屏且 SSR 新鲜**时成立，切集后只能抽样。
   */
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

  /**
   * 把 playurl 的 data / result 归一化成统一结构。
   * @param {object} data playurl 的 data（普通投稿）
   * @param {string} origin 'page' | 'api'
   */
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

  /* ---------------------------------------------------- 取数：页面 */

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

  /* -------------------------------------------- 可信度：这份 playinfo 算不算数 */

  /** 上一次被采信的 playinfo 对象引用 + 它对应的 key */
  let acceptedRef = null;
  let acceptedKey = null;

  function fmtSec(v) { return Number.isFinite(v) ? v.toFixed(1) : '?'; }

  /**
   * 判断页面上的 __playinfo__ 是不是「当前这个视频」的数据。
   *
   * 三重判据，从严到宽：
   *   ① 这份对象就是当前 key 已经采信过的 → 直接复用（同页多次触发的常见情形）
   *   ② __INITIAL_STATE__ 新鲜（bvid 与 URL 一致）→ 同源注入的 playinfo 必然也新鲜
   *   ③ 页面状态过期，但 playinfo 是**导航后新换的对象**且时长与播放器吻合
   *      → 说明 B 站这次确实刷新过它，仍可吃 FastPath 的红利
   *
   * 其余情况一律判不可信 —— 宁可多走一次抽样（约 0.6MB），
   * 也不能把上一个视频的响度安到新视频上。
   */
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
    //    改用「对象身份 + ep_id 配对」的 pgcFresh()（见 state-reader）
    const fresh = isPgc ? StateReader.pgcFresh() : StateReader.pageFresh();
    if (fresh) return { ok: true, why: isPgc ? 'ssr-fresh(pgc)' : 'ssr-fresh' };

    /*
     * 「换过对象」必须有**基准**才算数。
     * acceptedRef 为空 = 本页还没采信过任何东西（例如脚本刚起来就立刻切视频），
     * 此时无法证明这份 playinfo 是新换的，一律按不可信处理。
     * 少了这个判断，首屏竞态下就会把上一个视频的元数据当新视频用。
     */
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

  /* ------------------------------------------------ 取数：接口兜底 */

  /**
   * 页面状态过期时用来补 cid 的接口。
   * 按 bvid 缓存整份 view 结果 → 同一视频切分P 零请求。
   */
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

  /**
   * 补齐当前视频的 cid / 时长 / 分P 信息。
   *
   * ⚠️ 必须用 pages[p-1].duration，**不能用 data.duration** ——
   *    多分P 视频的 data.duration 是「所有 P 的总时长」。
   *    实测 BV11b411L7mg：data.duration=1266（总和），
   *    而 pages[0].duration=182（第 1P 真实时长）。
   *    用错会把「等播放器切流」的判据整个搞反。
   */
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

  /* ------------------------------------------- 番剧接口（S3.1） */

  const pgcCache = new Map();

  /** 带错误码标记的错误：skip=跳过分析、fatal=立即停手不重试 */
  function pgcErr(code, msg, info) {
    const e = new Error(`pgc playurl code=${code} ${msg || ''}（ep_id=${info && info.epId}）`);
    e.code = code;
    if (CONFIG.pgcAbortCodes && CONFIG.pgcAbortCodes.indexOf(code) >= 0) e.fatal = true;
    if (CONFIG.pgcSkipCodes && CONFIG.pgcSkipCodes.indexOf(code) >= 0) e.skip = true;
    return e;
  }

  /** 可能只是「暂时性」的错误码，退避重试一次 */
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

  /**
   * 主入口：页面优先（可信才行），不可信就回落接口。
   * @returns {Promise<{info, staleIgnored, why}>}
   */
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

  /** 调试/诊断用：重置「已采信」记忆 + 番剧新鲜度配对 + 接口短缓存 */
  function forget() {
    acceptedRef = null;
    acceptedKey = null;
    pgcCache.clear();
    try { StateReader.forgetPgc(); } catch (e) { /* 忽略 */ }
  }

  return {
    get, fromPage, fromApi, normalize, normalizePgc, chooseAudio,
    resolveCid, resolveVideo, trustPlayinfo, forget,
    /** 供验证脚本单独调番剧接口 */
    fromPgcApi,
  };
})();

/* ============================== sampler.js ============================== */
/* ================================================================
 * sampler.js — 全片抽样取音频（只取索引 + 均匀抽样，不全量下载）
 *
 * 流程（§4.2）：
 *   1. Range 取 Initialization（ftyp+moov）与 indexRange（sidx）—— 并行发
 *   2. 解析 sidx → 拿到全片 N 段的位置，均匀选 12 段（首段必取）
 *   3. 分批拉取（S2.2）：
 *        第一批 coarse（6 段，等距含首尾）→ 交给上层立刻测量并落位
 *        第二批 rest（其余 6 段）→ 后台补上后精修
 *   4. 每段各自与 init 组成一个独立可解码的 fMP4 片段，交给上层逐段解码
 *
 * ⚠️ 为什么是「逐段独立解码」而不是「拼成一个大 Blob 一次解码」（实测踩坑）：
 *    fMP4 分段的 trun 里可以是 base_data_offset（相对**原文件的绝对偏移**）。
 *    把这些 moof 拼到新 Blob 里，偏移全部失效 —— 实测结果是解码器读到第一段
 *    结束就停，57.3s 的抽样只解出 4.9s，响度直接偏了 2.9 LU。
 *    这正是我们要修掉的那类 bug（只量到开头几秒），所以改成逐段解码：
 *    init + 任意单片段本来就是合法的可独立解码单元（moov 带 mvex/trex）。
 *
 * ⚠️ 为什么要分批（S2.2，抽样时长不稳定，有时 6s 以上）：
 *    12 段全到齐才开工 = 木桶效应，「最慢那一段」决定总时长。而慢段往往来自
 *    CDN 冷连接 / 与播放器抢带宽 / 偶发重传 —— 恰恰是最不可控的部分。
 *    分批后，第一批只要 6 段就能先给出可用结论，长尾不再拖住整条链路。
 *
 * 代价实测：110 分钟视频音频全量 73.8MB，抽 12 段 ≈ 0.63MB = 0.9%。
 * ================================================================ */
const Sampler = (() => {

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------------------------------------------------- 网络层 */

  /**
   * 带 Range 的取字节。返回 ArrayBuffer。
   * 优先原生 fetch（S0 实测 CDN 已回 Access-Control-Allow-Origin）；
   * 若被 CORS / Referer 挡住，退 GM_xmlhttpRequest（Tampermonkey 环境）。
   *
   * @param {number} [timeoutMs] 覆盖默认超时（单段抽样用更短的 segTimeoutMs）
   * @param {number} [retries] 网络层内部重试次数（默认 0，重试策略交给调用方）
   */
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

  /* -------------------------------------------------- 并发调度 */

  /** 带全局启动间隔的并发池（防 -799 限流） */
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

  /* -------------------------------------------------- 准备：取索引 */

  /**
   * 取「初始化段 + 索引」并算出全片抽样计划。
   *
   * initRange 与 indexRange 是文件里两个互不重叠的小区间，所以并行发 ——
   * 省掉一个完整 RTT（冷连接下这一下就是 100–400ms）。
   *
   * @param {{url, initRange, indexRange, mimeType}} audio
   * @param {(stage: string, extra?: object) => void} [onStage]
   * @param {number} [anchorOverride] 强制索引基准点（自校验失败时回退用）
   */
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

  /* ---------------------------------------------- 抽样：分批下载 */

  /**
   * 拉取一组分段。
   *
   * 这里有两个反木桶效应（S2.2，针对「抽样时长不稳定，有时 6s 以上」）：
   *
   *   ① **单段失败不拖垮整批**：超时/报错先重试 segRetry 次，仍失败就丢掉
   *      这一段并记 warn，够数上层就继续算。原来任何一段抛错都会让整次分析
   *      失败重来，表现就是「有时候卡很久，有时候干脆失败」。
   *
   *   ② **够用即开工**（`wantAtLeast`）：不等全批到齐，先凑够这么多段就
   *      把结果交出去让它先算 —— 剩下的段继续在后台跑。这是彻底把「最慢那一段」
   *      从关键路径上摘掉：一批 6 段里只要有 1 段卡 5s，旧写法就得干等 5s。
   *
   * @returns {{early: Promise<Batch>, all: Promise<Batch>}}
   *   early — 达到 wantAtLeast 段时最先兑现（达不到则在全部结束后兑现，用 all 的结果）
   *   all   — 整批跑完（含失败/跳过）后兑现
   *   两者结构相同；early 只可能「段更少」，不会更差。
   */
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

/* ============================== audio-engine.js ============================== */
/* ================================================================
 * audio-engine.js — Web Audio 图
 *
 * 链路：
 *     <video> → MediaElementSource → GainNode(gain) → destination
 *
 * S2 起 gain 不再是常数：由 analyzer 算好后经 setGainDb() 平滑写入。
 * 分析未完成期间保持 1.0（原声），算好后 120ms 斜坡落位 —— 这就是
 * 「先原声 → 平滑修正」的过渡方式。
 *
 * S2 不加 WaveShaper 软限幅：增益已由 GainPlanner 的峰值预算从源头
 * 保证不削波，事后压限反而会引入非线性失真。
 *
 * ┌─ 三条铁律（早期方案踩坑后确立，绝不让步）─────────────────────┐
 * │ 1. 永不 disconnect 任何节点 —— 断掉 MediaElementSource 会让该  │
 * │    <video> 永久无声，且重连抛 already-connected。              │
 * │ 2. 永不 pause / preventDefault / alert —— 脚本绝不干预播放控制。│
 * │ 3. 只有 AudioContext 确实处于 running 时才接管。否则 media 输出 │
 * │    会被路由进一个挂起的 context，结果是「视频彻底没声」。      │
 * └───────────────────────────────────────────────────────────────┘
 * ================================================================ */
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

  /**
   * 归一流程「想要」施加的增益（dB）。
   *
   * 与 appliedGainDb 分开是为了旁路（S2.2）：旁路只把**实际**增益按到 0，
   * 心里记着的目标值原样留着，所以关掉旁路是瞬间恢复 —— 不用重新抽样。
   */
  let desiredGainDb = 0;

  /** 旁路开关：true = 听原声（不施加增益），分析照跑、结果照存 */
  let bypass = false;

  const stats = { attached: 0, failed: 0, deferred: 0, resumes: 0, gainSets: 0, bypassToggles: 0 };

  /* ---------------------------------------------------------- 上下文 */

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

  /* ---------------------------------------------------------- 接管 */

  function isVideoEl(el) {
    // 用 tagName 而非 instanceof：userscript 沙箱下 instanceof 会因 realm 不同而失效
    return !!el && el.tagName === 'VIDEO';
  }

  function isAttached(el) { return attached.has(el); }

  /**
   * 尝试接管一个 <video>。返回是否已接管。
   * 绝不抛错、绝不断播 —— 任何失败都只是「保持原声」。
   */
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

  /* ------------------------------------------------------ 增益 */

  /**
   * 施加增益（dB）。用 setTargetAtTime 做指数斜坡，避免跳变「咔」声。
   *
   * ⚠️ 只在 ctx running 时用调度 API；否则直接赋值（调度在挂起上下文里
   *    不会推进，反倒会卡住值）。
   *
   * 永不抛错、永不断链 —— 任何失败都只是「音量维持原样」。
   */
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

  /**
   * 旁路开关。开 → 立刻回到原声（0dB）；关 → 立刻恢复到归一后的增益。
   *
   * ⚠️ 只是「按 0dB」，**该不该有增益、增益多少全都记得**：
   *    · 不重新抽样、不重新解码、不动 desiredGainDb
   *    · 所以来回切是即时的，A/B 对比听不出分析开小差
   *    · 与「停用整条链路」是两回事 —— 停用走 Analyzer.setEnabled(false)
   *
   * 两种切换都走同一条 120ms 斜坡，不会「咔」一声。
   */
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

  /* ------------------------------------------------- 手势与待接管队列 */

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

  /* ---------------------------------------------------------- 验证 */

  /**
   * 信号探针：在 masterGain 上挂一个临时 Analyser 抽头，
   * 采样一小段时间测 RMS / 峰值。
   *
   * 这是 S1「真的有声」的硬证据 —— 只看 ctx.state 不足以证明音频在流动。
   * 抽头是并联的，不影响主链路；测完立即断开。
   */
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

  /* ---------------------------------------------------------- 对外 */

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

/* ============================== hud.js ============================== */
/* ================================================================
 * hud.js — 轻量调试浮层（S2 用）
 *
 * 目的：让「这一步到底做了什么」肉眼可见 —— 来源、实测响度、目标、
 * 最终增益、当前阶段与耗时。不是 S3 那套 Evolved 风格面板，
 * 只是个角落里的只读小卡片，pointer-events:none 不影响任何操作。
 * ================================================================ */
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

  /* 〔坑·必读〕all:initial 是 shorthand，会重置「所有」CSS 属性。
   * 它必须排在 cssText 的【最前面】—— 同一块里的声明按书写顺序生效，
   * 写到最后会把 position:fixed 一并重置回 static，整块浮层就掉进
   * 文档流最底部、被页面压住，肉眼完全看不见（S2 首次交付即踩此坑）。
   * 另外 display 也要显式补回 block：initial 会把它变成 inline。 */
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

  /**
   * 把 host 塞进 DOM。
   * 不能用「body 存在就 append，否则等 DOMContentLoaded」这种二选一写法：
   * 若脚本注入时机正好卡在 body 尚未创建、而 DOMContentLoaded 已触发之后，
   * 监听器永远等不到，浮层就无声无息地丢了。改成「立即试 + 定时补试」，
   * 两条路并行，最迟 500ms 一定挂上。
   */
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

  /**
   * body 出现后把 host 迁移进去。
   *
   * 这里【故意不用】MutationObserver.disconnect() —— 停观察改用
   * AbortController + observe({ signal })。两个原因：
   *   ① 构建守卫会拦「无参 disconnect()」（它要防的是断掉音频图那条链，
   *      而 MutationObserver 的同名方法完全是另一回事，无法用正则区分）；
   *   ② signal 本来就是更省心的写法，不用自己管句柄。
   */
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

    /**
     * 旁路行：只在真的旁路时出现，且要说清两件事 ——
     * 「现在听的是原声」以及「归一值是多少」，不然用户会以为功能坏了。
     */
    if (s.bypass) {
      lines.push(`<span class="warn">旁路 听原声（归一 ${fmtDb(s.gainDb)}dB 未施加）</span>`);
    }

    lines.push(`<span class="k">状态 </span>${status}${ms ? ` <span class="k">·</span> ${ms}` : ''}`);

    /**
     * 耗时归属行。抽样耗时波动较大，但「时长」是一个笼统的数，
     * 拆开（索引 / 下载 / 解码 / 响度）才能一眼看出慢在哪一环。
     */
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

  /* ---------------------------------------------------------- toast */

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

  /**
   * 一次性提示（1.4s 自动消失）。
   * 用途：旁路开关按下时给个可见反馈 —— HUD 可能被用户关掉了，
   * 那样切旁路就成了「按了没反应」，A/B 对比根本做不下去。
   */
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

  /**
   * HUD 自检：一次性回答「它到底在不在、为什么看不见」。
   * 之前排查「没看到 HUD」只能靠猜，这个接口把可观测事实全摊开。
   */
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

/* ============================== panel.js ============================== */
/* ================================================================
 * panel.js — 设置面板（Evolved 风格，S3.2；S3.2.1 对齐尺寸、S3.2.3/3.4 调布局与交互）
 *
 * 交互：
 *   · 面板收在**左侧边**，默认只露出半个圆钮；
 *   · **鼠标移到哪个按钮，只有那个按钮滑出来**（S3.2.3 起分离，不再整条一起弹）；
 *   · 点击按钮展开对应面板，再点收起；**点击面板以外的任何地方也收回**（S3.2.3）；
 *   · **网页全屏 / 真全屏时完全隐藏**。
 *
 * S3.2.4（三条）：
 *   ① **浮窗不再压住按钮**：`.side` 恒在 `-var(--shift)`，浮窗 / 面板的水平位置改按
 *      **滑出后**的按钮位置算 —— `left: calc(var(--rail) + var(--shift))`。
 *      旧写法 `left: var(--rail)` 在「收起态 hover」（按钮已滑到 +28）时会让浮窗
 *      落在按钮身上（按钮 8..50，浮窗从 30 起 → 压住右半）。
 *   ② **面板对齐「打开它的那个按钮」**：宿主顶边现在是按钮列的**中点**，
 *      两个面板共用 `top:0` 会让状态面板看起来落在**设置按钮**那一行。
 *      改为打开时按按钮顶边写 `pnl.style.top`（与 `showTip` 同理，两个 rect 相减）。
 *   ③ **打开面板只让那一个按钮保持滑出**：删掉 `.side.bl-pin { translateX(0) }`
 *      （它会把**两个**按钮一起弹出来），改由 `.rdw.bl-open` 精确标记。
 *      `.bl-pin` 保留为「有面板打开」的状态标记（供点击外部收回 / 自检用），
 *      但**不再改变 transform**。
 *
 * 两个面板（S3.2.3 起宽度 176px，文案一律精简）：
 *   ① 当前状态 —— 悬停按钮即显示「增益 / 实测响度」；
 *      展开后上部是「功能开关态 / 采样完成状态 / 增益来源」，
 *      下部是「旁路（听原声）」与「重新测量本视频」两个按钮 +
 *      各自一句说明（**重新测量**是 S3.3.0 加的，见下）。
 *   ② 设置 —— 功能开关 / 预设 / 目标响度滑块 / 增益上下限滑块 /
 *      缓存说明 / 清除缓存。
 *
 * S3.3.0（一条）：
 *   · **「重新测量本视频」从调试接口升为正式按钮**。原来重测只有两条路：
 *     控制台敲 `__biliLoudness.reanalyze()`，或点「清除缓存」把整库（800 条）清空。
 *     现在只丢**本视频那一条**缓存再重跑 —— 网络抖动导致某次抽样偏少时，
 *     用户自己就能修，不必动整库。
 *     逻辑复用 `Analyzer.reanalyze()`（早已存在且被测试覆盖），此处只是接线。
 *
 * 尺寸与位置（S3.2.1 对齐 Evolved 的 `.be-settings > .sidebar`；S3.2.3 调纵向锚点）：
 *   · 按钮直径 **42px** = 26px 内容 + 8px padding × 2（Evolved 用
 *     `box-sizing:content-box`；少这层 padding 就只剩 26px ——
 *     真机上看着「只有 Evolved 一半大」正是这个原因）；
 *   · 图标 **26px**（Evolved `.be-icon` 的 font-size），用 MDI 图标集；
 *   · 按钮间距 26px、热区 `::after` 外扩 20%、无描边；
 *   · **纵向：按钮列的「中点」固定在视口 1/3 高度**（S3.2.3）。
 *     做法：宿主顶边钉 `top:33.333vh`，`.btns` 再上移自身半高（`--btns-half`）——
 *     于是「列中点 = 宿主顶边 = 1/3」，且展开面板时按钮**不移位**
 *     （`.tip` / `.pnl` 都是绝对定位，不参与 `.side` 高度）。
 *     演进：S3.2 垂直居中（`top:50%`，与 Evolved 侧边栏**完全重合**）→
 *     S3.2.1 贴顶（`top:0`）→ S3.2.3 中点 1/3。
 *     仍**不跟随播放器** —— 那版要监听 scroll/resize + 轮询，故未采用。
 *
 * ⚠️ 四个硬约束（都踩过坑）：
 *   1. 宿主 cssText 里 `all:initial` 必须排**第一位**，且显式补 `display:block`
 *      —— 它是 shorthand，写后面会把 position:fixed 一并重置，浮层掉进文档流。
 *   2. **不用 alert**（构建守卫禁止，且会冻页面）；清除缓存的反馈走 toast。
 *   3. 全屏判定**无法在 headless 里复现**（实测：按 `w` 键与点按钮都不触发，
 *      疑因无真实窗口导致 Fullscreen API 静默失败），所以做成**多信号 + 几何兜底**，
 *      并提供 `panelInfo()` / `fsInfo()` 供真机校准。
 *   4. **不要往 ShadowRoot 上写 style** —— ShadowRoot 是 DocumentFragment，
 *      没有 `style` 属性。`root.style.cssText = ...` 会抛
 *      `TypeError: Cannot set properties of undefined`，而它发生在 boot() 里，
 *      会把后面的 Lifecycle.start() / exposeDebugApi() 一起带走：
 *      「面板样式的小错，整个功能没了」。主题变量改由 shadow 内一个 <style> 承载。
 * ================================================================ */
const Panel = (() => {
  let host = null;
  let root = null;
  let varsStyle = null;         // 主题变量的载体（见坑 4：ShadowRoot 没有 .style）
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
  let docClick = null;          // 〔问题 5〕「点击面板外收回」的 document 监听器

  const S = {};                 // 状态面板里各字段的引用
  const C = {};                 // 设置面板里各控件的引用

  /* ============================================================
   * 全屏判定
   * ============================================================ */

  /**
   * 类名里是否带「全屏」语义（B 站网页全屏是加 class，但具体类名各版本不同）。
   *
   * **真机取证（2026-10-03）**：按 `w` 进网页全屏时，只有 **body** 会多出
   * `webscreen-fix` 与 `player-mode-web` 两个类，`html` 与 `.bpx-player-container` 的 class
   * **一个都不变**（实测）。命中靠的是 **`webscreen-fix`** —— 正则里的 `web-?screen`
   * 正好覆盖 `webscreen`（无需改动，已由单测钉死）。
   *
   * `player-mode-web` **刻意不收**：字面是「网页模式播放器」，可能在非全屏的某些播放器
   * 设置下也常驻，收进来有误报风险（宁可漏一路 —— 几何兜底会接住）。
   * 若将来 `webscreen-fix` 被改版拿掉，再回头看它。
   */
  function classHit(el) {
    if (!el) return false;
    const c = el.className;
    if (typeof c !== 'string' || !c) return false;
    return /(^|[\s-_])(web-?screen|web_?fullscreen|fullscreen|screen-?full|bpx-state-web-?full)/i.test(c);
  }

  /**
   * 网页全屏 / 真全屏判定。
   *
   * 三路信号，任一命中即算：
   *   ① Fullscreen API（真全屏，最可靠）
   *   ② body / html / 播放器容器上的「全屏」class（B 站网页全屏用这种）
   *   ③ **几何兜底**：播放器容器几乎铺满视口（网页全屏的必然结果）
   * 三路并行是为了「不依赖某一个版本的类名」—— 类名会随改版变，几何不会。
   *
   * **真机实测（2026-10-03）网页全屏时 ②③ 同时成立**：② 命中在 body（`webscreen-fix`）；
   * ③ 容器实测 `[0,0,1147,956]` 恰好等于视口（1147×956）→ `coversViewport=true`。
   * **双保险**：任一被改版打掉，另一路仍然接得住。
   */
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

  /* ============================================================
   * 设置读写
   * ============================================================ */

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

  /* ============================================================
   * 样式
   * ============================================================ */

  /* 〔坑〕all:initial 必须排第一（见文件头注释）
   *
   * 〔S3.2.1〕纵向**不再**居中，也不再跟随播放器 —— 固定贴视口左上。
   *
   * 位置演进：
   *   S3.2   top:50% + translateY(-50%)（视口垂直居中）→ 与 Evolved 侧边栏
   *          （`.be-settings > .sidebar`，同样是 fixed + top:50%）**完全重合**，
   *          两个圆钮叠在一起。
   *   S3.2.1 试过「按钮顶部对齐播放器容器上边缘」，但那要监听 scroll/resize
   *          加轮询重算，滚动时按钮还一直动。取舍：**不用跟随播放器，
   *          固定在侧边就行** —— 够用且简单，于是退回纯 CSS。
   *   S3.2.3 把**按钮列的中点**锚在视口 **1/3 高度**处：
   *          宿主顶边钉 `top:33.333vh`，`.btns` 再上移自身半高（`--btns-half`）。
   *          这样「列中点 = 宿主顶边 = 33.333vh」，且展开面板时按钮**不移位**
   *          （面板是绝对定位，不参与 .side 高度）。 */
  const HOST_CSS = [
    'all:initial',
    'display:block',
    'position:fixed !important',
    'left:0', 'top:33.333vh',      /* ← 按钮列中点锚在这条线上（.btns 再上移半高） */
    'z-index:2147483647 !important',
    /* 〔问题 5〕宿主**不接管点击**：只有真正可见的按钮 / 提示 / 面板才吃事件。
     * 否则展开时那块透明矩形会把页面点击一并吞掉。 */
    'pointer-events:none',
  ].join(';');

  const CSS = `
    .side {
      --rail: 58px;          /* 按钮列宽度 = 8(padding) + 42(圆钮) + 8(padding) */
      --shift: 28px;         /* 收起位移 = hover/打开时的滑出量（露半个 → 全露） */
      --btns-half: 63px;     /* 按钮列半高 = (8+42+26+42+8)/2 —— 上移用，改按钮尺寸时同步 */
      /* 〔S3.2.4·问题 3〕**恒在收起位**，不再整条弹出 —— 滑出改由每个按钮自己负责
       * （.rdw:hover / .rdw.bl-open）。这样「打开面板」只会让**那一个**按钮在外。 */
      transform: translateX(calc(-1 * var(--shift)));
      transition: transform .3s cubic-bezier(.22,.61,.36,1);
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      pointer-events: none;           /* 见 HOST_CSS：只有按钮 / 提示 / 面板接收点击 */
    }
    /* 〔S3.2.4·问题 3〕.bl-pin 曾把整条 .side 推到 translateX(0)，于是**两个按钮
     * 一起弹出来**。现在它只是「有面板打开」的**状态标记**（供点击外部收回 / 自检用），
     * **不再改变 transform**。 */
    .side.bl-hide { display: none !important; }

    /* 〔对齐 Evolved〕按钮间距 26px（.be-settings > .sidebar > *:not(:last-child){margin-bottom:26px}）
     * 〔问题 2〕上移半高 → **按钮列中点**正好落在宿主顶边（= 视口 1/3 高度）上。 */
    .btns {
      display: flex; flex-direction: column; gap: 26px;
      padding: 8px;
      position: relative;
      top: calc(-1 * var(--btns-half));
      pointer-events: auto;
    }

    /* 〔对齐 Evolved·S3.2.1 修〕按钮**实际直径 = 26 + 8×2 = 42px**。
     * Evolved 原样式是 width/height:26px + padding:8px + box-sizing:content-box，
     * 少了这层 padding 就只剩 26px —— 真机上看着「只有 Evolved 一半大」正是这个原因。 */
    .rd {
      width: 26px; height: 26px;
      padding: 8px;
      box-sizing: content-box;
      border-radius: 50%;
      border: 0;                   /* Evolved 无描边：靠半透明底 + hover 变白区分。
                                    * 留着 1px 描边会让外径变成 44px（content-box 下
                                    * 描边算在外），与 Evolved 的 42px 对不齐。 */
      background: var(--btn-bg);
      color: var(--fg);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      position: relative;
      line-height: 0;              /* 纯图标按钮：去掉文字基线偏移，保证严格居中 */
      transition: transform .2s, background .2s, color .2s;
      -webkit-appearance: none; appearance: none;
    }
    /* 图标 26px（Evolved 的 .be-icon font-size 同为 26px） */
    .rd svg { width: 26px; height: 26px; display: block; fill: currentColor; }

    /* 点击热区外扩（Evolved 同款）：按钮小、热区不小，避免要点好几次 */
    .rd::after {
      content: ''; position: absolute;
      top: -20%; left: -20%; width: 140%; height: 140%;
      background: transparent;
    }

    /* 〔问题 3〕只有鼠标所在的那**一个**按钮滑出来，不再整条一起弹 ——
     * hover 判定挂在外壳 .rdw 上（挂 .rd 上会**自激抖动**，见 ensure() 注释）。
     * 〔问题 4〕面板打开时按钮**不再额外位移**：.bl-open 与 hover 是**同一个**位移量，
     * 所以「已打开的按钮」本来就在外，不会再窜一下 —— 既不会挡住菜单，也不会看起来乱跳。
     * 〔S3.2.4·问题 3〕.rdw.bl-open 精确标记「面板开着的那一个」按钮，
     * 另一个**保持收起**（不再被 .side.bl-pin 一并弹出来）。 */
    .rdw { display: block; }
    .side .rdw:hover .rd,
    .side .rdw.bl-open .rd { transform: translateX(var(--shift)); }
    .rd:hover { background: #fff; color: #111; }
    .rdw:hover .rd:not(.bl-on) { background: #fff; color: #111; }  /* :not(.bl-on) 保住主题色 */
    .rd.bl-on { background: var(--theme); color: #fff; }
    .rd.bl-on:hover { color: #fff; }

    /* 〔问题 6〕浮窗脱离文档流，用 translateY(-50%) 让**垂直中线**对齐被 hover 的那个按钮
     * （top 由 JS 按按钮位置写入 —— 两个按钮共用一个浮窗，不这么做就会飘在中间）。
     * 〔S3.2.4·问题 1〕水平位置必须按**滑出后**的按钮位置算：.side 恒在 -var(--shift)，
     * 所以 left = rail + shift → 视口 x = 58；而按钮滑出后是 8..50 —— 留 8px 间距，**不再压在按钮上**。
     * （旧写法只用 var(--rail)，在「收起态 hover」时浮窗从视口 30 起，正好压住按钮右半。） */
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
      pointer-events: none;         /* 提示不吃事件，鼠标滑过不会闪 */
    }
    .tip.bl-show { display: block; }

    /* 〔问题 7〕面板宽度**减半**（原 min 320 / max 360 → 固定 176）——
     * 只放常用项，窄一点不挡视频；配套把面板内文案整体精简（见各 build* 函数）。
     * ⚠️ 必须 border-box：宿主 all:initial 把 box-sizing 重置回 content-box，
     * 不改的话 width:176 会再叠上 padding(24) + border(2)，实渲 **202px**（实测踩到）。
     * 〔S3.2.4·问题 1〕水平位置同 .tip：按**滑出后**的按钮位置算，不压住按钮。
     * 〔S3.2.4·问题 2〕top 由 JS 在打开时按**那个**按钮的顶边覆盖 ——
     * 宿主顶边是按钮列**中点**，两个面板共用 top:0 会让状态面板落在设置按钮那一行。 */
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

  /* ============================================================
   * DOM
   * ============================================================ */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  /* ---------------------------------------------------------- 图标
   * Material Design Icons（Evolved 用的也是 MDI 图标集），内联 SVG。
   *
   * 为什么走 createElementNS 而不是 innerHTML：SVG 是独立命名空间，
   * 在 HTML 文档里用 innerHTML 解析虽然通常也行，但页面一旦启用
   * Trusted Types / 严格 CSP 就会被拦。createElementNS 没有这个风险。
   * ---------------------------------------------------------- */
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

  /* 位置是**纯 CSS 固定**的（见 HOST_CSS），这里没有 positionSelf / playerBox，
   * 也不需要 scroll / resize 监听。
   *
   * 为什么删掉：S3.2.1 一度实现过「按钮顶部对齐播放器容器上边缘」，
   * 但那意味着滚动时按钮一直跟着动，还得养一个 scroll 监听 + 轮询重算。
   * 取舍：不跟随播放器、固定在侧边 —— 少一层复杂度，
   * 也少一类失效面（B 站改版换播放器容器名就跟着废）。 */

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

    /* 〔问题 7〕标签一律取最短 —— 面板只有 176px 宽，长标签会把值挤断行 */
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
    /* 〔S3.2.5〕说清这个按钮到底干什么（原来那句「只把增益归零，结果与目标都留着」
     * 讲的是「不影响数据」，反倒没讲「点了会怎样」）。 */
    const note = el('div', 'note', '暂停音频归一，播放原始音频。');
    bottom.appendChild(note);

    /* 〔S3.3.0〕重新测量本视频 —— 原来只有 Analyzer.reanalyze() 这个「调试用」接口，
     * 用户想重测只能开控制台敲 __biliLoudness.reanalyze()，或点「清除缓存」把整库清空。
     * 接成按钮后，代价降到「只丢本视频这一条」。 */
    bottom.appendChild(el('div', 'hr'));
    S.remeasure = el('button', 'btn', '重新测量本视频');
    S.remeasure.addEventListener('click', () => {
      /* 进度看「采样」那一行（render 会跟着 phase 走），这里只负责即时反馈 */
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
      o.textContent = `${p.label} ${p.targetLufs} LUFS`;   /* 〔问题 7〕去掉全角括号，窄面板更省字 */
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
    /* 〔S3.2.5〕原来写「存原始测量值；改目标立即重算。清理不影响设置」——讲的是缓存
     * 的**性质**，没讲清按钮**清掉的是什么**。改成直述对象（缓存的是测量结果，不是增益）。 */
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

    /* 〔坑 4·续〕主题变量**不能**写 root.style ——
     * root 是 ShadowRoot（DocumentFragment），它**没有** style 属性：
     *   TypeError: Cannot set properties of undefined (setting 'cssText')
     * 这个异常发生在 boot() 里，会把后面的 Lifecycle.start() / exposeDebugApi()
     * 一起带走 —— 面板的样式小错能整个功能拖没。所以：
     *   ① 变量改由 shadow 内的 <style> 承载（:host{...}，可继承进 shadow 树）；
     *   ② main.js 里 Panel.init() 另有 try/catch 兜底。 */
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

    /* 〔问题 3〕「哪个按钮被 hover，哪个才弹」需要一层**不动的外壳**来做 hover 判定。
     * 直接把 :hover 位移挂在 .rd 上会**自激抖动**：按钮一滑走，鼠标就落到按钮外面了
     * → :hover 失效 → 按钮滑回来 → 再次触发…… 外壳不动，判定就稳。
     * 〔S3.2.4·问题 3〕外壳另有 `.bl-open`（面板开着的那一个），两者用**同一段位移**。 */
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

  /**
   * 挂载：与 HUD 同一套策略 —— 立即试 + 每 250ms 补试（6s 放弃）。
   * 不能写成「body 有就挂、否则等 DOMContentLoaded」：卡在两者之间会永远丢掉。
   */
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

  /* ============================================================
   * 交互
   * ============================================================ */

  function showTip(text, btn) {
    if (!tip) return;
    tip.textContent = text;
    /* 〔问题 6〕把浮窗的**垂直中线**对准被 hover 的那个按钮 —— 两个按钮共用一个浮窗，
     * 不按按钮定位就会飘在两个按钮中间（看起来「没跟按钮对齐」）。
     *
     * ⚠️ 必须用两个 rect 相减，**不能**用 `btn.offsetTop`：按钮的 offsetParent 是
     * `.btns`（它是 position:relative），而浮窗的包含块是 `.side`（带 transform）——
     * 两者混用会差出 `.btns` 上移的那 63px（实测：浮窗整体偏下 63px）。 */
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
    /* `.bl-pin` 只作「有面板打开」的状态标记（S3.2.4 起不再改变 transform）。 */
    if (side) side.classList.toggle('bl-pin', !!open);

    /* 〔S3.2.4·问题 2〕把面板**顶边**对齐到「打开它的那个按钮」的顶边 ——
     * 宿主顶边现在是按钮列的**中点**，若两个面板都吃 CSS 的 `top:0`，
     * 状态面板就会看起来落在**设置按钮**那一行。
     * 与 showTip 同理：两个 rect 相减（面板的包含块是 `.side`，带 transform）；
     * `.side` 的 transform 只有 X 分量，不影响 top。 */
    if (open && btn && btn.getBoundingClientRect && side) {
      const pnl = open === 'status' ? statusPnl : settingsPnl;
      const bq = btn.getBoundingClientRect();
      const sq = side.getBoundingClientRect();
      const t = bq.top - sq.top;
      if (pnl && Number.isFinite(t)) pnl.style.top = t + 'px';
    }

    /* 〔S3.2.4·问题 3〕只有「面板开着的那一个」按钮保持滑出，另一个回到收起位。 */
    if (S.wrapStatus) S.wrapStatus.classList.toggle('bl-open', open === 'status');
    if (S.wrapSettings) S.wrapSettings.classList.toggle('bl-open', open === 'settings');

    if (open) { syncControls(); render(lastSnap); }
    hideTip();
  }

  function closeAll() { if (open) togglePanel(open); }

  /* 〔问题 5〕点击面板 / 按钮**以外**的区域 → 收回菜单与侧边条。
   * 必须用**冒泡**、不能用捕获：按钮与 .side 上的 click 都 stopPropagation 了，
   * 冒泡到不了 document 就说明「点在面板里」，正好不该关；
   * 若用捕获，点在按钮上会先触发这里 —— 菜单刚开就被自己关掉。 */
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

  /* ============================================================
   * 渲染
   * ============================================================ */

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
    /* 〔S3.2.5〕未受限时写「未限幅」（原来只写一个「否」，配合标签「限幅」读起来像半句话）。 */
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

  /* ============================================================
   * 全屏隐藏 / 主题
   * ============================================================ */

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

  /* ============================================================
   * 对外
   * ============================================================ */

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
      ensureDocClick();          // 〔问题 5〕点击面板外收回

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
      dropDocClick();                       // 〔问题 5〕面板都没了，别再监听全局点击
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

  /** 自检：一次回答「面板在不在、为什么看不见、按钮对齐了没有」 */
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
      /* 定位自检：按钮在哪、多大，以及图标有没有真的渲染出来 */
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

  /**
   * 全屏判据诊断 —— 专门给真机校准用。
   * 在真机上按 `w` 进网页全屏后调它，就能看到到底是哪个 class 变了、
   * 几何兜底有没有命中，从而把 classHit 的正则补准。
   */
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
    /** 供调试接口直接改「自定义档」（验证脚本用） */
    setCustom(patch) {
      Object.assign(CONFIG.profiles.custom, patch || {});
      CONFIG.profile = 'custom';
      persist(); syncControls(); reapply(); render(lastSnap);
    },
  };
})();

/* ============================== analyzer.js ============================== */
/* ================================================================
 * analyzer.js — 全链路编排
 *
 *   识别页型/key → 查缓存 → 取流 → (FastPath 元数据 | SamplePath 抽样)
 *     → 算响度 → 规划增益 → 平滑写入 GainNode → 写缓存 → 更新 HUD
 *
 * 三条原则：
 *   ① 全程异步、绝不阻塞播放。分析没算完就保持原声。
 *   ② job 令牌：SPA 切视频后来新任务，旧任务在每个 await 后自我了断，
 *      绝不把上一个视频的响度安到新视频头上。
 *   ③ 任何一步失败 → 增益归零（原声），只更新状态，不干预播放。
 *
 * S2.2 起 SamplePath 是**渐进式**的（见 CONFIG.progressive）：
 *   第一批（coarse，6 段）到齐就立刻测量并落位 → 用户 1–2s 内就能听到结果；
 *   剩下的段后台补齐后精修，只有当精修建议与初测差 ≥ refineMinDeltaDb
 *   才重新落位（小差异不动，避免听感上无意义的抖动）。
 *   这么改是为了治「抽样时长不稳定，有时要等 6s 以上」—— 木桶效应下，
 *   最慢那一段不该决定整条链路何时可用。
 * ================================================================ */
const Analyzer = (() => {
  let jobSeq = 0;
  let runningKey = null;
  let appliedKey = null;

  /**
   * 本页面会话内已算过的结果（key → 结论）。
   * 用途：SPA 来回切视频时，重挂增益不该把「来源」降级成含糊的「缓存」，
   * 应该原样复现上次的结论（是元数据就是元数据，是抽样就是抽样）。
   */
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

  /* -------------------------------------------------- 解码与测量 */

  function getOfflineCtor() {
    return window.OfflineAudioContext || window.webkitOfflineAudioContext || null;
  }

  /** 固定并发上限的 map（与 Sampler.pacedPool 不同，这里不需要启动间隔） */
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

  /**
   * 逐段解码，返回可用 AudioBuffer 列表（**不合并**）。
   *
   * ⚠️ 不能把多个 moof 拼成一个大 Blob 一次解码：fMP4 分段的 trun 用的是
   *    相对原文件的 data_offset，换到新 Blob 里全部失效，解码器读到第一段
   *    结束就停（实测 57.3s 只解出 4.9s，响度偏 2.9 LU）。
   *    init + 任意单片段本来就是合法的独立解码单元，逐段解最稳。
   *
   * 分批场景下这里只会被喂「这一批」的段，前一批的 buffer 由调用方留着，
   * 最后一起合并测量 —— 不重复解码、不重复下载。
   */
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

  /* ---------------------------------------------------- 单次分析 */

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

    /* 番剧切集：SSR 那份属于上一个 ep，接口给的才是当前 ep。
     * 但播放器换流常晚 1–3s（S2.1 实测），此时若立刻施加增益，
     * 就成了「把新集的响度压到还在播的旧集尾巴上」。用接口给出的时长
     * 做一次**有界**等待，等播放器真的换了流再算。 */
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

      /* --- 分批计划 ---
       * coarse 从 picks 里**等距**挑（含首尾），所以段数少了、覆盖仍是 0%–100%；
       * rest 是补集，两批合起来正好等于原计划的 12 段，不重复下载。 */
      const coarsePicks = CONFIG.progressive
        ? Sidx.pickCoarse(prep.picks, CONFIG.firstBatchSegments)
        : prep.picks.slice();
      const restPicks = prep.picks.filter(i => coarsePicks.indexOf(i) < 0);

      const refsBy = (picks, p) => picks.map(i => p.refs[i]);

      /**
       * 提前开工阈值。
       *
       * 分批模式下要「比最低可算多一段」—— 既保证够算，又不等最慢那一段。
       * 不分批时反过来：把阈值设成整批，恢复「全部到齐才开工」的语义，
       * 这样 A/B 对照才是在比同一件事（见 probe/s2-timing.mjs）。
       */
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

      /* --- 补齐 + 精修 ---
       * 要补的段来自两处，去重后一起解码、一起测量：
       *   ① 首批里「够用即开工」时还没回来的那些（h1.all 这时应该已经齐了）
       *   ② 第二批 restPicks
       * 全程只解码一次，不重复下也不重复算。 */
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

    /* ⚠️ 诊断表格必须排在 push 之后（实测拦截到 343ms 的延迟）：
     *    状态落位是用户能感知的那一步，任何日志/表格都不该挡在它前面。
     *    而且只在开调试时打，省得平时也背这个开销。 */
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

  /* ------------------------------------------------------ 入口 */

  function fmtSec(v) { return Number.isFinite(v) ? v.toFixed(1) : '?'; }

  /**
   * 「等播放器切流」状态。
   *
   * SPA 切视频时 URL 几乎立刻变，但播放器换流要晚 1–3 秒
   * （实测：点推荐视频后 45s 内 <video>.duration 还是上一个视频的 213s）。
   * 这中间若照旧施加增益，就成了「把新视频的响度压到还在播的旧视频上」。
   * 所以时长达不上就先挂起，等播放器真换了流再算 —— 期间保持原声，零干预。
   */
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

  /**
   * 番剧专用的「等播放器切集」——有界轮询，返回 false 表示本任务已被新任务替换。
   *
   * 与上面的 waitForStream 的区别：那个在**取流之前**挂起（用页面给出的
   * 期望时长），等不到就 return 让上层稍后重来；这个在**取流之后**，
   * 已经有了接口给的权威时长，就地短暂轮询即可，不必重跑整条链路。
   */
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
      /* 番剧：接口只需要 ep_id（实测不需要 cid），所以不必调 view 补全。
       * 只在「季落地页还没定集」这种拿不到 ep_id 的情况下跳过。 */
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

      /*
       * 页面状态过期（SPA 导航后 __INITIAL_STATE__ 仍是上一个视频的）
       * 或页面压根没给 cid → 用 view 接口补全。
       *
       * 【绝不能采信过期的 cid】实测：拿旧 cid 配新 bvid 调 playurl
       * 会得到 code=-404「啥都木有」，也就是用户看到的「获取失败」。
       */
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
          /* 权限不足 / 地区限制 / 版权限制（番剧常见）——
           * 这不是「故障」，是这类内容本来就不该分析：保持原声、标「跳过」，
           * 不打成 error，免得用户以为是脚本坏了。 */
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

  /** 手动重跑（清掉当前 key 的缓存）：调试用 */
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

  /**
   * 用缓存里的原始测量值重新规划增益并施加。
   * 换目标响度/换档案走这条路 —— 零网络零解码，立即生效。
   */
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

  /* ------------------------------------------------------ 旁路 */

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

/* ============================== lifecycle.js ============================== */
/* ================================================================
 * lifecycle.js — video 元素发现 / 接管 / SPA 状态机
 *
 * 状态机：
 *   DISCOVERY ──找到 <video>──▶ ATTACHED
 *
 *   ⚠️ 关键约定：元素被替换时我们【什么都不做】。
 *      旧元素交给 GC，绝不调用 source.disconnect()。
 * ================================================================ */
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

  /* ------------------------------------------------------ 媒体事件 */

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

  /* -------------------------------------------------------- 主循环 */

  async function tick(why) {
    obs.ticks++;
    const el = findVideo();
    if (!el) return;

    /*
     * 路由变化必须单独检测。
     * B 站 SPA 切视频 / 切分P 时 <video> 元素**会被复用**（S1 已实测），
     * 只靠「元素被替换」会整个漏掉 —— 实测点推荐视频后 45s 内元素都没换，
     * 于是脚本一个分析都不发起，HUD 永远停在上一个视频的数字上。
     * 所以这里比对完整 href（含 ?p=），变了就重新走一遍分析。
     */
    const href = location.href;
    const urlChanged = lastHref !== null && href !== lastHref;
    if (urlChanged) {
      Log.info(`路由变化 → 重新评估 · ${href.slice(0, 90)}`);
      lastHref = href;
    } else if (lastHref === null) {
      lastHref = href;
    }

    // 快速路径：元素没换、路由没变、且已接管 → 直接返回，避免每 300ms 做无谓工作
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

/* ============================== main.js ============================== */
/* ================================================================
 * main.js — 入口
 *
 * S2 范围：普通投稿页 /video/* 与 /list/*，全链路响度归一。
 * S3.1 起：番剧 / 影视 / 电视剧 / 纪录片 / 国创 / 综艺（/bangumi/play/*）
 *          走同一套编排，差异全在 StateReader / PlayInfo 的分支里。
 * ================================================================ */
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

  /* -------------------------------------------------------- 旁路 */

  function hotkeyText() {
    const hk = CONFIG.bypassHotkey || {};
    return [hk.ctrl ? 'Ctrl' : null, hk.alt ? 'Alt' : null, hk.shift ? 'Shift' : null, String(hk.key || 'b').toUpperCase()]
      .filter(Boolean).join('+');
  }

  function gainText() {
    const g = Analyzer.snapshot().gainDb;
    return Number.isFinite(g) ? `${g >= 0 ? '+' : ''}${g.toFixed(2)}dB` : '—';
  }

  /** 切旁路 + 给一个看得见的反馈（菜单和快捷键共用一个出口） */
  function toggleBypass() {
    const on = Analyzer.toggleBypass();
    const label = on
      ? `旁路：听原声（归一 ${gainText()} 暂不施加）`
      : `恢复归一：${gainText()}`;
    if (CONFIG.bypassToast) Hud.toast(label);
    Log.info(label);
    return on;
  }

  /**
   * 旁路快捷键（默认 Shift+B）。
   *
   * ⚠️ 不调用 preventDefault —— 构建守卫禁止，而且本来就没必要：
   *    我们只是「顺便看一眼」这个按键，页面自己的处理照旧。
   *    B 站自身的快捷键（d 弹幕 / f 全屏 / m 静音 / w 网页全屏）里没有 b，
   *    实测不冲突。
   */
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
      /* 〔S3.3.0〕菜单只留用户真的会用的三件事。原先还挂着四个调试入口
       * （HUD 开关 / 调试日志开关 / 打印状态 / 导出日志），对普通用户是纯噪声；
       * 那几个能力仍在控制台接口上：
       *   __biliLoudness.hud(true) / .setDebug(true) / .status() / .logs()
       * ⚠️ probe/s3-panel-unit.mjs 有断言守着这个菜单的**条数与内容**，改这里要同步改它。 */
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

      /**
       * 索引自校验（独立于分析流程的诊断）：
       *   证明 sidx 解析出的 endOffset 正好等于文件真实长度。
       *
       * 不能靠 HEAD 读 Content-Length —— 它不是 CORS 安全列表里的响应头，
       * 页面里读不到。改用「越界探测」这个更硬的办法：
       *   ① 请求 bytes=(endOffset-1)-  → 必须成功（说明文件比 endOffset-1 长）
       *   ② 请求 bytes=endOffset-     → 必须 416（说明文件不比 endOffset 长）
       * 两条合起来即 endOffset === 文件长度，且只用得着可观测的状态码。
       */
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

      /**
       * 旁路（A/B 对比原声）。
       *   setBypass()       — 无参 = 切换；传 true/false = 指定
       *   isBypass()        — 当前是否在旁路
       * 旁路只把实际增益按到 0dB，分析结果与目标增益原样保留，
       * 所以来回切是瞬时的（这一点有单元断言钉着）。
       */
      setBypass: (v) => Analyzer.setBypass(v === undefined ? !Analyzer.isBypass() : v),
      toggleBypass: () => Analyzer.toggleBypass(),
      isBypass: () => Analyzer.isBypass(),

      /* 调试 / 诊断 */
      hud: (v) => Hud.setEnabled(v === undefined ? !Hud.isEnabled() : v),
      hudInfo: () => Hud.info(),
      setDebug: (v) => Log.setDebug(v),

      /* 设置面板（S3.2） */
      panel: (v) => Panel.setPanelEnabled(v === undefined ? !Panel.isEnabled() : v),
      panelInfo: () => Panel.info(),
      /** 全屏判据诊断 —— 真机按 `w` 后调它，用于校准 classHit 正则 */
      fsInfo: () => Panel.fsInfo(),
      panelToggle: (which) => { Panel.toggle(which); return Panel.isOpen(); },
      /** 直接改「自定义档」三元组（验证脚本用，改完立即重算） */
      setCustom: (patch) => { Panel.setCustom(patch); return GainPlanner.currentProfile(); },
      settings: () => Store.getSettings(),

      /** 读写运行时配置（验证脚本用它临时放宽「等切流」容差） */
      config: (k, v) => {
        if (k === undefined) return Object.assign({}, CONFIG);
        if (v === undefined) return CONFIG[k];
        CONFIG[k] = v;
        Log.info(`CONFIG.${k} = ${JSON.stringify(v)}`);
        return CONFIG[k];
      },

      /**
       * 页面状态诊断：一次看清「B 站注入的那几份数据还算不算数」。
       * S2.1 的事故就是「__INITIAL_STATE__ 是首屏那一份、SPA 后不更新」，
       * 有这条接口就不必再靠猜：pageFresh=false 即页面数据过期，cid 会走接口补。
       */
      pageState: () => {
        const el = Lifecycle.currentElement();
        const pi = PlayInfo.fromPage();
        return {
          href: location.href,
          pageKind: pageKind(),
          target: StateReader.target(),
          /* 普通投稿：bvid 与 URL 一致才算新鲜
           * 番剧：没有 __INITIAL_STATE__，改用「对象身份 + ep_id 配对」（见 state-reader） */
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
    //    Lifecycle.start() / exposeDebugApi() 一起带走（S3.2 真栽过一次：
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
