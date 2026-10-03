/* ================================================================
 * analyzer.js — 全链路编排
 *
 *   识别页型/key → 查缓存 → 取流 → (FastPath 元数据 | SamplePath 抽样)
 *     → 算响度 → 规划增益 → 平滑写入 GainNode → 写缓存 → 更新 HUD
 *
 * 三条原则：
 *   ① 全程异步、绝不阻塞播放。分析没算完就保持原声。
 *   ② job 令牌：SPA 切视频后来新任务，旧任务在每个 await 后自我了断，
 *      绝不把上一个视频的响度安到新视频头上。
 *   ③ 任何一步失败 → 增益归零（原声），只更新状态，不干预播放。
 *
 * S2.2 起 SamplePath 是**渐进式**的（见 CONFIG.progressive）：
 *   第一批（coarse，6 段）到齐就立刻测量并落位 → 用户 1–2s 内就能听到结果；
 *   剩下的段后台补齐后精修，只有当精修建议与初测差 ≥ refineMinDeltaDb
 *   才重新落位（小差异不动，避免听感上无意义的抖动）。
 *   这么改是为了治「抽样时长不稳定，有时要等 6s 以上」—— 木桶效应下，
 *   最慢那一段不该决定整条链路何时可用。
 * ================================================================ */
const Analyzer = (() => {
  let jobSeq = 0;
  let runningKey = null;
  let appliedKey = null;

  /**
   * 本页面会话内已算过的结果（key → 结论）。
   * 用途：SPA 来回切视频时，重挂增益不该把「来源」降级成含糊的「缓存」，
   * 应该原样复现上次的结论（是元数据就是元数据，是抽样就是抽样）。
   */
  const computed = new Map();

  const state = {
    phase: 'idle',
    key: null,
    source: null,
    measuredLufs: null,
    truePeakDb: null,
    targetLufs: null,
    gainDb: 0,
    limited: false,
    limitReason: null,
    reason: null,
    picked: null,
    sidxSegments: null,
    sampledBytes: null,
    audioSeconds: null,
    decodeRatio: null,
    decodeFailed: null,
    /** 渐进式：结果是否已经过第二批精修 */
    refined: null,
    /** 精修是否真的改动了增益（差 < refineMinDeltaDb 就只更新记录） */
    refineMoved: null,
    refineDelta: null,
    timing: {},
    totalMs: null,
  };

  function snapshot() {
    return {
      phase: state.phase, key: state.key, source: state.source,
      measuredLufs: state.measuredLufs, truePeakDb: state.truePeakDb,
      targetLufs: state.targetLufs, gainDb: state.gainDb,
      limited: state.limited, limitReason: state.limitReason,
      reason: state.reason, picked: state.picked, sidxSegments: state.sidxSegments,
      sampledBytes: state.sampledBytes, audioSeconds: state.audioSeconds,
      decodeRatio: state.decodeRatio, decodeFailed: state.decodeFailed,
      refined: state.refined, refineMoved: state.refineMoved, refineDelta: state.refineDelta,
      timing: Object.assign({}, state.timing), totalMs: state.totalMs,
      appliedGainLinear: AudioEngine.getGainValue(),
      ctxState: AudioEngine.getContextState(),
      /* 旁路是实时读的 —— 它可以在分析结束之后被用户随手切 */
      bypass: AudioEngine.isBypass(),
      desiredGainDb: AudioEngine.getDesiredGainDb(),
      appliedGainDb: AudioEngine.getAppliedGainDb(),
    };
  }

  function push(phase, patch, reason) {
    state.phase = phase;
    if (patch) Object.assign(state, patch);
    if (reason !== undefined) state.reason = reason;
    Hud.update(snapshot());
  }

  /* -------------------------------------------------- 解码与测量 */

  function getOfflineCtor() {
    return window.OfflineAudioContext || window.webkitOfflineAudioContext || null;
  }

  /** 固定并发上限的 map（与 Sampler.pacedPool 不同，这里不需要启动间隔） */
  async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    async function runner() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, runner));
    return out;
  }

  /**
   * 逐段解码，返回可用 AudioBuffer 列表（**不合并**）。
   *
   * ⚠️ 不能把多个 moof 拼成一个大 Blob 一次解码：fMP4 分段的 trun 用的是
   *    相对原文件的 data_offset，换到新 Blob 里全部失效，解码器读到第一段
   *    结束就停（实测 57.3s 只解出 4.9s，响度偏 2.9 LU）。
   *    init + 任意单片段本来就是合法的独立解码单元，逐段解最稳。
   *
   * 分批场景下这里只会被喂「这一批」的段，前一批的 buffer 由调用方留着，
   * 最后一起合并测量 —— 不重复解码、不重复下载。
   */
  async function decodeAll(scope, initBuf, mimeType, segs, onProgress) {
    let failed = 0;
    let done = 0;
    const limit = Math.max(1, CONFIG.decodeConcurrency || 2);

    const out = await mapLimit(segs, limit, async (seg) => {
      let r = null;
      try {
        const blob = Sampler.fragmentBlob(initBuf, seg.buf, mimeType);
        const ab = await blob.arrayBuffer();
        r = { seg, buffer: await scope.decodeAudioData(ab) };
      } catch (e) {
        failed++;
        Log.warn(`第 ${seg.index} 段解码失败（跳过）· ${(e && e.message) || e}`);
      }
      done++;
      if (typeof onProgress === 'function') onProgress(done, segs.length, failed);
      return r;
    });

    const items = out.filter(Boolean);
    return { items, buffers: items.map(x => x.buffer), failed, requested: segs.length };
  }

  /** 合并 + 测量（K 加权 / 门限 / 真峰值） */
  async function measureMerged(scope, buffers) {
    const merged = Loudness.concatBuffers(scope, buffers);
    if (!merged) throw new Error('没有可用的解码结果');
    const m = await Loudness.measure(merged, {
      onYield: () => new Promise(r => setTimeout(r, 0)),
    });
    Log.info(`解码合并 · ${merged.duration.toFixed(1)}s · ${merged.length} 帧 · ${merged.sampleRate}Hz · ${merged.numberOfChannels}ch · 测量 ${m.processedMs}ms`);
    return { merged, m };
  }

  function ratioOf(gotSec, wantSec) {
    if (!Number.isFinite(wantSec) || wantSec <= 0) return null;
    return +(gotSec / wantSec).toFixed(3);
  }

  /* ---------------------------------------------------- 单次分析 */

  async function analyzeKey(info, key, videoEl, myJob) {
    const t0 = Date.now();
    state.timing = {};
    state.totalMs = null;
    state.picked = null;
    state.sidxSegments = null;
    state.sampledBytes = null;
    state.audioSeconds = null;
    state.decodeRatio = null;
    state.decodeFailed = null;
    state.refined = null;
    state.refineMoved = null;
    state.refineDelta = null;

    /* 0. 换片先回中性，避免把上一个视频的增益带到新视频上 */
    appliedKey = null;
    AudioEngine.setGainDb(0);

    const stage = (ph, extra) => {
      if (jobSeq !== myJob) return;
      push(ph, extra || {});
    };

    /* 1. 缓存 */
    push('cache', { key: key, source: null, reason: null });
    const cached = Store.get(key);
    const cachedUsable = cached && Number.isFinite(cached.measuredLufs);

    /* 上次只跑完初测就被切走了（coarse 缓存）→ 先秒出，再往下走精修 */
    const needsRefine = !!(cachedUsable && cached.coarse && CONFIG.progressive);

    if (cachedUsable && !needsRefine) {
      const planned = GainPlanner.plan({ measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
      const record = {
        source: 'cache', measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb,
        sidxSegments: cached.sidxSegments, picked: cached.picked,
        sampledBytes: null, audioSeconds: cached.audioSeconds, decodeRatio: cached.decodeRatio,
        refined: cached.coarse ? false : true,
        timing: {},
      };
      computed.set(key, record);
      push('active', Object.assign({}, record, {
        targetLufs: planned.targetLufs, gainDb: planned.gainDb, limited: planned.limited,
        limitReason: planned.limitReason, reason: null, totalMs: Date.now() - t0,
      }));
      Log.info(`命中缓存 ${key} · 实测 ${cached.measuredLufs} LUFS（原来源 ${cached.source}）→ 增益 ${planned.gainDb}dB`);
      return;
    }

    if (needsRefine) {
      const planned0 = GainPlanner.plan({ measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb });
      AudioEngine.setGainDb(planned0.gainDb);
      appliedKey = key;
      push('active', {
        key, source: 'cache', measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb,
        targetLufs: planned0.targetLufs, gainDb: planned0.gainDb, limited: planned0.limited,
        limitReason: planned0.limitReason, reason: null, totalMs: Date.now() - t0,
        refined: false, picked: cached.picked, sidxSegments: cached.sidxSegments,
        audioSeconds: cached.audioSeconds, decodeRatio: cached.decodeRatio,
      });
      Log.info(`命中初测缓存 ${key}（${cached.measuredLufs} LUFS / ${cached.picked} 段）→ 先立即生效，再后台精修`);
    }

    /* 2. 取流 */
    push('fetching');
    const tFetch = Date.now();
    const got = await PlayInfo.get(info, videoEl, key);
    state.timing.fetchMs = Date.now() - tFetch;
    if (jobSeq !== myJob) return;

    const pi = got.info;
    if (!pi) throw new Error('取流失败：页面与接口都没有可用数据');
    if (pi.isDrm) { push('skipped', { reason: 'DRM 加密内容，放弃分析', targetLufs: GainPlanner.currentProfile().targetLufs }, 'DRM'); return; }
    if (pi.isPreview) { push('skipped', { reason: '试看片段，未完整解锁', targetLufs: GainPlanner.currentProfile().targetLufs }, '试看'); return; }
    if (pi.hasDurlOnly) { push('skipped', { reason: '仅返回 durl（未拿到 dash），无法抽样', targetLufs: GainPlanner.currentProfile().targetLufs }, 'durl'); return; }

    /* 番剧切集：SSR 那份属于上一个 ep，接口给的才是当前 ep。
     * 但播放器换流常晚 1–3s（S2.1 实测），此时若立刻施加增益，
     * 就成了「把新集的响度压到还在播的旧集尾巴上」。用接口给出的时长
     * 做一次**有界**等待，等播放器真的换了流再算。 */
    if (info.kind === 'pgc') {
      const alive = await waitElementDuration(videoEl, pi.duration, myJob);
      if (!alive) return;
    }

    let measuredLufs = null;
    let truePeakDb = null;
    let source = null;
    let planned = null;
    let refined = null;

    /* 3a. FastPath：B 站自己的响度元数据，零下载零解码 */
    if (!CONFIG.forceSamplePath && pi.volumeMeta && Number.isFinite(pi.volumeMeta.measuredI)) {
      measuredLufs = pi.volumeMeta.measuredI;
      truePeakDb = Number.isFinite(pi.volumeMeta.measuredTp) ? pi.volumeMeta.measuredTp : null;
      source = 'meta';
      planned = GainPlanner.plan({ measuredLufs, truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
      Log.info(`FastPath · B 站元数据 measured_i=${measuredLufs} LUFS · measured_tp=${truePeakDb} dBTP · target_i=${pi.volumeMeta.targetI}（零下载）`);
    } else {
      /* 3b. SamplePath：全片抽样 + 本地测量（渐进式两批） */
      if (!pi.audio) throw new Error('没有可用的 dash 音频轨，无法抽样');
      Log.info(`SamplePath · 音频 id=${pi.audio.id} · ${pi.audio.mimeType} · ${(pi.audio.bandwidth / 1000).toFixed(0)}kbps · id 优先级命中`);

      const tSample = Date.now();

      /* --- 取索引（init + sidx 并行） --- */
      let prep = await Sampler.prepare(pi.audio, stage);
      if (jobSeq !== myJob) return;

      state.sidxSegments = prep.refs.length;
      state.timing.initMs = prep.initMs;
      state.timing.indexMs = prep.indexMs;
      state.timing.prepMs = prep.prepMs;

      /* --- 分批计划 ---
       * coarse 从 picks 里**等距**挑（含首尾），所以段数少了、覆盖仍是 0%–100%；
       * rest 是补集，两批合起来正好等于原计划的 12 段，不重复下载。 */
      const coarsePicks = CONFIG.progressive
        ? Sidx.pickCoarse(prep.picks, CONFIG.firstBatchSegments)
        : prep.picks.slice();
      const restPicks = prep.picks.filter(i => coarsePicks.indexOf(i) < 0);

      const refsBy = (picks, p) => picks.map(i => p.refs[i]);

      /**
       * 提前开工阈值。
       *
       * 分批模式下要「比最低可算多一段」—— 既保证够算，又不等最慢那一段。
       * 不分批时反过来：把阈值设成整批，恢复「全部到齐才开工」的语义，
       * 这样 A/B 对照才是在比同一件事（见 probe/s2-timing.mjs）。
       */
      const wantAtLeast = CONFIG.progressive
        ? Math.max(2, Math.min(
          Number.isFinite(CONFIG.firstBatchEagerAt) ? CONFIG.firstBatchEagerAt : 4,
          coarsePicks.length,
        ))
        : coarsePicks.length;

      const startBatch = (picks, p, label, extra) => Sampler.download(
        refsBy(picks, p), pi.audio, stage,
        Object.assign({
          label,
          wantAtLeast,
          onProgress: (d, t, drop) => {
            if (jobSeq !== myJob) return;
            push('segments', { picked: picks.length, segDone: d, segTotal: t, segDropped: drop, refining: !!(extra && extra.refining) });
          },
        }, extra || {}),
      );

      /* --- 第一批：够用就开工 --- */
      let h1 = startBatch(coarsePicks, prep, 'coarse');
      let first = await h1.early;
      if (jobSeq !== myJob) return;

      /* 自校验：正确基准点下，抽样段必须以 moof box 开头。
       * 若不然（B 站改版 / 非标准封装），退回绝对偏移重下这一批。 */
      const looksRight = b => !!b.segs.length && Sidx.startsWithBox(b.segs[0].buf, 'moof');
      if (!looksRight(first)) {
        Log.warn(`首批抽样不是以 moof 开头（基准点 ${prep.anchor} 可能不对）→ 回退到绝对偏移重下`);
        try {
          prep = await Sampler.prepare(pi.audio, stage, 0);
          if (jobSeq !== myJob) return;
          h1 = startBatch(coarsePicks, prep, 'coarse2');
          first = await h1.early;
          if (jobSeq !== myJob) return;
        } catch (e) {
          Log.warn(`回退重下也失败：${(e && e.message) || e}`);
        }
        if (!looksRight(first)) throw new Error('抽样段结构异常（不是 moof 起始），无法解码');
      }

      const need = Math.min(CONFIG.minSegmentsToProceed, coarsePicks.length);
      if (first.ok < need) {
        throw new Error(`抽样失败：只拿到 ${first.ok}/${first.requested} 段（低于下限 ${need}），本次放弃`);
      }

      const OfflineCtor = getOfflineCtor();
      if (!OfflineCtor) throw new Error('浏览器不支持 OfflineAudioContext');
      // 只借它的 decodeAudioData / createBuffer：B 站音频本来就是 48kHz，不触发重采样
      const scope = new OfflineCtor(1, 1, 48000);

      /* --- 解码 + 测量 + 立即落位（此时可能还有段在后台取，不等） --- */
      push('decoding', { picked: first.ok, audioSeconds: +first.seconds.toFixed(1) });
      const tDecode = Date.now();
      const d1 = await decodeAll(scope, prep.initBuf, pi.audio.mimeType, first.segs);
      if (jobSeq !== myJob) return;
      if (!d1.buffers.length) throw new Error('全部抽样段解码失败');
      state.timing.decodeMs = Date.now() - tDecode;
      state.decodeFailed = d1.failed;

      push('analyzing', { picked: first.ok });
      const r1 = await measureMerged(scope, d1.buffers);
      if (jobSeq !== myJob) return;
      state.timing.lufsMs = r1.m.processedMs;

      measuredLufs = r1.m.lufs;
      truePeakDb = r1.m.truePeakDb;
      source = 'sample';
      if (!Number.isFinite(measuredLufs)) throw new Error('响度计算无有效结果（可能全片静音）');

      planned = GainPlanner.plan({ measuredLufs, truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
      refined = false;

      /** 已经用过的段号 —— 后面补齐时靠它去重，绝不重复解码同一段 */
      const usedIdx = first.segs.map(s => s.index);

      state.timing.sampleMs = Date.now() - tSample;
      state.timing.firstMs = Date.now() - t0;
      state.timing.segSlowestMs = first.slowestMs;
      state.timing.segMedianMs = first.medianMs;
      state.totalMs = Date.now() - t0;
      state.picked = first.ok;
      state.sampledBytes = prep.initBuf.byteLength + first.bytes;
      state.audioSeconds = +first.seconds.toFixed(1);
      state.decodeRatio = ratioOf(first.seconds, first.requestedSeconds);

      Log.info(`✓ 初测落位 · ${first.ok}/${first.requested} 段${first.partial ? '（够用即开工，其余在后台）' : ''} · ${state.audioSeconds}s 音频 · 实测 ${measuredLufs} LUFS → 增益 ${planned.gainDb >= 0 ? '+' : ''}${planned.gainDb}dB · 首批耗时 ${state.timing.firstMs}ms（下载 ${first.wallMs}ms，最慢段 ${first.slowestMs}ms / 中位 ${first.medianMs}ms）`);

      /* --- 补齐 + 精修 ---
       * 要补的段来自两处，去重后一起解码、一起测量：
       *   ① 首批里「够用即开工」时还没回来的那些（h1.all 这时应该已经齐了）
       *   ② 第二批 restPicks
       * 全程只解码一次，不重复下也不重复算。 */
      const b1 = await h1.all;
      if (jobSeq !== myJob) return;

      const leftFromB1 = b1.segs.filter(s => usedIdx.indexOf(s.index) < 0);

      if (CONFIG.progressive && (restPicks.length || leftFromB1.length)) {
        const tRefine = Date.now();

        let b2 = { segs: [], ok: 0, bytes: 0, seconds: 0, requested: 0, requestedSeconds: 0, slowestMs: null, dropped: 0 };
        if (restPicks.length) {
          stage('segments', { picked: restPicks.length, segDone: 0, segTotal: restPicks.length, refining: true });
          const h2 = startBatch(restPicks, prep, 'fine', { refining: true, wantAtLeast: 0 });
          b2 = await h2.all;
          if (jobSeq !== myJob) return;
        }

        const more = leftFromB1.concat(b2.segs);

        if (more.length) {
          push('decoding', { refining: true });
          const d2 = await decodeAll(scope, prep.initBuf, pi.audio.mimeType, more);
          if (jobSeq !== myJob) return;

          if (d2.buffers.length) {
            push('analyzing', { refining: true });
            const r2 = await measureMerged(scope, d1.buffers.concat(d2.buffers));
            if (jobSeq !== myJob) return;

            const planned2 = GainPlanner.plan({ measuredLufs: r2.m.lufs, truePeakDb: r2.m.truePeakDb });
            const delta = Math.abs(planned2.gainDb - planned.gainDb);
            const moved = delta >= CONFIG.refineMinDeltaDb;

            if (moved) {
              AudioEngine.setGainDb(planned2.gainDb);
              appliedKey = key;
            }

            measuredLufs = r2.m.lufs;
            truePeakDb = r2.m.truePeakDb;
            planned = planned2;
            refined = true;

            const finalOk = first.ok + more.length;
            const finalRequested = first.requested + b2.requested;
            const finalSeconds = first.seconds + leftFromB1.reduce((a, s) => a + s.duration, 0) + b2.seconds;
            const finalRequestedSeconds = first.requestedSeconds + b2.requestedSeconds;

            state.refined = true;
            state.refineMoved = moved;
            state.refineDelta = +delta.toFixed(2);
            state.picked = finalOk;
            state.sampledBytes = prep.initBuf.byteLength + first.bytes
              + leftFromB1.reduce((a, s) => a + s.buf.byteLength, 0) + b2.bytes;
            state.audioSeconds = +finalSeconds.toFixed(1);
            state.decodeRatio = ratioOf(finalSeconds, finalRequestedSeconds);
            state.decodeFailed = d1.failed + d2.failed;
            state.timing.refineMs = Date.now() - tRefine;
            state.timing.totalMs = Date.now() - t0;
            state.timing.segSlowestMsFine = b2.slowestMs;
            state.totalMs = Date.now() - t0;

            Log.info(`✓ 精修完成 · ${finalOk}/${finalRequested} 段 · ${state.audioSeconds}s · 实测 ${measuredLufs} LUFS · 建议增益 ${planned2.gainDb >= 0 ? '+' : ''}${planned2.gainDb}dB（与初测差 ${delta.toFixed(2)}dB）→ ${moved ? '已重新落位' : '差异过小，增益不动'} · 补齐用 ${state.timing.refineMs}ms（首批尾巴 ${leftFromB1.length} 段 + 第二批 ${b2.segs.length} 段）`);
          } else {
            Log.warn('精修阶段没有可用的解码结果，保留初测结论');
          }
        } else {
          Log.warn('精修阶段一段都没补到（网络异常），保留初测结论');
        }
      }
    }

    /* 4. 收尾（FastPath 也在上面落了位；这里统一补状态与缓存） */
    if (!Number.isFinite(measuredLufs)) throw new Error('响度计算无有效结果（可能全片静音）');
    if (!planned) {
      planned = GainPlanner.plan({ measuredLufs, truePeakDb });
      AudioEngine.setGainDb(planned.gainDb);
      appliedKey = key;
    }

    /* 5. 写缓存（存原始测量值，换档案立即重算） */
    Store.set(key, {
      measuredLufs,
      truePeakDb,
      source,
      coarse: refined === false,
      sidxSegments: state.sidxSegments,
      picked: state.picked,
      audioSeconds: state.audioSeconds,
      decodeRatio: state.decodeRatio,
      pageDuration: Number.isFinite(videoEl && videoEl.duration) ? +videoEl.duration.toFixed(1) : null,
      targetLufsAtAnalysis: planned.targetLufs,
      analyzedAt: Date.now(),
    });

    const record = {
      source,
      measuredLufs,
      truePeakDb,
      sidxSegments: state.sidxSegments,
      picked: state.picked,
      sampledBytes: state.sampledBytes,
      audioSeconds: state.audioSeconds,
      decodeRatio: state.decodeRatio,
      refined,
      timing: Object.assign({}, state.timing),
    };
    computed.set(key, record);

    state.totalMs = Date.now() - t0;
    push('active', Object.assign({}, record, {
      targetLufs: planned.targetLufs,
      gainDb: planned.gainDb,
      limited: planned.limited,
      limitReason: planned.limitReason,
      reason: null,
    }));

    Log.info(`✓ 归一完成 · 来源=${source}${refined === null ? '' : (refined ? '·已精修' : '·初测')} · 实测 ${measuredLufs} LUFS → 目标 ${planned.targetLufs} LUFS · 增益 ${planned.gainDb >= 0 ? '+' : ''}${planned.gainDb}dB${planned.limited ? `（受限：${planned.limitReason}）` : ''} · 总耗时 ${state.totalMs}ms`);

    /* ⚠️ 诊断表格必须排在 push 之后（实测拦截到 343ms 的延迟）：
     *    状态落位是用户能感知的那一步，任何日志/表格都不该挡在它前面。
     *    而且只在开调试时打，省得平时也背这个开销。 */
    if (!Log.isDebug()) return;
    try {
      console.table({
        key, source,
        实测LUFS: measuredLufs, 真峰值dBTP: truePeakDb,
        目标LUFS: planned.targetLufs, 增益dB: planned.gainDb,
        限幅: planned.limited ? planned.limitReason : '否',
        sidx段数: state.sidxSegments, 抽样段数: state.picked,
        抽样MB: state.sampledBytes ? +(state.sampledBytes / 1048576).toFixed(2) : null,
        解码覆盖: state.decodeRatio === null ? '—' : `${(state.decodeRatio * 100).toFixed(0)}%`,
        取流ms: state.timing.fetchMs, 索引ms: state.timing.prepMs,
        首批下载ms: state.timing.sampleMs, 首批落位ms: state.timing.firstMs,
        精修ms: state.timing.refineMs, 总ms: state.totalMs,
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------ 入口 */

  function fmtSec(v) { return Number.isFinite(v) ? v.toFixed(1) : '?'; }

  /**
   * 「等播放器切流」状态。
   *
   * SPA 切视频时 URL 几乎立刻变，但播放器换流要晚 1–3 秒
   * （实测：点推荐视频后 45s 内 <video>.duration 还是上一个视频的 213s）。
   * 这中间若照旧施加增益，就成了「把新视频的响度压到还在播的旧视频上」。
   * 所以时长达不上就先挂起，等播放器真换了流再算 —— 期间保持原声，零干预。
   */
  let waiting = null;

  function clearWait() {
    if (waiting && waiting.timer) clearTimeout(waiting.timer);
    waiting = null;
  }

  /**
   * @returns {boolean} true = 已获准继续分析；false = 仍在等，调用方应立即 return
   */
  function waitForStream(key, expected, actual) {
    if (!waiting || waiting.key !== key) {
      clearWait();
      waiting = { key, since: Date.now(), timer: null };
    }

    const waited = (Date.now() - waiting.since) / 1000;

    // 宽限期：等太久了就不再拿时长卡着（播放器行为异常时，永久等待比短暂错配更糟）
    if (waited > CONFIG.streamWaitGraceSec) {
      Log.warn(`等播放器切流已 ${waited.toFixed(0)}s 仍未切（元素 ${fmtSec(actual)}s vs 目标 ${fmtSec(expected)}s）→ 不再等待，按当前页面信息继续`);
      clearWait();
      return true;
    }

    push('waiting', {
      key, source: null, measuredLufs: null, truePeakDb: null,
      targetLufs: GainPlanner.currentProfile().targetLufs, gainDb: null,
      reason: `等待播放器切流（元素 ${fmtSec(actual)}s → 目标 ${fmtSec(expected)}s，已等 ${waited.toFixed(0)}s）`,
    });

    if (!waiting.timer) {
      waiting.timer = setTimeout(() => {
        if (waiting) waiting.timer = null;
        maybeRun(Lifecycle.currentElement(), 'retry').catch(e => Log.debug('retry 异常', e && e.message));
      }, CONFIG.streamWaitRetryMs);
    }
    return false;
  }

  /**
   * 番剧专用的「等播放器切集」——有界轮询，返回 false 表示本任务已被新任务替换。
   *
   * 与上面的 waitForStream 的区别：那个在**取流之前**挂起（用页面给出的
   * 期望时长），等不到就 return 让上层稍后重来；这个在**取流之后**，
   * 已经有了接口给的权威时长，就地短暂轮询即可，不必重跑整条链路。
   */
  async function waitElementDuration(videoEl, expected, myJob) {
    if (!Number.isFinite(expected)) return true;

    const tol = CONFIG.streamWaitToleranceSec;
    const budget = Number.isFinite(CONFIG.pgcStreamWaitMs) ? CONFIG.pgcStreamWaitMs : 8000;
    const t0 = Date.now();

    for (;;) {
      if (jobSeq !== myJob) return false;

      const actual = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
      if (actual && Math.abs(actual - expected) <= tol) return true;

      if (Date.now() - t0 > budget) {
        Log.warn(`等播放器切集超时（元素 ${fmtSec(actual)}s vs 目标 ${fmtSec(expected)}s）→ 不再等待，按接口信息继续`);
        return true;
      }

      push('waiting', {
        key: state.key, source: null, measuredLufs: null, truePeakDb: null,
        targetLufs: GainPlanner.currentProfile().targetLufs, gainDb: null,
        reason: `等待播放器切集（元素 ${fmtSec(actual)}s → 目标 ${fmtSec(expected)}s，已等 ${((Date.now() - t0) / 1000).toFixed(0)}s）`,
      });
      await new Promise(r => setTimeout(r, CONFIG.streamWaitRetryMs));
    }
  }

  /**
   * 尝试分析当前 video。内部按 key 去重，可以放心高频调用。
   */
  async function maybeRun(videoEl, reason) {
    if (!CONFIG.enabled) return;
    if (!videoEl || videoEl.tagName !== 'VIDEO') return;

    const info = StateReader.target();
    if (!info) {
      if (state.phase === 'idle') push('skipped', { reason: '未识别到可分析的页面目标' }, '未识别到页面目标');
      return;
    }

    if (info.kind === 'pgc') {
      /* 番剧：接口只需要 ep_id（实测不需要 cid），所以不必调 view 补全。
       * 只在「季落地页还没定集」这种拿不到 ep_id 的情况下跳过。 */
      if (!info.epId) {
        if (state.phase === 'idle') {
          push('skipped', { reason: '番剧页未识别到 ep_id（可能是季落地页，尚未定集）' }, '未识别到 ep_id');
        }
        return;
      }
    } else {
      if (!info.bvid) {
        if (state.phase === 'idle') push('skipped', { reason: '未识别到 bvid' }, '未识别到 bvid');
        return;
      }

      /*
       * 页面状态过期（SPA 导航后 __INITIAL_STATE__ 仍是上一个视频的）
       * 或页面压根没给 cid → 用 view 接口补全。
       *
       * 【绝不能采信过期的 cid】实测：拿旧 cid 配新 bvid 调 playurl
       * 会得到 code=-404「啥都木有」，也就是用户看到的「获取失败」。
       */
      if (!info.stateFresh || !info.cid) {
        try {
          Object.assign(info, await PlayInfo.resolveVideo(info));
        } catch (e) {
          const msg = `补全视频信息失败：${(e && e.message) || e}`;
          Log.warn(msg);
          push('error', {
            key: null, source: null, measuredLufs: null, gainDb: 0, reason: msg,
            targetLufs: GainPlanner.currentProfile().targetLufs,
          }, msg);
          return;
        }
      }
      if (!info.cid) return;
    }

    const key = StateReader.cacheKey(info);
    if (!key) return;

    /* 等播放器切流：元素时长对不上目标视频就先挂起，绝不把增益压到错的流上 */
    const expected = Number.isFinite(info.duration) ? info.duration : null;
    const actual = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
    if (expected && actual && Math.abs(expected - actual) > CONFIG.streamWaitToleranceSec) {
      Log.debug(`目标时长 ${fmtSec(expected)}s ≠ 元素时长 ${fmtSec(actual)}s → 先等播放器切流`);
      if (!waitForStream(key, expected, actual)) return;
    } else {
      clearWait();
    }

    // 同一任务已在跑 / 已生效 → 不重复
    if (key === runningKey) return;
    if (key === appliedKey) {
      // 回到同一视频（SPA 来回切 / loadedmetadata 二次触发）：
      // 优先用本会话算出来的结论复现（保住「来源」的真实语义），
      // 没有才退回读缓存。
      const known = computed.get(key);
      const source = (known && known.measuredLufs) || (Store.get(key) || {});
      if (Number.isFinite(source.measuredLufs)) {
        const planned = GainPlanner.plan({ measuredLufs: source.measuredLufs, truePeakDb: source.truePeakDb });
        AudioEngine.setGainDb(planned.gainDb);
        push('active', Object.assign({}, known || {
          source: 'cache',
          measuredLufs: source.measuredLufs,
          truePeakDb: source.truePeakDb,
          sidxSegments: source.sidxSegments,
          picked: source.picked,
        }, {
          key,
          targetLufs: planned.targetLufs, gainDb: planned.gainDb, limited: planned.limited,
          limitReason: planned.limitReason, reason: null, totalMs: 0,
        }));
        Log.debug(`复用已算结果 ${key}（来源 ${(known && known.source) || 'cache'}）· 增益 ${planned.gainDb}dB`);
      }
      return;
    }

    const myJob = ++jobSeq;
    runningKey = key;
    clearWait();

    Log.info(`开始分析 ${key}（触发：${reason || '未知'}）`);
    try {
      await analyzeKey(info, key, videoEl, myJob);
    } catch (e) {
      if (jobSeq === myJob) {
        if (e && e.skip) {
          /* 权限不足 / 地区限制 / 版权限制（番剧常见）——
           * 这不是「故障」，是这类内容本来就不该分析：保持原声、标「跳过」，
           * 不打成 error，免得用户以为是脚本坏了。 */
          AudioEngine.setGainDb(0);
          push('skipped', {
            key, source: null, gainDb: 0,
            targetLufs: GainPlanner.currentProfile().targetLufs,
            reason: (e && e.message) || String(e),
          }, '跳过');
          Log.warn(`跳过分析（保持原声）· ${(e && e.message) || e}`);
        } else if (appliedKey !== key) {
          // 铁律：失败只归零增益 + 更新状态，绝不干预播放
          AudioEngine.setGainDb(0);
          push('error', {
            key, source: null, gainDb: 0,
            targetLufs: GainPlanner.currentProfile().targetLufs,
            reason: (e && e.message) || String(e),
          });
          Log.warn(`分析失败（保持原声）· ${(e && e.message) || e}`);
        } else {
          // 已经有结论落位了（例如命中初测缓存后精修失败）——
          // 这时候把状态打成「失败」是误报：实际听感正常工作。
          Log.warn(`精修失败，保留已落位的结论 · ${(e && e.message) || e}`);
        }
      }
    } finally {
      if (jobSeq === myJob) runningKey = null;
    }
  }

  /** 手动重跑（清掉当前 key 的缓存）：调试用 */
  async function reanalyze() {
    const el = Lifecycle.currentElement();
    if (!el) return { ok: false, reason: 'no-video' };
    const info = StateReader.target();
    const key = info ? StateReader.cacheKey(info) : null;
    if (key) Store.remove(key);
    appliedKey = null;
    clearWait();
    PlayInfo.forget();   // 连「已采信过哪份 playinfo」的记忆一起清，强制重新判定
    await maybeRun(el, '手动');
    return { ok: true, state: snapshot() };
  }

  /**
   * 用缓存里的原始测量值重新规划增益并施加。
   * 换目标响度/换档案走这条路 —— 零网络零解码，立即生效。
   */
  async function reapply() {
    const el = Lifecycle.currentElement();
    const info = StateReader.target();
    const key = info ? StateReader.cacheKey(info) : null;
    if (!key) return { ok: false, reason: 'no-key' };

    const cached = Store.get(key);
    if (!cached || !Number.isFinite(cached.measuredLufs)) {
      return await reanalyze();
    }

    const planned = GainPlanner.plan({ measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb });
    AudioEngine.setGainDb(planned.gainDb);
    appliedKey = key;
    push('active', {
      key, source: 'cache', measuredLufs: cached.measuredLufs, truePeakDb: cached.truePeakDb,
      targetLufs: planned.targetLufs, gainDb: planned.gainDb, limited: planned.limited,
      limitReason: planned.limitReason, reason: null, totalMs: 0,
      refined: cached.coarse ? false : true,
    });
    Log.info(`档案切换重算 · 实测 ${cached.measuredLufs} LUFS → 目标 ${planned.targetLufs} → 增益 ${planned.gainDb}dB（零下载）`);
    return { ok: true, state: snapshot(), el };
  }

  /* ------------------------------------------------------ 旁路 */

  /** 旁路开关：不施加增益（听原声），但保留分析结果 —— 用于 A/B 对比 */
  function setBypass(v) {
    const on = AudioEngine.setBypass(v);
    push(state.phase, {});
    return on;
  }

  function toggleBypass() { return setBypass(!AudioEngine.isBypass()); }
  function isBypass() { return AudioEngine.isBypass(); }

  return {
    maybeRun,
    reanalyze,
    reapply,
    snapshot,
    setBypass,
    toggleBypass,
    isBypass,
    isEnabled() { return CONFIG.enabled; },
    setEnabled(v) {
      CONFIG.enabled = !!v;
      if (!v) { AudioEngine.setGainDb(0); push('idle', { gainDb: 0 }); }
      Log.info('响度归一已' + (v ? '启用' : '停用'));
    },
  };
})();
