#!/usr/bin/env node
/* ================================================================
 * s2-unit.mjs — S2 单元验证（纯 Node，不需要浏览器）
 *
 *   node probe/s2-unit.mjs
 *
 * 四个断言：
 *   1. sidx 解析器：构造一个已知内容的 sidx box → 解析结果必须逐字段吻合
 *   2. K 加权系数：与我按采样率现算的系数 vs BS.1770-4 给出的 48kHz
 *      官方系数，频响逐点比对（这是「滤波器写对了没有」的硬证据）
 *   3. 响度管线自洽：1kHz 正弦的测量值 vs 解析公式
 *   4. 门限：混入静音的素材，-70 LUFS 绝对门限必须把静音块丢掉
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* -------- 在纯 Node 里加载 src 模块（它们只依赖 Math，不碰 DOM） -------- */

function loadModules() {
  const code = ['config.js', 'sidx.js', 'loudness.js', 'gain-planner.js']
    .map(f => readFileSync(join(ROOT, 'src', f), 'utf8'))
    .join('\n');
  const factory = new Function(`${code}\nreturn { CONFIG, Sidx, Loudness, GainPlanner };`);
  return factory();
}

const { CONFIG, Sidx, Loudness, GainPlanner } = loadModules();

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

function section(t) { console.log(`\n=== ${t} ===`); }

/* ================================================================
 * 1. sidx 解析器 —— 构造已知内容，验证逐字段吻合
 * ================================================================ */

function buildSidxBox({ version = 0, timescale = 48000, earliest = 0, firstOffset = 900, durations, sizes }) {
  const count = durations.length;
  const payloadSize = version === 1 ? 4 + 4 + 4 + 8 + 8 + 2 + 2 + count * 12 : 4 + 4 + 4 + 4 + 4 + 2 + 2 + count * 12;
  const total = 8 + payloadSize;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let p = 0;

  view.setUint32(p, total); p += 4;
  'sidx'.split('').forEach(c => { view.setUint8(p++, c.charCodeAt(0)); });
  view.setUint8(p, version); p += 1;
  view.setUint8(p++, 0); view.setUint8(p++, 0); view.setUint8(p++, 0);   // flags
  view.setUint32(p, 1); p += 4;                                          // reference_ID
  view.setUint32(p, timescale); p += 4;

  if (version === 1) {
    // 64 位字段：高 32 位在前，低 32 位在后，各占 4 字节
    view.setUint32(p, 0); p += 4;
    view.setUint32(p, earliest); p += 4;
    view.setUint32(p, 0); p += 4;
    view.setUint32(p, firstOffset); p += 4;
  } else {
    view.setUint32(p, earliest); p += 4;
    view.setUint32(p, firstOffset); p += 4;
  }

  view.setUint16(p, 0); p += 2;    // reserved
  view.setUint16(p, count); p += 2;

  for (let i = 0; i < count; i++) {
    view.setUint32(p, sizes[i] & 0x7fffffff); p += 4;
    view.setUint32(p, durations[i]); p += 4;
    view.setUint32(p, 0); p += 4;
  }

  return bytes;
}

