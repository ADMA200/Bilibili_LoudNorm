#!/usr/bin/env node
/* ================================================================
 * build-strip-unit.mjs — 构建拆分（发布版 / 开发版）与注释剥离的单元验证
 *
 * build.mjs 现在产出两个文件：
 *   Bilibili_LoudNorm.user.js       发布版（上传用，注释精简）
 *   Bilibili_LoudNorm.dev.user.js   开发版（本地调试，注释全留）
 *
 * 这里要钉死的是**「剥离只动了注释，没动代码」** —— 这是整个拆分的前提。
 * 注释剥离是逐字符扫描实现的（见 strip-comments.mjs），一旦判断错
 * 「`/` 是除号还是正则开头」，就会把**一整行真实代码**当成注释删掉，
 * 而语法还可能是合法的 —— 靠人眼看产物发现不了。所以断言分三层：
 *   ① 骨架比对：两版把注释全剥掉后，代码必须逐字一致
 *   ② 定点比对：src 里所有含转义斜杠（正则）的代码行必须原样出现在产物里
 *   ③ 语法自检：node --check 真实解析一遍
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripComments, keepComment, literals, comments } from '../strip-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const REL = 'Bilibili_LoudNorm.user.js';
const DEV = 'Bilibili_LoudNorm.dev.user.js';

const MODULES = ['config.js', 'logger.js', 'store.js', 'sidx.js', 'loudness.js',
  'gain-planner.js', 'state-reader.js', 'playinfo.js', 'sampler.js',
  'audio-engine.js', 'hud.js', 'panel.js', 'analyzer.js', 'lifecycle.js', 'main.js'];

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const release = read(REL);
const dev = read(DEV);
const kb = (s) => Buffer.byteLength(s, 'utf8') / 1024;

/* --------------------------- 1. 体积 --------------------------- */
function testSize() {
  section('体积');
  check('发布版存在且非空', release.length > 10000, release.length);
  check('开发版存在且非空', dev.length > 10000, dev.length);
  check('★ 发布版 ≤ 150 KB', kb(release) <= 150, kb(release).toFixed(1) + ' KB');
  check('★ 发布版比开发版小 ≥ 20%',
    kb(release) / kb(dev) <= 0.80,
    (kb(release) / kb(dev) * 100).toFixed(1) + '%');
  check('发布版行数 ≤ 4600', release.split('\n').length <= 4600, release.split('\n').length);
}

/* --------------------- 2. 注释策略（该丢的丢了） --------------------- */
function testStripped() {
  section('注释策略');

  // 只取**注释文本**来查 —— 直接对整行做正则会把代码行也扫进来
  // （例：`Log.debug('调试接口已挂到 …')` 是代码，不是注释）。
  // 另：模板串（CSS 样式表）内的注释由剥离器直接丢弃，不在 comments() 里。
  const commentText = comments(release)
    .filter(t => !/^\/\/ @/.test(t))      // UserScript header 的元数据行不算注释
    .join('\n');

  check('发布版有注释（不是全清空）', commentText.length > 2000, commentText.length);

  const GONE = [
    ['版本演进标记 S3.x.x', /S\d\.\d/],
    ['内部问题编号 〔〕', /〔/],
    ['真机反馈', /真机/],
    ['踩坑记录', /踩过/],
    ['演进叙述', /演进/],
    ['个人署名 moxia（小写）', /moxia/],
    // ---- 开发向（S3.3.1 起清掉）----
    ['调试接口', /调试用|调试\/诊断|自检|供验证|验证脚本|__biliLoudness/],
    ['模块交叉引用', /见 [a-z-]+\.js|见 state-reader/],
    ['并发 / 限流调参', /HTTP\/2|并发上限|-799|退避|防抖延迟/],
    ['构建说明', /构建产物|请勿直接编辑/],
  ];
  for (const [name, re] of GONE) {
    const hit = commentText.split('\n').filter(l => re.test(l));
    check(`★ 发布版注释中无「${name}」`, hit.length === 0, hit[0]?.trim().slice(0, 80));
  }

  // 残留块注释不得有超过 3 行的（3 行以上 = 设计说明）
  const blocks = comments(release).filter(t => t.startsWith('/*'));
  const longOnes = blocks.filter(b => b.split('\n').length > 3);
  check('★ 发布版无「超过 3 行」的块注释', longOnes.length === 0, longOnes[0]?.slice(0, 80));

  const body = release.slice(release.indexOf('(function () {'));
  const commentBytes = comments(body).reduce((s, b) => s + Buffer.byteLength(b, 'utf8'), 0);
  check('★ 发布版注释占比 ≤ 15%',
    commentBytes / Buffer.byteLength(body) <= 0.15,
    (commentBytes / Buffer.byteLength(body) * 100).toFixed(1) + '%');

  check('★ 装饰性横幅已压成单行（无 20 连等号）', !/={20,}/.test(release));
  check('保留功能注释：字段说明', release.includes('/** 总开关 */'));
  check('保留功能注释：函数说明', /\/\*\* 均匀抽取 want 个段/.test(release));
  check('保留行注释：功能说明', release.includes('// 分析完成前保持原声'));
  check('保留行注释：危险提示', release.includes('// 铁律 3：ctx 不 running 就绝不接管'));

  const mods = MODULES.filter(m => release.includes(`/* ---- ${m} ---- */`));
  check('★ 发布版不含模块分隔标题（开发向，已清）', mods.length === 0, mods.join(', '));
  check('★ 开发版保留 15 个模块分隔标题',
    MODULES.every(m => dev.includes(`/* ---- ${m} ---- */`)));

  // 剥离后仍要留下实质代码（防止整段被吃掉）
  const codeLines = body.split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('//'));
  check('★ 发布版代码行 ≥ 3400 行', codeLines.length >= 3400, codeLines.length);
}

