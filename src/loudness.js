/* ================================================================
 * loudness.js — ITU-R BS.1770 集成响度 + 真峰值
 *
 * 用途：拿到「拼接后的抽样音频」→ 算出整片响度（LUFS）。
 * 因为抽样是均匀覆盖整条时间轴的，这个值可以代表全片。
 *
 * 实现要点（对齐 BS.1770-4 / EBU R128）：
 *   a) K 加权 = 高架(+4dB@1682Hz) → 高通(38Hz)，系数按实际采样率现算
 *   b) 分块 400ms / 步长 100ms（75% 重叠）
 *   c) 块响度 l_j = -0.691 + 10·log10( Σ_i G_i · z_ij )
 *   d) 绝对门限：丢弃 l_j < -70 LUFS
 *   e) 相对门限：Γ = 保留块能量均值(dB) − 10，再筛一遍
 *   f) 集成响度 = -0.691 + 10·log10( Σz / N )
 *   g) 真峰值 = 未加权 PCM 的最大绝对值（不做过采样，留 1dB 余量够用）
 *
 * 系数采用 pyloudnorm / De Man 那套「按采样率现算」的写法，
 * 与 BS.1770 参考系数的偏差约 0.25dB —— 对「拉齐音量」完全够用。
 * ================================================================ */
