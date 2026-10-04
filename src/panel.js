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
        if (r && r.ok) return;
        /* 停用状态下点它是「没拆也没跑」，别报成「没有可测量的视频」误导人 */
        Hud.toast(r && r.reason === 'disabled' ? '响度归一当前是关闭的' : '没有可测量的视频');
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
      /* 用**当下**的快照，不用切换前那份：缓存命中的落位是同步做完的，
       * 拿 lastSnap 会画出最多一个轮询周期（600ms）的「已开启 · 增益 —」空窗。 */
      render(Analyzer.snapshot());
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
