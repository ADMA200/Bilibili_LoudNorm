#!/usr/bin/env node
/* ================================================================
 * s3-enable-unit.mjs — 「总开关」与「增益落位」的单元验证（纯 Node，零浏览器）
 *
 * 为什么单开一个套件：
 *   总开关这类东西**坏了不报错**。开关关着、增益却照样写进音频图；
 *   开关打开、音量却不回来 —— 界面上只看得到「开关是开的」，
 *   没人能从产物或日志里发现。这三处缺陷就是这么活到 S3.3.1 的。
 *
 * 用的是**真实的 src/analyzer.js**，跑在零依赖的桩环境里
 * （FastPath 全程零解码，所以不需要 OfflineAudioContext / 真音频）。
 *
 * 六组行为断言 + 一组静态不变量：
 *   A. 同一视频复访 → 必须重新落位（旧代码里那段是死代码）
 *   B. setEnabled(true) → 立刻恢复归一，不等切视频
 *   C. 分析途中关掉开关（FastPath）→ 增益绝不落位
 *   C2. 分析途中关掉开关（抽样路径：下载与响度两处挂闸）→ 同样不许落位
 *   D. reapply 受总开关管
 *   D2. 停用状态下 reanalyze → 不得先拆后跑、白丢本视频缓存
 *   E. 静态：落位出口唯一、每个 land 都接住返回值、aborted 无遗漏
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../strip-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/* ================================================================
 * 桩环境 —— 把真实的 analyzer.js 丢进来跑
 * ================================================================ */

/** 默认 playinfo：带 B 站官方响度元数据 → 走 FastPath，零下载零解码 */
function defaultPi() {
  return { duration: 213, volumeMeta: { measuredI: -20, measuredTp: -1, targetI: -14 } };
}

/** 抽样路径用的 playinfo：只有 dash 音频轨，没有官方元数据 → 必须走 SamplePath */
function samplePi() {
  return { duration: 213, audio: { id: 30280, mimeType: 'audio/mp4', bandwidth: 128000 } };
}