function testSidx() {
  section('1. sidx 解析器');

  // 43 段 × 5s，段长递增，模拟真实 B 站音频
  const durations = Array.from({ length: 43 }, () => 5 * 48000);
  const sizes = Array.from({ length: 43 }, (_, i) => 140000 + i * 137);
  const firstOffset = 1661;
  const box = buildSidxBox({ durations, sizes, firstOffset });

  const parsed = Sidx.parse(box);

  check('解析成功', !!parsed);
  if (!parsed) return;

  check('段数 = 43', parsed.refs.length === 43, `实际 ${parsed.refs.length}`);
  check('timescale = 48000', parsed.timescale === 48000, `实际 ${parsed.timescale}`);
  check('每段 5s', Math.abs(parsed.refs[0].duration - 5) < 1e-9, `实际 ${parsed.refs[0].duration}`);
  check('首段 offset = firstOffset', parsed.refs[0].offset === firstOffset, `实际 ${parsed.refs[0].offset}`);

  const sizeSum = sizes.reduce((a, b) => a + b, 0);
  check('offset 闭合：末尾 = firstOffset + Σsize',
    parsed.endOffset === firstOffset + sizeSum,
    `${parsed.endOffset} vs ${firstOffset + sizeSum}`);

  check('时间轴闭合：末段起点 = 42×5s',
    Math.abs(parsed.refs[42].t - 210) < 1e-9,
    `实际 ${parsed.refs[42].t}`);

  check('verify() 对正确 Content-Length 返回 ok',
    Sidx.verify(parsed, firstOffset + sizeSum).ok === true);
  check('verify() 对错误 Content-Length 返回 not ok',
    Sidx.verify(parsed, firstOffset + sizeSum + 7).ok !== true);

  /* ---- 索引基准点（最容易踩的坑，单独钉死）---- */
  // ISO 规定 first_offset 的基准点是「sidx box 之后的第一个字节」
  const anchor = 1482;                       // 真实案例：ftyp+free+moov+sidx 共 1482 字节
  const anchored = Sidx.parse(box, anchor);
  check('传 anchor 后首段 offset = anchor + firstOffset',
    anchored.refs[0].offset === anchor + firstOffset,
    `${anchored.refs[0].offset} vs ${anchor + firstOffset}`);
  check('anchor 生效后 endOffset 也整体后移 anchor',
    anchored.endOffset === anchor + firstOffset + sizeSum,
    `${anchored.endOffset} vs ${anchor + firstOffset + sizeSum}`);
  check('未传 anchor 时退化为绝对偏移（默认 0）',
    Sidx.parse(box).refs[0].offset === firstOffset);

  // 真实回归用例（BV1GJ411x7h7 实测）：43 段、first_offset=0、Σsize=2730186、
  // sidx box 结束于 1481 → 文件总长 2731668。忽略基准点会整体偏 1482 字节。
  const REAL_SIZES = (() => {
    // 复现实测分布：总长精确等于 2730186
    const base = Math.floor(2730186 / 43);
    const sizes = Array.from({ length: 43 }, () => base);
    sizes[0] += 2730186 - base * 43;
    return sizes;
  })();
  const realBox = buildSidxBox({ durations: Array.from({ length: 43 }, () => 5 * 48000), sizes: REAL_SIZES, firstOffset: 0 });
  const realParsed = Sidx.parse(realBox, 1482);
  check('真实用例：1482 + Σsize = 观测到的文件长度 2731668',
    realParsed.endOffset === 2731668,
    `实际 ${realParsed.endOffset}`);
  check('真实用例：忽略基准点会短算 1482 字节（正是当初踩的坑）',
    Sidx.parse(realBox).endOffset === 2731668 - 1482,
    `实际 ${Sidx.parse(realBox).endOffset}`);
  check('真实用例：首段 offset = 1482（moof 真实起点）',
    realParsed.refs[0].offset === 1482);

  /* ---- box 起始探测（自校验用）---- */
  const moofBytes = new Uint8Array([0, 0, 7, 200, 109, 111, 111, 102]);
  check('startsWithBox 识别 moof', Sidx.startsWithBox(moofBytes, 'moof') === true);
  check('startsWithBox 拒绝非 moof', Sidx.startsWithBox(moofBytes, 'mdat') === false);
  check('startsWithBox 对短输入返回 false', Sidx.startsWithBox(new Uint8Array([1, 2, 3]), 'moof') === false);

  // version 1（64 位）
  const box1 = buildSidxBox({ version: 1, durations: [48000], sizes: [1000], firstOffset: 500 });
  const p1 = Sidx.parse(box1);
  check('version 1（64 位）解析成功', !!p1 && p1.refs.length === 1 && p1.refs[0].offset === 500);

  // 均匀抽取：首段必取
  const picks = Sidx.pickEvenly(parsed.refs, 12);
  check('抽 12 段且首段必取', picks.length === 12 && picks[0] === 0, `[${picks.slice(0, 6).join(',')}…]`);
  check('抽取序号严格递增', picks.every((v, i) => i === 0 || v > picks[i - 1]));
  const picksAll = Sidx.pickEvenly(parsed.refs, 100);
  check('want > N 时全取（不重复）', picksAll.length === 43);

  /* ---- S2.2 渐进式：从均匀抽取里再等距挑第一批 ---- */
  const coarse = Sidx.pickCoarse(picks, 6);
  check('pickCoarse 长度正确', coarse.length === 6, `[${coarse.join(',')}]`);
  check('pickCoarse 是 picks 的子集', coarse.every(i => picks.indexOf(i) >= 0));
  check('★ pickCoarse 含首尾（覆盖 0%–100% 时间轴）',
    coarse[0] === picks[0] && coarse[coarse.length - 1] === picks[picks.length - 1],
    `${coarse[0]} … ${coarse[coarse.length - 1]}（picks 首尾 ${picks[0]} / ${picks[picks.length - 1]}）`);
  check('pickCoarse 严格递增', coarse.every((v, i) => i === 0 || v > coarse[i - 1]));
  const rest = picks.filter(i => coarse.indexOf(i) < 0);
  check('★ 两批互补且不重叠（coarse ∪ rest = picks）',
    coarse.length + rest.length === picks.length && rest.every(i => coarse.indexOf(i) < 0),
    `${coarse.length} + ${rest.length} = ${picks.length}`);
  check('pickCoarse k>=n 时返回全部', Sidx.pickCoarse(picks, 99).length === 12);
  check('pickCoarse k=1 只取一段', Sidx.pickCoarse(picks, 1).length === 1);
  check('pickCoarse 空输入返回空', Sidx.pickCoarse([], 3).length === 0);

  // 越界输入不应抛错
  check('空输入返回 null', Sidx.parse(null) === null);
  check('垃圾输入返回 null', Sidx.parse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null);
}

/* ================================================================
 * 2. K 加权系数 —— 与 BS.1770-4 官方 48kHz 系数比对频响
 * ================================================================ */

