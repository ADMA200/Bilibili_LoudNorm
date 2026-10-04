#!/usr/bin/env node
/* ================================================================
 * build-strip-unit.mjs — 构建拆分（发布版 / 开发版）与注释剥离的单元验证
 *
 * build.mjs 产出两个文件：
 *   Bilibili_LoudNorm.user.js       发布版（上传用，**零注释**）
 *   Bilibili_LoudNorm.dev.user.js   开发版（本地调试，注释全留）
 *
 * 这里要钉死的两件事：
 *   ① **「剥注释只动了注释，没动代码」** —— 这是整个拆分的前提。
 *      剥离是逐字符扫描实现的（见 strip-comments.mjs），一旦判断错
 *      「`/` 是除号还是正则开头」，就会把**一整行真实代码**当成注释删掉，
 *      而语法还可能是合法的 —— 靠人眼看产物发现不了。
 *      断言分三层：骨架比对 + 含正则代码行定点比对 + `node --check`。
 *   ② **「交付产物一个注释都不许有」**（S3.3.4 起的约定）——
 *      同时**元数据块必须完好**：那是可上传性的命根子（GreasyFork 靠它校验），
 *      剥注释剥到它就等于把脚本废了，所以两边都要钉。
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripComments, literals, comments, codeSkeleton } from '../strip-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const REL = 'Bilibili_LoudNorm.user.js';
const DEV = 'Bilibili_LoudNorm.dev.user.js';

const MODULES = ['config.js', 'logger.js', 'store.js', 'sidx.js', 'loudness.js',
  'gain-planner.js', 'state-reader.js', 'playinfo.js', 'sampler.js',
  'audio-engine.js', 'hud.js', 'panel.js', 'analyzer.js', 'lifecycle.js', 'main.js'];

/** 发布版的 UserScript 元数据块 —— 不是注释，剥了脚本就废了 */
const META_KEYS = ['@name', '@name:en', '@namespace', '@version', '@description',
  '@author', '@license', '@homepageURL', '@match', '@grant', '@run-at', '@noframes'];

/**
 * 这些字眼不该进交付产物。
 * ⚠️ 不列 `__biliLoudness`（那是**功能**：挂到 window 的控制台接口，
 *    S3.3.0 删掉油猴菜单入口时刻意保留的能力）也不列 `S3.x.x`
 *    （`CONFIG.stage` 是 HUD 上要给用户看的字段）—— 两者另有正向断言单独钉。
 */
const DEV_LEAK = [
  ['内部问题编号 〔〕', /〔/],
  ['构建说明', /构建产物|请勿直接编辑|node build\.mjs/],
  ['个人署名 moxia（小写）', /moxia/],
  ['模块分隔标题', /---- \w+\.js ----/],
  ['注释腔调（调试用 / 自检 / 供验证脚本）', /调试用|自检接口|供验证脚本/],
];

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

/** 代码体起点：`(function () {` 之前是元数据区，之后是唯一该被剥的地方 */
const codeStart = release.indexOf('(function () {');
const head = codeStart > 0 ? release.slice(0, codeStart) : '';
const body = codeStart > 0 ? release.slice(codeStart) : '';

/* --------------------------- 1. 体积 --------------------------- */
function testSize() {
  section('体积');
  check('发布版存在且非空', release.length > 10000, release.length);
  check('开发版存在且非空', dev.length > 10000, dev.length);
  check('★ 发布版 ≤ 150 KB', kb(release) <= 150, kb(release).toFixed(1) + ' KB');
  check('★ 发布版比开发版小 ≥ 20%',
    kb(release) / kb(dev) <= 0.80,
    (kb(release) / kb(dev) * 100).toFixed(1) + '%');
  check('发布版总行数 ≤ 4600', release.split('\n').length <= 4600, release.split('\n').length);
  // 体积红利：注释全剥后应比「只留功能注释」的时代再瘦一截（旧值 149 KB）
  check('★ 零注释红利：发布版 < 140 KB（较保留功能注释时代再瘦 ~15 KB）',
    kb(release) < 140, kb(release).toFixed(1) + ' KB');
}