function load(opts = {}) {
  const calls = { gain: [], hud: 0, lastSnap: null };
  const logs = { debug: [], info: [], warn: [] };
  const str = (...a) => a.map(x => String(x)).join(' ');

  const Log = {
    debug: (...a) => logs.debug.push(str(...a)),
    info: (...a) => logs.info.push(str(...a)),
    warn: (...a) => logs.warn.push(str(...a)),
    error: (...a) => logs.warn.push(str(...a)),
    isDebug: () => false,
  };

  const CONFIG = {
    enabled: opts.enabled !== false,
    progressive: true,
    firstBatchSegments: 6,
    firstBatchEagerAt: 4,
    minSegmentsToProceed: 3,
    decodeConcurrency: 2,
    refineMinDeltaDb: 0.5,
    streamWaitToleranceSec: 3,
    streamWaitGraceSec: 20,
    streamWaitRetryMs: 700,
    pgcStreamWaitMs: 8000,
    forceSamplePath: !!opts.samplePath,
    profile: 'standard',
  };

  let appliedGainDb = 0;
  const AudioEngine = {
    setGainDb(db) { calls.gain.push(db); appliedGainDb = db; return true; },
    getGainValue() { return Math.pow(10, appliedGainDb / 20); },
    getContextState() { return 'running'; },
    isBypass() { return false; },
    getDesiredGainDb() { return appliedGainDb; },
    getAppliedGainDb() { return appliedGainDb; },
  };

  const Hud = { update(s) { calls.hud++; calls.lastSnap = s; }, toast() { /* 忽略 */ } };

  const store = new Map();
  const Store = {
    get(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    set(k, v) { store.set(k, JSON.stringify(v)); },
    remove(k) { store.delete(k); },
    clear() { store.clear(); },
    stats() { return { entries: store.size }; },
  };

  /** 增益 = 目标(−14) − 实测：实测 −20LUFS → +6dB，与文档一致 */
  const GainPlanner = {
    currentProfile() { return { label: '标准', targetLufs: -14, maxBoostDb: 12, minGainDb: -60 }; },
    plan({ measuredLufs }) {
      return { targetLufs: -14, gainDb: +(-14 - measuredLufs).toFixed(2), limited: false, limitReason: null };
    },
  };

  const target = Object.assign({
    kind: 'video', bvid: 'BV1TEST', cid: 111, epId: null,
    stateFresh: true, duration: 213,
  }, opts.target);
  const key = opts.key || 'BV1TEST-p1';

  const StateReader = {
    target: () => (opts.noTarget ? null : target),
    cacheKey: () => key,
  };

  /* PlayInfo.get 可手动挂闸（用来把「分析途中」这个瞬间卡住） */
  const pi = { gate: null, forgets: 0 };
  const PlayInfo = {
    async get() {
      if (pi.gate) await pi.gate;
      return { info: opts.pi || (opts.samplePath ? samplePi() : defaultPi()) };
    },
    forget() { pi.forgets++; },
    async resolveVideo() { return {}; },
  };

  /* ---- 抽样路径（SamplePath）的桩 ----------------------------------------
   * 默认（FastPath）模式下这三个模块一律 boom —— 一旦流程意外走到抽样就直接炸，
   * 免得「以为在测 FastPath，其实走了别的路」。
   * opts.samplePath 时才换成能真跑的实现，而且**可挂闸**：
   * 把下载返回、精修第二批、响度测量三处各自的 await 卡住，
   * 用来复现「分析途中关掉开关」这个瞬间。 */
  const gates = { download: null, refine: null, measure: null };
  const dl = { calls: 0 };

  const SEG_COUNT = 12;
  const segRefs = Array.from({ length: SEG_COUNT }, (_, i) => ({ index: i }));
  const makeBatch = (picks) => ({
    segs: picks.map(i => ({ index: i, buf: new ArrayBuffer(16), duration: 5, bytes: 16 })),
    ok: picks.length, bytes: picks.length * 16, seconds: picks.length * 5,
    requested: picks.length, requestedSeconds: picks.length * 5,
    slowestMs: 1, medianMs: 1, dropped: 0,
  });

  const boom = (what) => () => { throw new Error(`不该走到 ${what}（本套件只跑 FastPath）`); };

  let Sampler, Sidx, Loudness;
  if (opts.samplePath) {
    Sampler = {
      async prepare() {
        return {
          refs: segRefs, picks: segRefs.map(r => r.index), anchor: 0,
          initBuf: new ArrayBuffer(16), initMs: 1, indexMs: 2, prepMs: 3,
        };
      },
      download(refs, audio, stage, o) {
        dl.calls++;
        const picks = refs.map(r => r.index);
        if (typeof o.onProgress === 'function') o.onProgress(picks.length, picks.length, 0);
        const batch = makeBatch(picks);
        /* 第 1 批（coarse）挂 gates.download；第 2 批（精修）挂 gates.refine */
        const gate = dl.calls === 1 ? gates.download : (dl.calls === 2 ? gates.refine : null);
        if (gate) return { early: gate.then(() => batch), all: gate.then(() => batch) };
        return { early: Promise.resolve(batch), all: Promise.resolve(batch) };
      },
      fragmentBlob() { return { arrayBuffer: async () => new ArrayBuffer(16) }; },
    };
    Sidx = {
      pickCoarse: (picks, k) => picks.slice(0, Math.max(1, Math.min(k, picks.length))),
      startsWithBox: () => true,
    };
    Loudness = {
      concatBuffers: () => ({ duration: 5, length: 240000, sampleRate: 48000, numberOfChannels: 2 }),
      measure: async () => {
        if (gates.measure) await gates.measure;
        return { lufs: -20, truePeakDb: -1, processedMs: 5 };
      },
    };
  } else {
    Sampler = { prepare: boom('Sampler.prepare'), download: boom('Sampler.download'), fragmentBlob: boom('Sampler.fragmentBlob') };
    Sidx = { pickCoarse: boom('Sidx.pickCoarse'), startsWithBox: boom('Sidx.startsWithBox') };
    Loudness = { concatBuffers: boom('Loudness.concatBuffers'), measure: boom('Loudness.measure') };
  }

  /* 抽样路径要 decodeAudioData（FastPath 用不到，所以默认不给） */
  const win = opts.samplePath
    ? {
      OfflineAudioContext: class {
        decodeAudioData() {
          return Promise.resolve({ duration: 5, length: 240000, sampleRate: 48000, numberOfChannels: 2 });
        }
        createBuffer() { return {}; }
      },
    }
    : {};

  const el = { tagName: 'VIDEO', duration: 213 };
  const Lifecycle = { currentElement: () => (opts.noVideo ? null : el) };

  const src = read('src/analyzer.js');
  const factory = new Function(
    'CONFIG', 'Log', 'Store', 'GainPlanner', 'AudioEngine', 'Hud', 'StateReader',
    'PlayInfo', 'Sampler', 'Sidx', 'Loudness', 'Lifecycle', 'window',
    `${src}\nreturn Analyzer;`,
  );
  const Analyzer = factory(CONFIG, Log, Store, GainPlanner, AudioEngine, Hud, StateReader,
    PlayInfo, Sampler, Sidx, Loudness, Lifecycle, win);

  return {
    Analyzer, CONFIG, calls, logs, Store, store, pi, el, gates, dl,
    key, lastGain: () => calls.gain[calls.gain.length - 1],
  };
}

/* ================================================================
 * A. 同一视频复访 —— 必须重新落位
 * ================================================================ */

async function testRevisit() {
  section('A. 同一视频复访（durationchange / 路由抖动 / 元素重挂）');

  const env = load();
  await env.Analyzer.maybeRun(env.el, 'loadedmetadata');

  check('A1 首次分析：先归零再落位（0 → +6dB）',
    env.calls.gain.join(',') === '0,6', env.calls.gain.join(','));
  check('A2 首次分析后状态 active / 增益 6dB',
    env.calls.lastSnap.phase === 'active' && env.calls.lastSnap.gainDb === 6,
    `${env.calls.lastSnap.phase} / ${env.calls.lastSnap.gainDb}`);
  check('A3 首次分析走了 FastPath（零下载）',
    env.logs.info.some(l => l.includes('FastPath')));

  const g0 = env.calls.gain.length;
  const h0 = env.calls.hud;
  const starts0 = env.logs.info.filter(l => l.includes('开始分析')).length;

  await env.Analyzer.maybeRun(env.el, 'durationchange');

  check('★ A4 同 key 再次触发 → 增益**重新落位**（旧代码在这里 0 次调用）',
    env.calls.gain.length > g0, `${g0} → ${env.calls.gain.length}`);
  check('★ A5 复访落位后最后写入的仍是 +6dB',
    env.lastGain() === 6, String(env.lastGain()));
  check('★ A6 复访时 HUD 也刷新了（状态跟着回来）',
    env.calls.hud > h0, `${h0} → ${env.calls.hud}`);
  check('★ A7 复访走「复用已算结果」（保住来源语义，不是含糊的 cache）',
    env.logs.debug.some(l => l.includes('复用已算结果')),
    env.logs.debug[env.logs.debug.length - 1]);
  check('A8 复访后状态仍是 active / 6dB（没有被打成 idle 或 error）',
    env.calls.lastSnap.phase === 'active' && env.calls.lastSnap.gainDb === 6,
    `${env.calls.lastSnap.phase} / ${env.calls.lastSnap.gainDb}`);
  check('A9 复访不再重复下载（没有多出一次「开始分析」）',
    env.logs.info.filter(l => l.includes('开始分析')).length === starts0,
    `${starts0} → ${env.logs.info.filter(l => l.includes('开始分析')).length}`);

  /* 空结果也不能把状态带歪：computed 没记录时退回缓存 */
  const env2 = load();
  await env2.Analyzer.maybeRun(env2.el, 'loadedmetadata');
  env2.Analyzer.snapshotReset = null;
  const g = env2.calls.gain.length;
  await env2.Analyzer.maybeRun(env2.el, 'loadedmetadata');
  check('A10 连续三次触发仍然每次都落位',
    env2.calls.gain.length > g && env2.lastGain() === 6);
}

/* ================================================================
 * B. setEnabled(true) —— 立刻恢复归一
 * ================================================================ */

async function testToggle() {
  section('B. 关掉再打开（总开关）');

  const env = load();
  await env.Analyzer.maybeRun(env.el, 'loadedmetadata');
  check('B1 基线：增益 +6dB 已落位', env.lastGain() === 6, String(env.lastGain()));

  const off = env.Analyzer.setEnabled(false);
  check('B2 关掉 → 返回 false', off === false);
  check('B3 关掉 → 增益归零', env.lastGain() === 0, String(env.lastGain()));
  check('B4 关掉 → 状态 idle', env.calls.lastSnap.phase === 'idle', env.calls.lastSnap.phase);
  check('B5 关掉 → isEnabled() = false', env.Analyzer.isEnabled() === false);

  /* 关掉状态下再触发一次生命周期事件：不该有任何增益动作 */
  const g1 = env.calls.gain.length;
  await env.Analyzer.maybeRun(env.el, 'durationchange');
  check('★ B6 停用状态下触发分析 → 一个增益都不施加',
    env.calls.gain.length === g1, `${g1} → ${env.calls.gain.length}`);
  check('★ B7 停用状态下也不会偷偷改状态', env.calls.lastSnap.phase === 'idle');

  const g2 = env.calls.gain.length;
  const h2 = env.calls.hud;
  const on = env.Analyzer.setEnabled(true);
  check('B8 打开 → 返回 true', on === true);

  await flush();   // setEnabled 内部是 fire-and-forget，等它跑完

  check('★ B9 打开后**立刻**恢复增益（不必等切视频 / durationchange）',
    env.calls.gain.length > g2 && env.lastGain() === 6,
    `${g2} → ${env.calls.gain.length}，最后 ${env.lastGain()}`);
  check('★ B10 打开后状态回到 active / 6dB',
    env.calls.lastSnap.phase === 'active' && env.calls.lastSnap.gainDb === 6,
    `${env.calls.lastSnap.phase} / ${env.calls.lastSnap.gainDb}`);
  check('★ B11 打开后 HUD 有刷新', env.calls.hud > h2, `${h2} → ${env.calls.hud}`);
  check('B12 打开后走缓存命中（零下载零解码）',
    env.logs.info.some(l => l.includes('命中缓存')));

  /* 幂等：重复打开不该反复重算 */
  const g3 = env.calls.gain.length;
  env.Analyzer.setEnabled(true);
  await flush();
  check('★ B13 重复 setEnabled(true) 幂等（无变化就不折腾）',
    env.calls.gain.length === g3, `${g3} → ${env.calls.gain.length}`);

  /* 页面上没有 video 时打开开关不该抛 */
  const env3 = load({ noVideo: true });
  let threw = null;
  try { env3.Analyzer.setEnabled(false); env3.Analyzer.setEnabled(true); await flush(); }
  catch (e) { threw = e; }
  check('B14 没有 video 元素时开关也不抛错', threw === null, threw && threw.message);
}

/* ================================================================
 * C. 分析途中关掉开关 —— 增益绝不落位
 * ================================================================ */

async function testDisableMidflight() {
  section('C. 分析途中关掉开关（缺陷 3：落位不看开关）');

  const env = load();
  let release;
  env.pi.gate = new Promise(r => { release = r; });

  const p = env.Analyzer.maybeRun(env.el, 'test');
  await flush();

  check('C1 已进入取流阶段、且此时只有「换片归零」一次调用',
    env.calls.lastSnap.phase === 'fetching' && env.calls.gain.join(',') === '0',
    `${env.calls.lastSnap.phase} / ${env.calls.gain.join(',')}`);

  env.Analyzer.setEnabled(false);
  check('C2 关掉那一刻归零生效', env.lastGain() === 0, String(env.lastGain()));

  const n = env.calls.gain.length;
  const h = env.calls.hud;

  release();       // 放行：分析在这里「落位」
  await p;
  await flush();

  check('★ C3 分析落位被拦下 → 关掉之后一个增益写入都没有',
    env.calls.gain.length === n, `${n} → ${env.calls.gain.length}（${env.calls.gain.join(',')}）`);
  check('★ C4 最后写入的增益是 0，不是 +6dB', env.lastGain() === 0, String(env.lastGain()));
  check('★ C5 状态没有被改写成 active', env.calls.lastSnap.phase === 'idle', env.calls.lastSnap.phase);
  check('★ C6 HUD 也没有被这次落位带着刷新', env.calls.hud === h, `${h} → ${env.calls.hud}`);
  check('★ C7 整段作废：不写缓存', env.Store.get(env.key) === null, String(env.Store.get(env.key)));
  check('C8 也不误报「分析失败」（开关关着没什么可失败的）',
    !env.logs.warn.some(l => l.includes('分析失败')));

  /* 关掉之后重新打开，同一个视频还要能正常恢复 */
  const n2 = env.calls.gain.length;
  env.Analyzer.setEnabled(true);
  await flush();
  check('★ C9 中途关掉后再打开 → 仍然能恢复归一',
    env.calls.gain.length > n2 && env.lastGain() === 6, String(env.lastGain()));
}

/* ================================================================
 * C2. 抽样路径途中关掉开关
 *
 * C 组只走到「取流」就被拦下（FastPath 的落位点在取流之后不久）。
 * 真正长的是 SamplePath：取索引 → 下载 → 解码 → 响度 → 精修，
 * 中间有 7 处 aborted 判据，只靠静态正则看着是不够的。
 * 这里用可挂闸的抽样桩把流程卡在「下载返回」与「响度测量」两处，
 * 关掉开关再放行 —— 断言一个增益都不许落位。
 * ================================================================ */

async function testSamplePathMidflight() {
  section('C2. 抽样路径途中关掉开关（下载 / 响度两处闸）');

  /* ① 闸在「抽样下载」返回处（analyzeKey 里第一批拿到段的那一刻） */
  const env = load({ samplePath: true });
  let release;
  env.gates.download = new Promise(r => { release = r; });

  const p = env.Analyzer.maybeRun(env.el, 'test');
  await flush();

  check('C2-1 已进入抽样阶段（下载已发起、只有「换片归零」一次调用）',
    !!env.gates.download && env.calls.lastSnap.phase === 'segments' && env.calls.gain.join(',') === '0',
    `${env.calls.lastSnap.phase} / ${env.calls.gain.join(',')}`);

  env.Analyzer.setEnabled(false);
  const n = env.calls.gain.length;
  const h = env.calls.hud;

  release();
  await p;
  await flush();

  check('★ C2-2 关掉后放行 → 抽样路径一个增益写入都没有',
    env.calls.gain.length === n, `${n} → ${env.calls.gain.length}（${env.calls.gain.join(',')}）`);
  check('★ C2-3 状态没有被改成 active', env.calls.lastSnap.phase === 'idle', env.calls.lastSnap.phase);
  check('★ C2-4 整段作废：不写缓存', env.Store.get(env.key) === null, String(env.Store.get(env.key)));
  check('C2-5 HUD 也没被这次落位带着刷新', env.calls.hud === h, `${h} → ${env.calls.hud}`);
  check('C2-6 不误报「分析失败」', !env.logs.warn.some(l => l.includes('分析失败')));

  /* ② 闸在「响度测量」——已解码完，初测落位点就在眼前（最贴近危险的那一步） */
  const env2 = load({ samplePath: true });
  let release2;
  env2.gates.measure = new Promise(r => { release2 = r; });

  const p2 = env2.Analyzer.maybeRun(env2.el, 'test');
  await flush();

  check('C2-7 已进入响度分析阶段（解码已完成）',
    env2.calls.lastSnap.phase === 'analyzing', env2.calls.lastSnap.phase);

  env2.Analyzer.setEnabled(false);
  const n2 = env2.calls.gain.length;
  release2();
  await p2;
  await flush();

  check('★ C2-8 关掉后放行 → 测完也不落位（初测落位点被守卫拦下）',
    env2.calls.gain.length === n2, `${n2} → ${env2.calls.gain.length}（${env2.calls.gain.join(',')}）`);
  check('★ C2-9 状态不是 active', env2.calls.lastSnap.phase === 'idle',
    `${env2.calls.lastSnap.phase} | info: ${env2.logs.info.slice(-3).join(' ~ ')} | warn: ${env2.logs.warn.slice(-2).join(' ~ ')}`);
  check('★ C2-10 不写缓存', env2.Store.get(env2.key) === null,
    JSON.stringify(env2.Store.get(env2.key)));

  /* ③ 基线：同一套桩在开关开着时必须能跑通
   *    —— 否则上面每条「没有落位」都可能是「桩根本没跑起来」的假象 */
  const env3 = load({ samplePath: true });
  await env3.Analyzer.maybeRun(env3.el, 'test');
  await flush();

  check('★ C2-11 基线（开关打开）：抽样路径正常跑完并落位 +6dB',
    env3.lastGain() === 6 && env3.calls.lastSnap.phase === 'active',
    `${env3.lastGain()} / ${env3.calls.lastSnap.phase} / ${env3.calls.gain.join(',')}`);
  check('★ C2-12 基线：测量结果确实写进了缓存',
    !!env3.Store.get(env3.key) && Number.isFinite(env3.Store.get(env3.key).measuredLufs),
    JSON.stringify(env3.Store.get(env3.key)));
  check('C2-13 基线：走了抽样路径（日志里不是 FastPath）',
    env3.logs.info.some(l => l.includes('SamplePath')) && !env3.logs.info.some(l => l.includes('FastPath')));
  check('C2-14 基线：精修第二批也跑过（download 被调了两次）',
    env3.dl.calls === 2, String(env3.dl.calls));
}

/* ================================================================
 * D. reapply 也受总开关管（同源缺陷）
 * ================================================================ */

async function testReapplyGuard() {
  section('D. 停用状态下换档案（reapply）也不得落位');

  const env = load();
  await env.Analyzer.maybeRun(env.el, 'loadedmetadata');
  env.Analyzer.setEnabled(false);

  const n = env.calls.gain.length;
  const r = await env.Analyzer.reapply();
  check('★ D1 停用状态下 reapply → 不落位',
    env.calls.gain.length === n, `${n} → ${env.calls.gain.length}`);
  check('★ D2 reapply 明确返回被停用挡下',
    !!r && r.ok === false && r.reason === 'disabled', JSON.stringify(r && r.reason));
  check('D3 停用状态下 reapply 也不改状态', env.calls.lastSnap.phase === 'idle');

  env.Analyzer.setEnabled(true);
  await flush();
  const n2 = env.calls.gain.length;
  const r2 = await env.Analyzer.reapply();
  check('D4 启用后 reapply 正常落位',
    !!r2 && r2.ok === true && env.calls.gain.length > n2, JSON.stringify(r2 && r2.ok));
  check('D5 启用后 reapply 落位仍是 +6dB', env.lastGain() === 6, String(env.lastGain()));
}

/* ================================================================
 * D2. 停用状态下点「重新测量本视频」—— 不得白丢缓存
 *
 * reanalyze 是「先拆再跑」：丢缓存 + 清采信记忆，然后交给 maybeRun。
 * 开关关着时 maybeRun 在入口就被拦下 —— 于是拆完了跑不动，
 * 代价是这个视频下次启用要重抽几秒，而按钮返回的还是 ok。
 * ================================================================ */

async function testReanalyzeGuard() {
  section('D2. 停用状态下「重新测量本视频」不得先拆后跑');

  const env = load();
  await env.Analyzer.maybeRun(env.el, 'loadedmetadata');
  check('D2-1 基线：已分析完并写入缓存', env.Store.get(env.key) !== null);

  env.Analyzer.setEnabled(false);
  const n = env.calls.gain.length;
  const forgets0 = env.pi.forgets;
  const r = await env.Analyzer.reanalyze();

  check('★ D2-2 停用状态下 reanalyze 明确返回 disabled',
    !!r && r.ok === false && r.reason === 'disabled', JSON.stringify(r && r.reason));
  check('★ D2-3 缓存没被丢掉（没有守卫时这里会被 Store.remove 清掉）',
    env.Store.get(env.key) !== null, env.Store.get(env.key) === null ? '已被删除' : 'ok');
  check('★ D2-4 采信记忆也没被清（PlayInfo.forget 不该被调用）',
    env.pi.forgets === forgets0, `${forgets0} → ${env.pi.forgets}`);
  check('D2-5 不落位、状态保持 idle',
    env.calls.gain.length === n && env.calls.lastSnap.phase === 'idle',
    `${n} → ${env.calls.gain.length} / ${env.calls.lastSnap.phase}`);

  /* 启用后照旧能重测 —— 守卫不能把正常路径也挡了 */
  env.Analyzer.setEnabled(true);
  await flush();
  const forgets1 = env.pi.forgets;
  const r2 = await env.Analyzer.reanalyze();

  check('★ D2-6 启用后 reanalyze 正常跑完并落位 +6dB',
    !!r2 && r2.ok === true && env.lastGain() === 6, JSON.stringify(r2 && r2.ok) + ' / ' + env.lastGain());
  check('★ D2-7 启用后确实「拆了再跑」（采信记忆被清、缓存被重写）',
    env.pi.forgets > forgets1 && env.Store.get(env.key) !== null,
    `forget ${forgets1} → ${env.pi.forgets}`);
}

/* ================================================================
 * E. 静态不变量 —— 防止同类缺陷再长回来
 * ================================================================ */

function testStatic() {
  section('E. 静态不变量（源码）');

  const src = read('src/analyzer.js');
  /* 一律在**剥掉注释的代码**上查 —— 注释里正好在讲这件事（"别写成 jobSeq !== myJob"），
   * 直接对全文做正则会把说明文字当成违规代码。 */
  const code = stripComments(src);

  check('★ E1 统一「该不该继续」判据 aborted() 存在', /function aborted\(myJob\) \{/.test(src));
  check('★ E2 aborted 同时判 jobSeq 与 CONFIG.enabled',
    /function aborted\(myJob\) \{\s*return jobSeq !== myJob \|\| !CONFIG\.enabled;/.test(src));
  check('★ E3 统一落位出口 land() 存在', /function land\(key, planned, myJob\) \{/.test(src));
  check('★ E4 land 内部先过 aborted 再写音频图',
    /function land\(key, planned, myJob\) \{\s*if \(aborted\(myJob\)\) return false;/.test(src));

  check('★ E5 jobSeq !== myJob 只出现在 aborted 里（别处一律走 aborted）',
    (code.match(/jobSeq !== myJob/g) || []).length === 1,
    String((code.match(/jobSeq !== myJob/g) || []).length));
  check('E6 任务存活判据只剩 runningKey 收尾一处（jobSeq === myJob）',
    (code.match(/jobSeq === myJob/g) || []).length === 1,
    String((code.match(/jobSeq === myJob/g) || []).length));

  const sites = [...code.matchAll(/AudioEngine\.setGainDb\((\w+)\.gainDb\)/g)].map(m => m[0]);
  check('★ E7 非零增益落位点只有 3 处（land / 复用分支 / reapply），不得再长新的',
    sites.length === 3, `${sites.length}: ${sites.join(' | ')}`);

  /* land 现在会返回 false（被 aborted 拦下）。不接住它 → 后面照旧 push('active') 或写缓存，
   * 就成了「状态显示已生效、音频图里没有」。今天每个 aborted 判据都紧贴 land、中间没有 await，
   * 所以返回 false 实际不可达 —— 但这条断言管的是「将来别在这两者之间插 await」。 */
  const landCalls = [...code.matchAll(/(?<!function )land\(key, /g)].length;
  const landGuarded = [...code.matchAll(/!land\(key, /g)].length;
  check('★ E7b 每个 land 调用点都接住返回值（不得出现裸调用）',
    landCalls > 0 && landCalls === landGuarded, `${landGuarded} / ${landCalls}`);
  check('★ E8 复用分支不再把「记录对象」写成数字（死代码回归守卫）',
    /const knownOk = !!\(known && Number\.isFinite\(known\.measuredLufs\)\);/.test(src));
  check('E9 复用分支的 base 对象也用 knownOk 判（不再 known || {}）',
    /Object\.assign\(\{\}, knownOk \? known : \{/.test(src));

  check('★ E10 analyzeKey 起来第一件事就是过 aborted',
    /async function analyzeKey\(info, key, videoEl, myJob\) \{\s*\/\*[^*]*\*\/\s*if \(aborted\(myJob\)\) return;/.test(src));
  check('★ E11 setEnabled 清掉 appliedKey',
    /setEnabled\(v\) \{[\s\S]*?appliedKey = null;[\s\S]*?\}/.test(src));
  check('★ E12 setEnabled(true) 补一次对当前视频的 maybeRun',
    /maybeRun\(Lifecycle\.currentElement\(\), '启用'\)/.test(src));
  check('★ E13 setEnabled 是幂等的（状态没变就直接返回）',
    /if \(on === CONFIG\.enabled\) return on;/.test(src));
  check('★ E14 reapply 入口查总开关',
    /async function reapply\(\) \{\s*\/\*[^*]*\*\/\s*if \(!CONFIG\.enabled\) return \{ ok: false, reason: 'disabled' \};/.test(src));

  /* reanalyze 是「先拆再跑」，守卫必须在拆之前 —— 位置错了等于没修 */
  const rean = src.slice(src.indexOf('async function reanalyze()'), src.indexOf('async function reapply()'));
  check('★ E15 reanalyze 的守卫排在 Store.remove 之前（否则＝白丢本视频缓存）',
    rean.includes("if (!CONFIG.enabled) return { ok: false, reason: 'disabled' };") &&
    rean.indexOf('if (!CONFIG.enabled)') < rean.indexOf('Store.remove'),
    `guard@${rean.indexOf('if (!CONFIG.enabled)')} remove@${rean.indexOf('Store.remove')}`);

  /* 面板侧：开关这两种坏法的「用户可见部分」 */
  const panel = stripComments(read('src/panel.js'));
  check('★ E16 面板：停用状态下点重测给出正确提示（不再报「没有可测量的视频」）',
    /r\.reason === 'disabled' \? '响度归一当前是关闭的' : '没有可测量的视频'/.test(panel));
  check('★ E17 面板：启用开关的 change 用当下快照渲染（不留 600ms 的「已开启 · 增益 —」空窗）',
    /C\.enabled\.addEventListener\('change', \(\) => \{\s*setEnabled\(C\.enabled\.checked\);\s*render\(Analyzer\.snapshot\(\)\);/.test(panel));
}

/* ================================================================ */

(async () => {
  console.log('总开关 / 增益落位 单元验证\n');
  await testRevisit();
  await testToggle();
  await testDisableMidflight();
  await testSamplePathMidflight();
  await testReapplyGuard();
  await testReanalyzeGuard();
  testStatic();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
