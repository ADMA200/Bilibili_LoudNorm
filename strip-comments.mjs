/* ================================================================
 * strip-comments.mjs — 构建用：安全的 JS 注释剥离器
 *
 * 为什么需要它：
 *   src/*.js 里的注释是**给人看的**（设计取舍、踩过的坑、版本演进），
 *   交付产物里这些全是噪声，占掉三分之一体积。
 *   于是 build.mjs 产出两份：发布版**注释全剥**，开发版注释全留。
 *
 * 约定（2026-10-04 起）：**以后的注释只写进开发版**。
 *   发布版除 `// ==UserScript==` 元数据块外不留任何注释 ——
 *   那个块是油猴 / GreasyFork 解析用的**元数据**（剥掉脚本就废了，
 *   上传也过不了校验），它在 build.mjs 里于剥离**之后**才拼上去，
 *   因此不经过本模块；本模块只负责把内容注释清干净。
 *
 * 为什么不直接用正则 replace：
 *   注释符会出现在字符串、模板串、正则里（例如 `/\/video\//` 里就有连续的 `/`），
 *   一个 `\/\/.*$` 正则会把**一行真实代码**当成注释删掉。
 *   所以这里做逐字符扫描，理解字符串 / 模板串 / 正则 / 注释四种上下文。
 * ================================================================ */

const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete',
  'void', 'instanceof', 'do', 'else', 'yield', 'await']);

/**
 * 剥离注释。keep 缺省 = 全部剥离（发布版走的就是这条路）。
 * @param {string} code
 * @param {(text:string)=>boolean} [keep] 返回 true 的注释原样保留（通用开口，当前无人使用）
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
      if (keepIt(code.slice(i, j))) out += code.slice(i, j);
      i = j;
      continue;
    }

    // ---- 块注释 ----
    if (c === '/' && code[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      if (keepIt(code.slice(i, j))) out += code.slice(i, j);
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
