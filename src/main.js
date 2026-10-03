/* ================================================================
 * main.js — 入口
 *
 * S2 范围：普通投稿页 /video/* 与 /list/*，全链路响度归一。
 * S3.1 起：番剧 / 影视 / 电视剧 / 纪录片 / 国创 / 综艺（/bangumi/play/*）
 *          走同一套编排，差异全在 StateReader / PlayInfo 的分支里。
 * ================================================================ */
const Main = (() => {

  /** Safari / WebKit：MSE 源在 MediaElementAudioSourceNode 上输出全 0，WebKit 至今未修 */
  function isWebKitOnly() {
    const ua = navigator.userAgent;
    return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
  }

  /** 页型判定收敛到 StateReader.kind()（video / pgc / other），避免两处各写一份 */
  function pageKind() {
    return StateReader.kind();
  }

  /* -------------------------------------------------------- 旁路 */

  function hotkeyText() {
    const hk = CONFIG.bypassHotkey || {};
    return [hk.ctrl ? 'Ctrl' : null, hk.alt ? 'Alt' : null, hk.shift ? 'Shift' : null, String(hk.key || 'b').toUpperCase()]
      .filter(Boolean).join('+');
  }

  function gainText() {
    const g = Analyzer.snapshot().gainDb;
    return Number.isFinite(g) ? `${g >= 0 ? '+' : ''}${g.toFixed(2)}dB` : '—';
  }

  /** 切旁路 + 给一个看得见的反馈（菜单和快捷键共用一个出口） */
  function toggleBypass() {
    const on = Analyzer.toggleBypass();
    const label = on
      ? `旁路：听原声（归一 ${gainText()} 暂不施加）`
      : `恢复归一：${gainText()}`;
    if (CONFIG.bypassToast) Hud.toast(label);
    Log.info(label);
    return on;
  }

  /**
   * 旁路快捷键（默认 Shift+B）。
   *
   * ⚠️ 不调用 preventDefault —— 构建守卫禁止，而且本来就没必要：
   *    我们只是「顺便看一眼」这个按键，页面自己的处理照旧。
   *    B 站自身的快捷键（d 弹幕 / f 全屏 / m 静音 / w 网页全屏）里没有 b，
   *    实测不冲突。
   */
  function registerHotkey() {
    const hk = CONFIG.bypassHotkey || {};
    const want = String(hk.key || 'b').toLowerCase();

    document.addEventListener('keydown', (ev) => {
      if (ev.repeat || ev.isComposing) return;
      if (String(ev.key || '').toLowerCase() !== want) return;
      if (!!hk.shift !== ev.shiftKey) return;
      if (!!hk.alt !== ev.altKey) return;
      if (!!hk.ctrl !== ev.ctrlKey) return;
      if (!!hk.meta !== ev.metaKey) return;

      // 别在输入框里抢按键（搜索框、评论框、发弹幕时按 B 不该切旁路）
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      toggleBypass();
    }, true);

    Log.info(`旁路快捷键已注册：${hotkeyText()}`);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('开关响度归一', () => {
        Analyzer.setEnabled(!Analyzer.isEnabled());
      });
      GM_registerMenuCommand(`旁路开关（对比原声 ${hotkeyText()}）`, () => {
        toggleBypass();
      });
      GM_registerMenuCommand('开关调试 HUD', () => {
        Hud.setEnabled(!Hud.isEnabled());
      });
      GM_registerMenuCommand('切换调试日志', () => {
        Log.setDebug(!Log.isDebug());
        Log.info('调试日志已' + (Log.isDebug() ? '开启' : '关闭'));
      });
      GM_registerMenuCommand('打印状态到控制台', () => {
        console.log('[响度归一] 状态', buildStatus());
      });
      GM_registerMenuCommand('导出最近日志', () => {
        console.table(Log.ring());
      });
      GM_registerMenuCommand('清空测量缓存', () => {
        Store.clear();
      });
    } catch (e) {
      Log.debug('菜单命令注册失败（非致命）', e && e.message);
    }
  }

  function buildStatus() {
    return {
      version: CONFIG.version,
      stage: CONFIG.stage,
      enabled: CONFIG.enabled,
      href: location.href,
      pageKind: pageKind(),
      target: StateReader.target(),
      profile: CONFIG.profile,
      analysis: Analyzer.snapshot(),
      bypass: Analyzer.isBypass(),
      audioEngine: AudioEngine.stats(),
      audioContext: AudioEngine.getContextState(),
      gainLinear: AudioEngine.getGainValue(),
      gainDesiredDb: AudioEngine.getDesiredGainDb(),
      gainAppliedDb: AudioEngine.getAppliedGainDb(),
      lifecycle: Lifecycle.stats(),
      cache: Store.stats(),
      video: (() => {
        const el = Lifecycle.currentElement();
        if (!el) return null;
        return {
          source: String(el.currentSrc || el.src || '').slice(0, 70),
          volume: el.volume,
          muted: el.muted,
          paused: el.paused,
          readyState: el.readyState,
          currentTime: +el.currentTime.toFixed(2),
          duration: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null,
          crossOrigin: el.crossOrigin,
        };
      })(),
    };
  }

  /** 暴露到页面上下文，供 CDP / DevTools 直接读 —— 验证接口 */
  function exposeDebugApi() {
    const target = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    target.__biliLoudness = {
      version: CONFIG.version,
      stage: CONFIG.stage,
      status: buildStatus,
      logs: () => Log.ring(),
      clearLogs: () => Log.clear(),

      /* 分析相关 */
      analysis: () => Analyzer.snapshot(),
      reanalyze: () => Analyzer.reanalyze(),
      setEnabled: (v) => Analyzer.setEnabled(v),
      setProfile: (k) => {
        if (!CONFIG.profiles[k]) return { ok: false, reason: '未知档案' };
        CONFIG.profile = k;
        // 换档案 → 用缓存里的原始测量值立即重算，零下载零解码
        return Analyzer.reapply();
      },
      listProfiles: () => GainPlanner.listProfiles(),
      forceSamplePath: (v) => {
        CONFIG.forceSamplePath = !!v;
        Log.info('强制抽样路径 = ' + CONFIG.forceSamplePath);
        return CONFIG.forceSamplePath;
      },

      /* 缓存 */
      cache: {
        stats: () => Store.stats(),
        list: () => Store.list(),
        clear: () => Store.clear(),
      },

      /**
       * 索引自校验（独立于分析流程的诊断）：
       *   证明 sidx 解析出的 endOffset 正好等于文件真实长度。
       *
       * 不能靠 HEAD 读 Content-Length —— 它不是 CORS 安全列表里的响应头，
       * 页面里读不到。改用「越界探测」这个更硬的办法：
       *   ① 请求 bytes=(endOffset-1)-  → 必须成功（说明文件比 endOffset-1 长）
       *   ② 请求 bytes=endOffset-     → 必须 416（说明文件不比 endOffset 长）
       * 两条合起来即 endOffset === 文件长度，且只用得着可观测的状态码。
       */
      verifyIndex: async () => {
        const pi = PlayInfo.fromPage();
        if (!pi || !pi.audio) return { ok: false, reason: '页面没有可用 dash 音频轨' };
        const a = pi.audio;
        const anchor = a.indexRange.end + 1;

        const idxBuf = await Sampler.fetchRange(a.url, a.indexRange.start, a.indexRange.end, 'verify-idx');
        const parsed = Sidx.parse(idxBuf, anchor);
        if (!parsed) return { ok: false, reason: 'sidx 解析失败' };

        const end = parsed.endOffset;
        let justInside = null;
        let justOutside = null;
        try {
          const r1 = await fetch(a.url, { headers: { Range: `bytes=${end - 1}-` }, credentials: 'omit' });
          justInside = r1.status;
          if (r1.status === 206) await r1.arrayBuffer();
        } catch (e) { justInside = 'err'; }
        try {
          const r2 = await fetch(a.url, { headers: { Range: `bytes=${end}-` }, credentials: 'omit' });
          justOutside = r2.status;
          if (r2.status === 206) await r2.arrayBuffer();
        } catch (e) { justOutside = 'err'; }

        const ok = justInside === 206 && justOutside === 416;
        const picked = Sidx.pickEvenly(parsed.refs, CONFIG.sampleSegments);

        return {
          ok,
          reason: ok ? null : `内侧探测=${justInside}（期望 206）、越界探测=${justOutside}（期望 416）`,
          audioId: a.id,
          audioMime: a.mimeType,
          host: String(a.url).replace(/^https?:\/\//, '').split('/')[0],
          indexRange: a.indexRange,
          indexBytes: idxBuf.byteLength,
          anchor,
          firstOffset: parsed.firstOffset,
          segments: parsed.refs.length,
          timescale: parsed.timescale,
          segDuration: parsed.refs[0] ? +parsed.refs[0].duration.toFixed(3) : null,
          totalDuration: +parsed.refs.reduce((s, r) => s + r.duration, 0).toFixed(2),
          firstSegOffset: parsed.refs[0].offset,
          endOffset: end,
          probeInsideStatus: justInside,
          probeBeyondStatus: justOutside,
          pickedCount: picked.length,
          pickedPreview: picked.slice(0, 14),
        };
      },

      /* 音频与信号 */
      getGain: () => AudioEngine.getGainValue(),
      getGainDb: () => AudioEngine.getAppliedGainDb(),
      getDesiredGainDb: () => AudioEngine.getDesiredGainDb(),
      probeSignal: (ms) => AudioEngine.probeSignal(ms),

      /**
       * 旁路（A/B 对比原声）。
       *   setBypass()       — 无参 = 切换；传 true/false = 指定
       *   isBypass()        — 当前是否在旁路
       * 旁路只把实际增益按到 0dB，分析结果与目标增益原样保留，
       * 所以来回切是瞬时的（这一点有单元断言钉着）。
       */
      setBypass: (v) => Analyzer.setBypass(v === undefined ? !Analyzer.isBypass() : v),
      toggleBypass: () => Analyzer.toggleBypass(),
      isBypass: () => Analyzer.isBypass(),

      /* 调试 / 诊断 */
      hud: (v) => Hud.setEnabled(v === undefined ? !Hud.isEnabled() : v),
      hudInfo: () => Hud.info(),
      setDebug: (v) => Log.setDebug(v),

      /* 设置面板（S3.2） */
      panel: (v) => Panel.setPanelEnabled(v === undefined ? !Panel.isEnabled() : v),
      panelInfo: () => Panel.info(),
      /** 全屏判据诊断 —— 真机按 `w` 后调它，用于校准 classHit 正则 */
      fsInfo: () => Panel.fsInfo(),
      panelToggle: (which) => { Panel.toggle(which); return Panel.isOpen(); },
      /** 直接改「自定义档」三元组（验证脚本用，改完立即重算） */
      setCustom: (patch) => { Panel.setCustom(patch); return GainPlanner.currentProfile(); },
      settings: () => Store.getSettings(),

      /** 读写运行时配置（验证脚本用它临时放宽「等切流」容差） */
      config: (k, v) => {
        if (k === undefined) return Object.assign({}, CONFIG);
        if (v === undefined) return CONFIG[k];
        CONFIG[k] = v;
        Log.info(`CONFIG.${k} = ${JSON.stringify(v)}`);
        return CONFIG[k];
      },

      /**
       * 页面状态诊断：一次看清「B 站注入的那几份数据还算不算数」。
       * S2.1 的事故就是「__INITIAL_STATE__ 是首屏那一份、SPA 后不更新」，
       * 有这条接口就不必再靠猜：pageFresh=false 即页面数据过期，cid 会走接口补。
       */
      pageState: () => {
        const el = Lifecycle.currentElement();
        const pi = PlayInfo.fromPage();
        return {
          href: location.href,
          pageKind: pageKind(),
          target: StateReader.target(),
          /* 普通投稿：bvid 与 URL 一致才算新鲜
           * 番剧：没有 __INITIAL_STATE__，改用「对象身份 + ep_id 配对」（见 state-reader） */
          stateFresh: StateReader.kind() === 'pgc' ? StateReader.pgcFresh() : StateReader.pageFresh(),
          reader: StateReader.videoKey(),
          pagePlayinfo: pi ? {
            kind: pi.kind || 'video',
            origin: pi.origin,
            duration: pi.duration,
            audioId: pi.audio ? pi.audio.id : null,
            audioMime: pi.audio ? pi.audio.mimeType : null,
            hasVolume: !!pi.volumeMeta,
            measuredI: pi.volumeMeta ? pi.volumeMeta.measuredI : null,
            measuredTp: pi.volumeMeta ? pi.volumeMeta.measuredTp : null,
            isPreview: !!pi.isPreview,
            isDrm: !!pi.isDrm,
            hasDurlOnly: !!pi.hasDurlOnly,
            cid: pi.cid || null,
            bvid: pi.bvid || null,
          } : null,
          video: el ? {
            duration: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null,
            readyState: el.readyState,
            paused: el.paused,
          } : null,
        };
      },

      /* 生命周期 */
      start: () => Lifecycle.start(),
      stop: () => Lifecycle.stop(),
    };
    Log.debug('调试接口已挂到 window.__biliLoudness');
  }

  function boot() {
    Log.info(`Bilibili_LoudNorm v${CONFIG.version} (${CONFIG.stage}) · ${location.href}`);

    if (isWebKitOnly()) {
      Log.warn('检测到 Safari/WebKit：MSE 音频源在该引擎上输出恒为 0（WebKit 未修复的已知 bug），已放弃接管，不影响原声播放');
      return;
    }

    const kind = pageKind();
    if (kind === 'other') {
      Log.info(`非目标页型（${kind}：${location.pathname}），不启动`);
      return;
    }

    const kindLabel = kind === 'pgc' ? '番剧/影视' : '普通投稿';
    Log.info(`页型 = ${kind}（${kindLabel}），启动接管 + 归一流程 · 档案=${GainPlanner.currentProfile().label}(${GainPlanner.currentProfile().targetLufs} LUFS)`);

    // ⚠️ 面板必须在 Lifecycle.start() 之前 init —— 它会把持久化的设置
    //    （开关 / 预设 / 自定义目标与上下限）套回 CONFIG，
    //    晚了第一轮分析就会用默认档跑，白等一次抽样。
    // ⚠️ 而且必须**兜住异常**：面板是 UI，核心是归一。UI 出错不该把
    //    Lifecycle.start() / exposeDebugApi() 一起带走（S3.2 真栽过一次：
    //    ShadowRoot 没有 style 属性 → 面板样式写崩 → 整个功能没起来）。
    try {
      Panel.init();
    } catch (e) {
      Log.warn('设置面板初始化失败（不影响归一功能）', e && e.message);
      try { Panel.setPanelEnabled(false); } catch (e2) { /* 忽略 */ }
    }

    Lifecycle.start();
    registerMenu();
    registerHotkey();
    exposeDebugApi();
    if (CONFIG.hud) Hud.update(Analyzer.snapshot());
  }

  return { boot, buildStatus };
})();

Main.boot();
