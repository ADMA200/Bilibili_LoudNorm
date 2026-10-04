#!/usr/bin/env node
/* ================================================================
 * s3-panel-unit.mjs — S3.2 设置面板的单元验证（纯 Node，零浏览器）
 *
 * 面板这种东西，**编译不报错、运行不抛异常的坏法特别多**：
 *   · all:initial 排错位 → 浮层掉进文档流，看不见（S2 栽过一次）
 *   · hover 展开的 transform 写反 → 永远露在画面正中
 *   · 全屏判据只认某一个 class 名 → 改版即失效
 *   · 拖滑块没切 custom 档 → 设置改了但增益没动
 * 这些都得靠断言钉死。
 *
 * 分四组：
 *   1. 样式不变量（静态扫源码）
 *   2. 交互与状态机（假 DOM 沙箱里跑**真实的 panel.js**）
 *   3. 全屏隐藏判据（行为）
 *   4. 接线完整性（构建顺序 / 入口时序 / 调试接口 / 配置项）
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ================================================================
 * 1. 样式不变量
 * ================================================================ */

function testCssInvariants() {
  section('1. 样式不变量（静态）');

  const src = read('src/panel.js');

  /* --- 宿主 cssText：all:initial 必须第一 --- */
  const hm = src.match(/const HOST_CSS\s*=\s*\[([\s\S]*?)\]\s*\.join/);
  check('能定位 HOST_CSS 定义', !!hm);
  if (hm) {
    const d = [...hm[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
    console.log(`  宿主声明序列: ${d.join(' | ')}`);
    check('第一条是 all:initial', d[0] === 'all:initial', String(d[0]));
    check('all:initial 不在末尾', d[d.length - 1] !== 'all:initial');
    check('显式补回 display（initial 会变 inline）', d.some(x => /^display\s*:/.test(x)));
    check('position:fixed 带 !important', d.some(x => /^position\s*:\s*fixed\s*!important$/.test(x)));
    check('z-index 取 32 位上限', d.some(x => /^z-index\s*:\s*2147483647\s*!important$/.test(x)));
    check('钉在左侧边（left:0）', d.some(x => /^left\s*:\s*0$/.test(x)));
    /* S3.2.3：按钮列**中点**锚在视口 1/3 高度。
     * 宿主顶边钉 33.333vh，.btns 再上移自身半高 → 列中点 = 33.333vh。 */
    check('★ 按钮列中点锚在视口 1/3（top:33.333vh）',
      d.some(x => /^top\s*:\s*33\.333vh$/.test(x)), d.join(' | '));
    check('★ 不再视口垂直居中（避让 Evolved 侧边栏）',
      !d.some(x => /^top\s*:\s*50%$/.test(x)) && !d.some(x => /translateY/.test(x)),
      d.join(' | '));
    /* 〔问题 5〕宿主不接管点击 —— 否则展开时那块透明矩形会把页面点击一并吞掉 */
    check('★ 问题5：宿主 pointer-events:none（只有按钮/提示/面板吃事件）',
      d.some(x => /^pointer-events\s*:\s*none$/.test(x)), d.join(' | '));
  }

  /* --- Evolved 设计令牌：尺寸逐条对齐 .be-settings > .sidebar --- */
  check('★ 圆钮直径 42px = 26px 内容 + 8px padding×2（content-box，对齐 Evolved）',
    /\.rd\s*\{[^}]*width:\s*26px[^}]*height:\s*26px/.test(src)
    && /\.rd\s*\{[^}]*padding:\s*8px/.test(src)
    && /\.rd\s*\{[^}]*box-sizing:\s*content-box/.test(src));
  check('★ 图标 26px（Evolved .be-icon 的 font-size 同值）',
    /\.rd svg\s*\{[^}]*width:\s*26px[^}]*height:\s*26px/.test(src));
  check('★ 圆钮间距 26px（Evolved margin-bottom:26px 同值）',
    /\.btns\s*\{[^}]*gap:\s*26px/.test(src));
  check('★ 点击热区外扩 20%（Evolved 同款 ::after 140% / -20%）',
    /\.rd::after\s*\{[^}]*width:\s*140%[^}]*height:\s*140%/.test(src)
    && /\.rd::after\s*\{[^}]*top:\s*-20%/.test(src));
  check('纯图标按钮：line-height 归零（去文字基线偏移）', /\.rd\s*\{[^}]*line-height:\s*0/.test(src));
  check('圆钮是圆形（border-radius:50%）', /\.rd\s*\{[^}]*border-radius:\s*50%/.test(src));
  /* 〔问题 2〕按钮列上移半高，让「列中点」落在宿主顶边 */
  check('★ 问题2：.btns 上移半高（top: calc(-1 * var(--btns-half))）',
    /\.btns\s*\{[^}]*top:\s*calc\(-1\s*\*\s*var\(--btns-half\)\)/.test(src));
  check('★ 问题2：--btns-half 常量在（按钮列半高，改尺寸时要同步）',
    /--btns-half:\s*63px/.test(src));

  /* 〔问题 3/4〕按钮分离滑出 + 去掉二次弹出 */
  check('★ 问题3：--shift 常量在（收起位移 = 滑出量，两者同源）', /--shift:\s*28px/.test(src));
  check('★ 问题3：收起态只露半个圆钮（.side → translateX(calc(-1 * var(--shift)))）',
    /\.side\s*\{[^}]*transform:\s*translateX\(calc\(-1\s*\*\s*var\(--shift\)\)\)/.test(src));
  check('★ 问题3：.side.bl-pin **不再**改 transform（旧写法会把两个按钮一起弹出来）',
    !/\.side\.bl-pin\s*\{[^}]*transform:/.test(src));
  check('★ 问题3：位移挂在**不动的外壳** .rdw 上（挂 .rd 会自激抖动）',
    /\.side\s+\.rdw:hover\s+\.rd\s*,[\s\S]{0,80}?\.side\s+\.rdw\.bl-open\s+\.rd\s*\{\s*transform:\s*translateX\(var\(--shift\)\)/.test(src));
  check('★ 问题3：两个圆钮各有一层 .rdw 外壳',
    (src.match(/el\('div',\s*'rdw'\)/g) || []).length === 2,
    String((src.match(/el\('div',\s*'rdw'\)/g) || []).length));
  check('★ 问题3：.rdw 是块级（撑起 hover 判定区）', /\.rdw\s*\{\s*display:\s*block/.test(src));
  check('★ 问题3：打开面板时**只**标记那一个 .rdw（.bl-open 与 which 绑定）',
    /S\.wrapStatus\.classList\.toggle\('bl-open',\s*open === 'status'\)/.test(src)
    && /S\.wrapSettings\.classList\.toggle\('bl-open',\s*open === 'settings'\)/.test(src));
  check('★ 问题4：去掉二次弹出（源码里不再有 translateX(60%) / scale(1.1)）',
    !/translateX\(60%\)/.test(src) && !/scale\(1\.1\)/.test(src));
  check('★ 问题4：面板打开时按钮不额外位移（.rd:hover 内没有独立 transform）',
    !/^\s*\.rd:hover\s*\{\s*transform:/m.test(src));

  check('过渡曲线 cubezier(.22,.61,.36,1) 与 .3s',
    /transition:\s*transform\s+\.3s\s+cubic-bezier\(\.22,\s*\.61,\s*\.36,\s*1\)/.test(src));
  check('圆钮 hover 变白 + 反色文字', /\.rd:hover\s*\{[^}]*background:\s*#fff[^}]*color:\s*#111/.test(src));

  /* 〔问题 6〕提示浮窗：脱离文档流，垂直中线对齐被 hover 的按钮 */
  check('★ 问题6：.tip 绝对定位 + translateY(-50%) 垂直居中',
    /\.tip\s*\{[^}]*position:\s*absolute[^}]*transform:\s*translateY\(-50%\)/.test(src));
  /* 〔S3.2.4·问题 1〕水平位置按**滑出后**的按钮位置算，否则收起态 hover 时会压住按钮 */
  check('★ 问题1：.tip 左缘按滑出位置（left: calc(var(--rail) + var(--shift))）',
    /\.tip\s*\{[^}]*left:\s*calc\(var\(--rail\)\s*\+\s*var\(--shift\)\)/.test(src));
  check('★ 问题1：.pnl 左缘同样按滑出位置（与 .tip 一致）',
    /\.pnl\s*\{[^}]*left:\s*calc\(var\(--rail\)\s*\+\s*var\(--shift\)\)/.test(src));
  check('★ 问题1：旧的 `left: var(--rail)` 已移除（它就是压住按钮的写法）',
    !/\.tip\s*\{[^}]*left:\s*var\(--rail\)\s*;/.test(src) && !/\.pnl\s*\{[^}]*left:\s*var\(--rail\)\s*;/.test(src));

  /* 〔问题 7〕面板宽度减半 */
  check('★ 问题7：面板宽度减半（.pnl → width:176px）',
    /\.pnl\s*\{[^}]*width:\s*176px/.test(src));
  check('★ 问题7：.pnl 用 border-box（否则 176 + padding24 + border2 = 实渲 202px）',
    /\.pnl\s*\{[^}]*box-sizing:\s*border-box/.test(src));
  check('★ 问题7：旧宽度已移除（不再有 min-width:320px / max-width:360px）',
    !/min-width:\s*320px/.test(src) && !/max-width:\s*360px/.test(src));

  /* 〔问题 5〕「点击面板外收回」的接线约束 —— 这几条错了就会「菜单刚开就被自己关掉」 */
  check('★ 问题5：docClick 用**冒泡**注册（用捕获会当场把刚开的菜单关掉）',
    /document\.addEventListener\('click'\s*,\s*docClick\s*\)/.test(src));
  check('★ 问题5：面板容器与两个按钮都 stopPropagation（面板内点击冒泡不到 document）',
    /side\.addEventListener\('click',\s*\(ev\)\s*=>\s*ev\.stopPropagation\(\)\)/.test(src)
    && /ev\.stopPropagation\(\);\s*togglePanel\('status',\s*bStatus\)/.test(src)
    && /ev\.stopPropagation\(\);\s*togglePanel\('settings',\s*bSettings\)/.test(src));
  check('★ 问题5：.tip 不吃事件（pointer-events:none，鼠标滑过不闪）',
    /\.tip\s*\{[^}]*pointer-events:\s*none/.test(src));
  check('★ 问题5：注册/移除成对（ensureDocClick / dropDocClick）',
    /function ensureDocClick\(\)/.test(src) && /function dropDocClick\(\)/.test(src));

  check('面板圆角 8px', /\.pnl\s*\{[^}]*border-radius:\s*8px/.test(src));
  check('面板 1px 半透明描边（#8882 家族）', /--bd:#888/.test(src));
  check('深色兜底 --panel-bg:#222', /VARS_DARK[^\n]*--panel-bg:#222/.test(src));
  check('深色兜底 --card-bg:#282828', /VARS_DARK[^\n]*--card-bg:#282828/.test(src));
  check('浅色主题背景为白/浅灰（非深色）',
    /VARS_LIGHT[^\n]*--panel-bg:#fff/.test(src) && /VARS_LIGHT[^\n]*--card-bg:#f6f7f8/.test(src));

  /* --- 图标（S3.2.1：按钮文字改图标，学 Evolved 用 MDI 图标集） --- */
  check('★ 按钮内容改为图标（源码里不再有「状」「设」文字按钮）',
    !/el\('button',\s*'rd',\s*'[^']+'\)/.test(src));
  check('★ 图标用 createElementNS 建（SVG 有独立命名空间，避开 CSP/Trusted Types）',
    /createElementNS\(SVG_NS,\s*'svg'\)/.test(src) && /createElementNS\(SVG_NS,\s*'path'\)/.test(src));
  check('★ 图标取自 MDI（均衡器 / 齿轮，与 Evolved 同图标集）',
    /ICON\s*=\s*\{[\s\S]*?status:\s*'M10,20H14V4H10V20/.test(src)
    && /settings:\s*'M12,15\.5A3\.5/.test(src));
  check('图标按钮仍带 aria-label（无文字也可读）',
    /setAttribute\('aria-label',\s*'当前状态'\)/.test(src)
    && /setAttribute\('aria-label',\s*'设置'\)/.test(src));

  /* --- 定位（S3.2.1：固定贴视口左上，**不跟随播放器**） --- */
  check('★ 没有 positionSelf（不做播放器跟随）', !/function positionSelf\s*\(/.test(src));
  check('★ 源码不注册 scroll 监听（不养无用的监听器）', !/addEventListener\('scroll'/.test(src));
  /* 注意只匹配**赋值**：info() 里会读 host.style.top 做自检，那是允许的 */
  check('★ 不写 host.style.top（位置全由 HOST_CSS 决定，零 JS）', !/host\.style\.top\s*=/.test(src));
  check('圆钮无描边（Evolved 同款；留着 1px 描边会变 44px，对不齐 42px）',
    /\.rd\s*\{[^}]*border:\s*0/.test(src));

  /* --- 铁律 --- */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('★ 面板不含 alert（会冻页面）', !/(?<![.\w])alert\s*\(/.test(code));
  check('★ 面板不含 video.pause()', !/\.pause\s*\(/.test(code));
  check('★ 面板不含 preventDefault', !/preventDefault\s*\(/.test(code));

  check('文件头记录了「headless 无法验证全屏」这个已知边界', /headless[^\n]*全屏|全屏[^\n]*headless/.test(src));
  check('文件头记录了 ShadowRoot 没有 style 这个坑', /ShadowRoot[^\n]*没有\s*style|没有\s*`?style`?\s*属性/.test(src));

  /* --- 〔坑 4〕主题变量绝不能写 root.style（真机 TypeError，且会拖垮 boot） --- */
  check('★ panel.js 不出现 root.style（ShadowRoot 没有 style 属性）',
    !/\broot\s*\.\s*style\b/.test(code), 'root.style 会让 boot() 抛 TypeError');
  check('★ 主题变量改由 shadow 内的 <style> 承载（:host{...}）',
    /varsStyle\s*\.\s*textContent\s*=\s*`?.*:host\{/.test(src) || /:host\{\$\{/.test(src));
}

/* ================================================================
 * 2. 假 DOM —— 让真实的 panel.js 在 Node 里跑起来
 *
 *    只实现 panel.js 真正用到的那一小撮 API，
 *    目的是钉住「交互状态机」，不是做一个通用 DOM。
 * ================================================================ */

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _sync() { this.el._cls = [...this.set].join(' '); }
  add(...c) { c.forEach(x => this.set.add(x)); this._sync(); }
  remove(...c) { c.forEach(x => this.set.delete(x)); this._sync(); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    this._sync();
    return want;
  }
  contains(c) { return this.set.has(c); }
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._listeners = {};
    this._cls = '';
    this._text = '';
    this._html = null;
    this.style = { cssText: '' };
    this.dataset = {};
    this._attrs = {};
    this._rect = null;
    /* 〔S3.2.3〕问题 6 的浮窗定位读 offsetTop / offsetHeight —— 假 DOM 得给上，
     * 否则 showTip 里的 Number.isFinite 判空直接跳过，定位永远测不到。 */
    this.offsetTop = 0;
    this.offsetHeight = 0;
    this.classList = new FakeClassList(this);
  }
  get className() { return this._cls; }
  set className(v) {
    this._cls = String(v || '');
    this.classList.set = new Set(this._cls.split(/\s+/).filter(Boolean));
  }
  get textContent() {
    if (this._html != null && this.children.length === 0) return String(this._html).replace(/<[^>]*>/g, '');
    return this._text + this.children.map(c => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this._html = null; this.children = []; }
  get innerHTML() { return this._html != null ? this._html : this._text; }
  set innerHTML(v) { this._html = String(v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  dispatch(t, ev) { (this._listeners[t] || []).forEach(fn => fn(ev || { stopPropagation() {} })); }
  click() { this.dispatch('click', { stopPropagation() {} }); }

  /* 属性与 SVG 支持（S3.2.1 起按钮是图标）：
   *   · aria-label  —— 验证脚本靠它定位按钮（按钮里已经没有文字了）
   *   · setAttribute —— SVG 的 viewBox / d 都靠它
   *   · querySelectorAll —— panel.js 的 info() 会数按钮里的 <svg> */
  setAttribute(k, v) { this._attrs[String(k)] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  querySelectorAll(sel) { return this.all().filter(e => e.tagName === String(sel).toUpperCase()); }
  attachShadow() {
    const s = new FakeEl('shadow-root');
    s.isShadow = true;
    /* 〔关键〕真实的 ShadowRoot 是 DocumentFragment，**没有 style 属性**。
     * 早先这里给它配了 .style，于是把「往 root.style 写主题变量」这个
     * 真机上会抛 TypeError 的错给盖住了 —— 假 DOM 必须忠实到能复现该错误。 */
    delete s.style;
    delete s.classList;
    // 真实 DOM 里 shadowRoot 不算 host 的 child；这里挂进 children 只是
    // 为了让 all() 能一次走完整个可见树（测试便利，不影响被断言的行为）
    this.shadowRoot = s;
    this.children.push(s);
    return s;
  }
  getBoundingClientRect() {
    return this._rect || { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  /**
   * 真实 DOMRect **同时**提供 x/y 与 top/left。
   * 早先这里只给了 x/y，于是「按 rect.top 定位」拿到 undefined →
   * Math.round(undefined) = NaN → top 写成 'NaNpx'。
   * 假 DOM 既要「不宽容」（别盖住真机错误），也要「不缺字段」（别造出假错误）。
   */
  setRect(r) {
    this._rect = Object.assign({}, r, {
      top: r.y, left: r.x,
      right: r.x + r.width, bottom: r.y + r.height,
    });
    return this;
  }
  /** 递归收集自身与所有后代（含 shadow root 子树） */
  all(out) {
    out = out || [];
    out.push(this);
    this.children.forEach(c => c.all(out));
    return out;
  }
  find(pred) { return this.all().find(pred) || null; }
}

function makeDom() {
  const document = {
    body: new FakeEl('body'),
    documentElement: new FakeEl('html'),
    fullscreenElement: null,
    _byId: {},
    createElement: (t) => new FakeEl(t),
    /* SVG 走独立命名空间（panel.js 用 createElementNS 建图标，避开 CSP/Trusted Types） */
    createElementNS: (ns, t) => { const e = new FakeEl(t); e.ns = ns; return e; },
    createTextNode: (t) => { const e = new FakeEl('#text'); e.textContent = t; return e; },
    querySelector(sel) { return this._byId[sel] || null; },
    /* 〔S3.2.3〕document 上的监听要**真的记下来** —— 问题 5「点击面板外收回」就挂在它上面。
     * （又一次「假 DOM 缺字段」：原先这里是空实现，新交互根本断言不到。） */
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = this._listeners[t]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatch(t, ev) { (this._listeners[t] || []).slice().forEach(fn => fn(ev || { stopPropagation() {} })); },
  };
  const timers = { intervals: new Map(), timeouts: new Map(), id: 1 };
  const win = {
    _listeners: {},               // 记下监听了哪些事件（滚动跟随要断言）
    addEventListener(t, fn, opts) { (this._listeners[t] = this._listeners[t] || []).push({ fn, opts }); },
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
  };
  return { document, timers, win };
}

function loadPanel(CONFIG, dom, opts) {
  opts = opts || {};
  const { document, timers, win } = dom;
  const calls = { reapply: 0, setEnabled: [], toggleBypass: 0, toasts: [], cleared: 0, reanalyze: 0 };
  let SETTINGS = opts.settings || {};
  let SNAP = Object.assign({
    phase: 'active', source: 'meta', measuredLufs: -23.8, targetLufs: -14,
    gainDb: 9.8, truePeakDb: -2.1, limited: false, bypass: false,
    picked: 12, refined: true,
  }, opts.snapshot || {});

  const Log = { info() {}, warn() {}, error() {}, debug() {} };
  const Hud = { toast: (t) => calls.toasts.push(t) };
  const StateReader = { kind: () => opts.kind || 'pgc' };
  const GainPlanner = {
    listProfiles: () => Object.keys(CONFIG.profiles).map(k => Object.assign({ key: k }, CONFIG.profiles[k])),
    currentProfile: () => CONFIG.profiles[CONFIG.profile] || CONFIG.profiles.standard,
  };
  const Analyzer = {
    snapshot: () => Object.assign({}, SNAP),
    reapply: () => { calls.reapply++; return Promise.resolve({ ok: true }); },
    setEnabled: (v) => { calls.setEnabled.push(v); CONFIG.enabled = !!v; },
    isEnabled: () => !!CONFIG.enabled,
    toggleBypass: () => { calls.toggleBypass++; SNAP.bypass = !SNAP.bypass; return SNAP.bypass; },
    isBypass: () => !!SNAP.bypass,
    /* 〔S3.3.0〕状态面板的「重新测量本视频」按钮调它；opts.reanalyzeOk === false 模拟「页面上没视频」 */
    reanalyze: () => {
      calls.reanalyze++;
      return Promise.resolve(opts.reanalyzeOk === false ? { ok: false, reason: 'no-video' } : { ok: true });
    },
  };
  const Store = {
    getSettings: () => Object.assign({}, SETTINGS),
    setSettings: (p) => { SETTINGS = Object.assign({}, SETTINGS, p); return SETTINGS; },
    clear: () => { calls.cleared++; },
    stats: () => ({ entries: 3, maxEntries: 800, backend: 'GM' }),
  };
  const getComputedStyle = (el) => {
    const cs = el.style && el.style.cssText ? el.style.cssText : '';
    return {
      display: el.classList && el.classList.contains('bl-hide') ? 'none' : 'block',
      position: (cs.match(/position\s*:\s*([a-z]+)/) || [])[1] || 'static',
      zIndex: (cs.match(/z-index\s*:\s*([0-9]+)/) || [])[1] || 'auto',
      top: (cs.match(/top\s*:\s*([^;]+)/) || [])[1] || '',
    };
  };
  const matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  class MutationObserver { constructor() {} observe() {} disconnect() {} }

  const setInterval_ = (fn, ms) => { const id = timers.id++; timers.intervals.set(id, { fn, ms }); return id; };
  const clearInterval_ = (id) => { timers.intervals.delete(id); };
  const setTimeout_ = (fn, ms) => { const id = timers.id++; timers.timeouts.set(id, { fn, ms }); return id; };
  const clearTimeout_ = (id) => { timers.timeouts.delete(id); };

  /** rAF：同步执行 —— 测试里要能立刻看到滚动跟随（positionSelf）的效果 */
  const raf_ = (fn) => { try { fn(); } catch (e) { /* 忽略 */ } return 0; };

  const src = read('src/panel.js');
  const names = ['CONFIG', 'Log', 'Store', 'Analyzer', 'GainPlanner', 'StateReader', 'Hud',
    'document', 'window', 'getComputedStyle', 'matchMedia', 'MutationObserver',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'requestAnimationFrame', 'innerWidth', 'innerHeight'];
  const factory = new Function(...names, `${src}\nreturn { Panel };`);
  const Panel = factory(
    CONFIG, Log, Store, Analyzer, GainPlanner, StateReader, Hud,
    document, win, getComputedStyle, matchMedia, MutationObserver,
    setInterval_, clearInterval_, setTimeout_, clearTimeout_, raf_,
    win.innerWidth, win.innerHeight,
  ).Panel;

  return { Panel, calls, document, timers, win, getSettings: () => SETTINGS, setSnap: (p) => Object.assign(SNAP, p) };
}

function freshConfig() {
  const code = read('src/config.js');
  return new Function(`${code}\nreturn CONFIG;`)();
}

const $ = (root, pred) => root.find(pred);
const byClass = (root, cls) => root.find(e => e.classList && e.classList.contains(cls));
const allByTag = (root, tag) => root.all().filter(e => e.tagName === tag.toUpperCase());

/* ================================================================
 * 2. 交互与状态机
 * ================================================================ */

function testInteraction() {
  section('2. 交互与状态机（真实 panel.js + 假 DOM）');

  const dom = makeDom();
  const CONFIG = freshConfig();
  const h = loadPanel(CONFIG, dom);
  const Panel = h.Panel;

  Panel.init();

  /* --- 挂载 --- */
  const info = Panel.info();
  check('★ init() 后面板已挂进 DOM', info.mounted, JSON.stringify(info));
  check('挂到 body 上', info.parent === 'BODY', info.parent);
  check('用了 shadow root 隔离样式', info.shadow === true);
  check('宿主是 fixed 定位（没被 all:initial 冲掉）', info.computed.position === 'fixed', info.computed.position);

  const hasCls = (e, cls) => !!(e && e.classList && e.classList.contains(cls));
  const host = dom.document.body.children.find(c => hasCls(c, 'side') || c.all().some(e => hasCls(e, 'side')));
  const sideEl = byClass(host, 'side');
  check('侧边条 .side 已创建', !!sideEl);
  check('两个面板 .pnl 都在', allByTag(sideEl, 'div').filter(e => e.classList.contains('pnl')).length === 2);

  /* 〔坑 4〕主题变量必须落在 shadow 内的 <style> 上（ShadowRoot 没有 style） */
  const allStyles = host.all().filter(e => e.tagName === 'STYLE');
  const themeStyle = allStyles.find(s => /:host\{/.test(s.textContent));
  check('★ 主题变量写在 shadow 内 <style> 的 :host{} 上', !!themeStyle,
    allStyles.map(s => String(s.textContent).slice(0, 24)).join(' | '));
  check('★ 主题变量含 --theme / --panel-bg（浅色兜底）',
    !!themeStyle && /--theme:#fb7299/.test(themeStyle.textContent) && /--panel-bg:#fff/.test(themeStyle.textContent),
    themeStyle && themeStyle.textContent.slice(0, 80));

  /* --- 初始收起 --- */
  check('初始没有面板展开', info.open === null && !info.statusOpen && !info.settingsOpen);

  /* --- 圆钮：图标 + aria-label（S3.2.1 起按钮里没有文字了） --- */
  const roundBtns = allByTag(sideEl, 'button').filter(e => e.classList && e.classList.contains('rd'));
  const btnStatus = roundBtns.find(b => b.getAttribute('aria-label') === '当前状态');
  const btnSettings = roundBtns.find(b => b.getAttribute('aria-label') === '设置');
  check('有两个圆钮（状态 / 设置）', !!btnStatus && !!btnSettings, String(roundBtns.length));
  check('★ 圆钮内容是 SVG 图标而非文字',
    !!btnStatus && !!btnSettings
    && btnStatus.textContent === '' && btnSettings.textContent === ''
    && btnStatus.querySelectorAll('svg').length === 1
    && btnSettings.querySelectorAll('svg').length === 1);
  check('★ 图标走 SVG 命名空间（createElementNS）',
    !!btnStatus && btnStatus.querySelectorAll('svg')[0].ns === 'http://www.w3.org/2000/svg',
    btnStatus && btnStatus.querySelectorAll('svg')[0].ns);
  check('两个圆钮图标不同（一个均衡器、一个齿轮）',
    !!btnStatus && !!btnSettings
    && btnStatus.querySelectorAll('svg')[0].children[0].getAttribute('d')
    !== btnSettings.querySelectorAll('svg')[0].children[0].getAttribute('d'));
  check('info().placement 能数出按钮里的图标', Panel.info().placement.iconCount === 1);

  btnStatus.dispatch('mouseenter');
  const tip = byClass(sideEl, 'tip');
  check('★ 悬停「状态」按钮显示 tooltip', tip.classList.contains('bl-show'));
  check('tooltip 里同时给了增益与实测响度',
    /增益/.test(tip.textContent) && /实测/.test(tip.textContent), tip.textContent);
  btnStatus.dispatch('mouseleave');
  check('移开后 tooltip 收起', !tip.classList.contains('bl-show'));

  /* --- 点击展开状态面板 --- */
  btnStatus.click();
  let i2 = Panel.info();
  check('★ 点击「状态」展开状态面板', i2.open === 'status' && i2.statusOpen && !i2.settingsOpen, JSON.stringify(i2));
  check('展开时侧边条钉住（不会一移开就缩回）', byClass(sideEl, 'side').classList.contains('bl-pin'));

  /* --- 状态面板字段 --- */
  const pnlStatus = allByTag(sideEl, 'div').filter(e => e.classList.contains('pnl'))[0];
  const spans = allByTag(pnlStatus, 'span');
  const hasText = (t) => spans.some(s => (s.innerHTML || '').includes(t) || s.textContent.includes(t));
  check('★ 状态面板给出「功能」开关态', hasText('已开启'));
  check('★ 状态面板给出「采样」完成状态', hasText('已完成'));
  check('★ 状态面板给出「来源」= B 站元数据', hasText('官方元数据'));
  check('★ 状态面板给出实测响度 -23.8 LUFS', hasText('-23.8 LUFS'));
  check('★ 状态面板给出当前增益 +9.80 dB', hasText('+9.80 dB'));
  check('状态面板带页型标注（番剧/影视）', hasText('番剧'));

  /* 〔S3.2.5〕限幅行说人话：受削波预算限制 → 「+X dB（防止爆音）」；未受限 → 「未限幅」 */
  const statusText = () => pnlStatus.textContent;
  h.Panel.render({ phase: 'active', limited: false });
  check('★ S3.2.5：未受限时限幅行写「未限幅」（原来只有一个「否」）',
    /未限幅/.test(statusText()), statusText());
  h.Panel.render({ phase: 'active', limited: true, limitReason: '+1.7 dB（防止爆音）' });
  check('★ S3.2.5：受限时直接给「+1.7 dB（防止爆音）」，不再出现「削波预算 / dBTP / 余量」',
    /\+1\.7 dB（防止爆音）/.test(statusText())
    && !/削波预算/.test(statusText()) && !/dBTP/.test(statusText()) && !/余量/.test(statusText()),
    statusText());
  h.Panel.render({ phase: 'active', limited: true, limitReason: '+0 dB（素材已过峰）' });
  check('★ S3.2.5b：过峰时面板写「+0 dB（素材已过峰）」（数值与单位间留空格）',
    /\+0 dB（素材已过峰）/.test(statusText()), statusText());
  h.Panel.render({ phase: 'active', limited: true, limitReason: '档案上限 +6 dB' });
  check('★ S3.2.5b：被档案上限挡住时写「档案上限 +6 dB」（带空格）',
    /档案上限 \+6 dB/.test(statusText()), statusText());

  const bypassBtn = pnlStatus.find(e => e.tagName === 'BUTTON');
  check('★ 状态面板下方有「旁路（听原声）」按钮',
    !!bypassBtn && /旁路/.test(bypassBtn.textContent), bypassBtn && bypassBtn.textContent);
  check('★ S3.2.5：旁路说明改说「点了会怎样」（旧的那句只讲不影响数据）',
    /暂停音频归一，播放原始音频/.test(pnlStatus.textContent)
    && !/只把增益归零/.test(pnlStatus.textContent), pnlStatus.textContent);

  bypassBtn.click();
  check('点旁路按钮 → 切到旁路', h.calls.toggleBypass === 1);
  check('旁路按钮文案翻转为「关闭旁路」', /关闭旁路/.test(bypassBtn.textContent), bypassBtn.textContent);
  check('旁路按钮高亮成主色', bypassBtn.classList.contains('bl-primary'));
  check('旁路有 toast 反馈', h.calls.toasts.length >= 1);
  bypassBtn.click();
  check('再点一次恢复（文案不再含「关闭」）',
    /旁路/.test(bypassBtn.textContent) && !/关闭/.test(bypassBtn.textContent), bypassBtn.textContent);

  /* --- 〔S3.3.0〕状态面板第二个按钮：重新测量本视频 --- */
  const stBtns = allByTag(pnlStatus, 'button');
  check('★ S3.3.0：状态面板下方共两个按钮（旁路 + 重新测量）', stBtns.length === 2, String(stBtns.length));
  check('★ S3.3.0：第一个仍是「旁路（听原声）」（旧位置不变，用户肌肉记忆不被打乱）',
    /旁路/.test(stBtns[0].textContent), stBtns[0] && stBtns[0].textContent);
  const remeasureBtn = stBtns[1];
  check('★ S3.3.0：第二个是「重新测量本视频」',
    !!remeasureBtn && /重新测量本视频/.test(remeasureBtn.textContent), remeasureBtn && remeasureBtn.textContent);
  check('★ S3.3.0：说清丢的是「本视频」的结果（不是整库）',
    /丢弃本视频已保存的测量结果/.test(pnlStatus.textContent), pnlStatus.textContent);
  check('★ S3.3.0：两个按钮之间有分隔线（防止误点清库那类操作）',
    allByTag(pnlStatus, 'div').filter(e => e.classList && e.classList.contains('hr')).length >= 1,
    String(allByTag(pnlStatus, 'div').filter(e => e.classList.contains('hr')).length));

  const toastBefore = h.calls.toasts.length;
  remeasureBtn.click();
  check('★ S3.3.0：点「重新测量本视频」→ 调 Analyzer.reanalyze()', h.calls.reanalyze === 1);
  check('★ S3.3.0：点击立即给 toast「重新测量中…」（不等 Promise 回来）',
    h.calls.toasts.slice(toastBefore).some(t => /重新测量中/.test(t)),
    JSON.stringify(h.calls.toasts.slice(toastBefore)));
  /* 失败分支（页面上没视频）只做源码级断言 —— 它挂在 .then() 里，同步测不到 */
  check('★ S3.3.0：reanalyze 失败时提示「没有可测量的视频」',
    /: '没有可测量的视频'\)/.test(read('src/panel.js')));
  check('★ S3.3.2：停用状态下点重测另有提示 —— 不报成「没有可测量的视频」误导人',
    /r && r\.reason === 'disabled' \? '响度归一当前是关闭的' : '没有可测量的视频'/.test(read('src/panel.js')));

  /* --- 互斥与收起 --- */
  btnSettings.click();
  let i3 = Panel.info();
  check('★ 切到设置面板时状态面板自动收起（互斥）', i3.open === 'settings' && i3.settingsOpen && !i3.statusOpen, JSON.stringify(i3));
  btnSettings.click();
  check('再点一次全部收起', Panel.info().open === null);

  /* --- 〔问题 5〕点击面板 / 按钮以外的地方 → 收回菜单与侧边条 --- */
  {
    check('★ 问题5：document 上注册了 click 监听',
      Array.isArray(dom.document._listeners.click) && dom.document._listeners.click.length === 1,
      JSON.stringify(dom.document._listeners.click || null));

    btnStatus.click();
    check('先打开状态面板', Panel.info().open === 'status');
    dom.document.dispatch('click');          // 模拟「点在面板外」冒泡到 document
    check('★ 问题5：点外部 → 面板收回', Panel.info().open === null);
    check('★ 问题5：同时摘掉侧边条的钉住态（.bl-pin）', !sideEl.classList.contains('bl-pin'));

    /* 收起后再点外部不该有任何副作用 */
    dom.document.dispatch('click');
    check('★ 问题5：已收起时点外部无副作用', Panel.info().open === null && !!Panel.info().mounted);
  }

  /* --- 〔问题 6〕悬浮提示的垂直中线对齐被 hover 的**那一个**按钮 --- */
  {
    const tipEl = sideEl.find(e => e.classList && e.classList.contains('tip'));
    check('★ 存在 .tip 浮窗', !!tipEl);
    const b1 = sideEl.find(e => e.getAttribute && e.getAttribute('aria-label') === '当前状态');
    const b2 = sideEl.find(e => e.getAttribute && e.getAttribute('aria-label') === '设置');
    /* 假 DOM 没有布局引擎，手动给 rect（浮窗 top 相对 .side，所以两者都要给）。
     * ⚠️ 走 getBoundingClientRect —— 用 offsetTop 会因 offsetParent 是 `.btns` 而差出 63px。 */
    sideEl.setRect({ x: 0, y: 0, width: 58, height: 126 });
    b1.setRect({ x: 8, y: 8, width: 42, height: 42 });
    b2.setRect({ x: 8, y: 76, width: 42, height: 42 });

    b1.dispatch('mouseenter');
    const t1 = tipEl.style.top;
    check('★ 问题6：hover 状态按钮 → 浮窗 top 按该按钮垂直中线写入',
      typeof t1 === 'string' && /px$/.test(t1), 'top=' + t1);
    check('★ 问题6：写入值 = 按钮中线 − .side 顶边（8+21−0 = 29px）', t1 === '29px', 'top=' + t1);

    b2.dispatch('mouseenter');
    const t2 = tipEl.style.top;
    check('★ 问题6：hover 设置按钮 → 浮窗**换位置**（不再两按钮共用一处）',
      t2 !== t1, `t1=${t1} t2=${t2}`);
    check('★ 问题6：第二个按钮 = 76 + 21 = 97px', t2 === '97px', 'top=' + t2);

    b2.dispatch('mouseleave');
    check('移开后浮窗收起', !tipEl.classList.contains('bl-show'));
  }

  /* --- 〔问题 1/2/3〕浮窗不压按钮 / 面板对齐各自按钮 / 只留那一个按钮在外 --- */
  {
    const b1 = sideEl.find(e => e.getAttribute && e.getAttribute('aria-label') === '当前状态');
    const b2 = sideEl.find(e => e.getAttribute && e.getAttribute('aria-label') === '设置');
    const wraps = allByTag(sideEl, 'div').filter(e => e.classList && e.classList.contains('rdw'));
    check('★ 问题3：两个 .rdw 外壳都在（一个按钮一个）', wraps.length === 2, String(wraps.length));
    const [w1, w2] = wraps;

    /* 与问题6 同一套假布局：.side 顶边 0、状态钮顶 8、设置钮顶 76 */
    sideEl.setRect({ x: 0, y: 0, width: 58, height: 126 });
    b1.setRect({ x: 8, y: 8, width: 42, height: 42 });
    b2.setRect({ x: 8, y: 76, width: 42, height: 42 });

    const pnls = allByTag(sideEl, 'div').filter(e => e.classList.contains('pnl'));
    const pnlS = pnls[0], pnlT = pnls[1];

    b1.click();                                   // 打开状态面板
    check('★ 问题2：状态面板 top 按**状态按钮**顶边写入（8 − 0 = 8px）',
      pnlS.style.top === '8px', 'top=' + pnlS.style.top);
    check('★ 问题3：打开状态面板 → 只有状态按钮的 .rdw 带 .bl-open（另一个不弹）',
      w1.classList.contains('bl-open') && !w2.classList.contains('bl-open'));

    b2.click();                                   // 切到设置面板
    check('★ 问题2：设置面板 top 按**设置按钮**顶边写入（76 − 0 = 76px）',
      pnlT.style.top === '76px', 'top=' + pnlT.style.top);
    check('★ 问题2：两个面板 top 不同（不再共用 top:0 而落到对方按钮那一行）',
      pnlS.style.top !== pnlT.style.top, `${pnlS.style.top} vs ${pnlT.style.top}`);
    check('★ 问题3：切到设置面板 → .bl-open 转到设置按钮，状态按钮收回去',
      !w1.classList.contains('bl-open') && w2.classList.contains('bl-open'));

    b2.click();                                   // 收起
    check('★ 问题3：全部收起 → 两个 .rdw 都不带 .bl-open',
      !w1.classList.contains('bl-open') && !w2.classList.contains('bl-open'));
  }

  /* --- 设置面板控件 --- */
  btnStatus.click(); btnSettings.click();
  const pnlSet = allByTag(sideEl, 'div').filter(e => e.classList.contains('pnl'))[1];
  const cb = pnlSet.find(e => e.tagName === 'INPUT' && e.type === 'checkbox');
  const ranges = allByTag(pnlSet, 'input').filter(e => e.type === 'range');
  const sel = pnlSet.find(e => e.tagName === 'SELECT');

  check('★ 设置面板有「启用响度归一」开关', !!cb);
  check('★ 设置面板有预设下拉', !!sel && sel.children.length === Object.keys(CONFIG.profiles).length);
  check('★ 设置面板有三个滑块（目标响度 / 增益上限 / 增益下限）', ranges.length === 3, String(ranges.length));
  check('目标滑块范围 = CONFIG.targetRange',
    +ranges[0].min === CONFIG.targetRange[0] && +ranges[0].max === CONFIG.targetRange[1]);
  check('增益下限滑块 min < 0 < max（取负区间）', +ranges[2].min < 0 && +ranges[2].max === 0);
  check('★ 设置面板有缓存说明与「清除缓存」按钮',
    !!pnlSet.find(e => e.tagName === 'BUTTON' && /清除/.test(e.textContent)));
  check('★ S3.2.5：缓存说明改为直述「清掉的是什么」',
    /清除已保存的视频响度测量结果/.test(pnlSet.textContent)
    && !/原始测量值/.test(pnlSet.textContent), pnlSet.textContent);

  /* --- 开关联动 --- */
  cb.checked = false; cb.dispatch('change');
  check('★ 关掉开关 → Analyzer.setEnabled(false)', h.calls.setEnabled.includes(false));
  check('★ 开关状态被持久化', h.getSettings().enabled === false);
  cb.checked = true; cb.dispatch('change');
  check('再打开 → setEnabled(true)', h.calls.setEnabled.includes(true));

  /* --- 预设切换 --- */
  const before = h.calls.reapply;
  sel.value = 'night'; sel.dispatch('change');
  check('★ 换预设 → CONFIG.profile 跟着变', CONFIG.profile === 'night', CONFIG.profile);
  check('★ 换预设无需重新抽样（直接 reapply）', h.calls.reapply > before);
  check('预设写回设置', h.getSettings().profile === 'night');

  /* --- 拖滑块 → 自动切自定义档 + 防抖重算 --- */
  const before2 = h.calls.reapply;
  ranges[0].value = '-20'; ranges[0].dispatch('input');
  ranges[1].value = '8'; ranges[1].dispatch('input');
  ranges[2].value = '-30'; ranges[2].dispatch('input');
  check('★ 拖滑块自动切到「自定义」档', CONFIG.profile === 'custom', CONFIG.profile);
  check('三个滑块的值都写进 profiles.custom',
    CONFIG.profiles.custom.targetLufs === -20
    && CONFIG.profiles.custom.maxBoostDb === 8
    && CONFIG.profiles.custom.minGainDb === -30,
    JSON.stringify(CONFIG.profiles.custom));
  check('★ 拖动期间不立即重算（防抖 150ms，等手停）', h.calls.reapply === before2);
  check('已排队一个防抖任务', dom.timers.timeouts.size === 1, String(dom.timers.timeouts.size));
  [...dom.timers.timeouts.values()].forEach(t => t.fn()); dom.timers.timeouts.clear();
  check('★ 手停后自动重算一次（零下载零解码）', h.calls.reapply === before2 + 1, String(h.calls.reapply));
  ranges[2].dispatch('change');
  check('滑块 change 时持久化设置', h.getSettings().custom && h.getSettings().custom.minGainDb === -30);

  /* --- 清除缓存不影响设置 --- */
  const setBtn = pnlSet.find(e => e.tagName === 'BUTTON' && /清除/.test(e.textContent));
  setBtn.click();
  check('点清除缓存 → 调 Store.clear()', h.calls.cleared === 1);
  check('★ 清除缓存后用户设置仍在（两者互不牵连）',
    h.getSettings().profile === 'custom' && h.getSettings().enabled === true, JSON.stringify(h.getSettings()));

  /* --- 关掉整个面板 --- */
  Panel.setPanelEnabled(false);
  check('★ setPanelEnabled(false) → 宿主从 DOM 摘除', !dom.document.body.children.includes(host));
  check('关掉后面板自检报告未挂载', Panel.info().mounted === false);
  check('isEnabled() 跟随', Panel.isEnabled() === false);
  Panel.setPanelEnabled(true);
  check('★ 可重新开启（幂等恢复）', Panel.info().mounted === true && Panel.isEnabled() === true);

  /* --- setCustom --- */
  Panel.setCustom({ targetLufs: -18 });
  check('setCustom 直接改自定义档并切档', CONFIG.profile === 'custom' && CONFIG.profiles.custom.targetLufs === -18);

  /* --- 关掉 UI 后宿主不再被误碰 --- */
  Panel.setPanelEnabled(false);
}

/* ================================================================
 * 2b. 定位（S3.2.1）：按钮顶部对齐「播放器窗口顶部」
 *
 * 这条是**真机反馈驱动的**：面板原先用视口垂直居中，与 Evolved 的侧边栏
 * （`.be-settings > .sidebar`，同样是 fixed + top:50%）完全重合、按钮叠一起。
 * ================================================================ */

function testPlacement() {
  section('2b. 定位（固定贴视口左上，不跟随播放器）');

  const dom = makeDom();
  const CONFIG = freshConfig();
  /* 故意放一个播放器容器在页面中部：位置**不该**受它影响 */
  const box = new FakeEl('div');
  box.className = 'bpx-player-container';
  box.setRect({ x: 0, y: 137, width: 1200, height: 675 });
  dom.document._byId['.bpx-player-container'] = box;

  const h = loadPanel(CONFIG, dom);
  h.Panel.init();
  const host = dom.document.body.children[0];

  check('★ 宿主位置来自 HOST_CSS（left:0 / top:33.333vh = 视口 1/3）',
    /left:0/.test(host.style.cssText) && /top:33\.333vh/.test(host.style.cssText), host.style.cssText);
  check('★ 不走 JS 定位：host.style.top 为空（位置不由播放器决定）',
    !host.style.top, String(host.style.top));
  check('★ 不跟随播放器：容器在 y=137，宿主样式里没有这个数',
    !/137/.test(host.style.cssText), host.style.cssText);

  /* 容器动来动去 + 轮询跑几轮 → 位置都不该变 */
  box.setRect({ x: 0, y: 40, width: 1200, height: 675 });
  [...dom.timers.intervals.values()].forEach(t => t.fn());
  box.setRect({ x: 0, y: -300, width: 1200, height: 675 });
  [...dom.timers.intervals.values()].forEach(t => t.fn());
  check('★ 容器移动 + 轮询多轮后，宿主位置丝毫不变',
    !host.style.top && /top:33\.333vh/.test(host.style.cssText), host.style.cssText);

  check('★ 没有注册 scroll 监听（不跟随就不需要它）',
    !dom.win._listeners.scroll, JSON.stringify(Object.keys(dom.win._listeners)));

  const pl = h.Panel.info().placement;
  check('info().placement 只说按钮自己（不再报 playerTop）',
    !!pl && !('playerTop' in pl), JSON.stringify(pl));

  /* 页面里根本没有播放器容器时行为完全一致（少一类失效面） */
  {
    const d2 = makeDom();
    const h2 = loadPanel(freshConfig(), d2);
    h2.Panel.init();
    const css = d2.document.body.children[0].style.cssText;
    check('页面没有播放器容器时行为完全一致', /left:0/.test(css) && /top:33\.333vh/.test(css), css);
  }

  h.Panel.setPanelEnabled(false);
}

/* ================================================================
 * 3. 全屏隐藏判据
 * ================================================================ */

function testFullscreen() {
  section('3. 网页全屏时完全隐藏');

  /* --- 3a. 靠 class 判定 --- */
  {
    const dom = makeDom();
    const CONFIG = freshConfig();
    const h = loadPanel(CONFIG, dom);
    h.Panel.init();
    check('初始不隐藏', h.Panel.info().hiddenByFullscreen === false && h.Panel.fsInfo().detected === false);

    dom.document.body.classList.add('web-fullscreen');
    h.Panel.render(h.Panel.info() && null);
    h.Panel.syncControls();
    h.Panel.render({ phase: 'active' });
    const fi = h.Panel.fsInfo();
    check('★ body 带全屏 class → 判定为全屏', fi.detected === true, JSON.stringify(fi.classHit));
    check('★ 全屏时面板隐藏（hiddenByFullscreen）', h.Panel.info().hiddenByFullscreen === true);

    dom.document.body.classList.remove('web-fullscreen');
    h.Panel.render({ phase: 'active' });
    check('★ 退出全屏后恢复可见', h.Panel.info().hiddenByFullscreen === false);
  }

  /* --- 3a2. 真机取证回归（2026-10-03） ---
   * 网页全屏（按 w）时只有 **body** 多出两个类：webscreen-fix / player-mode-web；
   * html 与 .bpx-player-container 的 class **完全不变**（实测）。
   * 命中靠的是 `webscreen-fix`（正则里的 web-?screen 覆盖 webscreen）。 */
  {
    const dom = makeDom();
    const CONFIG = freshConfig();
    const h = loadPanel(CONFIG, dom);

    // 真机 baseline（非全屏）—— 原文照抄
    const BASE = 'mac round-corner dark remove-player-popup remove-player-popup-votes '
      + 'remove-player-popup-related-videos remove-player-popup-combo-likes remove-player-popup-rates '
      + 'remove-player-popup-reservations remove-player-popup-promotions';
    // 真机网页全屏 —— 末尾就多这两个
    const FS = BASE + ' webscreen-fix player-mode-web';

    dom.document.body.className = BASE;
    h.Panel.init();
    check('★ 真机 baseline（非全屏）body 不判全屏', h.Panel.fsInfo().classHit.body === false);
    check('★ 真机 baseline 整体 detected=false', h.Panel.fsInfo().detected === false);

    dom.document.body.className = FS;
    h.Panel.render({ phase: 'active' });
    check('★ 真机全屏（webscreen-fix）→ classHit.body=true', h.Panel.fsInfo().classHit.body === true);
    check('★ 真机全屏整体 detected=true', h.Panel.fsInfo().detected === true);
    check('★ 真机全屏时面板隐藏', h.Panel.info().hiddenByFullscreen === true);

    dom.document.body.className = BASE;
    h.Panel.render({ phase: 'active' });
    check('★ 去掉 webscreen-fix 后恢复', h.Panel.fsInfo().detected === false);
  }

  /* --- 3a3. player-mode-web 单独出现**不**命中（保守策略，防误报） --- */
  {
    const dom = makeDom();
    const CONFIG = freshConfig();
    const h = loadPanel(CONFIG, dom);
    dom.document.body.className = 'player-mode-web';
    h.Panel.init();
    check('★ player-mode-web 单独不判全屏（语义含「网页模式」，怕误报 → 刻意不入正则）',
      h.Panel.fsInfo().classHit.body === false);
  }

  /* --- 3b. 几何兜底（不依赖任何 class 名，改版也不失效） --- */
  {
    const dom = makeDom();
    const CONFIG = freshConfig();
    const h = loadPanel(CONFIG, dom);
    const box = new FakeEl('div');
    box.className = 'bpx-player-container';
    box.setRect({ x: 0, y: 0, width: dom.win.innerWidth, height: dom.win.innerHeight });
    dom.document._byId['.bpx-player-container'] = box;

    h.Panel.init();
    const fi = h.Panel.fsInfo();
    check('★ 几何兜底：容器铺满视口即判全屏（无 class 也成立）', fi.detected === true, JSON.stringify(fi));
    check('classHit 三路都没命中（证明是几何兜底生效）',
      !fi.classHit.body && !fi.classHit.html && !fi.classHit.container);
    check('面板已隐藏', h.Panel.info().hiddenByFullscreen === true);
  }

  /* --- 3c. 关掉 fullscreenHide 就不隐藏 --- */
  {
    const dom = makeDom();
    const CONFIG = freshConfig();
    CONFIG.fullscreenHide = false;
    const h = loadPanel(CONFIG, dom);
    h.Panel.init();
    dom.document.body.classList.add('web-fullscreen');
    h.Panel.render({ phase: 'active' });
    check('★ fullscreenHide=false 时不隐藏（可关）', h.Panel.info().hiddenByFullscreen === false);
  }

  /* --- 3d. 真全屏 API --- */
  {
    const dom = makeDom();
    const CONFIG = freshConfig();
    const h = loadPanel(CONFIG, dom);
    h.Panel.init();
    dom.document.fullscreenElement = { id: 'bilibili-player' };
    check('★ Fullscreen API 命中即判全屏', h.Panel.fsInfo().detected === true);
  }
}

/* ================================================================
 * 4. 接线完整性
 * ================================================================ */

function testWiring() {
  section('4. 接线完整性（构建 / 入口 / 接口 / 配置）');

  const build = read('build.mjs');
  const mods = (build.match(/const MODULES\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1]
    .match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  const iP = mods.indexOf('panel.js');
  const iA = mods.indexOf('analyzer.js');
  check('★ build.mjs 已把 panel.js 纳入构建', iP >= 0, mods.join(','));
  check('★ panel.js 排在 analyzer.js 之前（analyzer 只读设置）', iP >= 0 && iA >= 0 && iP < iA);
  check('panel.js 在 hud.js 之后（复用 toast）',
    mods.indexOf('hud.js') >= 0 && iP > mods.indexOf('hud.js'));

  const main = read('src/main.js');
  const initAt = main.indexOf('Panel.init()');
  const startAt = main.indexOf('Lifecycle.start();');
  check('★ main.js 调用了 Panel.init()', initAt >= 0);
  check('★ Panel.init() 早于 Lifecycle.start()（设置必须先落位，否则首轮白跑）',
    initAt >= 0 && startAt >= 0 && initAt < startAt);
  check('★ Panel.init() 被 try/catch 兜住（UI 出错不许拖垮归一核心）',
    /try\s*\{[\s\S]{0,120}Panel\.init\(\)[\s\S]{0,240}\}\s*catch/.test(main));

  check('调试接口暴露 panelInfo', /panelInfo:\s*\(\)\s*=>\s*Panel\.info\(\)/.test(main));
  check('调试接口暴露 fsInfo（真机校准全屏判据用）', /fsInfo:\s*\(\)\s*=>\s*Panel\.fsInfo\(\)/.test(main));
  check('调试接口暴露 setPanel', /panel:\s*\(v\)\s*=>\s*Panel\.setPanelEnabled/.test(main));
  check('调试接口暴露 setCustom', /setCustom:\s*\(patch\)\s*=>/.test(main));
  check('调试接口暴露 settings 读取', /settings:\s*\(\)\s*=>\s*Store\.getSettings\(\)/.test(main));

  const cfg = read('src/config.js');
  check('CONFIG.panel 存在', /panel:\s*true/.test(cfg));
  check('CONFIG.fullscreenHide 存在', /fullscreenHide:\s*true/.test(cfg));

  /* --- 调试 HUD 默认关闭（S3.2.1：与状态面板重复，且常驻挡视线） --- */
  check('★ CONFIG.hud 默认关闭', /hud:\s*false/.test(cfg));
  check('★ boot() 里 HUD 初始化受 CONFIG.hud 守门（关了就不建浮层）',
    /if\s*\(CONFIG\.hud\)\s*Hud\.update\(/.test(main));
  check('★ toast 与常驻浮层解耦（关 HUD 不影响旁路 / 清缓存提示）',
    /function toast\s*\(/.test(read('src/hud.js')) && /toastHost/.test(read('src/hud.js')));
  /* --- 〔S3.3.0〕油猴菜单瘦身：只留用户真会用的三项 --- */
  check('★ S3.3.0：菜单保留「开关响度归一 / 旁路开关 / 清空测量缓存」',
    /开关响度归一/.test(main) && /旁路开关/.test(main) && /清空测量缓存/.test(main));
  /* 断言前先剥注释：注释里出现「某个菜单项已移除」这类**说明性**文字是合法的，
   * 不该被当成「菜单里还有它」。真正要守的是「没有把这些命令注册进去」。 */
  const mainCode = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('★ S3.3.0：四个调试入口已从菜单移除（开关调试 HUD / 切换调试日志 / 打印状态 / 导出日志）',
    !/开关调试 HUD/.test(mainCode) && !/切换调试日志/.test(mainCode)
    && !/打印状态到控制台/.test(mainCode) && !/导出最近日志/.test(mainCode),
    mainCode.split('\n').filter(l => /调试 HUD|调试日志|打印状态|导出最近日志/.test(l)).join(' | '));
  check('★ S3.3.0：菜单项恰好 3 条（日后想加回来，这条会先拦下来）',
    (main.match(/GM_registerMenuCommand\(/g) || []).length === 3,
    String((main.match(/GM_registerMenuCommand\(/g) || []).length));
  check('★ S3.3.0：调试能力仍留在控制台接口上（hud / setDebug / status / logs）',
    /hud:\s*\(v\)\s*=>/.test(main) && /setDebug:\s*\(v\)\s*=>/.test(main)
    && /status:\s*buildStatus/.test(main) && /logs:\s*\(\)\s*=>\s*Log\.ring\(\)/.test(main));
  /* 菜单入口没了，debug 若仍默认开，用户就没有关它的办法了 */
  check('★ S3.3.0：CONFIG.debug 默认关闭（菜单入口一并移除，不能留个关不掉的开关）',
    /debug:\s*false/.test(cfg));
  check('三组滑块范围都在配置里',
    /targetRange:/.test(cfg) && /maxBoostRange:/.test(cfg) && /minGainRange:/.test(cfg));
  check('profiles 增加 custom 档', /custom:\s*\{\s*label:\s*'自定义'/.test(cfg));

  const store = read('src/store.js');
  check('Store 提供 getSettings / setSettings',
    /function getSettings/.test(store) && /function setSettings/.test(store));
  check('★ SETTINGS_KEY 不复用 INDEX_KEY（设置不进 LRU）', /SETTINGS_KEY\s*=\s*`\$\{NS\}:__settings`/.test(store));
  const touchBody = (store.match(/function touch\s*\(key\)\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  check('★ LRU 淘汰只认测量 key，不会删到设置', !!touchBody && !/settings/i.test(touchBody));
  check('导出里有 getSettings / setSettings', /return \{[^}]*getSettings[^}]*\}/.test(store));

  const dist = read('Bilibili_LoudNorm.user.js');
  check('★ 构建产物里含 Panel 模块', /const Panel = \(\(\) => \{/.test(dist));
  // 版本号的唯一来源是 src/config.js，这里只校验两者同步，不硬编码
  // （硬编码的结果是每升一次版本就得回来改一行套件）
  const relVer = (read('src/config.js').match(/version:\s*'([^']+)'/) || [])[1];
  check(`构建产物版本与 src/config.js 一致（v${relVer}）`,
    new RegExp('@version\\s+' + String(relVer).replace(/\./g, '\\.')).test(dist), relVer);
  check('构建产物铁律：无 alert', !/(?<![.\w])alert\s*\(/.test(dist.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('★ S3.3.1：发布版不再内联模块分隔标题（那是开发版的事）',
    !/^\/\* ---- [a-z-]+\.js ---- \*\/$/m.test(dist));
}

/* ================================================================ */

(() => {
  console.log('S3.2 / S3.2.1 面板单元验证\n');
  testCssInvariants();
  testInteraction();
  testPlacement();
  testFullscreen();
  testWiring();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