/* ------------------- 2. 零注释策略（S3.3.4） ------------------- */
function testNoComments() {
  section('零注释策略');
  check('发布版有代码体起点 `(function () {`', codeStart > 0, codeStart);
  if (codeStart <= 0) return;

  /* ---- ① 代码体：一个注释都不许有 ---- */
  const bodyComments = comments(body);
  check('★ 发布版**代码体零注释**', bodyComments.length === 0,
    bodyComments.slice(0, 3).map(t => t.slice(0, 60)).join(' | '));
  // 交叉验证：换一把「不借扫描器」的尺子。只查代码体 ——
  // 元数据区的 `@match …/video/*` 里天然含 `/*`，不能混进来。
  check('★ 交叉验证：代码体内不含 `/*` 且无行首 `//`',
    !body.includes('/*') && !/^\s*\/\//m.test(body),
    (body.match(/^.*(\/\*|\s\/\/).*$/m) || [''])[0].slice(0, 80));
  check('★ 发布版不含源码功能注释（如 `/** 总开关 */`）',
    !release.includes('/** 总开关 */') && !release.includes('// 分析完成前保持原声'));
  check('★ 发布版不含模块分隔标题（开发向，已清）',
    MODULES.every(m => !release.includes(`/* ---- ${m} ---- */`)));

  /* ---- ② 元数据块：一个字段都不许少（可上传性） ---- */
  const headLines = head.split('\n').filter(l => l.trim());
  const stray = headLines.filter(l => !/^\/\/ (@|==)/.test(l.trim()));
  check('★ 元数据区只有 `// @…` 与 `// ==…==`（没有夹带说明性注释）',
    stray.length === 0, stray[0]?.slice(0, 80));
  for (const key of META_KEYS) {
    check(`元数据 ${key} 存在`, new RegExp(`^// ${key}\\b`, 'm').test(head));
  }
  check('★ 元数据块闭合（==UserScript== / ==/UserScript== 各一个）',
    (head.match(/^\/\/ ==UserScript==$/m) || []).length === 1 &&
    (head.match(/^\/\/ ==\/UserScript==$/m) || []).length === 1);
  check('★ 元数据区之后紧接代码体（无文件头说明块）',
    /\/\/ ==\/UserScript==\n\n\(function \(\) \{/.test(release.slice(0, 1300)),
    JSON.stringify(release.slice(head.length - 30, head.length + 20)));

  /* ---- ③ 开发向内容整体不得进产物（注释没了，字符串里也不许有） ---- */
  for (const [name, re] of DEV_LEAK) {
    const hit = release.split('\n').filter(l => re.test(l));
    check(`★ 发布版（全文件）无「${name}」`, hit.length === 0, hit[0]?.trim().slice(0, 80));
  }

  // 阶段标记只许有一处：CONFIG.stage（HUD 要显示它）。
  // 其余 S3.x.x 演进标记都是注释腔调，应随注释一起消失。
  const stageLines = release.split('\n').filter(l => /S\d\.\d/.test(l));
  check('★ 发布版仅 CONFIG.stage 一处 S3.x.x 标记（其余演进标记已随注释剥净）',
    stageLines.length === 1 && /^\s*stage:/.test(stageLines[0]), stageLines.join(' | '));

  // 反向护栏：别把「功能」当注释一起清掉了
  check('★ 交付产物保留控制台接口 __biliLoudness（S3.3.0 决定：菜单入口删掉，能力留控制台）',
    /__biliLoudness\s*=\s*\{/.test(release));
  check('★ 交付产物保留铁律相关的运行时判断（observer.disconnect 白名单那一处）',
    /observer\s*\.\s*disconnect\s*\(\s*\)/.test(release));

  /* ---- ④ 对照组：开发版必须留着注释，证明剥的是注释不是代码 ---- */
  const devComments = comments(dev.slice(dev.indexOf('(function () {')));
  check('★ 对照组：开发版代码体注释 > 300 条', devComments.length > 300, devComments.length);
  check('★ 对照组：开发版保留设计史（S3.x.x）', /S\d\.\d/.test(dev));
  check('★ 对照组：开发版保留踩坑复盘与模块分隔标题',
    /踩过|演进/.test(dev) && /^\/\* ---- \w+\.js ---- \*\/$/m.test(dev));
  check('★ 开发版比发布版多 8 万字节以上注释',
    Buffer.byteLength(dev) - Buffer.byteLength(release) > 80000,
    (Buffer.byteLength(dev) - Buffer.byteLength(release)) + ' B');

  // 剥离后仍要留下实质代码（防止整段被吃掉）
  const codeLines = body.split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('//'));
  check('★ 发布版代码行 ≥ 3400 行', codeLines.length >= 3400, codeLines.length);
}

/* --------------------- 3. 代码完整性（核心） --------------------- */
function testIntegrity() {
  section('代码完整性');

  // ① 骨架比对：注释全剥后，两版必须逐字一致
  const sDev = codeSkeleton(dev), sRel = codeSkeleton(release);
  check('★ 两版「去掉全部注释 + 折叠空白」后逐字一致', sDev === sRel,
    sDev === sRel ? sDev.length : `${sDev.length} vs ${sRel.length}`);

  // ② 字面量多重集一致（字符串 / 模板串没被吃掉）
  const norm = (s) => literals(s).sort().join('\u0000');
  check('★ 两版字符串字面量多重集一致', norm(sDev) === norm(sRel));

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

  // ③b 零注释后，src 里**全部**代码行都该原样出现在产物里（以前只能抽查正则行）。
  //     先整文件剥注释再逐行比 —— 逐行剥会破坏跨行上下文（模板串、块注释）。
  //     这条能抓到骨架比对抓不到的事：MODULES 列表若漏了某个 src 文件，
  //     两版都由同一份列表生成、骨架当然一致，只有这里会发现「src 的行没进产物」。
  const allLost = [];
  let allTotal = 0;
  for (const m of MODULES) {
    for (const line of stripComments(read('src/' + m)).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      allTotal++;
      if (!release.includes(t)) allLost.push(`${m}: ${t.slice(0, 70)}`);
    }
  }
  check(`★ src 中全部 ${allTotal} 代码行逐行出现在发布版（零注释让这条可以全量查了）`,
    allLost.length === 0,
    `${allLost.length} 行缺失，例：${allLost.slice(0, 3).join(' | ')}`);

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

  // 边界必须写在用户看得见的地方：装脚本时先看 @description，不是 README
  // —— 零注释后这一点更关键：文件头注释没了，@description 成了唯一门面
  check('★ 两版 @description 都写明「不含课程与直播」',
    /不含课程与直播/.test(field(release, '@description') || '') &&
    /不含课程与直播/.test(field(dev, '@description') || ''),
    `rel…${(field(release, '@description') || '').slice(-12)} / dev…${(field(dev, '@description') || '').slice(-12)}`);
  check('★ 两版 @description:en 都写明不支持直播',
    /live streams are not supported/.test(field(release, '@description:en') || '') &&
    /live streams are not supported/.test(field(dev, '@description:en') || ''));
  check('★ 发布版 @description 长度 < 200 字符（零注释后 @description 是唯一门面，不能还塞成说明文档）',
    (field(release, '@description') || '').length < 200,
    (field(release, '@description') || '').length);

  const matchR = (release.match(/^\/\/ @match/gm) || []).length;
  check('两版 @match 条数一致', matchR === (dev.match(/^\/\/ @match/gm) || []).length, matchR);
}

/* --------------------- 5. 剥离器自身的规则 --------------------- */
function testStripper() {
  section('剥离器规则');

  // 上下文判定是剥离器的命门：判错 `/` 就会把一整行真代码当注释删掉
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

  // 默认全剥（发布版走的就是这条路）
  check('默认全剥：块注释不留痕',
    stripComments('/** 功能说明 */\nconst a = 1;').trim() === 'const a = 1;',
    JSON.stringify(stripComments('/** 功能说明 */\nconst a = 1;')));
  check('默认全剥：多行块注释不留痕',
    stripComments('/*\n * a\n * b\n */\nconst x = 1;').trim() === 'const x = 1;');
  check('默认全剥：行注释不留痕',
    stripComments('const a = 1; // 说明\nconst b = 2;').trim() === 'const a = 1;\nconst b = 2;');
  check('★ 默认全剥：模板串内的 CSS 块注释也剥',
    (() => {
      const out = stripComments('const css = `\n/* 设计史 */\n.a { color: red }\n`;');
      return !out.includes('设计史') && out.includes('.a { color: red }');
    })());
  check('★ 但模板串里的 `//` 不能剥（`https://` 会中招）',
    stripComments('const u = `https://a.com/x`;').includes('https://a.com/x'));

  // keep 回调仍是一条通用开口（当前无人使用）
  check('keep 回调可保留指定注释（通用开口）',
    stripComments('/*keep*/\nx();', t => t.includes('keep')).includes('/*keep*/'));
  check('keep 缺省 = 全剥', !stripComments('/*keep*/\nx();').includes('keep'));

  // comments() 必须与剥离器同一套扫描逻辑
  const sample = '/* a */\nconst x = 1; // b\nconst r = /\\/\\//;\nconst u = "https://x";';
  const got = comments(sample);
  check('comments() 收集 2 条注释、不把正则/字符串当注释', got.length === 2,
    got.map(t => t.slice(0, 20)).join(' | '));
  check('comments() 在剥干净的代码上收集到 0 条', comments(stripComments(sample)).length === 0);
  check('codeSkeleton() 与剥离器同源（骨架比对用的就是它）',
    codeSkeleton('/* c */\nconst a = 1;') === 'const a = 1;');
}

/* ================================================================ */

(() => {
  console.log('构建拆分与注释剥离验证\n');
  testSize();
  testNoComments();
  testIntegrity();
  testIdentity();
  testStripper();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
