/* ================================================================
 * sampler.js — 全片抽样取音频（只取索引 + 均匀抽样，不全量下载）
 *
 * 流程（§4.2）：
 *   1. Range 取 Initialization（ftyp+moov）与 indexRange（sidx）—— 并行发
 *   2. 解析 sidx → 拿到全片 N 段的位置，均匀选 12 段（首段必取）
 *   3. 分批拉取（S2.2）：
 *        第一批 coarse（6 段，等距含首尾）→ 交给上层立刻测量并落位
 *        第二批 rest（其余 6 段）→ 后台补上后精修
 *   4. 每段各自与 init 组成一个独立可解码的 fMP4 片段，交给上层逐段解码
 *
 * ⚠️ 为什么是「逐段独立解码」而不是「拼成一个大 Blob 一次解码」（实测踩坑）：
 *    fMP4 分段的 trun 里可以是 base_data_offset（相对**原文件的绝对偏移**）。
 *    把这些 moof 拼到新 Blob 里，偏移全部失效 —— 实测结果是解码器读到第一段
 *    结束就停，57.3s 的抽样只解出 4.9s，响度直接偏了 2.9 LU。
 *    这正是我们要修掉的那类 bug（只量到开头几秒），所以改成逐段解码：
 *    init + 任意单片段本来就是合法的可独立解码单元（moov 带 mvex/trex）。
 *
 * ⚠️ 为什么要分批（S2.2，用户反馈「抽样时长不稳定，有时 6s 以上」）：
 *    12 段全到齐才开工 = 木桶效应，「最慢那一段」决定总时长。而慢段往往来自
 *    CDN 冷连接 / 与播放器抢带宽 / 偶发重传 —— 恰恰是最不可控的部分。
 *    分批后，第一批只要 6 段就能先给出可用结论，长尾不再拖住整条链路。
 *
 * 代价实测：110 分钟视频音频全量 73.8MB，抽 12 段 ≈ 0.63MB = 0.9%。
 * ================================================================ */
