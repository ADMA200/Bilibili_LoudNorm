#!/usr/bin/env node
/* ================================================================
 * s3-unit.mjs — S2.1 修复的单元验证（纯 Node，零浏览器）
 *
 * 针对的事故：
 *   __INITIAL_STATE__ / __playinfo__ 都是**首屏那一份**，B 站 SPA
 *   导航后不重新注入 → 旧 cid 配新 bvid → playurl 返回 -404
 *   「啥都木有」→ 用户看到的「获取失败」。
 *
 * 这里把「页面注入的数据到底能不能采信」拆成可枚举的用例钉死，
 * 其中第 2 组是**复刻真实事故全流程**（先正常启动写入记忆，再模拟跳转）。
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ------------------------------------------------ 沙箱装载 */

const CONFIG = { preferAudioId: 30232, excludeAudioIds: [30250, 30251, 30280], viewCacheTtlMs: 600000 };
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeEnv({ href, initialState, playinfo, fetchImpl }) {
  const u = new URL(href);
  const win = { __INITIAL_STATE__: initialState, __playinfo__: playinfo };
  return {
    location: { href, pathname: u.pathname, search: u.search },
    unsafeWindow: win,
    window: win,
    CONFIG,
    Log: silentLog,
    fetch: fetchImpl || (async () => { throw new Error('未提供 fetch'); }),
  };
}