const Loudness = (() => {
  const OFFSET_691 = -0.691;
  const ABS_GATE_LUFS = -70;
  const REL_GATE_LU = 10;

  /* ------------------------------------------------- K 加权滤波器 */

  /** 高架滤波：G=+3.999843853973347 dB, fc=1681.974450955533 Hz, Q=0.7071752369554196 */
  function highShelfCoeffs(fs) {
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const fc = 1681.974450955533;

    const K = Math.tan(Math.PI * fc / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;

    return {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  }

  /**
   * 高通滤波：fc=38.13547087602444 Hz, Q=0.5003270373238773
   *
   * ⚠️ 分子**不除以 a0**（b = [1, -2, 1]）—— 这不是笔误，BS.1770-4 的高通
   *    就是这么一个「整体带 +0.043dB 增益」的形式。若按常规归一化（除以 a0），
   *    实测响度会系统性偏低 0.043dB，与 B 站元数据对不上。
   *    单元测试用标准表里的 48kHz 系数逐频点比对来钉住这件事。
   */
  function highPassCoeffs(fs) {
    const Q = 0.5003270373238773;
    const fc = 38.13547087602444;

    const K = Math.tan(Math.PI * fc / fs);
    const a0 = 1 + K / Q + K * K;

    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  }

  /**
   * 直接 I 型双二阶，原地过滤。
   * 返回过滤后的峰值（顺带把「未加权真峰值」也扫出来，省一遍遍历）。
   */
  function biquadInPlace(x, c) {
    const st = biquadState();
    biquadRange(x, 0, x.length, c, st);
  }

  /** IIR 的四个延迟单元。分块滤波必须把状态带过块边界，否则块间会有跳变 */
  function biquadState() { return { x1: 0, x2: 0, y1: 0, y2: 0 }; }

  /**
   * 对 x[s, e) 做一次原地双二阶，状态从 st 续上、算完写回 st。
   *
   * 为什么要有「分块」版本（S2.2）：60s 立体声有 576 万个采样点，
   * 一趟滤波 + 累加就是几百毫秒的**不可中断**长任务 —— 页面正开着 B 站，
   * 主线程被占住会连带影响播放器 UI 与弹幕。切块后每块之间让一次主线程，
   * 结果与一次性滤波**逐位相同**（状态连续，不是重新起头）。
   */
  function biquadRange(x, s, e, c, st) {
    let x1 = st.x1, x2 = st.x2, y1 = st.y1, y2 = st.y2;
    for (let i = s; i < e; i++) {
      const xi = x[i];
      const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = xi;
      y2 = y1; y1 = yi;
      x[i] = yi;
    }
    st.x1 = x1; st.x2 = x2; st.y1 = y1; st.y2 = y2;
  }

  function peakOf(x) {
    let p = 0;
    for (let i = 0; i < x.length; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      if (a > p) p = a;
    }
    return p;
  }

  /**
   * 把多段解码结果拼成一条连续 PCM（供 measure 使用）。
   *
   * 段落之间做 5ms 淡入淡出：抽样段在原片里是连续的，但抽出来是彼此不相邻的
   * 片段，硬拼会在边界产生跳变。淡入淡出对集成响度的影响远小于 0.01dB
   * （5ms / 5000ms），但能让波形干净。
   *
   * @param {BaseAudioContext} scope 用来 createBuffer 的上下文
   * @param {AudioBuffer[]} buffers
   */
  function concatBuffers(scope, buffers) {
    const usable = (buffers || []).filter(b => b && b.length > 0);
    if (!usable.length) return null;

    const fs = usable[0].sampleRate;
    const channels = usable.reduce((m, b) => Math.min(m, b.numberOfChannels), Infinity);
    const total = usable.reduce((a, b) => a + b.length, 0);

    const out = scope.createBuffer(channels, total, fs);
    const fade = Math.min(Math.round(0.005 * fs), Math.floor(total / 8));

    let off = 0;
    for (const b of usable) {
      for (let c = 0; c < channels; c++) {
        const dst = out.getChannelData(c);
        const src = b.getChannelData(c);
        dst.set(src, off);

        // 首尾淡入淡出
        for (let i = 0; i < fade; i++) {
          const w = i / fade;
          dst[off + i] *= w;
          dst[off + b.length - 1 - i] *= w;
        }
      }
      off += b.length;
    }
    return out;
  }

  /* ---------------------------------------------------- 主入口 */

  /**
   * @param {AudioBuffer} audioBuffer 解码后的抽样音频
   * @param {{onYield?: Function}} [opts]
   * @returns {Promise<{lufs, truePeakDb, truePeakLinear, blocks, blocksAfterAbs, blocksAfterRel, frames, sampleRate, channels, processedMs}>}
   */
  async function measure(audioBuffer, opts) {
    const o = opts || {};
    const t0 = Date.now();

    const fs = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const frames = audioBuffer.length;

    const hs = highShelfCoeffs(fs);
    const hp = highPassCoeffs(fs);

    /** 逐采样能量累加器（已 K 加权）
     *
     * ⚠️ BS.1770 对多声道是**求和**不是平均：l_j = -0.691 + 10·log10(Σ_i G_i·z_ij)，
     *    环绕声权重 G 为 {L:1, R:1, C:1.41, Ls/Rs:1.41}。
     *    同一信号同时放进左右两声道，测得响度比单声道**高 3.01dB** —— 这是标准的
     *    规定行为（也是 mono→stereo 上混会让测量响度上升的原因）。
     *    早期版本按 numberOfChannels 做了平均，结果所有立体声素材系统性偏低 3dB，
     *    与 B 站官方元数据对不上。单元测试专门钉死这条。
     */
    const z = new Float64Array(frames + 1);
    let truePeakLinear = 0;

    /**
     * 分块粒度：每块相当于 CONFIG.lumChunkFrames 帧（默认 5s 音频）。
     * 但**不是每块都让线程** —— 只有距上次让步超过 8ms 才让，
     * 否则小块素材上会被 setTimeout 的调度开销反噬（本来 60ms 算完，
     * 硬生生被几百次让步拖成 300ms）。
     */
    const chunk = Math.max(1, Math.min(frames, Math.floor(CONFIG.lumChunkFrames) || frames));
    const wantYield = typeof o.onYield === 'function';
    let lastYield = Date.now();

    for (let ch = 0; ch < channels; ch++) {
      const src = audioBuffer.getChannelData(ch);
      const buf = new Float32Array(frames);
      buf.set(src);

      const st1 = biquadState();
      const st2 = biquadState();

      for (let s = 0; s < frames; s += chunk) {
        const e = Math.min(s + chunk, frames);

        // 未加权峰值（真峰值近似）——必须在加权改写之前扫
        let pk = 0;
        for (let i = s; i < e; i++) {
          const a = buf[i] < 0 ? -buf[i] : buf[i];
          if (a > pk) pk = a;
        }
        if (pk > truePeakLinear) truePeakLinear = pk;

        // K 加权（状态跨块延续，结果与一次性滤波逐位相同）
        biquadRange(buf, s, e, hs, st1);
        biquadRange(buf, s, e, hp, st2);

        for (let i = s; i < e; i++) {
          const v = buf[i];
          z[i] += v * v;
        }

        if (wantYield && Date.now() - lastYield > 8) {
          lastYield = Date.now();
          await o.onYield(ch);
        }
      }
    }

    /* 声道能量直接相加（不除以声道数）—— 见上面 z 的说明 */

    /* ------------------------------------------------ 分块与门限 */

    const blockLen = Math.round(0.4 * fs);
    const stepLen = Math.round(0.1 * fs);

    const blockEnergy = [];   // 每个块的 Σz / blockLen
    if (frames >= blockLen) {
      for (let s = 0; s + blockLen <= frames; s += stepLen) {
        let sum = 0;
        // 分片累加，避免超长循环阻塞
        for (let i = s; i < s + blockLen; i++) sum += z[i];
        blockEnergy.push(sum / blockLen);
      }
    }

    const lufsOf = (energy) => OFFSET_691 + 10 * Math.log10(energy > 0 ? energy : 1e-12);

    // d) 绝对门限
    const stage1 = blockEnergy.filter(e => lufsOf(e) >= ABS_GATE_LUFS);

    let integrated = null;
    let stage2 = [];
    if (stage1.length) {
      // e) 相对门限
      let sum = 0;
      for (let i = 0; i < stage1.length; i++) sum += stage1[i];
      const meanEnergy = sum / stage1.length;
      const gamma = lufsOf(meanEnergy) - REL_GATE_LU;

      stage2 = stage1.filter(e => lufsOf(e) >= gamma);
      const use = stage2.length ? stage2 : stage1;

      let sum2 = 0;
      for (let i = 0; i < use.length; i++) sum2 += use[i];
      integrated = lufsOf(sum2 / use.length);
    }

    const truePeakDb = 20 * Math.log10(truePeakLinear > 0 ? truePeakLinear : 1e-12);

    return {
      lufs: integrated === null ? null : +integrated.toFixed(2),
      truePeakDb: +truePeakDb.toFixed(2),
      truePeakLinear,
      blocks: blockEnergy.length,
      blocksAfterAbs: stage1.length,
      blocksAfterRel: stage2.length,
      frames,
      sampleRate: fs,
      channels,
      processedMs: Date.now() - t0,
    };
  }

  return {
    measure, concatBuffers, highShelfCoeffs, highPassCoeffs,
    biquadInPlace, biquadRange, biquadState,
  };
})();
