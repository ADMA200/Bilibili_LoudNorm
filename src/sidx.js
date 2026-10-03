/* ================================================================
 * sidx.js — fMP4 分段索引解析（纯函数，无副作用）
 *
 * B 站音频是单文件 fMP4：
 *     ftyp → moov(含 mvex/trex) → sidx → [moof+mdat]×N
 * SegmentBase.indexRange 直接给出 sidx 的字节区间，所以我们只要
 * 拿几 KB 就能知道整条时间轴上每一段的位置与长度。
 *
 * 关键点：不全量下载音频，却能覆盖整片时间轴 —— 只要几 KB 索引，
 * 就知道每一段在哪、有多长。
 *
 * 结构（ISO/IEC 14496-12 §8.16.3）：
 *   box header(8|16) + version(1) flags(3) reference_ID(4)
 *   timescale(4) earliest_presentation_time(v0:4 / v1:8)
 *   first_offset(v0:4 / v1:8) reserved(2) reference_count(2)
 *   然后每条 reference 12 字节：
 *     type(1bit) + referenced_size(31bit) | subsegment_duration(4) | SAP(4)
 * ================================================================ */
const Sidx = (() => {

  /** 读一个 box 头：{type, size, headerSize}；返回 null 表示越界 */
  function readBoxHeader(view, offset) {
    if (offset + 8 > view.byteLength) return null;

    const size32 = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );

    let size = size32;
    let headerSize = 8;

    if (size32 === 1) {
      // largesize：64 位
      const hi = view.getUint32(offset + 8);
      const lo = view.getUint32(offset + 12);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      // 延伸到缓冲区末尾
      size = view.byteLength - offset;
    }

    if (size < headerSize) return null;
    return { type, size, headerSize };
  }

  /**
   * 解析 sidx。
   *
   * ⚠️ anchor 是**必须**传对的那个坑：ISO/IEC 14496-12 规定
   *    first_offset 的基准点是「sidx box 之后的第一个字节」，不是文件头。
   *    若按 anchor=0 解析，B 站音频每一段都会整体前移「ftyp+free+moov+sidx」的长度
   *    （实测该视频是 1482 字节），抓到的字节全错位 —— 表现为只有第 0 段能解码
   *    （它恰好含完整 init+sidx+moof+mdat），其余全部报 Unable to decode audio data。
   *
   * @param {ArrayBuffer|Uint8Array} input 从 indexRange 拿到的字节（起点应就是 sidx box）
   * @param {number} [anchor=0] 索引基准点（文件内绝对偏移），通常传 indexRange.end + 1
   * @returns {null | {version, timescale, earliestPresentationTime, firstOffset, anchor, refs}}
   *          refs[i] = { index, t, duration, size, offset }
   *          offset 是**文件内绝对字节偏移**，t / duration 单位秒
   */
  function parse(input, anchor) {
    if (!input) return null;
    const base = Number.isFinite(anchor) ? anchor : 0;
    const view = input instanceof DataView
      ? input
      : new DataView(input.buffer || input, input.byteOffset || 0, input.byteLength);

    // 扫描顶层 box，定位 sidx（正常情况下第一个就是）
    let off = 0;
    let found = -1;
    let guard = 0;
    while (off + 8 <= view.byteLength && guard++ < 64) {
      const h = readBoxHeader(view, off);
      if (!h) break;
      if (h.type === 'sidx') { found = off; break; }
      off += h.size;
    }
    if (found < 0) return null;

    const h = readBoxHeader(view, found);
    let p = found + h.headerSize;

    const version = view.getUint8(p);
    p += 4; // version(1) + flags(3)

    p += 4; // reference_ID
    const timescale = view.getUint32(p);
    p += 4;

    let earliest, firstOffset;
    if (version === 1) {
      earliest = view.getUint32(p) * 4294967296 + view.getUint32(p + 4);
      p += 8;
      firstOffset = view.getUint32(p) * 4294967296 + view.getUint32(p + 4);
      p += 8;
    } else {
      earliest = view.getUint32(p);
      p += 4;
      firstOffset = view.getUint32(p);
      p += 4;
    }

    p += 2; // reserved
    const count = view.getUint16(p);
    p += 2;

    if (!timescale) return null;

    const refs = [];
    let cursor = base + firstOffset;
    let t = earliest;

    for (let i = 0; i < count; i++) {
      if (p + 12 > view.byteLength) break;
      const sizeWithType = view.getUint32(p);
      const size = sizeWithType & 0x7fffffff; // 低 31 位
      // const refType = (sizeWithType >>> 31) & 1;  // 0=media 1=index
      const duration = view.getUint32(p + 4);
      p += 12;

      refs.push({
        index: i,
        t: t / timescale,
        duration: duration / timescale,
        size,
        offset: cursor,
      });

      cursor += size;
      t += duration;
    }

    return {
      version,
      timescale,
      earliestPresentationTime: earliest / timescale,
      firstOffset,
      anchor: base,
      refs,
      /** 索引区末尾 + 1 —— 与 Content-Length 比对可验证解析正确性 */
      endOffset: cursor,
    };
  }

  /** 检查一段字节是否以指定 box 类型开头（用于验证索引基准点选对了） */
  function startsWithBox(input, type) {
    if (!input || input.byteLength < 8) return false;
    const v = input instanceof DataView
      ? input
      : new DataView(input.buffer || input, input.byteOffset || 0, input.byteLength);
    const t = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    return t === type;
  }

  /**
   * 自校验：Σ size + firstOffset 是否等于整文件长度。
   * S0 实测 B 站音频满足此式（43 段 × 5s 精确吻合 Content-Length）。
   */
  function verify(parsed, contentLength) {
    if (!parsed || !Number.isFinite(contentLength)) return { ok: null, reason: 'no-data' };
    const diff = parsed.endOffset - contentLength;
    return {
      ok: diff === 0,
      endOffset: parsed.endOffset,
      contentLength,
      diff,
    };
  }

  /** 均匀抽取 want 个段（首段必取，避免片头静场把响度拉低） */
  function pickEvenly(refs, want) {
    const n = refs.length;
    if (!n) return [];
    if (n <= want) return refs.map(r => r.index);
    if (want <= 1) return [0];

    const out = [];
    for (let i = 0; i < want; i++) {
      out.push(Math.round((i * (n - 1)) / (want - 1)));
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  /**
   * 从一个**已经均匀**的抽取结果里，再等距挑出 k 个（含首尾）。
   *
   * 用途：渐进式抽样的第一批。既要「段数少、来得快」，又要
   * 「依然覆盖整条时间轴」—— 直接取前 k 个会让第一批只覆盖前半段，
   * 片尾音量就无从判断了。等距子集（0、25%、50%、75%、100%）两头都摸得到。
   *
   * @param {number[]} picks 已排序的段号
   * @param {number} k 想要几个
   * @returns {number[]} 段号的子集（升序）
   */
  function pickCoarse(picks, k) {
    const n = picks.length;
    if (!n || k <= 0) return [];
    if (k >= n) return picks.slice();

    const out = [];
    for (let i = 0; i < k; i++) {
      const pos = Math.round((i * (n - 1)) / (k - 1));
      out.push(picks[pos]);
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  return { parse, verify, pickEvenly, pickCoarse, startsWithBox, readBoxHeader };
})();
