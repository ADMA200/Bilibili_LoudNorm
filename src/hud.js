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
     * 耗时归属行。用户反馈「抽样时长不稳定」，但「时长」是一个笼统的数，
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
