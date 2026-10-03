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
