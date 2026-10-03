/* ================================================================
 * lifecycle.js — video 元素发现 / 接管 / SPA 状态机
 *
 * 状态机：
 *   DISCOVERY ──找到 <video>──▶ ATTACHED
 *
 *   ⚠️ 关键约定：元素被替换时我们【什么都不做】。
 *      旧元素交给 GC，绝不调用 source.disconnect()。
 * ================================================================ */
const Lifecycle = (() => {
  let lastEl = null;
  let lastHref = null;
  let pollTimer = null;
  let observer = null;
  let mutationDebounce = null;
  let started = false;

  const obs = { ticks: 0, elementSwaps: 0, attached: 0 };

  function isVideoEl(el) {
    return !!el && el.tagName === 'VIDEO';
  }

  /** 优先在播放器容器内找，找不到再全文档兜底 */
  function findVideo() {
    for (let i = 0; i < CONFIG.playerSelectors.length; i++) {
      let box = null;
      try { box = document.querySelector(CONFIG.playerSelectors[i]); } catch (e) { box = null; }
      if (box) {
        const v = box.querySelector('video');
        if (isVideoEl(v)) return v;
      }
    }
    const v = document.querySelector('video');
    return isVideoEl(v) ? v : null;
  }

  /* ------------------------------------------------------ 媒体事件 */

  const MEDIA_EVENTS = ['loadedmetadata', 'durationchange', 'emptied', 'abort', 'error'];

  function onMediaEvent(ev) {
    const el = ev.target;
    if (ev.type === 'error') {
      const err = el.error;
      Log.warn(`video 报错 · code=${err && err.code} · ${err && err.message || ''}`);
      return;
    }
    const dur = Number.isFinite(el.duration) ? `${el.duration.toFixed(1)}s` : '?';
    Log.debug(`video 事件 ${ev.type} · duration=${dur} · readyState=${el.readyState}`);

    // 时长确定后是分析的最佳时机：此时 dash.duration 的时效性校验也有了依据
    if (ev.type === 'loadedmetadata' || ev.type === 'durationchange') {
      Analyzer.maybeRun(el, ev.type).catch(e => Log.debug('maybeRun 异常', e && e.message));
    }
  }

  function bindMediaEvents(el) {
    MEDIA_EVENTS.forEach(t => el.addEventListener(t, onMediaEvent));
  }

  function unbindMediaEvents(el) {
    MEDIA_EVENTS.forEach(t => el.removeEventListener(t, onMediaEvent));
  }

  /* -------------------------------------------------------- 主循环 */

  async function tick(why) {
    obs.ticks++;
    const el = findVideo();
    if (!el) return;

    /*
     * 路由变化必须单独检测。
     * B 站 SPA 切视频 / 切分P 时 <video> 元素**会被复用**（S1 已实测），
     * 只靠「元素被替换」会整个漏掉 —— 实测点推荐视频后 45s 内元素都没换，
     * 于是脚本一个分析都不发起，HUD 永远停在上一个视频的数字上。
     * 所以这里比对完整 href（含 ?p=），变了就重新走一遍分析。
     */
    const href = location.href;
    const urlChanged = lastHref !== null && href !== lastHref;
    if (urlChanged) {
      Log.info(`路由变化 → 重新评估 · ${href.slice(0, 90)}`);
      lastHref = href;
    } else if (lastHref === null) {
      lastHref = href;
    }

    // 快速路径：元素没换、路由没变、且已接管 → 直接返回，避免每 300ms 做无谓工作
    if (!urlChanged && el === lastEl && AudioEngine.isAttached(el)) return;

    const swapped = el !== lastEl;

    if (swapped) {
      const isFirst = lastEl === null;
      const prev = lastEl;
      lastEl = el;
      obs.elementSwaps++;

      if (!isFirst && prev) {
        // 只解绑事件；【绝不】disconnect 旧元素的音频源
        try { unbindMediaEvents(prev); } catch (e) { /* 忽略 */ }
        Log.info(`video 元素被替换（第 ${obs.elementSwaps} 次）· 旧元素交还 GC，不做任何音频断连`);
      } else {
        Log.info(`发现 video 元素（${why}）· src=${String(el.currentSrc || el.src || '').slice(0, 58)}`);
      }
      bindMediaEvents(el);
    }

    const ok = await AudioEngine.tryAttach(el);
    if (ok) obs.attached = AudioEngine.stats().attached;

    // 元素一变 或 路由一变就触发分析（内部按 key 去重，重复调用无副作用）
    if (swapped || urlChanged) {
      Analyzer.maybeRun(el, urlChanged ? '路由变化' : why).catch(e => Log.debug('maybeRun 异常', e && e.message));
    }
  }

  function scheduleTick(why) {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => {
      mutationDebounce = null;
      tick(why).catch(e => Log.error('tick 异常', e && e.message));
    }, CONFIG.mutationDebounceMs);
  }

  function whenBodyReady(fn) {
    if (document.body) return fn();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function start() {
    if (started) return;
    started = true;

    // 主力：定时轮询。不依赖 DOM ready，后台标签页也不会冻结（不像 rAF）
    pollTimer = setInterval(() => {
      tick('poll').catch(e => Log.error('tick 异常', e && e.message));
    }, CONFIG.pollIntervalMs);

    // 辅助：MutationObserver，仅用于「尽快」感知元素出现
    whenBodyReady(() => {
      try {
        observer = new MutationObserver(() => scheduleTick('mutation'));
        observer.observe(document.body, { childList: true, subtree: true });
        Log.debug('MutationObserver 已挂载到 document.body');
      } catch (e) {
        Log.warn('MutationObserver 挂载失败，仅依赖轮询', e && e.message);
      }
      tick('init').catch(e => Log.error('tick 异常', e && e.message));
    });

    Log.info(`Lifecycle 启动 · 轮询间隔 ${CONFIG.pollIntervalMs}ms`);
  }

  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (mutationDebounce) { clearTimeout(mutationDebounce); mutationDebounce = null; }
    if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } observer = null; }
    started = false;
    Log.info('Lifecycle 已停止');
  }

  return {
    start,
    stop,
    stats() { return Object.assign({}, obs); },
    currentElement() { return lastEl; },
  };
})();
