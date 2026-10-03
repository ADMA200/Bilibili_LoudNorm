#!/usr/bin/env node
/* ================================================================
 * build.mjs — 把 src/ 拼成单文件 userscript
 *
 *   node build.mjs
 *
 * 做三件事：
 *   1. 按依赖顺序内联 src/*.js 到一个 IIFE
 *   2. 前置 UserScript header（版本号从 config.js 提取，单一来源）
 *   3. 【铁律守卫】扫描产物，确认没有出现任何干预播放器的调用
 * ================================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUTPUT = join(ROOT, 'Bilibili_LoudNorm.user.js');

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

/* ---------------------------------------------------------------- */

function readVersion() {
  const cfg = readFileSync(join(SRC, 'config.js'), 'utf8');
  const m = cfg.match(/version:\s*'([^']+)'/);
  if (!m) throw new Error('无法从 config.js 提取 version');
  return m[1];
}

function buildHeader(version) {
  return `// ==UserScript==
// @name         B站响度归一
// @name:en      Bilibili_LoudNorm
// @namespace    https://github.com/ADMA200/Bilibili_LoudNorm
// @version      ${version}
// @description  全片响度归一：测量整段视频的响度并按需统一增益，拉齐 B 站连播音量（投稿 / 多P / 番剧影视）。不压缩原声、不干预播放器。
// @description:en Normalizes the loudness of a whole video with a single gain, so consecutive Bilibili videos play at a consistent volume. No compression, no player interference.
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

/*
 * 构建产物 —— 请勿直接编辑，改动请改 src/ 后重新运行 node build.mjs
 * 构建模块：${MODULES.join(', ')}
 */
`;
}

/** 去掉注释，避免注释里提到的禁用词被误判 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function guard(finalCode) {
  // 先把合法调用屏蔽掉，避免误报（替换等长，不影响行号）
  let body = stripComments(finalCode);
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

/* ---------------------------------------------------------------- */

function main() {
  const version = readVersion();
  const parts = [];

  for (const name of MODULES) {
    let code;
    try {
      code = readFileSync(join(SRC, name), 'utf8');
    } catch (e) {
      console.error(`✗ 读取 src/${name} 失败: ${e.message}`);
      process.exit(1);
    }
    parts.push(`/* ============================== ${name} ============================== */\n${code.trim()}`);
  }

  const header = buildHeader(version);
  const body = `(function () {\n'use strict';\n\n${parts.join('\n\n')}\n\n})();\n`;
  const finalCode = `${header}\n${body}`;

  const violations = guard(finalCode);

  writeFileSync(OUTPUT, finalCode, 'utf8');

  const kb = (Buffer.byteLength(finalCode, 'utf8') / 1024).toFixed(1);
  console.log(`✓ 构建完成  v${version}  ${kb} KB  ${MODULES.length} 个模块`);
  console.log(`  输出: ${OUTPUT}`);

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