/** 官方 48kHz 系数（ITU-R BS.1770-4 Table 1 & 2） */
const BS1770_48K = {
  shelf: {
    b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
    a: [1, -1.69065929318241, 0.73248077421585],
  },
  hpf: {
    b: [1.0, -2.0, 1.0],
    a: [1, -1.99004745483398, 0.99007225036621],
  },
};

/** 数字滤波器在给定频率的幅频响应（dB），b/a 为直接 I 型 */
function magnitudeDb(coeff, fs, freq) {
  const w = 2 * Math.PI * freq / fs;
  const { b, a } = coeff;
  const re = b[0] + b[1] * Math.cos(-w) + b[2] * Math.cos(-2 * w);
  const im = b[1] * Math.sin(-w) + b[2] * Math.sin(-2 * w);
  const dre = a[0] + a[1] * Math.cos(-w) + a[2] * Math.cos(-2 * w);
  const dim = a[1] * Math.sin(-w) + a[2] * Math.sin(-2 * w);
  const num = Math.hypot(re, im);
  const den = Math.hypot(dre, dim);
  return 20 * Math.log10(num / den);
}

function toBA(c) { return { b: [c.b0, c.b1, c.b2], a: [1, c.a1, c.a2] }; }

function testKWeighting() {
  section('2. K 加权系数 vs BS.1770-4 官方 48kHz');

  const fs = 48000;
  const mineShelf = toBA(Loudness.highShelfCoeffs(fs));
  const mineHpf = toBA(Loudness.highPassCoeffs(fs));

  const freqs = [20, 50, 100, 500, 1000, 1681.97, 3000, 6000, 10000, 16000];

  console.log('  freq(Hz)   shelf: 我/官方/差       hpf: 我/官方/差');
  let maxShelf = 0;
  let maxHpf = 0;

  for (const f of freqs) {
    const ms = magnitudeDb(mineShelf, fs, f);
    const os = magnitudeDb(BS1770_48K.shelf, fs, f);
    const mh = magnitudeDb(mineHpf, fs, f);
    const oh = magnitudeDb(BS1770_48K.hpf, fs, f);
    maxShelf = Math.max(maxShelf, Math.abs(ms - os));
    maxHpf = Math.max(maxHpf, Math.abs(mh - oh));
    console.log(`  ${String(f.toFixed(0)).padStart(7)}   ${ms.toFixed(3).padStart(7)} / ${os.toFixed(3).padStart(7)} / ${(ms - os).toFixed(4).padStart(8)}   ${mh.toFixed(3).padStart(7)} / ${oh.toFixed(3).padStart(7)} / ${(mh - oh).toFixed(4).padStart(8)}`);
  }

  // 20Hz 处高通响应是 -9dB 量级，浮点比对要看绝对差
  check('高架滤波频响与官方一致（最大偏差 < 0.02 dB）', maxShelf < 0.02, `最大 ${maxShelf.toFixed(4)} dB`);
  check('高通滤波频响与官方一致（最大偏差 < 0.02 dB）', maxHpf < 0.02, `最大 ${maxHpf.toFixed(4)} dB`);
}

/* ================================================================
 * 3 & 4. 响度管线 —— 合成信号，与解析公式比对
 * ================================================================ */

/** 伪造一个 AudioBuffer（measure 只用到这四个成员） */
function fakeBuffer(channels, fs) {
  const length = channels[0].length;
  return {
    sampleRate: fs,
    numberOfChannels: channels.length,
    length,
    duration: length / fs,
    getChannelData: (i) => channels[i],
  };
}

/** 用我自己的系数算 1kHz 处的总响应（用于解析预测） */
function kWeightAt1k(fs) {
  const s = toBA(Loudness.highShelfCoeffs(fs));
  const h = toBA(Loudness.highPassCoeffs(fs));
  return magnitudeDb(s, fs, 1000) + magnitudeDb(h, fs, 1000);
}