const Sampler = (() => {

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------------------------------------------------- 网络层 */

  /**
   * 带 Range 的取字节。返回 ArrayBuffer。
   * 优先原生 fetch（S0 实测 CDN 已回 Access-Control-Allow-Origin）；
   * 若被 CORS / Referer 挡住，退 GM_xmlhttpRequest（Tampermonkey 环境）。
   *
   * @param {number} [timeoutMs] 覆盖默认超时（单段抽样用更短的 segTimeoutMs）
   * @param {number} [retries] 网络层内部重试次数（默认 0，重试策略交给调用方）
   */
  async function fetchRange(url, start, end, label, timeoutMs, retries) {
    const rangeValue = `bytes=${start}-${end}`;
    const expected = end - start + 1;
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : CONFIG.fetchTimeoutMs;
    const maxTries = 1 + (Number.isFinite(retries) ? Math.max(0, retries) : 0);

    const t0 = Date.now();

    const tryFetch = async () => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, budget);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Range: rangeValue },
          credentials: 'omit',
          cache: 'default',
          signal: ctrl ? ctrl.signal : undefined,
        });
        clearTimeout(timer);
        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.arrayBuffer();
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    };

    const tryGM = () => new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no-gm'));
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { Range: rangeValue, Referer: 'https://www.bilibili.com/' },
          responseType: 'arraybuffer',
          timeout: budget,
          onload: (r) => {
            if (r.status === 200 || r.status === 206) resolve(r.response);
            else reject(new Error(`GM HTTP ${r.status}`));
          },
          onerror: () => reject(new Error('GM 网络错误')),
          ontimeout: () => reject(new Error('GM 超时')),
        });
      } catch (e) { reject(e); }
    });

    let lastErr = null;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      let buf = null;
      let via = 'fetch';
      try {
        buf = await tryFetch();
      } catch (e) {
        if (typeof GM_xmlhttpRequest === 'function') {
          Log.warn(`Range 请求 fetch 失败（${e && e.message}），改走 GM_xmlhttpRequest 重试`);
          buf = await tryGM();
          via = 'gm';
        } else {
          lastErr = e;
          if (attempt < maxTries - 1) { await sleep(200); continue; }
          throw e;
        }
      }

      const ms = Date.now() - t0;
      Log.debug(`Range ${label} · ${rangeValue} · ${buf.byteLength}B / 期望 ${expected}B · ${ms}ms · ${via}`);
      return buf;
    }
    throw lastErr || new Error('Range 请求失败');
  }

  /* -------------------------------------------------- 并发调度 */

  /** 带全局启动间隔的并发池（防 -799 限流） */
  async function pacedPool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    let lastStart = 0;

    async function runner() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;

        const wait = lastStart + CONFIG.requestGapMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastStart = Date.now();

        out[i] = await worker(items[i], i);
      }
    }

    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, runner));
    return out;
  }

  /* -------------------------------------------------- 准备：取索引 */

  /**
   * 取「初始化段 + 索引」并算出全片抽样计划。
   *
   * initRange 与 indexRange 是文件里两个互不重叠的小区间，所以并行发 ——
   * 省掉一个完整 RTT（冷连接下这一下就是 100–400ms）。
   *
   * @param {{url, initRange, indexRange, mimeType}} audio
   * @param {(stage: string, extra?: object) => void} [onStage]
   * @param {number} [anchorOverride] 强制索引基准点（自校验失败时回退用）
   */
  async function prepare(audio, onStage, anchorOverride) {
    const stage = onStage || function () {};

    if (!audio || !audio.url) throw new Error('缺少音频地址');
    if (!audio.initRange || !audio.indexRange) throw new Error('缺少 SegmentBase（init/index range）');

    stage('index');
    const t0 = Date.now();

    const at = { initMs: null, indexMs: null };
    const [initBuf, idxBuf] = await Promise.all([
      fetchRange(audio.url, audio.initRange.start, audio.initRange.end, 'init')
        .then(b => { at.initMs = Date.now() - t0; return b; }),
      fetchRange(audio.url, audio.indexRange.start, audio.indexRange.end, 'sidx')
        .then(b => { at.indexMs = Date.now() - t0; return b; }),
    ]);

    // sidx box 之后的第一个字节就是 first_offset 的基准点
    const anchor = Number.isFinite(anchorOverride) ? anchorOverride : (audio.indexRange.end + 1);
    const parsed = Sidx.parse(idxBuf, anchor);
    if (!parsed || !parsed.refs.length) throw new Error('sidx 解析失败');

    const picks = Sidx.pickEvenly(parsed.refs, CONFIG.sampleSegments);

    Log.info(`sidx 解析成功 · v${parsed.version} · timescale=${parsed.timescale} · ${parsed.refs.length} 段 · 单段 ${parsed.refs[0].duration.toFixed(3)}s · 基准点=${parsed.anchor} · 索引末尾 offset=${parsed.endOffset}`);

    return {
      initBuf,
      indexBytes: idxBuf.byteLength,
      parsed,
      refs: parsed.refs,
      picks,
      anchor,
      initMs: at.initMs,
      indexMs: at.indexMs,
      prepMs: Date.now() - t0,
    };
  }

  /* ---------------------------------------------- 抽样：分批下载 */

  /**
   * 拉取一组分段。
   *
   * 这里有两个反木桶效应（S2.2，针对「抽样时长不稳定，有时 6s 以上」）：
   *
   *   ① **单段失败不拖垮整批**：超时/报错先重试 segRetry 次，仍失败就丢掉
   *      这一段并记 warn，够数上层就继续算。原来任何一段抛错都会让整次分析
   *      失败重来，表现就是「有时候卡很久，有时候干脆失败」。
   *
   *   ② **够用即开工**（`wantAtLeast`）：不等全批到齐，先凑够这么多段就
   *      把结果交出去让它先算 —— 剩下的段继续在后台跑。这是彻底把「最慢那一段」
   *      从关键路径上摘掉：一批 6 段里只要有 1 段卡 5s，旧写法就得干等 5s。
   *
   * @returns {{early: Promise<Batch>, all: Promise<Batch>}}
   *   early — 达到 wantAtLeast 段时最先兑现（达不到则在全部结束后兑现，用 all 的结果）
   *   all   — 整批跑完（含失败/跳过）后兑现
   *   两者结构相同；early 只可能「段更少」，不会更差。
   */
  function download(refs, audio, onStage, opts) {
    const o = opts || {};
    const label = o.label || 'seg';
    const total = refs.length;
    const wantAtLeast = Number.isFinite(o.wantAtLeast) ? Math.max(1, o.wantAtLeast) : 0;

    const out = new Array(total).fill(null);
    const perSeg = [];
    let done = 0;
    let dropped = 0;
    let okCount = 0;
    let earlyFired = false;

    const t0 = Date.now();

    let earlyResolve = null;
    const early = new Promise(res => { earlyResolve = res; });

    function pack() {
      const segs = out.filter(Boolean);
      const sorted = perSeg.slice().sort((a, b) => a - b);
      return {
        segs,
        requested: total,
        ok: segs.length,
        dropped,
        bytes: segs.reduce((a, s) => a + s.buf.byteLength, 0),
        seconds: segs.reduce((a, s) => a + s.duration, 0),
        /** 本批**申请**的音频总时长（含失败段）—— 覆盖率的分母 */
        requestedSeconds: refs.reduce((a, r) => a + r.duration, 0),
        wallMs: Date.now() - t0,
        slowestMs: sorted.length ? sorted[sorted.length - 1] : null,
        medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        /** 是否为「够用即开工」的那一版快照 */
        partial: false,
      };
    }

    const all = (async () => {
      await pacedPool(refs, CONFIG.concurrency, async (r, i) => {
        const s0 = Date.now();
        let buf = null;
        let err = null;
        let attempts = 0;

        for (let attempt = 0; attempt <= CONFIG.segRetry; attempt++) {
          attempts = attempt + 1;
          try {
            buf = await fetchRange(audio.url, r.offset, r.offset + r.size - 1,
              `${label}#${r.index}`, CONFIG.segTimeoutMs);
            err = null;
            break;
          } catch (e) {
            err = e;
            if (attempt < CONFIG.segRetry) {
              Log.warn(`第 ${r.index} 段失败（${(e && e.message) || e}）→ ${CONFIG.segRetryDelayMs}ms 后重试`);
              await sleep(CONFIG.segRetryDelayMs);
            }
          }
        }

        const ms = Date.now() - s0;
        if (buf) {
          out[i] = {
            index: r.index, t: r.t, duration: r.duration,
            size: r.size, buf, ms, attempts,
          };
          perSeg.push(ms);
          okCount++;

          if (wantAtLeast && !earlyFired && okCount >= wantAtLeast) {
            earlyFired = true;
            const snap = pack();
            snap.partial = true;
            Log.info(`抽样「够用即开工」· 已到 ${okCount}/${total} 段（阈值 ${wantAtLeast}）→ 先交给上层计算，其余继续在后台取`);
            earlyResolve(snap);
          }
        } else {
          dropped++;
          Log.warn(`第 ${r.index} 段彻底失败（${attempts} 次尝试）→ 跳过，本次抽样少一段：${(err && err.message) || err}`);
        }

        done++;
        if (typeof o.onProgress === 'function') o.onProgress(done, total, dropped);
      });
      return pack();
    })();

    // 兜底：一批都没凑够阈值（段太少 / 大面积失败）时，early 也得兑现
    all.then(r => earlyResolve(r), () => earlyResolve(pack()));

    return { early, all };
  }

  /** init + 单片段 → 一个可独立解码的 fMP4 */
  function fragmentBlob(initBuf, segBuf, mimeType) {
    return new Blob([initBuf, segBuf], { type: mimeType || 'audio/mp4' });
  }

  return { prepare, download, fragmentBlob, fetchRange, pacedPool };
})();
