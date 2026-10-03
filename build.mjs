#!/usr/bin/env node
/* ================================================================
 * build.mjs — 把 src/ 拼成单文件 userscript
 *
 *   node build.mjs
 *
 * 做四件事：
 *   1. 按依赖顺序内联 src/*.js 到一个 IIFE
 *   2. 前置 UserScript header（版本号从 config.js 提取，单一来源）
 *   3. 【铁律守卫】扫描产物，确认没有出现任何干预播放器的调用
 *   4. 语法自检（node --check），确保剥离注释没弄坏代码
 *
 * 产出**两个文件**：
 *   Bilibili_LoudNorm.user.js      发布版 —— 只保留「说明代码功能」的短注释，
 *                                  上传 GitHub / GreasyFork 用，体积约 150 KB
 *   Bilibili_LoudNorm.dev.user.js  开发版 —— 源码注释一字不动，约 215 KB，
 *                                  仅供本地阅读 / 调试安装，不进仓库（见 .gitignore）
 *
 *   两者 @name / @namespace 不同 —— 油猴按「名字 + 命名空间」认脚本，
 *   因此可以同时安装，互不覆盖、互不更新。
 *
 * 注释怎么剥、保留哪些：见 strip-comments.mjs
 * ================================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripComments, keepComment } from './strip-comments.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUTPUT_RELEASE = join(ROOT, 'Bilibili_LoudNorm.user.js');
const OUTPUT_DEV = join(ROOT, 'Bilibili_LoudNorm.dev.user.js');

/** 内联顺序即依赖顺序：后写的模块可以用前面模块的顶层 const */
const MODULES = [
  'config.js',
  'logger.js',
  'store.js',
  'sidx.js',
  'loudness.js',
  'gain-planner.js',
  'state-reader.js',
  'playinfo.js',
  'sampler.js',
  'audio-engine.js',
  'hud.js',
  'panel.js',
  'analyzer.js',
  'lifecycle.js',
  'main.js',
];

/** 以下调用会干预播放器（卡暂停 / 永久静音），本方案明确禁用 */
const FORBIDDEN = [
  { re: /\.pause\s*\(/,                     why: '调用 video.pause() 会干预播放' },
  { re: /preventDefault\s*\(/,              why: 'preventDefault 会拦截播放事件' },
  { re: /window\.alert\s*\(|(?<![.\w])alert\s*\(/, why: 'alert 会冻结页面' },
  { re: /\.disconnect\s*\(\s*\)/,           why: '无参 disconnect() 会断掉整条链（含 MediaElementSource）' },
];

/** 合法用法白名单 —— 这些不是音频链路上的断连，守卫应放行 */
const SAFE_CALLS = [
  /observer\s*\.\s*disconnect\s*\(\s*\)/g,        // MutationObserver 停止观察
  /masterGain\s*\.\s*disconnect\s*\(\s*analyser\s*\)/g, // 拆掉临时抽头，主链仍在
];

const EN_DESC = 'Normalizes the loudness of a whole video with a single gain, so consecutive Bilibili videos play at a consistent volume. No compression, no player interference.';

/* ---------------------------------------------------------------- */

function readVersion() {
  const cfg = readFileSync(join(SRC, 'config.js'), 'utf8');
  const m = cfg.match(/version:\s*'([^']+)'/);
  if (!m) throw new Error('无法从 config.js 提取 version');
  return m[1];
}

/**
 * 生成 UserScript header。
 * @param {'release'|'dev'} kind 发布版 / 开发版 —— 两者的 @name 与 @namespace 必须不同，
 *        否则油猴会把它们当成同一个脚本，安装会互相覆盖。
 */
function buildHeader(kind, version) {
  const dev = kind === 'dev';
  const name = dev ? 'B站响度归一 · 开发版' : 'B站响度归一';
  const nameEn = dev ? 'Bilibili_LoudNorm (dev)' : 'Bilibili_LoudNorm';
  const ns = dev
    ? 'https://github.com/ADMA200/Bilibili_LoudNorm/dev'
    : 'https://github.com/ADMA200/Bilibili_LoudNorm';
  const desc = dev
    ? '（开发版，含源码全部设计注释，仅供本地调试，请勿发布）全片响度归一：测量整段视频的响度并按需统一增益，拉齐 B 站连播音量（投稿 / 多P / 番剧影视）。不压缩原声、不干预播放器。'
    : '全片响度归一：测量整段视频的响度并按需统一增益，拉齐 B 站连播音量（投稿 / 多P / 番剧影视）。不压缩原声、不干预播放器。';
  const descEn = dev
    ? '(dev build, keeps every source comment, local debugging only) ' + EN_DESC
    : EN_DESC;

  // ⚠️ @downloadURL / @updateURL 一律不写 —— GreasyFork 托管后会自动注入，
  //    手写会让开发版被正式版覆盖更新。
  return `// ==UserScript==
// @name         ${name}
// @name:en      ${nameEn}
// @namespace    ${ns}
// @version      ${version}
// @description  ${desc}
// @description:en ${descEn}
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

${dev
  ? `/*
 * 构建产物 —— 请勿直接编辑：改动请改 src/ 后运行 node build.mjs（${MODULES.length} 个模块）
 * 本文件是**开发版**：源码注释全部保留 + 模块分隔标题，仅本地调试安装用。
 */`
  : `/*
 * B站响度归一 —— 源码与设计文档：https://github.com/ADMA200/Bilibili_LoudNorm
 */`}
`;
}

/** 去掉注释，避免注释里提到的禁用词被误判 */
function stripAll(code) {
  return stripComments(code);
}

function guard(finalCode) {
  // 先把合法调用屏蔽掉，避免误报（替换等长，不影响行号）
  let body = stripAll(finalCode);
  for (const safe of SAFE_CALLS) {
    body = body.replace(safe, m => '/*'.padEnd(m.length - 2, 'x') + '*/');
  }

  const lines = body.split('\n');
  const hits = [];

  for (const { re, why } of FORBIDDEN) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 100), why });
      }
    }
  }
  return hits;
}