async function testPipeline() {
  section('3. 响度管线自洽（1kHz 正弦，振幅 −20dBFS）');

  const fs = 48000;
  const secs = 30;
  const n = fs * secs;
  const amp = Math.pow(10, -20 / 20);   // −20 dBFS
  const kw = kWeightAt1k(fs);           // 1kHz 处的 K 加权总响应

  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = amp * Math.sin(2 * Math.PI * 1000 * i / fs);

  /* 3a. 单声道：z = A²/2 → 解析式带 −3.01 项 */
  const mono = await Loudness.measure(fakeBuffer([ch], fs));
  const predMono = -0.691 + 20 * Math.log10(amp) - 3.0103 + kw;
  const dMono = Math.abs(mono.lufs - predMono);

  console.log(`  单声道 实测 ${mono.lufs} LUFS | 解析 ${predMono.toFixed(2)} | 差 ${dMono.toFixed(3)} dB`);

  /* 3b. 双声道（左右同信号）：BS.1770 是**求和** → z = A²/2 + A²/2 = A²，不带 −3.01 */
  const stereo = await Loudness.measure(fakeBuffer([ch, ch.slice()], fs));
  const predStereo = -0.691 + 20 * Math.log10(amp) + kw;
  const dStereo = Math.abs(stereo.lufs - predStereo);

  console.log(`  双声道 实测 ${stereo.lufs} LUFS | 解析 ${predStereo.toFixed(2)} | 差 ${dStereo.toFixed(3)} dB`);

  check('单声道测量有限', Number.isFinite(mono.lufs));
  check('单声道与解析公式吻合（< 0.1 dB）', dMono < 0.1, `实际差 ${dMono.toFixed(4)} dB`);
  check('双声道与解析公式吻合（< 0.1 dB）', dStereo < 0.1, `实际差 ${dStereo.toFixed(4)} dB`);

  // ★ 这条是当初写错的那个点：多声道必须求和，不能平均
  const delta = stereo.lufs - mono.lufs;
  check('★ 同信号双声道比单声道高 3.01 dB（BS.1770 求和而非平均）',
    Math.abs(delta - 3.0103) < 0.02, `实际差 ${delta.toFixed(3)} dB`);

  check('真峰值 = −20 dBTP ± 0.1', Math.abs(stereo.truePeakDb - (-20)) < 0.1, `实际 ${stereo.truePeakDb}`);
  check('块数 ≈ (30−0.4)/0.1 + 1 = 297', Math.abs(stereo.blocks - 297) <= 1, `实际 ${stereo.blocks}`);
  check('单频正弦全部通过门限', stereo.blocksAfterAbs === stereo.blocks && stereo.blocksAfterRel === stereo.blocks);

  section('4. 门限：混入静音后，静音块必须被丢弃');

  // 前 10s 静音 + 后 10s 正弦 → 集成响度应等于正弦段响度（静音块被绝对门限丢掉）
  const n2 = fs * 20;
  const mixed = new Float32Array(n2);
  for (let i = fs * 10; i < n2; i++) mixed[i] = amp * Math.sin(2 * Math.PI * 1000 * i / fs);
  const m2 = await Loudness.measure(fakeBuffer([mixed, mixed.slice()], fs));

  console.log(`  混合信号 ${m2.lufs} LUFS  |  纯正弦 ${stereo.lufs} LUFS  |  差 ${Math.abs(m2.lufs - stereo.lufs).toFixed(3)} dB`);
  console.log(`  绝对门限后块数 ${m2.blocksAfterAbs} / 总块 ${m2.blocks}`);

  check('静音块被绝对门限剔除（保留块 ≈ 一半）',
    m2.blocksAfterAbs > 80 && m2.blocksAfterAbs < 120,
    `实际 ${m2.blocksAfterAbs}/${m2.blocks}`);
  check('混入静音后响度基本不变（< 0.5 dB）',
    Math.abs(m2.lufs - stereo.lufs) < 0.5,
    `实际差 ${Math.abs(m2.lufs - stereo.lufs).toFixed(3)} dB`);

  section('5. 真峰值不被 K 加权污染');
  // 直流 / 低频信号会被高通压掉，但真峰值必须还原封不动地反映原始 PCM
  const dcAmp = 0.5;
  const dc = new Float32Array(fs);
  dc.fill(dcAmp);
  const m3 = await Loudness.measure(fakeBuffer([dc, dc.slice()], fs));
  check('低频信号真峰值仍为原始幅度（−6.02 dBTP）',
    Math.abs(m3.truePeakDb - 20 * Math.log10(dcAmp)) < 0.01,
    `实际 ${m3.truePeakDb}`);
}

/* ================================================================
 * 6. 增益规划 —— 含那个「峰值预算不该倒扣音量」的实测反例
 * ================================================================ */

