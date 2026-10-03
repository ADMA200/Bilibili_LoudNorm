/* ================================================================
 * audio-engine.js — Web Audio 图
 *
 * 链路：
 *     <video> → MediaElementSource → GainNode(gain) → destination
 *
 * S2 起 gain 不再是常数：由 analyzer 算好后经 setGainDb() 平滑写入。
 * 分析未完成期间保持 1.0（原声），算好后 120ms 斜坡落位 —— 这就是
 * 「先原声 → 平滑修正」的过渡方式。
 *
 * S2 不加 WaveShaper 软限幅：增益已由 GainPlanner 的峰值预算从源头
 * 保证不削波，事后压限反而会引入非线性失真。
 *
 * ┌─ 三条铁律（早期方案踩坑后确立，绝不让步）─────────────────────┐
 * │ 1. 永不 disconnect 任何节点 —— 断掉 MediaElementSource 会让该  │
 * │    <video> 永久无声，且重连抛 already-connected。              │
 * │ 2. 永不 pause / preventDefault / alert —— 脚本绝不干预播放控制。│
 * │ 3. 只有 AudioContext 确实处于 running 时才接管。否则 media 输出 │
 * │    会被路由进一个挂起的 context，结果是「视频彻底没声」。      │
 * └───────────────────────────────────────────────────────────────┘
 * ================================================================ */
