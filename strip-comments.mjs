/* ================================================================
 * strip-comments.mjs — 构建用：安全的 JS 注释剥离器
 *
 * 为什么需要它：
 *   src/*.js 里的注释是**给人看的**（设计取舍、踩过的坑、版本演进），
 *   上线产物里这些全是噪声，占掉三分之一体积。
 *   于是 build.mjs 产出两份：发布版剥注释、开发版留全注释。
 *
 * 为什么不直接用正则 replace：
 *   注释符会出现在字符串、模板串、正则里（例如 `/\/video\//` 里就有连续的 `/`），
 *   一个 `\/\/.*$` 正则会把**一行真实代码**当成注释删掉。
 *   所以这里做逐字符扫描，理解字符串 / 模板串 / 正则 / 注释四种上下文。
 *
 * 保留规则（KEEP）：只保留「说明这段代码干什么」的功能注释。
 *   丢弃——版本演进（S3.2.4…）、真机反馈、踩坑复盘、原因分析、内部问题编号。
 *   这些内容在 src/ 与 docs/ 里都完整保留，产物不需要。
 * ================================================================ */

/** 命中即视为「设计史 / 踩坑 / 演进」类注释 → 产物里丢弃 */
const HISTORY = /S\d\.\d|\bS[1-9]\b|真机|实测反馈|踩过|坑\s*\d|演进|起因|历史|教训|当时|原先|曾经|旧写法|之所以|复盘|反馈|取巧|回归|口径|moxia|Moxia9527|〔/;

/**
 * 「开发向」注释 —— 上传版一律清掉。
 * 这些内容对**读脚本的人**没用，只对写它的人有用：
 *   · 构建方式 / 源码模块结构（模块分隔标题、"请勿直接编辑"）
 *   · 调试、自检、验证接口（`调试用`、`__biliLoudness`、`控制台`）
 *   · 模块交叉引用（"见 state-reader"）
 *   · 实现取舍与性能考量（并发数、限流、退避、防抖、内存与缓存时长、"为了避免…"）
 * 与之相对，**「这段代码在做什么」的注释保留** —— 字段 / 函数 / 常量的一句话说明。
 */
const DEV_SCOPE = /构建产物|请勿直接编辑|源码|模块分隔|^\/\* ---- |^\* ---- |调试用|调试\/诊断|诊断用|自检|供验证|验证脚本|__biliLoudness|控制台|见 [a-z-]+\.js|见 state-reader|HTTP\/2|木桶|并发|限流|-799|退避|防抖|内存|缓存时长|为了避免|避免每|之所以|便于|尽量少|省一次|省下|不加|不要用|不需要/;

/**
 * 关键警示 —— 即便命中 DEV_SCOPE 也保住。
 * 「这么做会静音 / 会断链 / 会抛」这一类说明是**读代码时的护栏**，删了容易踩回去。
 */
const HAZARD = /铁律|⚠️|会静音|必然静音|会断链|会抛|会失效|不可逆|务必/;