function testGainPlanner() {
  section('6. 增益规划');

  CONFIG.profile = 'standard';   // 目标 −14 LUFS，上限 +12dB

  const cases = [
    {
      name: '已归一素材 → 微调',
      in: { measuredLufs: -13.5, truePeakDb: 1.1 },
      expect: -0.5, limited: false,
    },
    {
      // ★ 实测反例：BV1muab6rEbA
      name: '★ 素材已过峰 → 不提升，也不倒扣（原实现会误压成 −1.79）',
      in: { measuredLufs: -18.69, truePeakDb: 0.79 },
      expect: 0, limited: true,
    },
    {
      name: '真峰值有余量 → 受削波预算限制',
      in: { measuredLufs: -24, truePeakDb: -6 },
      expect: 5, limited: true,      // 目标提升 10dB，但只剩 5dB 余量
    },
    {
      name: '安静且峰值低 → 受档案上限限制',
      in: { measuredLufs: -30, truePeakDb: -20 },
      expect: 12, limited: true,
    },
    {
      name: '过于响 → 纯衰减，峰值不参与',
      in: { measuredLufs: -8, truePeakDb: -3 },
      expect: -6, limited: false,
    },
    {
      name: '无测量结果 → 0dB（保持原声）',
      in: { measuredLufs: null, truePeakDb: null },
      expect: 0, limited: false,
    },
  ];

  for (const c of cases) {
    const r = GainPlanner.plan(c.in);
    check(c.name, Math.abs(r.gainDb - c.expect) < 0.001 && r.limited === c.limited,
      `gain=${r.gainDb}dB (期望 ${c.expect}) limited=${r.limited} (期望 ${c.limited}) ${r.limitReason || ''}`);
  }

  // 不变量：规划出的增益永远不能让输出峰值超过原峰值（除非是在提升且有余量）
  const r = GainPlanner.plan({ measuredLufs: -18.69, truePeakDb: 0.79 });
  check('不变量：过峰素材的输出峰值不会比原峰值更高',
    r.gainDb <= 0, `gain=${r.gainDb}`);

  /* 〔S3.2.5〕limitReason 会**原样显示在面板的「限幅」行**上，所以一律「人话」；
   * 〔S3.2.5b〕数值与单位之间**统一留一个空格**（+0 dB / +6 dB / -60 dB），与面板其它 dB 读数一致。 */
  const lr = GainPlanner.plan({ measuredLufs: -24, truePeakDb: -6 });   // 余量 5dB，想提 10dB
  check('★ S3.2.5：削波预算限制 → 说人话「+5.0 dB（防止爆音）」',
    /^\+5\.0 dB（防止爆音）$/.test(lr.limitReason || ''), lr.limitReason || '(空)');
  check('★ S3.2.5b：过峰那条 → 「+0 dB（素材已过峰）」（带空格）',
    /^\+0 dB（素材已过峰）$/.test(r.limitReason || ''), r.limitReason || '(空)');
  const lc = GainPlanner.plan({ measuredLufs: -30, truePeakDb: -20 });  // 被档案上限拦住
  check('★ S3.2.5b：档案上限 → 「档案上限 +12 dB」（带空格）',
    /^档案上限 \+12 dB$/.test(lc.limitReason || ''), lc.limitReason || '(空)');
  /* 下限同样取自 currentProfile()（**不读入参**）—— 临时用「自定义」档把 minGainDb 抬到 0 来触发，
   * 跑完逐个字段还原，不换对象引用（别处可能持着 CONFIG.profiles.custom 的引用）。 */
  const lfTarget = CONFIG.profiles.custom.targetLufs;
  const lfMin = CONFIG.profiles.custom.minGainDb;
  CONFIG.profile = 'custom';
  CONFIG.profiles.custom.targetLufs = -14;
  CONFIG.profiles.custom.minGainDb = 0;
  const lf = GainPlanner.plan({ measuredLufs: -10 });   // 想降 4 dB，被下限 0 拦住
  check('★ S3.2.5b：档案下限 → 「档案下限 0 dB」（带空格）',
    /^档案下限 0 dB$/.test(lf.limitReason || ''), lf.limitReason || '(空)');
  CONFIG.profiles.custom.targetLufs = lfTarget;
  CONFIG.profiles.custom.minGainDb = lfMin;
  CONFIG.profile = 'standard';
}

/* ================================================================
 * 8. 分块 K 加权 —— 与一次性滤波的逐位一致性
 *
 *    S2.2 把「一个声道一整趟滤波」切成若干块，块间让出主线程，
 *    免得在页面上糊一个几百毫秒的长任务。切块必须**带着 IIR 状态跨块**，
 *    不然每个块都从头起振，结果就悄悄变了 —— 这类 bug 不会报错，
 *    只会让响度偏一点，然后增益也偏一点。
 * ================================================================ */

class FakeAudioBufferLike {
  constructor(chans, fs) {
    this.sampleRate = fs;
    this.numberOfChannels = chans.length;
    this.length = chans[0].length;
    this.duration = chans[0].length / fs;
    this._c = chans;
  }
  getChannelData(i) { return this._c[i]; }
}

async function testChunkedBiquad() {
  section('8. 分块 K 加权 vs 一次性滤波（S2.2 长任务切块）');

  const fs = 48000;
  const n = 200000;
  const base = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    base[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5;
  }

  for (const [name, coeffs] of [
    ['高架', Loudness.highShelfCoeffs(fs)],
    ['高通', Loudness.highPassCoeffs(fs)],
  ]) {
    const a = base.slice();
    const b = base.slice();
    Loudness.biquadInPlace(a, coeffs);

    const st = Loudness.biquadState();
    const CH = 7777;   // 故意取一个不整除的长度，测边界
    for (let s = 0; s < n; s += CH) {
      Loudness.biquadRange(b, s, Math.min(s + CH, n), coeffs, st);
    }

    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > maxDiff) maxDiff = d;
    }
    check(`${name}：分块(7777帧/块) 与一次性滤波逐位一致`, maxDiff === 0, `最大差 ${maxDiff}`);
  }

  // 分块粒度不能影响最终测量结果
  const sig = new Float32Array(fs * 3);
  for (let i = 0; i < sig.length; i++) sig[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * i / fs);

  const keep = CONFIG.lumChunkFrames;
  CONFIG.lumChunkFrames = 4096;
  const mSmall = await Loudness.measure(new FakeAudioBufferLike([sig, sig.slice()], fs));
  CONFIG.lumChunkFrames = 1000000;
  const mBig = await Loudness.measure(new FakeAudioBufferLike([sig, sig.slice()], fs));
  CONFIG.lumChunkFrames = keep;

  check('分块粒度不影响集成响度',
    Math.abs(mSmall.lufs - mBig.lufs) < 1e-9,
    `小块 ${mSmall.lufs} vs 大块 ${mBig.lufs}`);
  check('分块粒度不影响真峰值',
    mSmall.truePeakDb === mBig.truePeakDb,
    `${mSmall.truePeakDb} vs ${mBig.truePeakDb}`);
}

