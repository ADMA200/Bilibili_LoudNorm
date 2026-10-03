/* ================================================================
 * gain-planner.js — 响度 → 增益（纯计算）
 *
 *   gain_dB = 目标响度 − 实测响度
 *
 * 然后受三重约束：
 *   ① 削波预算（只限制**提升**，不强制衰减）
 *   ② 档案上限 profile.maxBoostDb
 *   ③ 档案下限 profile.minGainDb
 *
 * ⚠️ 关于①，与方案文档 §4.4 的原始写法有一处**有意修正**：
 *    原文写的是 maxBoost_dB = 峰值余量 − 实测真峰值，然后
 *    final_gain = clamp(gain, -INF, maxBoost_dB)。
 *    那样写会把「上限」当成「最大增益」，于是当素材本身已经过峰
 *    （真峰值 > 0 dBTP，在响度压缩过的素材里很常见）时，
 *    maxBoost 变成负数，一个本该 +4.7dB 的素材会被压成 −1.8dB ——
 *    结果比原声还小 1.8dB，离目标越来越远。
 *
 *    实测反例：BV1muab6rEbA 实测 −18.69 LUFS、真峰值 +0.79 dBTP。
 *    按原文：gain = −1.79dB → 输出 −20.5 LUFS（目标 −14，差 6.5 LU）。
 *    按修正：gain = 0dB      → 输出 −18.69 LUFS（不引入新削波，也不倒扣音量）。
 *
 *    所以削波预算只做一件事：**算出来要提多少，最多提到不越天花板为止**。
 *    衰减永远放行 —— 衰减只会让峰值更低，不可能造成削波。
 * ================================================================ */
const GainPlanner = (() => {

  function currentProfile() {
    return CONFIG.profiles[CONFIG.profile] || CONFIG.profiles.standard;
  }

  /**
   * @param {{measuredLufs: number|null, truePeakDb: number|null}} input
   * @returns {{gainDb, targetLufs, limited, limitReason, ceilingHeadroom, rawGainDb}}
   */
  function plan(input) {
    const p = currentProfile();
    const targetLufs = p.targetLufs;

    const measured = input && input.measuredLufs;
    if (!Number.isFinite(measured)) {
      return {
        gainDb: 0, targetLufs, limited: false,
        limitReason: 'no-measurement', ceilingHeadroom: null, rawGainDb: null,
      };
    }

    const rawGainDb = targetLufs - measured;
    let gainDb = rawGainDb;
    let limited = false;
    let limitReason = null;
    let ceilingHeadroom = null;

    const tp = input.truePeakDb;
    if (Number.isFinite(tp)) {
      ceilingHeadroom = CONFIG.peakCeilingDb - tp;

      // 只夹「提升」的部分；衰减不受峰值约束
      const maxAllowedGain = Math.max(0, ceilingHeadroom);
      if (rawGainDb > maxAllowedGain) {
        gainDb = maxAllowedGain;
        limited = true;
        /* 〔S3.2.5〕这句话会**直接显示在面板上**，所以不写「削波预算 / dBTP / 余量」这些
         * 只有音频人才懂的量 —— 统一成「提多少 + 为什么」两段式：
         *   · 有余量  → `+1.7 dB（防止爆音）`
         *   · 已过峰  → `+0 dB（素材已过峰）`   ← 提到 0，即「一点都不提」
         * 真峰值没丢：console.table 有独立的「真峰值dBTP」列，日志里紧跟「实测 → 目标」。
         * 〔格式〕数值与单位之间**一律一个空格**（`+1.7 dB` / `+0 dB` / `+6 dB` / `-60 dB`），
         * 与面板其它 dB 读数（panel.js 的 fmt）保持一致 —— moxia要求。 */
        limitReason = ceilingHeadroom < 0
          ? '+0 dB（素材已过峰）'
          : `+${ceilingHeadroom.toFixed(1)} dB（防止爆音）`;
      }
    }

    const cap = Number.isFinite(p.maxBoostDb) ? p.maxBoostDb : 12;
    if (gainDb > cap) {
      gainDb = cap;
      limited = true;
      limitReason = `档案上限 +${cap} dB`;
    }

    const floor = Number.isFinite(p.minGainDb) ? p.minGainDb : -60;
    if (gainDb < floor) {
      gainDb = floor;
      limited = true;
      limitReason = `档案下限 ${floor} dB`;
    }

    return {
      gainDb: +gainDb.toFixed(2),
      targetLufs,
      limited,
      limitReason,
      ceilingHeadroom: ceilingHeadroom === null ? null : +ceilingHeadroom.toFixed(2),
      rawGainDb: +rawGainDb.toFixed(2),
    };
  }

  /** 预设档案列表，供 UI 用 */
  function listProfiles() {
    return Object.keys(CONFIG.profiles).map(k => Object.assign({ key: k }, CONFIG.profiles[k]));
  }

  return { plan, currentProfile, listProfiles };
})();