/** 收集内联后的源码（逐模块加分隔标题） */
function readModules() {
  const parts = [];
  for (const name of MODULES) {
    let code;
    try {
      code = readFileSync(join(SRC, name), 'utf8');
    } catch (e) {
      console.error(`✗ 读取 src/${name} 失败: ${e.message}`);
      process.exit(1);
    }
    parts.push(`/* ---- ${name} ---- */\n${code.trim()}`);
  }
  return parts.join('\n\n');
}

const wrap = (body) => `(function () {\n'use strict';\n\n${body.trim()}\n\n})();\n`;

/** 语法自检：node --check 真实解析一遍产物 */
function syntaxCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || '').trim();
}

/* ---------------------------------------------------------------- */

function main() {
  const version = readVersion();
  const raw = readModules();

  const devCode = `${buildHeader('dev', version)}\n${wrap(raw)}`;
  const releaseCode = `${buildHeader('release', version)}\n${wrap(stripComments(raw, keepComment))}`;

  writeFileSync(OUTPUT_DEV, devCode, 'utf8');
  writeFileSync(OUTPUT_RELEASE, releaseCode, 'utf8');

  const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1);
  const save = (1 - Buffer.byteLength(releaseCode) / Buffer.byteLength(devCode)) * 100;

  console.log(`✓ 构建完成  v${version}  ${MODULES.length} 个模块`);
  console.log(`  发布版  ${kb(releaseCode).padStart(6)} KB  ${OUTPUT_RELEASE}`);
  console.log(`  开发版  ${kb(devCode).padStart(6)} KB  ${OUTPUT_DEV}  （注释精简掉 ${save.toFixed(0)}%）`);

  // 语法自检 —— 剥离注释若弄坏代码，这里立刻暴露
  for (const f of [OUTPUT_RELEASE, OUTPUT_DEV]) {
    const err = syntaxCheck(f);
    if (err) {
      console.error(`\n✗ 语法自检失败: ${f}\n${err}`);
      process.exit(1);
    }
  }
  console.log('✓ 语法自检通过（node --check ×2）');

  const violations = guard(releaseCode);
  if (violations.length > 0) {
    console.error(`\n✗ 铁律守卫失败 —— 发现 ${violations.length} 处禁用调用：`);
    for (const v of violations) {
      console.error(`  行 ${v.line}: ${v.text}`);
      console.error(`    ^ ${v.why}`);
    }
    process.exit(1);
  }
  console.log('✓ 铁律守卫通过 · 无 pause / preventDefault / alert / 空参 disconnect');
}

main();