function loadModules(env) {
  const code = ['state-reader.js', 'playinfo.js'].map(f => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n');
  const names = Object.keys(env);
  const factory = new Function(...names, `${code}\nreturn { StateReader, PlayInfo };`);
  return factory(...names.map(n => env[n]));
}

/** 把页面「导航到」新地址（SPA：URL 变了，但页面注入的全局量不变） */
function spaGoto(env, href) {
  const u = new URL(href);
  env.location.href = href;
  env.location.pathname = u.pathname;
  env.location.search = u.search;
}

const URL_A = 'https://www.bilibili.com/video/BV1GJ411x7h7/';
const URL_B = 'https://www.bilibili.com/video/BV11b411L7mg/';
const KEY_A = 'v:BV1GJ411x7h7:137649199';
const KEY_B = 'v:BV11b411L7mg:86380334';

const FRESH_STATE = {
  bvid: 'BV1GJ411x7h7', aid: 80433022, cid: 137649199,
  videoData: { bvid: 'BV1GJ411x7h7', aid: 80433022, cid: 137649199, title: 'T', pages: [{ cid: 137649199, duration: 213, part: 'P1' }] },
};

const makePi = (duration, measuredI) => ({
  data: {
    dash: { duration, audio: [{ id: 30232, baseUrl: 'u', segment_base: { initialization: '0-9', index_range: '10-19' } }] },
    volume: { measured_i: measuredI, measured_tp: -1, target_i: -14 },
  },
});

const API_PAYLOAD = {
  code: 0, message: 'OK',
  data: {
    dash: { duration: 300, audio: [{ id: 30232, baseUrl: 'https://x/a.m4s', segment_base: { initialization: '0-899', index_range: '900-1400' } }] },
    volume: { measured_i: -20, measured_tp: -1, target_i: -14 },
  },
};
const apiFetch = () => Promise.resolve({ ok: true, status: 200, json: async () => API_PAYLOAD });

/* ------------------------------------------------ 1. 页面状态新鲜度 */

section('1. StateReader：__INITIAL_STATE__ 新鲜度校验');

{
  const env = makeEnv({ href: URL_A, initialState: FRESH_STATE });
  const { StateReader } = loadModules(env);
  const k = StateReader.videoKey();
  check('bvid 与 URL 一致 → stateFresh=true', k.stateFresh === true);
  check('采信页面 cid', k.cid === 137649199, String(k.cid));
  check('采信页面时长', k.duration === 213);
}

{
  // 【事故现场】URL 已换、INITIAL_STATE 还是上一个视频 → 必须拒绝
  const env = makeEnv({ href: URL_B, initialState: FRESH_STATE });
  const { StateReader } = loadModules(env);
  const k = StateReader.videoKey();
  check('bvid 与 URL 不一致 → stateFresh=false', k.stateFresh === false);
  check('★ 过期状态下的 cid 必须为 null（绝不复用旧 cid）', k.cid === null, `实际 ${k.cid}`);
  check('过期状态下时长也为 null', k.duration === null);
  check('bvid 仍取 URL 的（新视频）', k.bvid === 'BV11b411L7mg', String(k.bvid));
  check('cacheKey 退化为 p 形式，不掺旧 cid', StateReader.cacheKey(k) === 'v:BV11b411L7mg:p1', StateReader.cacheKey(k));
}

{
  // 同视频切分P：bvid 不变 → 仍算新鲜，pages[p-1] 给出对应 P 的 cid
  const multi = {
    bvid: 'BV1xx411c7mu', aid: 1, cid: 1001,
    videoData: { bvid: 'BV1xx411c7mu', aid: 1, title: 'T', pages: [{ cid: 1001, duration: 100, part: 'P1' }, { cid: 1002, duration: 200, part: 'P2' }] },
  };
  const env = makeEnv({ href: 'https://www.bilibili.com/video/BV1xx411c7mu/?p=2', initialState: multi });
  const { StateReader } = loadModules(env);
  const k = StateReader.videoKey();
  check('切分P 后 stateFresh 仍为 true', k.stateFresh === true);
  check('★ 取的是 pages[p-1].cid（不是顶层 cid）', k.cid === 1002, String(k.cid));
  check('对应 P 的时长', k.duration === 200);
  check('缓存 key 含新 P 的 cid', StateReader.cacheKey(k) === 'v:BV1xx411c7mu:1002', StateReader.cacheKey(k));
}

{
  // 没有 __INITIAL_STATE__（/list/* 一类页型，bvid 只能从 query 取）
  const env = makeEnv({ href: 'https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7&oid=80433022', initialState: null });
  const { StateReader } = loadModules(env);
  const k = StateReader.videoKey();
  check('无 __INITIAL_STATE__ → 仍能从 query 取到 bvid', k && k.bvid === 'BV1GJ411x7h7', String(k && k.bvid));
  check('无 __INITIAL_STATE__ → stateFresh=false', k.stateFresh === false);
  check('cid 为 null（交给接口补）', k.cid === null);
}

{
  // 只有 aid、没有 bvid 的 INITIAL_STATE → 无法交叉校验，按不可信处理
  const env = makeEnv({
    href: 'https://www.bilibili.com/video/BV1AAA411c7mu/',
    initialState: { aid: 123, cid: 9999, videoData: { aid: 123, cid: 9999, pages: [{ cid: 9999, duration: 10 }] } },
  });
  const { StateReader } = loadModules(env);
  const k = StateReader.videoKey();
  check('★ 只有 aid 无法比对 → 保守判为不可信', k.stateFresh === false && k.cid === null);
}

/* ------------------------------------------------ 2. __playinfo__ 可信度 */

section('2. PlayInfo：__playinfo__ 可信度判定（含事故全流程复刻）');

{
  // ① 页面新鲜 → 采信（FastPath 可用）
  const env = makeEnv({ href: URL_A, initialState: FRESH_STATE, playinfo: makePi(213, -13.5), fetchImpl: apiFetch });
  const { PlayInfo } = loadModules(env);
  const t = PlayInfo.trustPlayinfo(PlayInfo.fromPage(), { bvid: 'BV1GJ411x7h7' }, KEY_A, { duration: 213 });
  check('页面新鲜 → 采信（ssr-fresh）', t.ok === true && t.why === 'ssr-fresh', JSON.stringify(t));
}

{
  // ② 【事故全流程】先从 A 正常启动（写入「已采信」记忆），再 SPA 跳到 B
  const env = makeEnv({ href: URL_A, initialState: FRESH_STATE, playinfo: makePi(213, -13.5), fetchImpl: apiFetch });
  const { PlayInfo } = loadModules(env);

  const first = await PlayInfo.get({ bvid: 'BV1GJ411x7h7', cid: 137649199 }, { duration: 213 }, KEY_A);
  check('起点：A 页正常启动 → 采信页面 playinfo', first.why === 'ssr-fresh', first.why);

  // SPA 跳转：URL 换、INITIAL_STATE 不换、__playinfo__ 也不换
  spaGoto(env, URL_B);
  const videoEl = { duration: 212.2 };   // 与旧 playinfo 的 213s 只差 0.8s
  const t = PlayInfo.trustPlayinfo(PlayInfo.fromPage(), { bvid: 'BV11b411L7mg' }, KEY_B, videoEl);
  check('★ 过期状态 + 同一份 playinfo + 时长只差 0.8s → 仍判不可信', t.ok === false, JSON.stringify(t));

  const got = await PlayInfo.get({ bvid: 'BV11b411L7mg', cid: 86380334 }, videoEl, KEY_B);
  check('★ 于是回落接口，不再把上一个视频的元数据当新视频用', got.why === 'api', got.why);
  check('staleIgnored 标记为 true（供 HUD/诊断追溯）', got.staleIgnored === true);
  check('接口结果被采用', got.info && got.info.audio && got.info.audio.url === 'https://x/a.m4s');
}

{
  // ③ 没有「已采信」基准（脚本刚起来就切视频的竞态）→ 保守拒绝
  const env = makeEnv({ href: URL_B, initialState: FRESH_STATE, playinfo: makePi(213, -13.5), fetchImpl: apiFetch });
  const { PlayInfo } = loadModules(env);
  const t = PlayInfo.trustPlayinfo(PlayInfo.fromPage(), { bvid: 'BV11b411L7mg' }, KEY_B, { duration: 212.2 });
  check('★ 无基准时不认定为「换过对象」→ 保守拒绝', t.ok === false, JSON.stringify(t));
}

{
  // ④ playinfo 真被换过（新对象）+ 时长吻合 → 采信，仍能吃 FastPath 红利
  const env = makeEnv({ href: URL_A, initialState: FRESH_STATE, playinfo: makePi(213, -13.5), fetchImpl: apiFetch });
  const { PlayInfo } = loadModules(env);
  await PlayInfo.get({ bvid: 'BV1GJ411x7h7', cid: 137649199 }, { duration: 213 }, KEY_A);

  spaGoto(env, URL_B);
  env.unsafeWindow.__playinfo__ = makePi(400, -17);
  const t = PlayInfo.trustPlayinfo(PlayInfo.fromPage(), { bvid: 'BV11b411L7mg' }, KEY_B, { duration: 400 });
  check('★ playinfo 换过对象 + 时长吻合 → 采信（replaced+duration-match）',
    t.ok === true && t.why === 'replaced+duration-match', JSON.stringify(t));
}

{
  // ⑤ 同一个对象 + 同 key → 复用；同对象 + 换 key（切分P 未刷新）→ 拒绝
  const env = makeEnv({ href: URL_A, initialState: FRESH_STATE, playinfo: makePi(213, -13.5), fetchImpl: apiFetch });
  const { PlayInfo } = loadModules(env);
  await PlayInfo.get({ bvid: 'BV1GJ411x7h7', cid: 137649199 }, { duration: 213 }, KEY_A);

  const same = PlayInfo.trustPlayinfo(PlayInfo.fromPage(), { bvid: 'BV1GJ411x7h7' }, KEY_A, { duration: 213 });
  check('同对象同 key 二次判定 → 复用（reuse-accepted）', same.why === 'reuse-accepted', JSON.stringify(same));

  const other = PlayInfo.trustPlayinfo(PlayInfo.fromPage(), { bvid: 'BV1GJ411x7h7' }, 'v:BV1GJ411x7h7:999', { duration: 213 });
  check('★ 同一份 playinfo 换了目标（切分P 未刷新）→ 拒绝', other.ok === false, JSON.stringify(other));
}

/* ------------------------------------------------ 3. view 接口补全 */

section('3. PlayInfo.resolveVideo：接口补全 cid / 时长');

{
  // 复刻实测数据：多分P 视频 data.duration 是「总时长」，pages[p-1].duration 才是本P
  const REAL = {
    code: 0, message: 'OK',
    data: {
      aid: 566445, title: '多分P 测试', duration: 1266,   // ← 总时长（陷阱）
      cid: 86380334,
      pages: [
        { cid: 86380334, duration: 182, part: 'P1' },
        { cid: 86380335, duration: 300, part: 'P2' },
      ],
    },
  };
  let calls = 0;
  const env = makeEnv({
    href: URL_B, initialState: null,
    fetchImpl: () => { calls++; return Promise.resolve({ ok: true, status: 200, json: async () => REAL }); },
  });
  const { PlayInfo } = loadModules(env);

  const p1 = await PlayInfo.resolveVideo({ bvid: 'BV11b411L7mg', p: 1 });
  check('p=1 → cid 正确', p1.cid === 86380334, String(p1.cid));
  check('★ 时长取 pages[0].duration=182，而不是 data.duration=1266（多分P 总时长陷阱）',
    p1.duration === 182, String(p1.duration));
  check('带上了标题与页数', p1.title === 'P1' && p1.pageCount === 2);

  const p2 = await PlayInfo.resolveVideo({ bvid: 'BV11b411L7mg', p: 2 });
  check('p=2 → 取到第 2 个 cid', p2.cid === 86380335, String(p2.cid));
  check('★ 同一 bvid 切分P 只请求一次 view（内存缓存生效）', calls === 1, `实际 ${calls} 次`);
}

/* ------------------------------------------------ */

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
