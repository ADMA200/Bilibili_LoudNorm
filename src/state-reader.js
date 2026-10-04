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
   * 番剧集号 ep_id。四个来源（按权威度降序）：
   *   /bangumi/play/ep308426              → 308426（用户明确打开的那一集，最权威）
   *   /bangumi/play/ss12345?ep_id=308426  → query 里的
   *   __playinfo__.result.play_view_business_info.episode_info.ep_id  ← 季落地页
   *   __playinfo__.result.supplement.ogv_episode_info.episode_id      ← 同上，兜底字段
   *
   * ⚠️ 后两条是为「**季落地页 /bangumi/play/ssXXX**」准备的，不能省：
   *    实测（CDP 抓 ss29308）——B 站打开季落地页时会自动选中一集
   *    （第一集 / 上次看到的那集）**并直接开始播放**，而 URL 里**始终没有 ep**。
   *    只认 URL 的话 target() 返回 null，脚本报「未识别到页面目标」：
   *    播放器明明在放、SSR 数据（含官方响度元数据）也齐全，却整个跳过；
   *    用户必须手动点一次分集（URL 才变成 /epXXXX）才会归一。
   *    pagePlayInfo/番剧 SSR 里这两处字段写的就是**正在播的那一集**
   *    （实测 308426，与同一份 result 里的 arc.cid 配套）。
   *
   * ⚠️ URL 的优先级不能反：点分集时 URL 会变成 /epXXXX（实测），此时若还采信 SSR，
   *    读到的是 SPA 切集后**没更新**的那一份（属于上一集）—— 增益会压错集。
   */
  function epId() {
    const m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
    if (m) return m[1];
    const q = query('ep_id');
    if (q && /^\d+$/.test(q)) return q;
    const s = ssrEpId();
    if (s) return s;
    return null;
  }

  /** 季落地页专用：从 __playinfo__.result 读「当前正在播的这一集」的 ep_id */
  function ssrEpId() {
    let r = null;
    try { r = page().__playinfo__.result || null; } catch (e) { r = null; }
    if (!r) return null;
    const biz = r.play_view_business_info;
    const sup = r.supplement;
    const cands = [
      biz && biz.episode_info && biz.episode_info.ep_id,
      sup && sup.ogv_episode_info && sup.ogv_episode_info.episode_id,
      epFromFormats(r),
      r.ep_id,
    ];
    for (let i = 0; i < cands.length; i++) {
      const v = cands[i];
      if (Number.isFinite(v) && v > 0) return String(v);
      if (typeof v === 'string' && /^\d+$/.test(v)) return v;
    }
    return null;
  }

  /** 兜底来源：清晰度档位的上报参数里也带当前集 ep（实测是字符串，页型覆盖面最广） */
  function epFromFormats(r) {
    const list = r.video_info && r.video_info.support_formats;
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const rep = list[i] && list[i].report;
      if (rep && rep.ep_id !== undefined && rep.ep_id !== null) return rep.ep_id;
    }
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