/* ================================================================
 * 9. 旁路语义 —— 按 0dB，但不丢归一结果
 *
 *    用户要的是一个「一键 A/B」的开关。最容易写错的实现是
 *    「旁路 = 把增益忘了」，那样切回来就得重新等一次抽样。
 *    这里用一套假的 AudioContext 把 audio-engine 拉起来直接断言。
 * ================================================================ */

function testAudioEngineBypass() {
  section('9. 旁路语义（S2.2 新增）');

  class FakeParam {
    constructor() { this.value = 1; }
    setValueAtTime(v) { this.value = v; }
    setTargetAtTime(v) { this.value = v; }   // 测试只关心「最终落到多少」
    cancelScheduledValues() {}
  }
  class FakeGain {
    constructor() { this.gain = new FakeParam(); }
    connect() {}
  }
  class FakeCtx {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = {};
    }
    createGain() { return new FakeGain(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }

  const code = ['config.js', 'audio-engine.js']
    .map(f => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n');
  const factory = new Function('window', 'Log', `${code}\nreturn { AudioEngine };`);
  const { AudioEngine } = factory(
    { AudioContext: FakeCtx },
    { info() {}, warn() {}, debug() {}, error() {} },
  );

  AudioEngine.setGainDb(6);
  check('setGainDb(+6) → 目标与实际都是 +6dB',
    AudioEngine.getDesiredGainDb() === 6 && AudioEngine.getAppliedGainDb() === 6);
  check('线性增益 = 10^(6/20)',
    Math.abs(AudioEngine.getGainValue() - Math.pow(10, 0.3)) < 1e-9,
    `实际 ${AudioEngine.getGainValue()}`);

  AudioEngine.setBypass(true);
  check('★ 旁路中实际增益归 0dB',
    AudioEngine.getAppliedGainDb() === 0, `实际 ${AudioEngine.getAppliedGainDb()}`);
  check('★ 旁路中线性增益回到 1.0（真·原声）',
    Math.abs(AudioEngine.getGainValue() - 1) < 1e-12, `实际 ${AudioEngine.getGainValue()}`);
  check('★ 旁路中仍记得归一目标 +6dB（切回来是瞬时的）',
    AudioEngine.getDesiredGainDb() === 6);
  check('isBypass() 为真', AudioEngine.isBypass() === true);

  AudioEngine.setGainDb(-3);
  check('旁路中重新分析 → 目标更新为 −3dB，实际仍 0dB',
    AudioEngine.getDesiredGainDb() === -3 && AudioEngine.getAppliedGainDb() === 0);

  AudioEngine.toggleBypass();
  check('★ 关闭旁路 → 立刻恢复到最新的归一增益 −3dB',
    AudioEngine.getAppliedGainDb() === -3, `实际 ${AudioEngine.getAppliedGainDb()}`);
  check('isBypass() 归位', AudioEngine.isBypass() === false);

  const st = AudioEngine.stats();
  check('stats 暴露 bypass / desiredGainDb',
    st.bypass === false && st.desiredGainDb === -3, JSON.stringify({ b: st.bypass, d: st.desiredGainDb }));

  // 幂等：重复开同一边不该抖动
  AudioEngine.setBypass(true);
  const g1 = AudioEngine.getGainValue();
  AudioEngine.setBypass(true);
  check('重复 setBypass(true) 不抖动', AudioEngine.getGainValue() === g1);
}

/* ================================================================
 * 10. 抽样容错 —— 单段失败不再拖垮整批
 *
 *     原来的写法：任何一段抛错 → 整次分析失败 → 重来一遍全批。
 *     用户看到的就是「有时候等很久，有时候干脆失败」。
 *     S2.2 改成「超时 → 重试 → 仍失败就丢掉这一段」，够数就继续。
 * ================================================================ */

async function testSamplerResilience() {
  section('10. 抽样容错（S2.2 新增）');

  // 故意不带 logger.js：Log 变成可注入的自由变量，测试里塞一个静音的，
  // 免得「预期内的失败日志」把测试输出刷花
  const code = ['config.js', 'sidx.js', 'sampler.js']
    .map(f => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n');
  const factory = new Function('Log', `${code}\nreturn { Sampler, CONFIG };`);
  const silent = { info() {}, warn() {}, debug() {}, error() {}, setDebug() {}, isDebug() { return false; } };
  const { Sampler, CONFIG: C } = factory(silent);

  const realFetch = globalThis.fetch;
  const realGap = C.requestGapMs;
  const realRetryDelay = C.segRetryDelayMs;

  C.requestGapMs = 5;          // 测试里没必要真按 80ms 排队
  C.segRetryDelayMs = 1;

  /** 偏移 2048 的那一段永远失败，其余正常 */
  globalThis.fetch = async (url, opts) => {
    const rv = String((opts && opts.headers && opts.headers.Range) || '');
    const m = rv.match(/bytes=(\d+)-(\d+)/);
    if (!m) throw new Error('no-range');
    const start = +m[1];
    const end = +m[2];
    if (start === 2048) throw new Error('HTTP 500');
    return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(Math.max(1, end - start + 1)) };
  };

  const refs = [
    { index: 0, t: 0,  duration: 5, size: 100, offset: 0 },
    { index: 1, t: 5,  duration: 5, size: 100, offset: 1024 },
    { index: 2, t: 10, duration: 5, size: 100, offset: 2048 },   // ← 必失败
    { index: 3, t: 15, duration: 5, size: 100, offset: 3072 },
  ];
  const audio = { url: 'https://example.invalid/audio.m4s' };

  const r = await Sampler.download(refs, audio, null, { label: 'unit' }).all;
  check('单段失败不抛错（整批照常返回）', !!r);
  check('★ 失败段被跳过，dropped=1', r.dropped === 1, `实际 ${r.dropped}`);
  check('成功段数 3/4', r.ok === 3 && r.requested === 4, `${r.ok}/${r.requested}`);
  check('返回的段里不含失败那一段', r.segs.every(s => s.index !== 2));
  check('覆盖率分母用「申请段数」而非成功段数',
    Math.abs(r.seconds - 15) < 1e-6 && Math.abs(r.requestedSeconds - 20) < 1e-6,
    `${r.seconds}s / ${r.requestedSeconds}s`);
  check('记录了最慢段与中位段耗时',
    Number.isFinite(r.slowestMs) && Number.isFinite(r.medianMs),
    `最慢 ${r.slowestMs}ms 中位 ${r.medianMs}ms`);

  // 全部失败也不该抛错（由上层按 minSegmentsToProceed 决定放弃）
  globalThis.fetch = async () => { throw new Error('全断'); };
  const h2 = Sampler.download(refs, audio, null, { label: 'unit2', wantAtLeast: 2 });
  const r2 = await h2.all;
  check('全部失败 → ok=0 且不抛错', r2.ok === 0 && r2.dropped === 4, `ok=${r2.ok} dropped=${r2.dropped}`);
  const e2 = await h2.early;
  check('达不到阈值时 early 也会兜底兑现（不会永久挂起）',
    !!e2 && e2.ok === 0, `early.ok=${e2 && e2.ok}`);

  /* ---- 够用即开工：最慢那一段不该卡住整条链路 ---- */
  globalThis.fetch = async (url, opts) => {
    const rv = String((opts && opts.headers && opts.headers.Range) || '');
    const m = rv.match(/bytes=(\d+)-(\d+)/);
    const start = +m[1];
    const end = +m[2];
    if (start === 3072) await new Promise(r => setTimeout(r, 400));   // 故意慢
    return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(Math.max(1, end - start + 1)) };
  };

  const tE = Date.now();
  const he = Sampler.download(refs, audio, null, { label: 'eager', wantAtLeast: 2 });
  const early = await he.early;
  const earlyMs = Date.now() - tE;
  const full = await he.all;
  const allMs = Date.now() - tE;

  check('★ 够用即开工：early 明显早于 all 兑现',
    earlyMs < allMs - 150, `early ${earlyMs}ms / all ${allMs}ms`);
  check('early 是部分快照（段更少），all 才是全集',
    early.segs.length < full.segs.length && full.segs.length === 4,
    `early ${early.segs.length} 段 / all ${full.segs.length} 段`);
  check('early 快照带 partial 标记', early.partial === true);
  check('早兑现的段都在 all 里（不是另一份数据）',
    early.segs.every(s => full.segs.some(f => f.index === s.index)));

  globalThis.fetch = realFetch;
  C.requestGapMs = realGap;
  C.segRetryDelayMs = realRetryDelay;

  /* ---- 渐进式参数自洽 ---- */
  check('首批段数 < 总段数', C.firstBatchSegments < C.sampleSegments,
    `${C.firstBatchSegments} < ${C.sampleSegments}`);
  check('minSegmentsToProceed ≤ firstBatchSegments',
    C.minSegmentsToProceed <= C.firstBatchSegments,
    `${C.minSegmentsToProceed} ≤ ${C.firstBatchSegments}`);
  check('★ 够用即开工阈值：≥ 最低可算段数，且 < 首批段数（否则等于没提前）',
    C.firstBatchEagerAt >= C.minSegmentsToProceed && C.firstBatchEagerAt < C.firstBatchSegments,
    `${C.minSegmentsToProceed} ≤ ${C.firstBatchEagerAt} < ${C.firstBatchSegments}`);
  check('单段超时明显短于整体超时（长尾不该拖死全局）',
    C.segTimeoutMs < C.fetchTimeoutMs, `${C.segTimeoutMs}ms < ${C.fetchTimeoutMs}ms`);
}

/* ================================================================
 * 11. HUD / 快捷键：旁路与耗时归因必须可见
 * ================================================================ */

function testHudBypassRow() {
  section('11. HUD 可见性 + 快捷键（S2.2 新增）');

  const src = readFileSync(join(ROOT, 'src', 'hud.js'), 'utf8');
  check('HUD 有旁路行', /s\.bypass/.test(src) && /旁路/.test(src));
  check('初测 / 已精修 有区分', /初测/.test(src) && /已精修/.test(src));
  check('耗时按环节拆开（索引 / 下载 / 解码 / 响度）',
    /add\('索引'/.test(src) && /add\('下载'/.test(src) && /add\('解码'/.test(src) && /add\('响度'/.test(src));
  check('toast 已实现并导出', /function toast/.test(src) && /return \{[^}]*toast[^}]*\}/.test(src));

  const tm = src.match(/const TOAST_CSS\s*=\s*\[([\s\S]*?)\]\s*\.join/);
  check('能定位 TOAST_CSS 定义', !!tm);
  if (tm) {
    const d = [...tm[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
    check('toast 宿主同样以 all:initial 打头',
      d[0] === 'all:initial', `实际: ${d[0]}`);
    check('toast 保留了 fixed 定位与置顶 z-index',
      d.some(x => /^position\s*:\s*fixed\s*!important$/.test(x))
      && d.some(x => /^z-index\s*:\s*2147483647\s*!important$/.test(x)));
  }

  const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  // 剥掉注释再查 —— 注释里正好在解释「为什么不调用它」，不剥会误报
  const mainCode = main
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('★ 快捷键监听不拦截默认行为（铁律）', !/preventDefault/.test(mainCode));
  check('快捷键避开输入框（搜索 / 评论 / 发弹幕）',
    /tagName === 'INPUT'/.test(main) && /TEXTAREA/.test(main));
  check('菜单里有旁路入口', /旁路开关/.test(main));
}

/* ================================================================
 * 7. HUD 宿主样式 —— 防「浮层看不见」回归
 *
 *    这类错误编译器不报、运行时也不抛异常：浮层照样被创建、
 *    照样渲染，只是被推回文档流最底部。唯一能拦住它的就是
 *    对源码字面顺序做断言。S2 首次交付正是栽在这里。
 * ================================================================ */
function testHudHostCss() {
  section('7. HUD 宿主样式顺序（防「看不见」回归）');

  const src = readFileSync(join(ROOT, 'src', 'hud.js'), 'utf8');

  const m = src.match(/const HOST_CSS\s*=\s*\[([\s\S]*?)\]\s*\.join/);
  check('能定位 HOST_CSS 定义', !!m);
  if (!m) return;

  // 按字符串字面量切，而不是按行 —— 一行里可能塞了多条声明
  const decls = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
  console.log(`  声明序列: ${decls.join(' | ')}`);

  check('第一条声明是 all:initial', decls[0] === 'all:initial', `实际: ${decls[0]}`);
  check('all:initial 不在末尾（否则会重置掉定位）',
    decls[decls.length - 1] !== 'all:initial', `实际末尾: ${decls[decls.length - 1]}`);

  const at = decls.indexOf('all:initial');
  check('没有定位声明排在 all:initial 之前',
    decls.slice(0, at).every(d => !/^(position|left|bottom|top|right|z-index)\s*:/.test(d)),
    `all:initial 前的声明: ${decls.slice(0, at).join(', ') || '(无)'}`);

  check('显式补回 display（initial 会把它变成 inline）',
    decls.some(d => /^display\s*:/.test(d)));
  check('position:fixed 带 !important 保护',
    decls.some(d => /^position\s*:\s*fixed\s*!important$/.test(d)));
  check('z-index 取到 32 位上限',
    decls.some(d => /^z-index\s*:\s*2147483647\s*!important$/.test(d)));

  // 挂载路径的健壮性：不能只依赖 DOMContentLoaded 一条路
  check('挂载有 documentElement 兜底（body 可能还不存在）',
    /document\.body\s*\|\|\s*document\.documentElement/.test(src));
  check('挂载有定时补挂逻辑',
    /function armMountRetry[\s\S]*?setInterval/.test(src));
}

/* ================================================================ */

(async () => {
  console.log('S2 单元验证\n');
  testSidx();
  testKWeighting();
  await testPipeline();
  testGainPlanner();
  testHudHostCss();
  await testChunkedBiquad();
  testAudioEngineBypass();
  await testSamplerResilience();
  testHudBypassRow();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