/* --------------------- 3. 代码完整性（核心） --------------------- */
function testIntegrity() {
  section('代码完整性');

  // ① 骨架比对：注释全剥后，两版必须逐字一致
  const skel = (s) => stripComments(s).replace(/\s+/g, ' ').trim();
  const sDev = skel(dev), sRel = skel(release);
  check('★ 两版「去掉全部注释 + 折叠空白」后逐字一致', sDev === sRel,
    sDev === sRel ? sDev.length : `${sDev.length} vs ${sRel.length}`);

  // ② 字面量多重集一致（字符串 / 模板串没被吃掉）
  const norm = (s) => literals(s).sort().join('\u0000');
  check('★ 两版字符串字面量多重集一致', norm(skel(dev)) === norm(skel(release)));

  // ③ 定点比对：src 里含转义斜杠的代码行（正则）必须原样出现在发布版
  const tricky = [];
  for (const m of MODULES) {
    for (const line of read('src/' + m).split('\n')) {
      if (!/\\\//.test(line)) continue;
      const t = line.trim();
      if (!t || t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
      tricky.push([m, t]);
    }
  }
  const lost = tricky.filter(([, t]) => !release.includes(t));
  check(`★ src 中 ${tricky.length} 行「含正则」的代码全部原样保留`, lost.length === 0,
    lost.map(([m, t]) => `${m}: ${t.slice(0, 60)}`).join(' | '));

  // ④ 语法自检
  const r = spawnSync(process.execPath, ['--check', join(ROOT, REL)], { encoding: 'utf8' });
  check('★ 发布版通过 node --check 语法自检', r.status === 0, (r.stderr || '').split('\n')[0]);
  const r2 = spawnSync(process.execPath, ['--check', join(ROOT, DEV)], { encoding: 'utf8' });
  check('开发版通过 node --check', r2.status === 0, (r2.stderr || '').split('\n')[0]);

  // ⑤ 铁律（在剥掉注释的代码上查，避免注释里的字眼误报）
  const code = stripComments(release);
  check('铁律：无 alert(', !/(?<![.\w])alert\s*\(/.test(code));
  check('铁律：无 pause(', !/\.pause\s*\(/.test(code));
  check('铁律：无 preventDefault', !/preventDefault\s*\(/.test(code));
  // 空参 disconnect() 只允许出现在 MutationObserver 上（拆音频链是铁律禁止项）
  const anyClose = (code.match(/disconnect\s*\(\s*\)/g) || []).length;
  const safeClose = (code.match(/observer\s*\.\s*disconnect\s*\(\s*\)/g) || []).length;
  check('铁律：空参 disconnect() 全部是 observer.disconnect()',
    anyClose === safeClose && safeClose > 0, `共 ${anyClose} 处，白名单 ${safeClose} 处`);
}

/* --------------------- 4. 两个文件的身份必须不同 --------------------- */
function testIdentity() {
  section('两版身份与头部');
  const field = (src, key) => src.match(new RegExp(`^// ${key}\\s+(.*)$`, 'm'))?.[1].trim();

  check('两版 @version 一致', field(release, '@version') === field(dev, '@version'),
    `${field(release, '@version')} vs ${field(dev, '@version')}`);
  check('★ 两版 @name 不同（否则油猴当成同一脚本互相覆盖）',
    field(release, '@name') !== field(dev, '@name'),
    `${field(release, '@name')} / ${field(dev, '@name')}`);
  check('★ 两版 @namespace 不同', field(release, '@namespace') !== field(dev, '@namespace'),
    `${field(release, '@namespace')} / ${field(dev, '@namespace')}`);
  check('★ 两版都不手写 @downloadURL（交给 GreasyFork 注入）', !/^\/\/ @downloadURL/m.test(release) && !/^\/\/ @downloadURL/m.test(dev));
  check('★ 两版都不手写 @updateURL', !/^\/\/ @updateURL/m.test(release) && !/^\/\/ @updateURL/m.test(dev));
  check('@name:en 存在时必须带 @description:en（GreasyFork 校验）',
    !/^\/\/ @name:en/m.test(release) || /^\/\/ @description:en\s+\S/m.test(release));

  const matchR = (release.match(/^\/\/ @match/gm) || []).length;
  check('两版 @match 条数一致', matchR === (dev.match(/^\/\/ @match/gm) || []).length, matchR);

  // 开发版确实留住了设计注释
  check('开发版保留设计史注释（S3.x.x）', /S\d\.\d/.test(dev));
  check('开发版保留踩坑复盘', /踩过|演进/.test(dev));
  check('开发版保留模块分隔标题', /^\/\* ---- \w+\.js ---- \*\/$/m.test(dev));
  check('开发版比发布版多 6 万字节以上注释',
    Buffer.byteLength(dev) - Buffer.byteLength(release) > 60000,
    (Buffer.byteLength(dev) - Buffer.byteLength(release)) + ' B');
}

/* --------------------- 5. 剥离器自身的规则 --------------------- */
function testStripper() {
  section('剥离器规则');

  check('第 1 行注释（构建说明）保留', keepComment('/* x */'));
  check('4 行块注释丢弃', !keepComment('/*\n * a\n * b\n * c\n */'));
  check('含 S3.3.0 的注释丢弃', !keepComment('/* S3.3.0 改动 */'));
  check('含「〔问题 5〕」的注释丢弃', !keepComment('/* 〔问题 5〕收起 */'));
  check('纯分隔线丢弃', !keepComment('// ----------------'));
  check('超长行注释丢弃', !keepComment('// ' + 'x'.repeat(200)));

  // 开发向注释（S3.3.1）
  check('★ 调试接口注释丢弃', !keepComment('/** 调试用：重置记忆 */'));
  check('★ 自检接口注释丢弃', !keepComment('/** 自检：面板在不在 */'));
  check('★ 验证脚本用注释丢弃', !keepComment('/** 供验证脚本单独调接口 */'));
  check('★ 模块交叉引用丢弃', !keepComment('/* 改用 pgcFresh()（见 state-reader） */'));
  check('★ 并发/限流调参说明丢弃', !keepComment('/** 并发上限（HTTP/2 多路复用） */'));
  check('★ 模块分隔标题丢弃', !keepComment('/* ---- panel.js ---- */'));
  check('★ 但关键警示即使含「并发」也保留',
    keepComment('/* 铁律：并发放大时也绝不能 disconnect 音频链 */'));

  // 正则 / 字符串不被误判成注释
  const cases = [
    ["引号内的 //", "const u = 'https://a.com/x';", "const u = 'https://a.com/x';"],
    ['模板串内的 //', 'const u = `https://a.com`;', 'const u = `https://a.com`;'],
    ['正则内的 //', 'if (/a\\/\\/b/.test(x)) y();', 'if (/a\\/\\/b/.test(x)) y();'],
    ['字符类内的 /', 'const r = /[/]+/g;', 'const r = /[/]+/g;'],
    ['真正的注释被删', 'a(); // note\nb();', 'a();\nb();'],
    ['除法不被当注释', 'const x = a / b;', 'const x = a / b;'],
    ['关键字后的正则', 'return /x/y;', 'return /x/y;'],
  ];
  for (const [name, input, want] of cases) {
    check(`剥离正确：${name}`, stripComments(input) === want, JSON.stringify(stripComments(input)));
  }
}

/* ================================================================ */

(() => {
  console.log('构建拆分与注释剥离验证\n');
  testSize();
  testStripped();
  testIntegrity();
  testIdentity();
  testStripper();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