const AudioEngine = (() => {
  let ctx = null;
  let masterGain = null;

  /** 已成功 createMediaElementSource 的元素（防重复调用抛 InvalidStateError） */
  const attached = new WeakSet();
  /** 尝试接管但失败的元素（如被 B 站杜比音效占用），不再重试以免刷屏 */
  const failed = new WeakSet();
  /** 因 ctx 未 running 而暂缓接管的元素，等用户手势后补上 */
  const pending = new Set();

  let gestureArmed = false;

  /** 当前**实际**施加的增益（dB）。分析未完成 / 未接管 / 旁路中时是 0 */
  let appliedGainDb = 0;

  /**
   * 归一流程「想要」施加的增益（dB）。
   *
   * 与 appliedGainDb 分开是为了旁路（S2.2）：旁路只把**实际**增益按到 0，
   * 心里记着的目标值原样留着，所以关掉旁路是瞬间恢复 —— 不用重新抽样。
   */
  let desiredGainDb = 0;

  /** 旁路开关：true = 听原声（不施加增益），分析照跑、结果照存 */
  let bypass = false;

  const stats = { attached: 0, failed: 0, deferred: 0, resumes: 0, gainSets: 0, bypassToggles: 0 };

  /* ---------------------------------------------------------- 上下文 */

  function ensureContext() {
    if (ctx) return ctx;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      Log.error('浏览器不支持 AudioContext，放弃接管');
      return null;
    }

    try {
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1.0; // 分析完成前保持原声
      masterGain.connect(ctx.destination);

      const base = typeof ctx.baseLatency === 'number' ? (ctx.baseLatency * 1000).toFixed(1) : '?';
      const out = typeof ctx.outputLatency === 'number' ? (ctx.outputLatency * 1000).toFixed(1) : '?';
      Log.info(`AudioContext 就绪 · state=${ctx.state} · rate=${ctx.sampleRate}Hz · baseLatency=${base}ms · outputLatency=${out}ms`);
    } catch (e) {
      Log.error('AudioContext 创建失败', e && e.message);
      ctx = null;
      masterGain = null;
    }
    return ctx;
  }

  async function ensureRunning() {
    if (!ctx) return false;
    if (ctx.state === 'running') return true;

    try {
      await ctx.resume();
      stats.resumes++;
    } catch (e) {
      Log.warn('ctx.resume() 被拒绝', e && e.message);
    }

    const ok = ctx.state === 'running';
    Log.debug(`ensureRunning → ${ctx.state}（${ok ? '可接管' : '暂不可接管'}）`);
    return ok;
  }

  /* ---------------------------------------------------------- 接管 */

  function isVideoEl(el) {
    // 用 tagName 而非 instanceof：userscript 沙箱下 instanceof 会因 realm 不同而失效
    return !!el && el.tagName === 'VIDEO';
  }

  function isAttached(el) { return attached.has(el); }

  /**
   * 尝试接管一个 <video>。返回是否已接管。
   * 绝不抛错、绝不断播 —— 任何失败都只是「保持原声」。
   */
  async function tryAttach(el) {
    if (!isVideoEl(el)) return false;
    if (attached.has(el)) return true;
    if (failed.has(el)) return false;
    if (pending.has(el)) return false;

    const c = ensureContext();
    if (!c) return false;

    // 铁律 3：ctx 不 running 就绝不接管，否则必然静音
    if (c.state !== 'running') {
      const running = await ensureRunning();
      if (!running) {
        pending.add(el);
        stats.deferred++;
        Log.info('AudioContext 尚未 running → 暂缓接管（此刻保持原声，绝不静音）');
        armGestureHook();
        return false;
      }
    }

    return doAttach(el);
  }

  function doAttach(el) {
    try {
      const source = ctx.createMediaElementSource(el);
      source.connect(masterGain);
      attached.add(el);
      stats.attached++;

      const src = el.currentSrc || el.src || '(无)';
      Log.info(`✓ 已接管 video · 第 ${stats.attached} 次 · 当前增益 ${appliedGainDb}dB · src=${src.slice(0, 58)}`);
      return true;
    } catch (e) {
      failed.add(el);
      stats.failed++;
      // InvalidStateError：该元素已被别人 createMediaElementSource 过
      // （典型场景：B 站「音量均衡」已开启并占用了音频源）
      const hint = e && e.name === 'InvalidStateError' ? '该元素音频源已被占用，保持原声' : '保持原声';
      Log.warn(`接管失败（${e && e.name || '未知'}）→ ${hint}`);
      return false;
    }
  }

  /* ------------------------------------------------------ 增益 */

  /**
   * 施加增益（dB）。用 setTargetAtTime 做指数斜坡，避免跳变「咔」声。
   *
   * ⚠️ 只在 ctx running 时用调度 API；否则直接赋值（调度在挂起上下文里
   *    不会推进，反倒会卡住值）。
   *
   * 永不抛错、永不断链 —— 任何失败都只是「音量维持原样」。
   */
  function setGainDb(db, opts) {
    const target = Number(db);
    if (!Number.isFinite(target)) return false;

    desiredGainDb = target;
    return applyGain(opts);
  }

  /** 把「实际该施加多少」算出来写进图里。旁路时一律按 0dB（原声） */
  function applyGain(opts) {
    const target = bypass ? 0 : desiredGainDb;

    const c = ensureContext();
    if (!c || !masterGain) return false;

    const linear = Math.pow(10, target / 20);
    const ramp = !(opts && opts.immediate === true);
    const tau = Number.isFinite(CONFIG.gainRampTau) ? CONFIG.gainRampTau : 0.04;

    try {
      if (ramp && c.state === 'running' && typeof masterGain.gain.setTargetAtTime === 'function') {
        const now = c.currentTime;
        const cur = masterGain.gain.value;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(cur, now);
        masterGain.gain.setTargetAtTime(linear, now, tau);
      } else {
        masterGain.gain.value = linear;
      }
      appliedGainDb = target;
      stats.gainSets++;
      Log.info(`→ 施加增益 ${target >= 0 ? '+' : ''}${target.toFixed(2)} dB（线性 ${linear.toFixed(4)}${ramp ? '，斜坡 ' + Math.round(tau * 3000) + 'ms' : '，立即'}${bypass ? ' · 旁路中' : ''}）`);
      return true;
    } catch (e) {
      Log.warn('设置增益失败（保持原声）', e && e.message);
      return false;
    }
  }

  /**
   * 旁路开关。开 → 立刻回到原声（0dB）；关 → 立刻恢复到归一后的增益。
   *
   * ⚠️ 只是「按 0dB」，**该不该有增益、增益多少全都记得**：
   *    · 不重新抽样、不重新解码、不动 desiredGainDb
   *    · 所以来回切是即时的，A/B 对比听不出分析开小差
   *    · 与「停用整条链路」是两回事 —— 停用走 Analyzer.setEnabled(false)
   *
   * 两种切换都走同一条 120ms 斜坡，不会「咔」一声。
   */
  function setBypass(v) {
    const next = !!v;
    if (next === bypass) return bypass;
    bypass = next;
    stats.bypassToggles++;
    applyGain();
    Log.info(bypass
      ? `旁路已开启 · 输出原声（0dB），归一结果仍记着 ${desiredGainDb >= 0 ? '+' : ''}${desiredGainDb.toFixed(2)}dB`
      : `旁路已关闭 · 恢复归一增益 ${desiredGainDb >= 0 ? '+' : ''}${desiredGainDb.toFixed(2)}dB`);
    return bypass;
  }

  function toggleBypass() { return setBypass(!bypass); }
  function isBypass() { return bypass; }

  /** 当前增益（线性值，用于验证真的写进了图里） */
  function getGainValue() {
    return masterGain ? masterGain.gain.value : null;
  }

  /** 当前**实际**增益（dB）—— 旁路中是 0 */
  function getAppliedGainDb() { return appliedGainDb; }

  /** 归一流程想要施加的增益（dB）—— 旁路中也保留原值 */
  function getDesiredGainDb() { return desiredGainDb; }

  /* ------------------------------------------------- 手势与待接管队列 */

  function armGestureHook() {
    if (gestureArmed) return;
    gestureArmed = true;

    const EVENTS = ['click', 'keydown', 'touchstart', 'pointerdown'];
    const onGesture = async () => {
      EVENTS.forEach(t => document.removeEventListener(t, onGesture, true));
      gestureArmed = false;
      Log.debug('捕获到用户手势');

      if (ctx) {
        try { await ctx.resume(); } catch (e) { /* 忽略 */ }
      }
      await drainPending();
    };

    EVENTS.forEach(t => document.addEventListener(t, onGesture, true));
    Log.debug('已注册一次性手势钩子（等待用户交互以解锁 AudioContext）');
  }

  async function drainPending() {
    if (!ctx || ctx.state !== 'running') return;
    if (pending.size === 0) return;

    const list = Array.from(pending);
    pending.clear();
    Log.debug(`补接管 ${list.length} 个暂缓元素`);

    for (const el of list) {
      await tryAttach(el);
    }
  }

  /* ---------------------------------------------------------- 验证 */

  /**
   * 信号探针：在 masterGain 上挂一个临时 Analyser 抽头，
   * 采样一小段时间测 RMS / 峰值。
   *
   * 这是 S1「真的有声」的硬证据 —— 只看 ctx.state 不足以证明音频在流动。
   * 抽头是并联的，不影响主链路；测完立即断开。
   */
  async function probeSignal(durationMs = 600) {
    const c = ensureContext();
    if (!c || !masterGain) return { ok: false, reason: 'no-context' };
    if (c.state !== 'running') return { ok: false, reason: `ctx-${c.state}` };

    const analyser = c.createAnalyser();
    analyser.fftSize = 2048;
    masterGain.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    let sumSq = 0;
    let n = 0;

    const t0 = Date.now();
    await new Promise(resolve => {
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSq += v * v;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          n++;
        }
        if (Date.now() - t0 >= durationMs) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });

    try { masterGain.disconnect(analyser); } catch (e) { /* 忽略 */ }

    const rms = n ? Math.sqrt(sumSq / n) : 0;
    return {
      ok: true,
      samples: n,
      rms: +rms.toFixed(6),
      rmsDb: +(20 * Math.log10(rms || 1e-9)).toFixed(2),
      peak: +peak.toFixed(6),
      peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(2),
      ctxState: c.state,
      verdict: peak > 1e-4 ? '有信号' : '静默',
    };
  }

  /* ---------------------------------------------------------- 对外 */

  return {
    ensureContext,
    ensureRunning,
    tryAttach,
    isAttached,
    probeSignal,
    setGainDb,
    setBypass,
    toggleBypass,
    isBypass,
    getGainValue,
    getAppliedGainDb,
    getDesiredGainDb,
    getContextState() { return ctx ? ctx.state : null; },
    stats() {
      return Object.assign({}, stats, {
        pending: pending.size,
        bypass,
        desiredGainDb,
        appliedGainDb,
      });
    },
  };
})();