/** 纯分隔线（`// ---------`）无信息量 */
const DIVIDER = /^\/\/[\s\-=*#_]{4,}$/;

/** 单条注释的字节上限 */
const MAX_BLOCK_BYTES = 200;
const MAX_LINE_BYTES = 170;

/**
 * 保留的注释在写进产物前先「瘦身」：
 *   装饰性横幅（`/* ============ 设置读写 ============ *\/`）压成单行
 *   `/* ---- 设置读写 ---- *\/` —— 同样的导航作用，省掉整墙的等号。
 * @param {string} text
 */
export function normalizeComment(text) {
  if (!text.startsWith('/*')) return text;
  const lines = text.split('\n')
    .map(l => l.trim().replace(/^\/\*+\s?/, '').replace(/\*+\/$/, '').replace(/^\*+\s?/, '').trim());
  const real = lines.filter(l => l && !/^[=\-*#_\s]+$/.test(l));
  if (real.length !== 1) return text;
  // 标题自身也可能被等号/短横线包着（含已压缩过的），先剥掉装饰再判长度
  const title = real[0].replace(/^[-=*#_\s]+/, '').replace(/[-=*#_\s]+$/, '').trim();
  if (!title || Buffer.byteLength(title, 'utf8') > 48) return text;
  const isBanner = lines.length > 1 || /[=\-*#_]{4,}/.test(text);
  return isBanner ? `/* ---- ${title} ---- */` : text;
}

/**
 * 这条注释要不要保留进发布版？
 * @param {string} text 含注释符的原始文本
 */
export function keepComment(text) {
  if (HISTORY.test(text)) return false;
  // 开发向的说明清掉，但关键警示那几条留住
  if (DEV_SCOPE.test(text) && !HAZARD.test(text)) return false;

  if (text.startsWith('/*')) {
    const lines = text.split('\n').length;
    if (lines > 3) return false;                        // 超过 3 行 = 设计说明
    if (Buffer.byteLength(text, 'utf8') > MAX_BLOCK_BYTES) return false;
    return true;
  }

  // 行注释
  if (DIVIDER.test(text.trim())) return false;
  if (text.includes('\n')) return false;
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return false;
  return true;
}

const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete',
  'void', 'instanceof', 'do', 'else', 'yield', 'await']);

/**
 * 剥离注释。keep 缺省 = 全部剥离。
 * @param {string} code
 * @param {(text:string)=>boolean} [keep] 返回 true 的注释原样保留
 */
export function stripComments(code, keep) {
  const keepIt = keep ? (t) => !!keep(t) : () => false;
  let out = '';
  let i = 0;
  const n = code.length;
  let lastSig = '';   // 最近一个有语义的记号，用来判断 `/` 是除号还是正则开头

  while (i < n) {
    const c = code[i];

    // ---- 行注释 ----
    if (c === '/' && code[i + 1] === '/') {
      let j = i;
      while (j < n && code[j] !== '\n') j++;
      const text = code.slice(i, j);
      if (keepIt(text)) out += text;
      i = j;
      continue;
    }

    // ---- 块注释 ----
    if (c === '/' && code[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      const text = code.slice(i, j);
      if (keepIt(text)) out += normalizeComment(text);
      i = j;
      continue;
    }

    // ---- 单 / 双引号字符串 ----
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n) {
        out += code[i];
        if (code[i] === '\\') { out += code[i + 1] ?? ''; i += 2; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      lastSig = q;
      continue;
    }

    // ---- 模板串 ----
    // 只剥**原文区**（depth 0）的块注释 —— 面板与 HUD 的 CSS 样式表就写在这里，
    // 里面成篇的注释同样是设计史。`${...}` 内是代码，一律原样保留：
    // 那里的 `/` 可能属于正则或字符串，冒然动手会改坏代码。
    // 注意：`//` 在模板里**不能**当注释剥（`https://…` 会中招）。
    if (c === '`') {
      out += c; i++;
      let depth = 0;
      while (i < n) {
        const ch = code[i];
        if (ch === '\\') { out += ch + (code[i + 1] ?? ''); i += 2; continue; }
        if (depth === 0 && ch === '/' && code[i + 1] === '*') {
          let j = i + 2;
          while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
          i = Math.min(j + 2, n);
          continue;
        }
        if (ch === '$' && code[i + 1] === '{') { depth++; out += '${'; i += 2; continue; }
        if (ch === '}' && depth > 0) { depth--; out += ch; i++; continue; }
        if (ch === '`' && depth === 0) { out += ch; i++; break; }
        out += ch; i++;
      }
      lastSig = '`';
      continue;
    }

    // ---- 正则字面量 ----
    if (c === '/') {
      const canBeRegex = lastSig === ''
        || '([{,;=:!&|?+-*%~^<>'.includes(lastSig)
        || KEYWORDS.has(lastSig);
      if (canBeRegex) {
        out += c; i++;
        let inClass = false;
        while (i < n) {
          const ch = code[i];
          if (ch === '\\') { out += ch + (code[i + 1] ?? ''); i += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { out += ch; i++; break; }
          else if (ch === '\n') break;               // 正则不跨行，保底退出
          out += ch; i++;
        }
        while (i < n && /[a-z]/i.test(code[i])) { out += code[i]; i++; }   // flags
        lastSig = '/';
        continue;
      }
    }

    if (/\S/.test(c)) {
      lastSig = /[A-Za-z0-9_$]/.test(c)
        ? (lastSig + c).match(/[A-Za-z0-9_$]+$/)?.[0] ?? c
        : c;
    }
    out += c; i++;
  }

  // 剥离后收尾：去掉行尾空白 + 折叠连续空行
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

/** 校验用：抽取全部字符串 / 模板字面量 */
export function literals(code) {
  const out = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === q) { j++; break; }
        j++;
      }
      out.push(code.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** 校验用：把注释全部去掉，剩下的当「代码骨架」比对（空白折叠） */
export function codeSkeleton(code) {
  return stripComments(code).replace(/\s+/g, ' ').trim();
}

/**
 * 校验用：收集全部注释。
 * 借 keep 回调实现 —— 保证与剥离器是**同一套扫描逻辑**，
 * 不会出现「正则里的 `/` 被当成注释」这类误收集。
 * 注意：模板串内（CSS 样式表）的注释由剥离器直接丢弃，不经过回调。
 */
export function comments(code) {
  const out = [];
  stripComments(code, (t) => { out.push(t); return false; });
  return out;
}
