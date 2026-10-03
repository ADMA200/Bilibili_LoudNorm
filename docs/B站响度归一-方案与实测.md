# B 站响度归一油猴脚本 — 实施计划

> 目标产物：`bili-loudness/Bilibili_LoudNorm.user.js`（单文件 userscript，Tampermonkey 直接装）
> 脚本名：**B站响度归一**（`@name`，中文）/ **Bilibili_LoudNorm**（`@name:en`，英文）—— **S3.2.7 定名**
> 定位：**替代 greasyfork 587251**，保留它「整片一个固定增益、播放中零干扰」的体验，换掉它的实现方式。
> 证据标注：**【实测】**= 本会话 curl/解析一手验证；**【源码】**= 直接读源码；**【文档】**= API 官方文档；**【推测】**= 待实跑确认。

---

## 1. 要解决的三个问题（来自moxia的原话）

| # | 原问题 | 根因（已定位） | 本方案对策 |
| --- | --- | --- | --- |
| 1 | 卡暂停，必须刷新才能继续播 | 被替代的脚本有三处实现会干预播放器：① `analyzeBeforePlay` 在 `play` 捕获阶段 `preventDefault()` + `video.pause()`，分析完再 `await video.play()`，一旦被自动播放策略拒绝就永久卡住；② `disconnectVideo()` 调 `source.disconnect()`，`createMediaElementSource` 之后一断开该元素**永久无声**；③ 失败时 `alert()` 冻页面 | 全链路**禁止** `preventDefault` / `pause()` / `disconnect()` / `alert()`。硬约束写进代码 CHECKLIST |
| 2 | 快速模式只采 0.2MB（≈开头 12 秒），长视频压不准 | `downloadHead()` 用 `Range: bytes=0-(N-1)`，只取文件**开头** | 解析 **sidx 索引**，全片均匀抽 12 段（≈60s 音频 / ≈0.63MB），覆盖整条时间轴 |
| 3 | （新需求）番剧 / 电视剧也要归一 | 番剧链路与普通投稿完全不同 | 新增 `PageRouter` + 统一适配层；番剧零请求即可拿到音频地址 |


---

## 2. 关键实测事实（直接采信，不用再验）

### 2.1 两种页面的状态注入方式**完全不同**

| 页面 | `__INITIAL_STATE__` | `__playinfo__` | 其他 | cid 来源 |
| --- | --- | --- | --- | --- |
| 普通投稿 `/video/*` | ✅ 出现 16 次 | ⚠️ 只被**引用**不被赋值 | — | `__INITIAL_STATE__.cid`（顶层直取）或 `videoData.pages[p-1].cid` |
| 番剧/影视/电视剧/纪录片 `/bangumi/play/*` | ❌ **0 次** | ✅ `= playurlSSRData.data` | `__PLAYURL_HYDRATE_DATA__`、`__NEXT_DATA__` | `__playinfo__.result.arc.cid` |


> **范围已收敛：不做课程（`cheese/play/*`）。** 课程页的 `__EduPlayPiniaState__`（值是两层 JSON 字符串）与 `pugv/player/web/playurl`（`data` 而非 `result`）分支一并砍掉，`PageRouter` 只保留 `video` / `pgc` 两种页型。

⚠️ `playurlSSRData` 是 `const`（脚本作用域），**油猴里取不到**；只能走 `window.__playinfo__`。
⚠️ 电视剧/电影/纪录片/国创/综艺**全部在 `/bangumi/play/` 下**，靠 `season_type` 区分（1番剧 2电影 3纪录片 4国创 5电视剧 7综艺），所以「加番剧」= 顺带把电视剧一起覆盖了，不用额外做链路。

### 2.2 ★ 番剧自带官方响度元数据（重大发现）

`__playinfo__.result.video_info.volume`【实测】：

```
{
  "measured_i": -23.8,        // 实测集成响度 LUFS
  "measured_lra": 8.1,        // 响度范围 LU
  "measured_tp": -2.7,        // 真峰值 dBTP
  "measured_threshold": -34.7,
  "target_offset": 0.1,
  "target_i": -14,            // 目标集成响度
  "target_tp": -1,
  "multi_scene_args": {
    "high_dynamic_target_i": "-24",   // ← B 站播放器「音量均衡·高动态」档
    "normal_target_i": "-14",         // ← B 站播放器「音量均衡·标准」档
    "undersized_target_i": "-28"
  }
}
```

**推论（强）**：B 站对番剧/影视走的是**客户端响度归一**（播放器读元数据施加增益），两档 = −14 / −24 LUFS。

### 2.3 ★ 普通投稿的响度元数据（**§2.7.2 已修正，以那节为准**）

**未登录 curl 视角**（本节原始结论）：

- 页面 HTML：`measured_i` / `target_i` / `volume` 出现 **0 次**【实测】
- `x/player/playurl`（`fnval=4048` 与 `143312` 都试）→ `data.volume = null`、`dash.volume = null`【实测】
- `x/player/v2` → 无 `measured_i`【实测】
- `x/player/wbi/playurl` 不签名直调 → **HTTP 412 风控**【实测】
- `pgc/player/web/playurl` v1/v2 → 也无 `volume`（**元数据只存在于 SSR 那一份**）【实测】

**⚠️ 登录态实测修正（§2.7.2）**：`x/player/playurl` 的 `data` 确实**不含** `volume`，但**页面里的 `window.__playinfo__.data.volume` 含**（播放器/SSR 额外注入）——**部分视频有、部分没有**：`BV1GJ411x7h7` ✅ / `BV1EV411s7vu` ✅ / `BV1muab6rEbA`（110 分钟）❌。

**这解释了moxia的原始痛点**：B 站的响度归一**默认关闭**（`loudnessSwitch=0`，见 §2.7.5），且即使开启也只覆盖「有元数据的视频」→ 处理过的正常、没处理的炸。**我们的价值就是补这段覆盖。**

### 2.4 音频文件结构（两种页面**完全一致**）

```
ftyp → moov(含 mvex/trex) → sidx → [moof(mfhd+traf(tfhd/tfdt/trun))]×N
```

- 单文件 fMP4 + **sidx 时间索引**；`SegmentBase.indexRange` 直接给出 sidx 的字节区间
- 索引闭合验证：43 段 × 5s 的字节偏移求和 = `Content-Length`（精确吻合）【实测】
- 抽样成本（110 分钟视频，音频全量 73.8MB）：**抽 12 段 = 60s 音频 = 0.63MB = 全量 0.9%**；`decodeAudioData` 解 60s 仅约 23MB 内存
- 响应头：`Accept-Ranges: bytes` ✅；`content-range` 越界 → **416**；`Access-Control-Allow-Origin`：普通投稿 `*`，番剧回显 origin —— **均不影响 `fetch`**【实测】
- **字段命名差异（必须兼容）**：番剧 SSR 只有 **snake_case**（`base_url` / `segment_base.initialization` / `segment_base.index_range` / `mime_type`）；普通投稿 API 是 camelCase（`baseUrl` / `SegmentBase`）。字段归一函数统一双读。

### 2.5 接口与错误码

| 页面 | 接口 | 备注 |
| --- | --- | --- |
| 普通投稿 | `x/player/playurl?bvid=&cid=&platform=web&high_quality=1&fnval=4048` → `data` | 无需 wbi【实测】 |
| 番剧 | 优先 SSR `__playinfo__`（**零请求**）；回落 `pgc/player/web/playurl?ep_id=&qn=80&fnval=4048&fourk=1&platform=web` → `result` | 无需登录、无需 Referer、无需 wbi【实测】 |


关键降级码：顶层 `code` 与 `result.error_code` **两处都要看**（试看时顶层是 0、错误藏在 `result.error_code=-10403`）。`-403` 权限不足 / `-404` 资源不存在 → 跳过；`-412` IP 风控 → **立即停手不重试**；`-352` wbi/UA 不合规 → 退避重试 1 次；`-799` 频繁 → 退避；`-688` 地区限制 / `-689` 版权限制 → 跳过。

试看识别（任一命中即视为不完整）：`result.is_preview===1` / `result.error_code===-10403` / **有 `durl` 无 `dash`** / `durl[0].length < result.timelength` / `play_check.play_detail !== "PLAY_WHOLE"`。命中 → 只对可用窗口分析，面板标注「试看片段」。

DRM 识别：`is_drm` / `widevine_pssh` / `playerDrmError.code` → 放弃分析，保持原声。

### 2.6 Bilibili Evolved UI 设计令牌【源码】

| 用途 | 值 |
| --- | --- |
| 主色 | `--theme-color`（B 站粉），派生 `--theme-color-10..90`（alpha %）、`--theme-color-lightness-10..90` |
| 深色判定 | `body.dark`（B 站自身深色模式） |
| 面板 | `min-width:320px`、`border-radius:8px`、`border:1px solid #8882`、`--header-height:50px` |
| 阴影 | `0 4px 12px 0 rgba(0,0,0,.05)`；深色 `.2` |
| 深色兜底 | `--be-color-panel-bg:#222`、`-card-bg:#282828`、`-text-title:#eee`、`-text-content:#eee`、`-text-placeholder:#888`、`-switch-bg:#8884`、`-button-bg:#333`、`-thumb-bg:#666`、`-thumb-border:#555` |
| 布局 | 左 `sidebar`（固定，圆钮 26px + 8px padding = 42px 命中区）+ 右 `main`（sticky 搜索栏 36px + 列表） |
| 侧边圆钮 | `background:#fffa`（深色 `#333a`）；hover `translateX(60%) scale(1.1)` 且变白 |
| 开合动画 | `transform .3s cubic-bezier(.22,.61,.36,1)`；收起 `translateX(-48%)` → 展开 `translateX(0)` |
| 开关 | 宽 `32px`、轨道 `h12 r6`、滑块 `18px` 圆；开=主色 |
| 滑块 | 轨道 `h4 r2`、滑块 `16px` 圆 + `box-shadow:0 0 0 2px var(--theme-color-20)` |
| 文本框 | `box-shadow:0 0 0 1px #8884`；focus `0 0 0 1px theme, 0 0 0 3px theme-20`；`r4` `padding:4px 6px` |
| 按钮 | `padding:4px 8px`、`r4`、`bg:#8882`、hover `#8884` |
| 字号 | 基础 `12px`、面板标题 `18px`、搜索 `13px` |
| 通用过渡 | `transition: .2s all ease-out` |


**⚠️ 复刻必踩的坑**：`body.dark` 选择器**跨不进 Shadow DOM**（`body` 在 shadow 之外）。必须在宿主元素上镜像主题：`MutationObserver` 观察 `document.body.classList` → 给 shadow host 打 `data-theme="dark|light"`，面板样式全部写 `:host([data-theme="dark"]) &`。

---

### 2.7 ★★★ S0 登录态实测结果（2026-09-28 03:30–04:00，本机 Edge + CDP）

> 方法：复制本机 Edge 的登录态关键文件（976K：`Cookies` / `Local State` / `Preferences` / `Local\ Storage` / `Session\ Storage`）到 `/tmp/bl_edge_profile`，用 `--headless=new --remote-debugging-port=9222` 启动**独立实例**，Node 22 内置 WebSocket 走 CDP 执行 JS。**未触碰日常使用的浏览器实例**。测试账号已登录（**年度大会员 vipType=2**，确认登录态有效）。

#### 2.7.1 通道结论：AppleScript 路线**不可用**

| 尝试 | 结果 |
| --- | --- |
| `tell application "Finder"/"System Events"/"Microsoft Edge"` 发真实 Apple Event | **全部 `-10004 errAEEventNotPermitted`** |
| 宿主 App 签名 | 启用 Hardened Runtime、**无 `com.apple.security.automation.apple-events` entitlement** |

**根因**：Hardened Runtime + 缺 automation entitlement → 系统**连 TCC 授权弹窗都不会弹**，用户无法在「隐私与安全性 → 自动化」里修复。
**⇒ AppleScript 方案作废，改用 CDP（也不吃 TCC）。**

#### 2.7.2 普通投稿**有**响度元数据（修正 §2.3）

路径是 **`window.__playinfo__.data.volume`**（不是 `__playinfo__.volume`）：

```
pi.data.volume = { measured_i:-13.5, measured_lra:5.3, measured_tp:1.1,
                   measured_threshold:-23.6, target_offset:0.5, target_i:-14, target_tp:-1,
                   multi_scene_args:{ normal_target_i:"-14", high_dynamic_target_i:"-24", undersized_target_i:"-28" } }
```

| 视频 | `pi.data.volume` | 说明 |
| --- | --- | --- |
| `BV1GJ411x7h7`（2009 老 MV） | ✅ `measured_i=-13.5, target_i=-14, offset=0.5` | |
| `BV1EV411s7vu` | ✅ 存在 | |
| `BV1muab6rEbA`（110 分钟长视频） | ❌ **该路径完全为空** | 对应moxia说的"很多视频不支持" |

**关键限定**：`x/player/playurl` 返回的 `data` **不含** `volume` 字段（`dataKeys` 里确认没有）→ 该字段是**播放器/SSR 额外注入到 `__playinfo__` 的**，页面内零请求可读。

#### 2.7.3 wbi 接口登录态下**裸调可用**（修正 §2.3）

`x/player/wbi/playurl`（**不带 wbi 签名**、仅带 Cookie）→ `http=200 code=0 message=OK`。未登录时是 **412**。⇒ 登录态下不需要实现 wbi 签名。

#### 2.7.4 大会员集返回**完整 dash**（§13-4 已验证）

| 集 | is_preview | is_drm | dash.audio | timelength | volume 元数据 |
| --- | --- | --- | --- | --- | --- |
| `ep308426`（免费集） | 0 | False | 3 条（30216/30232/30280） | 1441042ms | `measured_i=-23.8, target_i=-14, offset=0.1` |
| `ep309868`（**会员集**） | 0 | False | 3 条 | 1439976ms | `measured_i=-23.5, target_i=-14, offset=-0.1` |

**未登录时**这两个 ep 都是 `durl` 试看（360s）。⇒ 大会员登录态下番剧 FastPath 成立。
番剧元数据路径：**`__playinfo__.result.video_info.volume`**（snake_case），与普通投稿的 `data.volume` **不同**。

#### 2.7.5 ★★★ B 站「音量均衡」的实现方式（决定性）

用 CDP `Page.addScriptToEvaluateOnNewDocument` 在 document-start hook `AudioContext` / `createGain` / `createMediaElementSource` / `HTMLMediaElement.volume` setter：

| `bpx_player_profile.media.loudnessSwitch` | AudioContext | createMediaElementSource | GainNode | 结论 |
| --- | --- | --- | --- | --- |
| **0（默认，moxia当前值）** | **0 个** | **0 次** | **0 个** | B 站**什么都不做** |
| **1（手动开启）** | **2 个**（48kHz, running） | **1 次**（`VIDEO`，blob 源） | `initial:1` → **`setTargetAtTime(3.090295432513591)`** | B 站接管音频源并施加增益 |

**验算（严丝合缝）**：`20·log10(3.090295432513591) = 9.80 dB`
元数据公式：`target_i − measured_i + target_offset = −14 −(−23.8) + 0.1 = 9.9 dB` ✅

**⇒ 三条硬结论**：

1. **B 站网页端响度归一 = Web Audio `createMediaElementSource` + `GainNode`，增益值直接用响度元数据算**。§13-1 假设**已证实**。
2. **`loudnessSwitch` 默认是 0** → moxia的痛点根因确认：**B 站有元数据但根本没施加**。且即使开启，也只覆盖「有元数据的视频」。
3. ⚠️ **`loudnessSwitch≠0` 时 B 站已占用 `createMediaElementSource`** → 我们的脚本再调用会抛 `InvalidStateError`。§11 风险表第一条**是真实存在的**（此前未开均衡时测不到）。

#### 2.7.6 其他页面内事实

| 项 | 值 | 影响 |
| --- | --- | --- |
| `video.crossOrigin` | **`"anonymous"`**（B 站自己设的） | 对我们有利，跨域静音风险进一步降低 |
| `video.src` | `blob:https://www.bilibili.com/...` | MSE，与 §2.4 一致 |
| `window.player` | 存在，暴露 `isInitialized` / `mediaElement` / `getVolume` / `setVolume` / `getMediaInfo` / `getQuality` / `getSupportedQualityList` | **`player.mediaElement` 可直接拿 video**，比 DOM 查询稳；但仍是私有 API，作兜底 |
| `bpx_player_profile.media` 关键字段 | `volume:1`、`nonzeroVol:1`、`loudnessSwitch:0`、`dolbyAudio:false`、`audioQuality:null` | `loudnessSwitch` 就是均衡开关；`volume` 是播放器音量 |
| `bilibili_player_kv_config.dash_config.abr_limit_by_user_level` | `{unlogin:16, loginWithoutVip:80, loginWithVip:116}` | 会员档位上限 116 |
| localStorage 里 `bilibili-gate:evolved-theme-color-hex` | 存在 → moxia装了 **Bilibili Evolved** | 与 §2.6 UI 复刻方向一致 |

**⇒ 策略修订**：面板需新增「**B 站自带均衡检测**」——若 `loudnessSwitch ≠ 0`，提示「B 站已接管音频源并做归一，功能重复」并引导关闭 B 站均衡（我们的覆盖更广：无元数据的视频也能处理）。降级链：`createMediaElementSource` 失败 → `volumeOnlyMode`（只削不补）。

---

## 3. 总体架构

```
┌─ PageRouter ────────────────────────────── 判断页型，产出 PageContext
│    {kind: 'video'|'pgc', key: 'BV...'|'ep123', seasonType?}
├─ StateReader ───────────────────────────── 取 cid / aid / ep_id（两套分支）
├─ PlayInfoFetcher ───────────────────────── 取音频 URL + 官方 volume 元数据（两套分支）
│    └─ 统一归一化为 NormalizedPlayInfo {audio[], duration, volumeMeta?, isPreview, isDrm}
├─ LoudnessEngine ─────────────────────────── 响度测量（两条路径）
│    ├─ FastPath  : volumeMeta 存在 → 直接用 measured_i（零下载零解码）
│    └─ SamplePath: 无元数据 → sidx 解析 → 抽 12 段 → BS.1770 集成响度
├─ GainPlanner ───────────────────────────── 目标响度 → 增益 dB，限幅保护，平滑斜坡
├─ AudioEngine ───────────────────────────── MediaElementSource → Gain → SoftLimit → dest
├─ Lifecycle ─────────────────────────────── video 元素发现/接管/SPA 清理（状态机）
├─ Store ─────────────────────────────────── GM_setValue 缓存 + 预设档案
└─ UI ────────────────────────────────────── 左侧圆钮 + 侧滑面板（Evolved 风格）+ 调试 HUD
```

**贯穿全程的硬约束（代码级 CHECKLIST）**：

```
✗ 不调 video.pause() / video.play()
✗ 不 event.preventDefault()
✗ 不 video.load() / 不改 video.src / 不改 crossOrigin
✗ 不 source.disconnect() / 不 ctx.close()
✗ 不 alert() / 不阻塞主线程 > 16ms
✓ 所有网络与分析都在分析窗口内异步做，播放照常进行
```

---

## 4. 响度两条路径

### 4.1 FastPath（番剧 / 影视，有官方元数据）

```
gain_dB = target_i_ours - measured_i + target_offset
```

零下载、零解码、毫秒级、且是**真 LUFS 口径**。

**策略（已被 §2.7.5 实测钉死，不再是推测）**：

| B 站 `loudnessSwitch` | B 站行为 | 我们的策略 |
| --- | --- | --- |
| `0`（**默认值，moxia当前就是 0**） | 完全不处理 | **我们接管**（正常路径）：走上面的公式，`gain = our_target − measured_i` |
| `≠ 0`（用户开了均衡） | 已 `createMediaElementSource` + GainNode 施加 `target_i − measured_i + offset` | **不接管**（音频源已被占用，调用会抛 `InvalidStateError`）。面板提示「B 站自带均衡已开启且已接管音频源，功能重复」+ 引导关闭 B 站均衡（我们的覆盖更广：**无元数据的视频也能处理**，B 站不能） |

**v2 约定（实测修订）**：`createMediaElementSource` 之前**先读 `localStorage.bpx_player_profile` 的 `media.loudnessSwitch`** 判断是否已被 B 站占用，而不是等抛异常再降级 —— 这样面板能给出明确原因，而不是含糊的「降级中」。检测时机：播放器初始化后 + `video` 元素首次出现时各读一次。

**⇒ 原本计划的「30 秒听感验证」已不需要**：§2.7.5 用 hook 直接读到了 B 站施加的增益值（3.0903 = +9.80dB），与元数据公式吻合，**结论比听感可靠得多**。

### 4.2 SamplePath（普通投稿，无元数据）

```
1. 取 dash.audio（默认挑 30232 中档，约 132kbps；码率越低解码越快、响度等价）
2. 解析 SegmentBase.indexRange → Range 请求拿 sidx（约 1-7KB）
3. 解析 sidx → [(startTime, size, byteOffset)] × N
   ⚠️⚠️ **first_offset 的基准点是「sidx box 之后的第一个字节」，不是文件头。**
       绝对偏移 = (indexRange.end + 1) + first_offset + Σ(前面各段 size)。
       漏掉这个基准点会让每一段整体前移「ftyp+free+moov+sidx」的长度
       （实测该视频是 1482 字节），抓到的字节全部错位 —— 表现为**只有第 0 段能解码**
       （它恰好含完整 init+sidx+moof+mdat），其余全部报 Unable to decode audio data，
       于是响度只反映了开头 5 秒。见 §12.2 S2 实测踩坑记录。
4. 均匀抽 12 段（首段必取，避免片头静场）
5. 并发 Range 拉这 12 段（≤4 并发，间隔 120ms 防 -799）
6. **每段各自与 init 拼成一个独立 fMP4 → 逐段 decodeAudioData → 再拼 PCM**
   ⚠️ 不能把 12 个 moof 拼成一个大 Blob 一次解码。实测：B 站分片的 tfhd 是
      `default-base-is-moof=true`、trun.data_offset 相对 moof 起点（该视频 1992），
      单段独立解码是合法的；但**多个分段拼在一起解码器只会解出第一段**
      （实测 57.3s 抽样只解出 4.9s，响度偏 2.9 LU）。
   ⚠️ 实测 confirm：moov 含 mvex/trex/trep，是标准 fMP4 初始化段 → init + 任意 moof 可独立解码
   ⚠️ 段落之间会有拼接跳变，对集成响度影响 < 0.05 LU；实测加了 5ms 淡入淡出
7. K-weighting + BS.1770 集成响度（见 §4.3）
8. gain_dB = 目标响度 − 实测响度，再按 §4.4 的预算夹一次
```

失败任一步 → `gain = 0dB`，面板标红「分析失败·原声播放」，播放不受影响。

### 4.3 BS.1770 集成响度实现

```
a) K-weighting：OfflineAudioContext 渲染两段 BiquadFilter
   ① 高架 highshelf: frequency=1681.974450955533, gain=+3.999843853973347, Q=0.7071752369554196
   ② 高通 highpass : frequency=38.13547087602444,  Q=0.5003270373238773
   与 BS.1770 参考系数的偏差约 0.25dB —— 对"拉齐音量"完全够用【文档/二手】
b) 分块：400ms 块 / 75% 重叠（步长 100ms）
c) 块响度：l_j = -0.691 + 10*log10( Σ_i G_i * z_ij )   // G: L=R=1.0, C=1.41, Ls/Rs=1.41
d) 绝对门限：丢弃 l_j < -70 LUFS
e) 相对门限：Γ = (保留块的能量均值) - 10 LU，再做第二轮筛选
f) 集成响度 = -0.691 + 10*log10( Σ_j G_j * z_j / Σ_j G_j )  over 通过门限的块
g) 真峰值：取 |PCM| 最大值 → dBTP（用于限幅预算）
```

用 **声道能量求和**（不除以声道数）：

```
z_ij = Σ_over_channels K加权后该块的能量
```

⚠️ BS.1770 规定多声道是**加权求和**（G: L=R=1.0, C=1.41, Ls/Rs=1.41），不是平均。
同一个信号同时放进左右声道，测得响度比单声道**高 3.01dB** —— 这是标准的规定行为。
早期版本按 `numberOfChannels` 做了平均，导致所有立体声素材系统性偏低 3dB，
与 B 站官方元数据对不上（实测差 −2.48 LU，修正后降到 0.53 LU）。见 §12.2。

**真机口径校验**：K 加权系数改成「按采样率现算」后，与 ITU-R BS.1770-4 表里给出的
48kHz 参考系数逐频点比对，20Hz–16kHz 全程偏差 **0.0000 dB**（`probe/s2-unit.mjs` §2）。
另注：BS.1770 的高通分子**不除以 a0**（b=[1,−2,1]），这个形式本身带 +0.043 dB 增益，
按常规归一化会系统性偏低 0.043 dB。

### 4.4 目标基准与预设档案

| 档案 | 目标响度 | 增益上限 | 适用 |
| --- | --- | --- | --- |
| **标准（默认）** | **−14 LUFS** | +12 / −∞ dB | 对齐 B 站自己的 `normal_target_i` → 已归一内容增益≈0 |
| 高动态 | −24 LUFS | +12 / −∞ dB | 对齐 B 站「高动态」档 |
| 耳机 | −16 LUFS | +12 dB | 夜间、耳塞 |
| 外放/音箱 | −11 LUFS | +12 dB | 手机外放、桌面小音箱 |
| 深夜 | −20 LUFS | +6 dB | 怕吵到人 |


每套档案独立存目标响度 + 上下限。**默认「标准」的好处**：B 站已处理的内容增益≈0dB，我们只在没处理的内容上补差 —— 语义干净、可验证。

**增益安全预算**（防削波）—— ⚠️ **实现时修正了原写法，见下**：

```
headroom     = 峰值余量(-1.0) - 实测真峰值        // 允许的最大**提升**
maxAllowed   = max(0, headroom)                  // 关键：不为负
final_gain   = raw > maxAllowed ? maxAllowed : raw
final_gain   = clamp(final_gain, 档案下限, 档案上限)
```

**为什么必须夹到 0 而不是直接夹到 headroom**（实测反例，`probe/s2-unit.mjs` §6 钉死）：

原写法 `clamp(gain, -INF, headroom)` 把「防削波上限」当成了「最大增益」。当素材本身已经过峰
（真峰值 > 0 dBTP，在响度压缩过的素材里非常常见）时 headroom 是负数，于是：
`BV1muab6rEbA` 实测 −18.69 LUFS、真峰值 +0.79 dBTP → headroom = −1.79
→ 一个本该 **+4.69dB** 的素材被压成 **−1.79dB**，输出落到 −20.5 LUFS，
比原声还小 1.8dB，离目标 −14 更远了。

修正后：过峰素材 **不提升，也不倒扣**（gain = 0dB），输出 = −18.69 LUFS。
衰减永远放行 —— 衰减只会让峰值更低，不可能造成削波。

即：真峰值高的素材不许提太多；元数据路径直接用 `measured_tp`，抽样路径用实测峰值。

---

## 5. 音频链路（关键设计决策）

**只做固定增益 + 软限幅，不做实时 AGC。** 这是保留「整片一个固定增益、播放零干扰」体验的核心。

```
<video>
  └─ MediaElementAudioSourceNode          // 全生命周期只创建一次，永不 disconnect
       └─ GainNode(gain = 10^(dB/20))     // 每个视频只设置一次；平滑斜坡 120ms 生效
            └─ WaveShaperNode(tanh)       // 软限幅，阈值 -1dBFS，透明、无 attack/release 泵动
                 └─ AudioContext.destination
```

**为什么用 Web Audio 而不是 `video.volume`**：

- `video.volume` 上限 1.0，**只能衰不能提**；moxia要的是双向可调（+12dB 上限）
- 但代码里保留一条 `volumeOnlyMode` 降级路径：若 `createMediaElementSource` 抛 `InvalidStateError`（被 B 站杜比/音效占用了音频源）→ 自动退化为纯 `video.volume` 乘法（只削不补），**不报错、不断播**

**为什么固定增益天然没有「音量滑块级联」问题**：
早期调研里担心的「拖音量滑块被 AGC 反向补偿」只存在于**闭环 AGC**。我们的增益是播放前一次性算好的**开环常数**，B 站滑块拖到 50% 就是整体再乘 0.5 —— 语义正确，无需补偿公式，也无需监听 `volumechange`。这是「整片固定增益」路线附带的一个白拿的好处。

**音画同步**：Web Audio 会叠加 `AudioContext.outputLatency`（蓝牙可达 100-300ms）。缓解：`ctx.baseLatency` + 在首次接管时记录 `outputLatency`，若 > 60ms 则在面板显示「延迟补偿：xx ms」并允许手动微调（默认不动播放器 `currentTime`，避免触发 buffering）。

---

## 6. video 元素生命周期与 SPA 状态机

```
DISCOVERY ──找到 <video>──▶ ATTACHED ──分析完成──▶ ACTIVE(gain 已应用)
    ▲                            │                      │
    │                    src/blob 变化                  │
    │              或 **路由变化（href 变了）**           │
    │                            ▼                      │
    └──────────── RELOADING（重新分析 + 平滑换增益）◀───┘
                                 │
                    目标时长 ≠ 元素时长（播放器还没换流）
                                 ▼
                        WAITING（保持原声，绝不施加）
                                 │
                       时长吻合 / 超 20s 宽限期
                                 ▼
                            RELOADING
```

> **⚠️ S2.1 补上的两条触发条件**（原设计漏了，见「坑 5」）：
> ① 触发不能只看「元素被替换」—— SPA 切视频/切分P 时 `<video>` **会被复用**，
> 实测点推荐视频后 45s 内元素都没换，于是脚本一个分析都不发起。
> 必须额外比对**完整 href**（含 `?p=`）。
> ② 换片后不能立刻施加增益 —— 播放器换流比 URL 晚 1–3s，
> 中间施加就成了「把新视频的响度压到还在播的旧视频上」。需要 WAITING 态。

**发现策略**（沿用社区验证过的组合，不用 `window.player` 私有 API）：

- `MutationObserver(document, {childList,subtree})` 观察播放器容器（`.bpx-player-container` / `#bilibili-player` / `.bilibili-player`）下 `<video>` 的增删
- `setInterval(300ms)` 兜底轮询 `document.querySelector('video')`，做**元素身份比较**（`el !== lastEl` 才处理）
⚠️ 必须用 `setInterval` 而非 `requestAnimationFrame`：后台标签页 rAF 会冻结
- 监听 `loadedmetadata` / `durationchange` / 轮询 `el.src`（blob URL 变化 = 换了片源）；
  **外加路由变化检测**（`location.href` 比对，S2.1 补）

**元素被替换时的处理（关键约定）**：

```
旧元素：什么都不做（它会自己被 GC）。绝不调 source.disconnect()。
新元素：新建 MediaElementAudioSourceNode(newEl) 接入同一个 AudioContext
重复接管防护：WeakSet<HTMLMediaElement> 记录已 `createMediaElementSource` 过的元素
              —— 同一元素重复调用会抛 InvalidStateError，必须 try/catch + 跳过
AudioContext：懒创建，首次用户手势（click/keydown/touchstart，once）时 resume()
              ⚠️ Chrome 71+ autoplay 策略：页面加载即创建会 suspended
```

**番剧切集**：URL 变 → `pushState/replaceState` 被 patch + `popstate` + MutationObserver 三保险；切集后 `__playinfo__` 是首屏 SSR 的旧数据（**不会更新**）【推测，需实跑确认】→ 我们优先用 **URL 里的 ep_id 重新调接口**，SSR 数据只当"首屏加速用的一次性输入"。

> ✅ **2026-10-02 已证实（普通投稿，S2.1）**：这条推测是对的，而且比预想的更彻底 ——
> `__INITIAL_STATE__` **和** `__playinfo__` 都是首屏快照，SPA 导航后双双不刷新。
> 直接采信会「旧 cid 配新 bvid」→ playurl `-404 啥都木有`。
> 番剧大概率同构，S3 直接用同一套新鲜度校验（`StateReader.pageFresh()`）与
> `PlayInfo.trustPlayinfo()`，不要另起一套。证据见「坑 5」。

---

## 7. 模块划分与文件结构

> 下面是**最终实际结构**（15 个模块，构建顺序即依赖顺序）。
> 设计期曾规划过 `router.js` 与 `ui/` 子目录，实现时收敛为：页型判定并入 `state-reader.js`，
> UI 平铺在 `src/`（`hud.js` / `panel.js`）。

```
bili-loudness/
├── Bilibili_LoudNorm.user.js    # 单文件产物（构建后）
├── src/                          # 开发期分模块，构建时内联成一个文件
│   ├── config.js                 # 配置 + 预设档案（含 custom 档）+ 番剧 / 面板参数
│   ├── logger.js                 # 带环形缓冲的日志
│   ├── store.js                  # 测量缓存（GM_setValue + LRU + TTL）+ 设置持久化
│   ├── sidx.js                   # 纯函数：解析 sidx → [{t,size,offset}] + 分层选段
│   ├── loudness.js               # K-weighting + BS.1770 集成响度 + 真峰值（分块双二阶）
│   ├── gain-planner.js           # 目标响度 → dB、削波预算、档案
│   ├── state-reader.js           # 页型（video/pgc/other）+ 两套 cid/aid/ep 取法 + 新鲜度
│   ├── playinfo.js               # 普通投稿 / 番剧两套接口 + 归一化 + 试看与 DRM 守卫
│   ├── sampler.js                # 并发 Range 抽样 + 渐进式两阶段 + 单段容错重试
│   ├── audio-engine.js           # Web Audio 图 + setGainDb 斜坡 + desiredGain / bypass
│   ├── hud.js                    # 调试 HUD + 旁路行 / toast / 耗时归因
│   ├── panel.js                  # S3.2 侧边面板（状态 + 设置，Shadow DOM）；S3.2.1 起 42px 圆钮 + MDI 图标、固定左上
│   ├── analyzer.js               # 全链路编排（job 令牌 / 渐进式初测→精修 / 旁路状态机）
│   ├── lifecycle.js              # video 发现 / 接管 / SPA 状态机
│   └── main.js                   # 入口 + 快捷键 + 调试接口 __biliLoudness
└── build.mjs                     # 拼接单文件 + 铁律守卫
```

**UserScript header**：

```js
// @name         B站响度归一
// @namespace    https://github.com/moxia/bili-loudness
// @version      0.1.0
// @description  不依赖 B 站是否处理过，本地全片响度归一，拉齐连播音量
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @exclude      https://www.bilibili.com/video/*/play/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      hdslb.com
// @run-at       document-start
// @noframes
```

- `@run-at document-start`：要在播放器脚本之前 patch `pushState`，并尽早抓到 `__playinfo__` 的赋值时机
- `@connect`：GM_xmlhttpRequest 的跨域白名单 —— **但实测 CDN 已回 `Access-Control-Allow-Origin`，优先用原生 `fetch`**，避免 GM 沙箱和 `@connect` 授权弹窗；`@connect` 只作兜底
- `@noframes`：番剧部分场景 video 在 iframe 里，主文档脚本套壳会重复注入（**本方案不处理 iframe 内的 video**，标为已知限制）
- 不申请任何 `GM_xmlhttpRequest` 之外的敏感权限

---

## 8. UI（复刻 Bilibili Evolved）

### 8.1 结构（**S3.2 实现 / S3.2.3 · S3.2.4 修订布局与交互 / S3.2.5 文案说人话**）

设计期想过 VPopup 同款「侧栏分类 + 折叠分组」的大面板；实现时按moxia的明确要求收敛为
**两个圆钮 + 两个面板**（更贴近 Evolved 的「收在边上、要用才出来」的紧凑手感）：

```
#bili-loudness-panel-host（Shadow DOM host）
  style  ×1                            静态样式（.side / .btns / .rdw / .rd / .tip / .pnl ...）
  style  ×1                            ← 主题变量载体 :host{--theme:...}（见 §12.x 坑）
  .side                                position:fixed; left:0; top:33.333vh; pointer-events:none
    │                                  ← 按钮列**中点**锚在这条线上（.btns 再上移半高）
    │                                  ← S3.2 初版 top:50% 垂直居中 → S3.2.1 top:0 贴顶 → S3.2.3 1/3
    │                                  恒 translateX(calc(-1 * var(--shift)))（--shift:28px，只露半个圆钮）
    │                                  ← S3.2.4：**删掉 .side.bl-pin{translateX(0)}**（它会把两个按钮
    │                                    一起弹出来）；.bl-pin 只作「有面板打开」的状态标记
    ├─ .btns                           小计高度 126（8+42+26+42+8）；top: calc(-1 * var(--btns-half))
    │    ├─ .rdw（外壳，不动）          承担 hover 判定（挂 .rd 上会自激抖动，见 §12.x 坑）
    │    │    └─ .rd（均衡器图标）       42px 圆钮（26px 内容 + 8px padding，content-box、无描边），
    │    │                              .side .rdw:hover .rd / .side .rdw.bl-open .rd → translateX(var(--shift))
    │    │                              （S3.2.4：hover 与「面板开着」用**同一段**位移，无二次弹出）
    │    └─ .rdw ─ .rd（齿轮图标）       同上，**只有被 hover / 面板开着的那一个滑出**（.bl-open）
    ├─ .tip                            position:absolute; left:calc(var(--rail) + var(--shift)); top:0
    │                                  translateY(-50%) → 垂直中线对齐**被 hover 的那个按钮**；
    │                                  left 按**滑出后**的按钮位置算（视口 58），**不压住按钮**（S3.2.4）
    ├─ .pnl（状态）                     width 176px / box-sizing:border-box / border-radius 8px
    │    │                              left 同 .tip（视口 58）；top 由 JS 按**打开它的那个按钮**顶边写入
    │    ├─ 功能 · 采样 · 来源
    │    ├─ 实测 · 目标 · 增益 · 限幅 · 页型  ← S3.2.5：限幅值说人话 + 数值一律带空格
    │    │                                 （`+1.7 dB（防止爆音）` / `+0 dB（素材已过峰）` / `未限幅`）
    │    └─ 「旁路（听原声）」按钮 + 说明「暂停音频归一，播放原始音频。」（S3.2.5）
    └─ .pnl（设置）
         ├─ 启用响度归一（开关）
         ├─ 预设档案（下拉，6 档）
         ├─ 目标 / 上限 / 下限（三个滑块，拖动自动切「自定义」档）
         └─ 缓存说明「清除已保存的视频响度测量结果。」+ 「清除缓存」（S3.2.5）
```

**开合状态机**：`open ∈ {null, 'status', 'settings'}`。点击圆钮切换；**两个面板互斥**；
打开时给 `.side` 加 `.bl-pin`（状态标记）、给**对应那个** `.rdw` 加 `.bl-open`（让它保持滑出，其余收起）；
面板内 `✕` 或再点圆钮收起。**S3.2.3 起「点击面板以外的区域也一律收起」**（冒泡注册 `document` click → `closeAll()`）。

**面板顶边对齐（S3.2.4）**：`.pnl` 的 `top` 在打开时由 JS 写入 = `按钮 rect.top − .side rect.top`
（不能用 CSS 的 `top:0` —— 宿主顶边是按钮列**中点**，两个面板共用会让状态面板落到设置按钮那一行）。

**点击穿透分级（S3.2.3）**：宿主与 `.side` 都 `pointer-events:none`，**只有 `.btns` / `.tip` / `.pnl`（及外层 `.rdw`/`.rd`）设 `auto`**
—— 否则展开时那块透明矩形会把页面点击全吞掉（问题 5 的根因）。

**网页全屏 / 真全屏时完全隐藏**：三路判据任一命中 → `.side` 加 `.bl-hide`（`display:none`）。
判据与真机校准入口见 §8.4。

### 8.2 设置项（配合moxia「非专业开发者也能看懂」的偏好，全部带人话说明）

> **S3.2 实际实现的是下表的一个子集**（避免文档比代码超前）：
> ✅ 启用开关 · ✅ 预设档案（6 档）· ✅ 目标响度滑块 · ✅ 增益上限 / 下限滑块 ·
> ✅ 缓存条数与后端说明 · ✅ 清除缓存 · ✅ 当前状态卡片（含旁路按钮）。
> ⬜ 未进面板、暂留在 `CONFIG` 里的：抽样强度 / 首次过渡 /
> 高级（音频档位·并发·音画延迟·降级模式）/ 调试子项（HUD 开关仍在油猴菜单里，但 **S3.2.1 起默认关闭**）。
> ❌ 另有 **「接管番剧官方归一」** 一条：**从未实现，且前提已被实测推翻** → 已否决（见下表该条注）。
> 这些都在代码里可调（`__biliLoudness.config(k, v)`），只是没做成控件 —— 「面板只放常用几项」是moxia的取舍。

**总览**

- 启用响度归一（开关，默认开）
- 当前状态卡片：页型 / 数据来源（官方元数据 / 本地抽样）/ 实测响度 LUFS / 当前增益 dB / 是否触发限幅

**响度**

- 预设档案（下拉：标准 −14 / 高动态 −24 / 耳机 −16 / 外放 −11 / 深夜 −20 / 自定义）
- 目标响度（滑块，−28 ~ −8 LUFS，0.5 步进）
- 增益上限（滑块，0 ~ +18 dB，默认 +12）
- 增益下限（滑块，0 ~ −60 dB，默认 −24）
- 抽样强度（下拉：6 段/30s · 12 段/60s（默认）· 20 段/100s · 全量）
- ~~接管番剧官方归一（开关，默认关）— 附说明「番剧 B 站自己会归一，打开会强制按你的目标重算」~~
  → **❌ 已否决（2026-10-03）：从未实现，且前提不成立**。规划时假设「番剧 B 站自己会归一」，
  但 §2.7.5 实测把它推翻了：B 站归一的 `loudnessSwitch` **默认是 0（什么都不做）**。
  既然番剧与普通投稿一样都没被 B 站处理过，就**不需要单独的接管开关** —— 两者走同一条归一流程。
  ⚠️ 这条曾在 `CONFIG` 里被写成「暂留」，实际**连字段都没有**（`config.js` 的番剧字段只有
  `pgcApi/pgcQn/pgcFnval/pgcCacheTtlMs/pgcSkipCodes/pgcAbortCodes/pgcStreamWaitMs`）。
  **番剧不跳过归一**，详见 §12「S3.1」的「容易误解的事实」。
- 首次过渡（下拉：先原声→平滑修正（默认）· 渐进收敛）

**高级**

- 优先音频档位（自动 / 30216 / 30232 / 30280）
- 并发数与请求间隔（默认 4 / 120ms）
- 音画延迟补偿（数字框 ms，默认 0，可点「自动测量」）
- 降级模式（下拉：自动 / 强制 volume-only（只削不补））

**缓存**

- 已缓存条目数 / 占用字节（GM_setValue 上限约 5-10MB，做 LRU，上限 800 条或 3MB）
- 过期策略（按 bvid/cid，默认 30 天；番剧按 `ep_id + cid`）
- 清空缓存按钮

**调试（moxia要「看证据」）**

- 显示调试 HUD（开关）
- 面板里直接打印：sidx 段数 / 抽样耗时 / 解码耗时 / 分析耗时 / 测得 LUFS / 测得真峰值 / gain_dB / 限幅触发次数

### 8.3 调试 HUD（播放器角落实时浮层）—— ⚠️ **S3.2.1 起默认关闭**

> **为什么关**：S2 期间默认开是为了直观看到每一步。S3.2 有了左侧状态面板后，HUD 展示的
> 「来源 / 实测 / 目标 / 增益 / 状态」与状态面板**完全重复**，而且常驻在左下角挡视线
> —— moxia原话「**功能与状态按钮重复，且会一直留在界面上**」。于是 `CONFIG.hud` 默认改为 `false`。
> 关掉不影响 `Hud.toast()`（独立宿主，旁路提示 / 清缓存反馈照常弹）；
> 油猴菜单里仍保留「开关调试 HUD」，想用时随时开。

```
┌ B站响度归一 ────────────────┐
│ 来源: 本地抽样 (12段/60s)    │
│ 实测: -21.3 LUFS  TP -2.1dB │
│ 目标: -14.0 LUFS            │
│ 增益: +7.3 dB   [限幅 ✓]     │
│ 状态: ACTIVE  耗时 1.24s     │
└─────────────────────────────┘
```

数字实时刷新（1Hz，用 `setInterval`），HUD 可点击穿透不影响播放器操作。

**宿主样式硬约束（踩过坑，见 §12.2 坑 4）**：Shadow DOM 宿主 `div` 必须
①`all:initial` 排在 cssText **第一位**（它是 shorthand，写最后会重置掉定位）；
②显式声明 `display:block`（`initial` 会把它变成 `inline`）；
③`position:fixed` 与 `z-index` 带 `!important`。三条缺一，浮层就会掉进文档流里看不见。

**挂载策略**：`mount()` 立即试 → 失败则 `armMountRetry()` 每 250ms 补试（6 秒放弃）；
`document-start` 下 body 尚不存在时先挂 `<html>`，由 `watchForBody()` 在 body 出现后迁进 `body`。
自检入口：`window.__biliLoudness.hudInfo()`。

### 8.4 面板（S3.2.1 / S3.2.2 / S3.2.3 / S3.2.4）：实际采用的设计令牌 + 全屏判据

**样式全部落在 Shadow DOM 内**，不污染页面。**尺寸/位置不是照文档抄的，是从 Evolved 产物里挖出来的**
（`.be-settings > .sidebar`，见 §12 S3.2.1 修订）：

| 项 | S3.2 旧值 | **S3.2.1 现值（S3.2.3 标 ★、S3.2.4 标 ☆）** | Evolved 原值 |
| --- | --- | --- | --- |
| 宿主 | `all:initial`（**必须第一**）+ `display:block` + `position:fixed!important` + `left:0 / top:50% / translateY(-50%)` + `z-index:2147483647!important` | `all:initial` 打头 + `display:block` + `position:fixed!important` + `z-index:2147483647!important`；**★ 纵向位置 `top:0` → `top:33.333vh`**（按钮列中点），**★ 宿主 `pointer-events:none`**（不接管点击） | `position:fixed; top:50%`（**故意错开**） |
| 侧边条收起 / 展开 | `translateX(-48%)` → hover 或 `.bl-pin` 时 `translateX(0)`；`transition: transform .3s cubic-bezier(.22,.61,.36,1)` | **★ 收起 `translateX(calc(-1 * var(--shift)))`**（`--shift:28px`，只露半个圆钮）；**★ 删掉 `.side:hover`**；**☆ `.side.bl-pin` 不再改 transform**（旧写法会把两个按钮一起弹出来，降级为纯状态标记） | 同款 |
| 圆钮 | `26px` 圆、`border:1px solid var(--bd)`、hover `translateX(60%) scale(1.1)` 且 `background:#fff; color:#111` | `width/height:26px` + `padding:8px` + `box-sizing:content-box` = 42px 外径、`border:0`（去描边，留 1px 会变 44px 对不齐）、`position:relative`；**★ hover 改为单钮滑出**、**☆ 规则合为 `.side .rdw:hover .rd, .side .rdw.bl-open .rd { transform: translateX(var(--shift)) }`**（hover 与「面板开着」**同一段位移**，无二次弹出）、反色保留 | `width/height:26px; padding:8px`（实测 42px） |
| 圆钮内容 | 文字「状」「设」 | **MDI 内联 SVG 图标（均衡器 / 齿轮）26px**，`createElementNS` 建、`fill:currentColor` | `.be-icon{font-size:26px}` |
| 按钮间距 | `8px` | **`26px`**（`.btns { gap:26px }`）；**★ `.btns` 增 `top: calc(-1 * var(--btns-half))`（上移自身半高，`--btns-half:63px`）** | `margin-bottom:26px` |
| 点击热区 | 按钮本体 | **`.rd::after{ width:140%; height:140%; top:-20%; left:-20% }`** | 同款 |
| 面板 | `min-width:320px`、`max-width:360px`、`border-radius:8px`、`border:1px solid #8882`、`box-shadow:0 4px 12px 0 rgba(0,0,0,.05)` | **★ `width:176px`（减半）+ `box-sizing:border-box`（否则 `all:initial` 的 `content-box` 会撑到 202px）+ `padding:10px 12px`**、`border-radius:8px`、`border:1px solid #8882`、`box-shadow`；**☆ `left: calc(var(--rail) + var(--shift))`（视口 58，不压按钮）+ `top` 由 JS 按「打开它的那个按钮」顶边写入** | — |
| 悬浮提示 | 跟随文档流 / 用 `offsetTop` | **★ `.tip { position:absolute; top:0; transform:translateY(-50%) }`，`showTip(text, btn)` 用两个 `getBoundingClientRect()` 相减算中线**；**☆ `left: calc(var(--rail) + var(--shift))`（视口 58，收起态 hover 时不再压住按钮）** | — |
| 主题变量 | 浅色 `--panel-bg:#fff / --card-bg:#f6f7f8`；深色兜底 `--panel-bg:#222 / --card-bg:#282828`；`--theme:#fb7299` | 同左（未改） | — |
| 主题载体 | **shadow 内的第二个 `<style>`，内容 `:host{...}`** —— 绝不能写 `root.style`（ShadowRoot 没有 `style`，见 §12.x 坑 23） | 同左（未改） | — |

> **位置为什么改**：Evolved 的侧边栏同样是 `position:fixed; top:50%` + 垂直居中，与我们 S3.2 的初版
> **完全重合**，圆钮直接叠在一起打架。中间试过「按钮顶部对齐播放器容器上边缘」（`positionSelf` + scroll 监听 + rAF 节流），
> 但跟随意味着滚动时按钮一直动、还要额外养监听 —— moxia拍板「**不用跟随播放器，固定在侧边就行**」，
> 于是退回纯 CSS 固定（S3.2.1 先落 `top:0`）。
>
> **S3.2.3 再把纵向位置从 `top:0` 挪到 `top:33.333vh`**（moxia：「按钮太高了，中点改到屏幕 1/3」）——
> 仍是**纯 CSS**：宿主顶边钉 `33.333vh`，`.btns` 用 `top: calc(-1 * var(--btns-half))` 上移自身半高 →
> **列中点 = 宿主顶边 = 33.333vh**；`.tip` / `.pnl` 都是绝对定位、不参与 `.side` 高度，所以**展开面板时按钮不移位**。

> **☆ S3.2.4 补的三处**（二轮真机反馈，详见 §12 S3.2.4）：
> ① **浮窗 / 面板的水平位置**改成按「滑出后」的按钮算 —— `left: calc(var(--rail) + var(--shift))` → 视口 58；
> 旧写法只用 `var(--rail)`，而 `.side` 已被 translate 到 −28，实际落在视口 30，**正好压住按钮右半**。
> ② **面板顶边**不再共用 CSS 的 `top:0`（那是按钮列**中点**），改由打开时 JS 写 `pnl.style.top` = 按钮顶边。
> ③ `.side.bl-pin { translateX(0) }` **删掉** —— 它打开面板时会把两个按钮一起弹出来；改由 **`.rdw.bl-open`** 精确标记。

**点击穿透与「点外部收起」（S3.2.3）**

问题 5「菜单出现后其他区域无法点击」的根因是：宿主是铺开的大矩形，默认吃事件 → 展开时整块区域吞掉页面点击。
修法分两层：① 宿主与 `.side` 都设 `pointer-events:none`，只有 `.btns`/`.tip`/`.pnl`（及外层 `.rdw`/`.rd`）设 `auto`；
② `document` 上**冒泡**注册 click → `closeAll()`（把 `.bl-pin` 与两个 `.rdw` 的 `.bl-open` 一并摘掉）。

> ⚠️ 注册**必须用冒泡、不能用捕获**：按钮与 `.side` 的 click 都 `stopPropagation` 了，捕获会**先于**它们触发 ——
> 结果是菜单刚一开就被自己关掉。冒泡到不了 `document` = 点在面板内 = 不该关。

**面板自检入口**：`__biliLoudness.panelInfo()`（在不在 / 为什么看不见；`info().placement` 现会回传
`hostTop` / `btnSize` / `btnTop` / `btnLeft` / `iconCount`，S3.2.3 起 `hostTop` 为 `33.333vh`）。

**全屏隐藏判据（三路任一命中即算，不赌具体类名）**：

1. **Fullscreen API** —— `document.fullscreenElement` / `webkitFullscreenElement`
2. **class 命中** —— body / html / 播放器容器（`.bpx-player-container` 或 `#bilibili-player`）上带 `fullscreen` 语义的类名
3. **几何兜底** —— 播放器容器几乎铺满视口（`width ≥ innerWidth−2 && height ≥ innerHeight−2`）—— **不随改版失效**

**✅ 已真机校准（2026-10-03，S3.2.2）**：moxia在 Edge 上全屏前后各跑一次 `fsInfo()`，实测如下 ——

| 观测 | 非全屏（baseline） | 网页全屏（按 `w`） |
| --- | --- | --- |
| `bodyClass` | `…remove-player-popup-promotions` | 同上 **+ `webscreen-fix player-mode-web`** |
| `htmlClass` / `containerClass` | `bilibili-gate-using-dark` / `bpx-player-container bpx-state-paused` | **都不变** |
| `boxRect` → `coversViewport` | `[41,168,685,431]` → false | **`[0,0,1147,956]`（= 视口） → true** |
| `classHit` / `detected` | body·html·container 全 false / false | **body: true** / **true** |

结论：① 命中靠 **`webscreen-fix`**（正则里的 `web-?screen` 正好覆盖 `webscreen`，**无需改**，已用真机原文写进单测钉死）；
② `player-mode-web` 语义含「网页模式」，怕在非全屏也常驻 → **刻意不收**（宁可漏一路）；③ **几何兜底独立成立** —— 双保险，任一路被改版打掉另一路仍接得住。

> ⚠️ **headless 里拿不到网页全屏**：按 `w` 键、点 `.bpx-player-ctrl-web`、`documentElement.requestFullscreen()` 三者都不成（后者直接抛 `TypeError`）。
> 所以上面这份取证**只能在真机上做**；下次若 B 站改类名，用同一套流程（`fsInfo()` 全屏前后各一次）再校一遍即可。

全屏判据自检入口：`__biliLoudness.fsInfo()`（逐项回传 `bodyClass` / `htmlClass` / `containerClass` / `boxRect` / `coversViewport` / `classHit`）。

---

## 9. 缓存与「秒进入」

| 项 | 方案 |
| --- | --- |
| Key | 普通投稿 `v:{bvid}:{cid}`；番剧 `p:{ep_id}:{cid}` |
| Value | `{gainDb, measuredLufs, truePeak, source:'meta' | 'sample', analyzedAt, targetLufs, pageDur}` |
| 失效 | `targetLufs` 或「预设档案」变了 → 缓存里存的是**原始 measuredLufs**，增益**每次现算** → 换档案立即生效不用重分析 ✅ |
| 容量 | **条数**上限 800（`CONFIG.cacheMaxEntries`），超出即从「最久未使用」端淘汰。**没有**字节上限 —— 800 条 × 每条 300–500B ≈ **0.3–0.4MB**，而 localStorage 配额约 **5MB**，**条数永远先到**，所以早期设想的「3MB 体积守卫」没做（见 §14 取舍） |
| 续期 | **S3.2.6**：`get()` 命中即把该条挪到队尾（**已在队尾则不动**，避免 analyzer 一轮里连读几次就写几次索引）。此前只有 `set()` 会续期 → 淘汰实际按**最早写入**发生，是 **FIFO 不是 LRU** |
| 过期 | TTL 30 天，在 `get()` 时判定。**S3.2.6**：过期时删数据**并同步摘掉索引项**（此前只删数据 → 索引里留悬空条目白占名额，要等被 `shift` 到才顺手删） |
| 写失败 | **S3.2.6**：localStorage 配额满时，先淘汰最旧 `ceil(上限×10%)` 条再重试一次；成功 → `warn` 写明淘汰条数，仍失败 → `warn` 明说「不落盘」并返回 `false`。此前是**静默** `return false` → 旧缓存永不释放，此后每条新测量都白跑 |
| 效果 | 二次进入同一视频 → 0 网络 0 解码，**毫秒级**应用增益（解决"开头几秒不准"） |


**首次过渡（先原声→平滑修正）**：分析未完成时压根不动增益，`GainNode.gain` 保持 1.0；算好后 `setTargetAtTime(g, ctx.currentTime, 0.04)` 做 120ms 斜坡，避免"咔"一声的跳变。抽 12 段实测约 0.5-1.5s，感知上是"开始播 → 约 1 秒后音量落到位"。

---

## 10. 验证方案（这是重点：怎么证明真的生效了）

### 10.1 三步验证法

**第 0 步 · 先验 B 站自己的归一（决定番剧默认策略）**
番剧播放中切「音量均衡」标准/高动态两档，听有没有明显音量差。有 → 保持「尊重 B 站」；没有 → 改「接管」。

**第 1 步 · 单元级：sidx 解析正确性**
拿 `f12` 里已验证的样本，断言 `Σ segment.size === Content-Length`。控制台跑一次即可，**不通过就不往下走**。

**第 2 步 · 集成级：A/B 对比**
准备 3 个已用 `curl` 验证过响度差异明显的视频做对照组：

- A：有官方元数据的番剧集（`measured_i ≈ -23.8`）
- B：普通投稿、无元数据、老视频（预期偏高 → 需要衰减）
- C：普通投稿、无元数据、近年视频（预期接近 −14 → 增益≈0）

判定标准（**客观，不靠耳朵**）：

1. 打开 HUD，三个视频的「增益 dB」应该依次是 ≈0 / 明显负 / ≈0
2. 关闭/开启脚本，用系统音量不动的前提下感知音量跳变是否消失
3. 与 B 站自带「音量均衡」并排比：两边都开、只开一边、都不开，记录主观评分（1-5 分）
4. 与 **587251 并排比**（不同时启用的前提下），重点是「卡暂停是否消失」

**第 3 步 · 回归：播放器不被破坏**
逐项确认：拖进度条 / 切清晰度 / 切分 P / 切集 / 切视频 / 全屏 / 画中画 / 倍速 0.5-2x / 后台标签页 30 分钟 / 连续播 20 个视频 —— 全过 = 无干扰。**这一关最容易出问题，必须一项项走。**

### 10.2 关键埋点（只读，不影响行为）

```js
console.table({ sidxSegments, sampledBytes, decodeMs, lufsMs,
                measuredLufs, truePeak, gainDb, limited, totalMs })
```

---

## 11. 风险清单与降级

| 风险 | 检测 | 降级 |
| --- | --- | --- |
| ⚠️ **B 站自带均衡已占用音频源**（`loudnessSwitch≠0` → B 站已 `createMediaElementSource`，**§2.7.5 实测**） | 读 `localStorage.bpx_player_profile.media.loudnessSwitch` **预判**，再 try/catch | 不接管，面板提示「关闭 B 站均衡」；若用户坚持 → 退 `volumeOnlyMode`（只削不补） |
| 元素被替换导致重复接管 | WeakSet 身份表 | 跳过，不 disconnect |
| 音画不同步（蓝牙延迟） | 比较 `ctx.outputLatency` | 面板显示 + 手动补偿，默认 0 |
| 后台标签页 rAF 停 | 用 `setInterval` | 天然规避 |
| `-412` IP 风控 | HTTP 状态码 | **立即停手**，本次会话不再请求 |
| `-799` 请求频繁 | 顶层 code | 指数退避，最长 3 次 |
| Range 越界 416 | HTTP 416 | 收缩抽样窗口到可用长度 |
| 试看 / DRM | `is_preview` / `is_drm` / `pssh` | 只对可用窗口归一 / 完全放弃并提示 |
| B 站改版（DOM/接口） | 找不到 video / 接口非 0 | 全局静默降级：`gain=1.0`，仅面板标红 |
| sn 字段 camel/snake 混用 | 字段归一函数 | `a.baseUrl \ | \ | a.base_url` 等双读 |
| Shadow DOM 拿不到深色主题 | `body.dark` 观察失败 | 兜底读 `document.documentElement.dataset.theme` + `prefers-color-scheme` |
| GM 存储超限 | **写入失败即腾位重试**（S3.2.6） | 先淘汰最旧 10% 再重试一次；仍失败则 `warn` 明说「不落盘」并返回 `false`，**绝不静默**（此前是静默 return，旧缓存永不释放） |


**通用原则**：任何失败都**不 pause / 不 preventDefault / 不 disconnect / 不 alert**，只更新面板状态，播放保持原声。

---

## 12. 分阶段交付（moxia选的「分两步走」→ 拆成四步更稳）

### S0 · 登录态实测 ✅ **已完成（2026-09-28 03:30–04:00）→ 结论见 §2.7**

> **执行摘要**：原定的 AppleScript 通道**作废**（WorkBuddy 缺 automation entitlement，所有 Apple Event 一律 `-10004`，见 §2.7.1）。**实际改用 CDP**：复制 976K 登录态文件 → `--headless=new --remote-debugging-port=9222` 独立实例 → Node 22 内置 WebSocket 执行 JS。**四项探测全部完成**，另加两项计划外的高价值实验（WebAudio hook + 均衡开关对比）。
>
> **最大的两个收获**：① 找到了 B 站响度归一的确切实现（`loudnessSwitch` + Web Audio GainNode，增益 = 元数据公式，实测吻合到 0.1dB）；② 发现**它默认是关的**——这才是moxia痛点的真根因。

#### S0 复现资产（可复用）

| 文件 | 作用 |
| --- | --- |
| `/tmp/bl_cdp.mjs` | 极简 CDP 客户端（list / goto / eval），零依赖 |
| `/tmp/bl_run_probe.mjs` | 单 URL：导航 → 等就绪 → 注入探测 → 输出 JSON |
| `/tmp/bl_batch.mjs` | 多 URL 批量探测，汇总 JSON 数组 |
| `/tmp/bl_spy.mjs` | **document-start 注入 spy**（hook AudioContext / GainNode / createMediaElementSource / volume setter）→ 导航 → 读回 |
| `/tmp/bl_spy2.mjs` | 同上，但中间插入 preJs 执行 + `Page.reload`（用于改 localStorage 后重载对比） |
| `/tmp/bl_hook_spy.js` | spy 本体：用 `Proxy` 包装 AudioContext 构造，记录所有音频图操作 |
| `/tmp/bl_read_spy.js` | 读回 spy 记录 + localStorage 播放器配置 |
| `/tmp/bl_enable_loudness.js` | 把 `bpx_player_profile.media.loudnessSwitch` 置 1 |
| `/tmp/bl_probe_video.js` / `_voltime.js` / `_pgc.js` | 三类探测载荷（普通投稿 / 时间序列 / 番剧） |

**关键工程经验**（踩过的坑）：
1. `Page.addScriptToEvaluateOnNewDocument` 必须**在 navigate 之前**调用，否则 hook 不到播放器初始化时的 AudioContext 创建（时机是 t≈722ms）。
2. Bash 工具对**长时间无输出**的命令会 SIGKILL（`exit 137`）→ 长任务一律 `run_in_background: true` + `TaskOutput` 等待。
3. macOS 无 `timeout` 命令；`osascript` 的 `tell application X to return "字面量"` 是**假阳性**（编译器不发事件），验证权限必须引用目标对象的真实属性。
4. CDP 的 `Runtime.evaluate` 配合 `awaitPromise: true` 可直接返回异步结果，比"注入-轮询"两段式简洁。

---

**原始 S0 计划（保留作对照，实际执行以 §2.7 为准）**

**目的**：本轮所有结论都是**未登录 curl** 得出的。第 13 节第 4 条（大会员集是否返回完整 `dash`）、第 2.3 节（普通投稿 `volume` 是否真的恒为 `null`）都需要登录态才能定论。若登录后普通投稿也吐 `volume` 元数据，**S2 的 sidx 抽样从「必需」降级为「兜底」，整个方案复杂度下降一档**。

**通道：AppleScript 直连（本机实测前提已确认）**

| 前提 | 实测结果 |
| --- | --- |
| Edge 版本 | `154.0.4258.37`，正在运行（16 进程），仅 `Default` profile |
| AppleScript 字典 | ✅ 含 `execute`（`code="CrSuExJa"`，参数 `javascript`，`handlesExecuteJavascriptScriptCommand:`） |
| JS 开关 | ❌ `allow_javascript_apple_events` 在 `Local State` / `Preferences` 中**无任何写入** → 默认关闭 |


> **⚠️ 需要moxia手动做一次**：Edge 菜单栏 `视图(View) → 开发者(Developer) → 允许来自 Apple 事件的 JavaScript(Allow JavaScript from Apple Events)`。这是 Edge 的硬门槛，不点开关我会收到 `Executing JavaScript through AppleScript is turned off` 报错。点一次长期有效。
> 首次调用还会弹一次系统授权「…想要控制 Microsoft Edge」→ 允许。

**实现要点（避开两个已知的坑）**

1. **JS 源码写文件再读入**，避免 AppleScript 引号转义地狱：
```applescript
set jsCode to (read POSIX file "/tmp/bl_probe.js" as «class utf8»)
```
2. **遍历窗口/标签定位 B 站页**，不假设 `front window` 就是目标（moxia可能在别的窗口）：
```applescript
tell application "Microsoft Edge"
repeat with w in windows
repeat with t in tabs of w
if URL of t contains "bilibili.com" then return execute t javascript jsCode
end repeat
end repeat
return "NO_BILIBILI_TAB"
end tell
```
3. **两段式异步**（AppleScript 的 `execute` 是同步的，`await fetch` 无法直接返回）：第一段注入任务写 `window.__blProbe`，第二段轮询读 `JSON.stringify(window.__blProbe)`。

**⚠️ 这条路线的能力边界（必须记清）**：页面内 `fetch` **自动携带 httpOnly Cookie**（`SESSDATA` 是 HttpOnly，`document.cookie` 读不到）—— 所以 P1/P2/P3 都能在页面上下文里跑通。但**代价是拿不到 Cookie 导出给 curl 复用**。如需 curl 对照，得另走 CDP 或手工复制。

**四项探测**

| # | 探测项 | 做法 | 判定与影响 |
| --- | --- | --- | --- |
| **P1** | 普通投稿响度元数据 | 在登录态 `/video/BVxxxx` 页面内：① 读 `window.__playinfo__` 的 `data.volume`；② fetch `x/player/playurl`（`fnval=4048` 与 `143312` 各一次）→ `data.volume` / `dash.volume` | `volume !== null` → **普通投稿也能走 FastPath**，S2 大幅简化；仍 `null` → 维持原设计（sidx 抽样为必经之路） |
| **P2** | wbi 签名接口 | 页面内裸调 `x/player/wbi/playurl`（带 Cookie、不带签名）看是否仍 412；若仍 412，则 **hook `window.fetch` 后触发一次播放**，抓 B 站自己请求 playurl 时的真实 URL 与签名参数 | 能拿到签名规律 → 多一条规范取流路径；拿不到 → 弃用 wbi，继续 `x/player/playurl` |
| **P3** | 大会员集完整 `dash` | 登录态打开任一会员专属集 → 读 `window.__playinfo__.result`：`video_info.dash.audio[]` 是否存在、`is_preview` / `error_code` / `timelength` / `volume` 元数据；页面内对照 fetch `pgc/player/web/playurl`（同源自动带 Cookie，无需 curl） | 返回完整 `dash` → 番剧 FastPath 在会员集上同样成立；并确认 `volume` 元数据是否随会员态变化 |
| **P4** | 页面内真实行为 | ① `__playinfo__` / `__INITIAL_STATE__` 关键字段快照（与未登录对照）；② `document.querySelector('video')` 的 `src`(blob:) / `crossOrigin` / `volume` / `duration`；③ 枚举 `window.player` 可用方法（找 `isInitialized` / `getVolume` / 音量均衡相关）；④ **找「音量均衡」档位的存储位置**（localStorage / 播放器设置对象）—— 能读到当前档位就直接验证 B 站是否在做客户端归一（替代 §10.1 第 0 步的听感判断） | 决定 §4.1 默认策略、§6 的元素发现策略是否要改用播放器私有 API |


**产出**：结构化 JSON 落 `/tmp/bl_s0_result.json`，逐项与未登录 baseline 做 diff 后回填到 §2.3 / §4.1 / §13。

**触发条件与降级**：通道自检（能读回 `location.href`）不通过 → 退到 CDP 路线（需完全退出 Edge，再用 `--remote-debugging-port=9222` 启同 profile）。**S0 不阻塞 S1**（S1 是纯 bug 修复，与元数据无关），但 S0 结论必须在 S2 动工前拿到。

---

### S1 · 骨架 + 零干扰验证 ✅ **已完成（2026-09-28 04:15–04:26）**

> **实现方式调整**：原计划写的是「在既有实现上删三处」，实际改为**从零搭骨架**。理由：那三处（`analyzeBeforePlay` / `disconnectVideo` / `alert`）并非「删掉就好」——它们深度耦合在原实现自己的架构里，剥离比重写更脏。我们要保留的是它**「整片一个固定增益」的产品理念**，不是那份代码。

- [x] 搭骨架：`src/` 5 模块（`config` / `logger` / `audio-engine` / `lifecycle` / `main`）+ `build.mjs`
- [x] `lifecycle.js`：video 发现 + 接管，**零** pause / preventDefault / disconnect / alert
      *（由构建期 **铁律守卫** 自动扫描产物保证，不靠人记）*
- [x] `audio-engine.js`：`MediaElementSource → GainNode(1.0) → destination`，纯直通不改声
- [x] 验证：见下表
- ⛔ 交付门禁：**通过** —— 可进 S2

#### S1 实测结果（CDP 自动化三轮 · 证据在 `probe/raw/bls1_*.json`）

| 轮次 | 场景 | 结果 |
| --- | --- | --- |
| 单页 | `BV1GJ411x7h7` | 接管 1204ms · `ctx=running` · **信号 RMS −16.89dBFS / 峰值 −1.88dBFS** · `video.volume` 未被动过 · 0 异常 |
| SPA 连播 | 同页点击 4 个不同视频 | **`<video>` 元素复用（元素数恒为 1）** · 切换 4 次只接管 1 次 · 每轮都有信号 · 0 异常 |
| **多标签页** | **4 页各一视频，挨个播放、一次只播一个** | **卡暂停 0 次**（每轮 `currentTime` 前进 3s = 完全正常）· 4 页全部 `ctx=running` · 0 异常 |

**两个副产物**

1. **B 站 SPA 切视频复用同一个 `<video>` 元素** —— 已由实测确认（原先标为【推测】）。这直接解释了「切视频后永久断哑」的成因：对**被复用**的元素调 `source.disconnect()`，等于把正在播的视频永久断哑。本方案「永不 disconnect」在此场景下天然正确。
2. **「有没有声音」不能只看 `ctx.state`** —— 挂起与非挂起的 AudioContext 都可能报 running 却无声。本方案用 `probeSignal()`（在 `masterGain` 上挂临时 `AnalyserNode` 抽头测 RMS/峰值）作为硬判据，这是 S1 最有力的那条证据。

**S1 未覆盖、需moxia在真实浏览器实测**：切清晰度、切分 P、后台标签页挂 30 分钟、**Tampermonkey 沙箱环境**（本地验证是页面上下文直注入，不含 Tampermonkey 的沙箱与 GM API 差异）。

### S2 · 全片抽样 + 响度归一（普通投稿）✅ **已完成（2026-09-29）**

- [x] `sidx.js` + `sampler.js` + `loudness.js` + `gain-planner.js`
- [x] `state-reader.js` / `playinfo.js`（只做 `video/*` 分支）
- [x] `store.js` 缓存（GM_setValue + LRU + TTL，缓存**原始测量值**而非增益）
- [x] 首次平滑过渡：分析期间保持 0dB 原声，算好后 `setTargetAtTime` 120ms 斜坡
- [x] 轻量调试 HUD（`hud.js`，非 S3 那套 Evolved 面板）
- [x] 验证：单元 52 项（S2.2 后扩到 101 项）+ 端到端 4 场景 + HUD 渲染 A/B

> **实现方式调整**：原计划把 12 段拼成一个大 Blob 一次解码，实测不可行（见 §12.2 坑 2），
> 改为**逐段独立解码再拼 PCM**。同时**没有加 WaveShaper 软限幅** —— 增益已由
> GainPlanner 的峰值预算从源头保证不削波，事后压限只会引入非线性失真。

#### S2 交付物

| 文件 | 说明 |
| --- | --- |
| `bili-loudness.user.js` | 单文件产物 96.2KB，14 个模块，可直接装 Tampermonkey（**当时的文件名**；S3.2.7 起改为 `Bilibili_LoudNorm.user.js`） |
| `probe/s2-unit.mjs` | 单元验证：sidx 解析 / K 加权系数对表 / 响度自洽 / 门限 / 增益规划 / HUD 样式顺序 |
| `probe/s2-verify.mjs` | 端到端：headless Edge + 本机登录态，4 场景 |
| `probe/s2-hud-verify.mjs` | HUD 真实渲染验证：注入完整产物读 `hudInfo()`，并同内容 A/B 对照两种 cssText（9 项判定） |

#### S2 实测结果（2026-09-29 · `probe/raw/bls2_result.json`）

**单元验证 52 / 52 通过**，其中三条是硬证据：

| 断言 | 结果 |
| --- | --- |
| K 加权系数 vs BS.1770-4 官方 48kHz 系数（20Hz–16kHz 逐点） | **最大偏差 0.0000 dB** |
| 1kHz 正弦测量 vs 解析公式（单声道 / 双声道各一次） | 差 **0.003 / 0.003 dB** |
| 同信号双声道比单声道高 3.01 dB | **3.010 dB** |
| HUD 宿主样式的字面顺序（§7，防「看不见」回归） | 9 项全过 |

**端到端 4 场景**：

| 场景 | 视频 | 结果 |
| --- | --- | --- |
| A 官方元数据 FastPath | `BV1GJ411x7h7` | `source=meta` · 实测 −13.5 LUFS · 增益 **−0.5dB** · 零下载 · 428ms |
| B 强制抽样对表 ★ | 同上（忽略元数据） | 本地 **−12.97** vs B站官方 **−13.5** → **差 0.53 LU** · 抽样 0.71MB（12/43 段 · 57.3s）· **解码覆盖 100%** · 0 失败段 · 1040ms |
| C 重载命中缓存 | 同上 | `source=cache` · 425ms · 零网络零解码 |
| D 长视频真抽样 | `BV1muab6rEbA`（110 分钟） | 1323 段取 12 段 · 0.63MB（全量 73.8MB 的 **0.85%**）· 实测 −18.69 LUFS · 增益 0dB（已过峰不提升）· 1942ms |

**索引自校验（S2 新增的硬判据）**：`endOffset = 2731668`，
探测 `bytes=2731667-` → **206**、`bytes=2731668-` → **416**。
两条合起来即「sidx 解析出的末尾偏移 == 文件真实长度」，
且只依赖可观测的状态码（`Content-Length` 不在 CORS 安全头列表里，页面读不到）。

**信号硬证据**：A 场景 `probeSignal` RMS −19.86 dBFS、峰值 −5.23 dBFS、`gainLinear=0.9441`
（= 10^(−0.5/20)，与标称 −0.5dB 一致）→ 增益确实写进了音频图，不是只改了状态变量。

**JS 异常 0** · 切清晰度/切分P 时元素身份不变（S1 已证复用），未触发重复分析。

#### S2 踩坑记录（四个，都已修）

**坑 1 · sidx 的 first_offset 基准点**
`first_offset` 的基准点是**「sidx box 之后的第一个字节」**，不是文件头。
漏掉它 → 每段整体前移 1482 字节（ftyp+free+moov+sidx 的长度）→ 抓到的字节全部错位。
**症状**：只有第 0 段能解码（它恰好含完整 init+sidx+moof+mdat），其余 11 段全部
`Unable to decode audio data`；表现为「抽样完成 57.3s」但「解码完成 4.9s」，
响度只反映开头 5 秒 —— **本质是同一个字节偏移错误换了张皮**。
**修复**：`Sidx.parse(buf, anchor)`，`anchor = indexRange.end + 1`；
另加自校验「首段必须以 moof 开头」，不满足则退回绝对偏移重试一次。
**副产品**：这个坑顺便解释了为什么 `bytes=2730186-` 没返回 416 —— 真实文件是 2731668。

**坑 2 · 多个 moof 拼成一个 Blob 后只能解出第一段**
B 站分片 tfhd 是 `default-base-is-moof=true`，trun.data_offset 相对 moof 起点
（该视频 1992）→ 单独解码合法，但**拼在一起解码器只解第一段**。
**修复**：`Sampler.fetchPlan()` 只取字节不做拼接，`analyzer.decodeSegments()`
逐段 `init + moof + mdat` 解码，再用 `Loudness.concatBuffers()`（含 5ms 淡入淡出）拼 PCM。

**坑 3 · BS.1770 多声道是求和不是平均**
按 `numberOfChannels` 做平均 → 所有**立体声**素材系统性偏低 3.01dB →
与官方元数据差 −2.48 LU（修正后 0.53 LU）。
**最阴的地方**：单元测试当时用的是同一个错误假设做「解析预测」，所以自洽通过了 ——
**假阴性**。修复后补了一条专门钉这条的断言：同信号双声道必须比单声道高 3.010 dB。

**坑 4 · `all:initial` 写在 cssText 末尾，把浮层推进了文档流**
HUD 宿主 `<div>` 靠 `all:initial` 隔离页面样式污染，但它被排在 cssText 的**最后一条**。
`all` 是 shorthand，重置所有属性、并且**按书写顺序参与层叠** —— 排最后就把前面写的
`position:fixed` / `z-index` / `display` 一并重置回 `static` / `auto` / `inline`。

**症状**：浮层被正常创建、正常渲染、内容完整，但掉进 body 末尾的常规文档流里。
实测（`probe/s2-hud-verify.mjs`，视口 500×450、文档高 2694px）：
宿主计算样式 `position=static, display=inline, z-index=auto`，
`getBoundingClientRect()` 给出纵坐标 **2672px** —— 要滚到页面最底部才看得见。
moxia的反馈原话就是「没有看到 hud」。

**为什么难发现**：不抛异常、不报错、不影响播放；构建守卫全过；单元测试全绿；
连截图都只拍视口内、拍不到它。唯一能戳穿它的是 `getComputedStyle` + `getBoundingClientRect`。

**修复**：
```js
const HOST_CSS = [
  'all:initial',                      // ← 必须第一条
  'display:block',                    // initial 会把它变成 inline，显式补回
  'position:fixed !important',
  'left:12px', 'bottom:12px',
  'z-index:2147483647 !important',
  'pointer-events:none',
].join(';');
```
修后同一页面实测：`position=fixed, display=block, z-index=2147483647`，
rect 230×135、在视口内、`Hud.info().visible === true`，七行内容完整渲染。

**顺带修掉的两个隐患**：

① 原挂载逻辑是「`document.body` 存在就 append，否则等 `DOMContentLoaded`」。
若注入时机卡在「body 尚未创建」而「DOMContentLoaded 已触发之后」，监听器永远等不到，
浮层无声无息丢失。改为 `mount()` 立即试 + `armMountRetry()` 每 250ms 补试（6 秒放弃），
并用 `document.body || document.documentElement` 兜底。

② `@run-at document-start` 时 body 尚不存在，兜底会把宿主挂到 `<html>` 上
（实测 `parent=HTML`）。虽然 `position:fixed` 通常不受父元素影响，但万一宿主 `<html>`
被加了 `transform` / `filter`，fixed 的定位基准就会变。故补 `watchForBody()`：
用 `MutationObserver` + `AbortController` 等 body 出现后把宿主迁移进去，
实测迁移后 `parent=BODY`。

> 这里**故意不用** `MutationObserver.disconnect()` —— 构建守卫会拦「无参 `disconnect()`」
> （它要防的是断掉音频图那条链，而 `MutationObserver` 的同名方法完全是另一回事，
> 无法用正则区分）。改用 `observe({ signal })` + `ac.abort()`，既绕开误报，也是更省心的写法。

**防回归**：`probe/s2-unit.mjs` §7 对 `HOST_CSS` 的**字面顺序**做断言（第一条必须是
`all:initial`、其后不得再有定位声明排在它前面、`display` 必须显式声明）；
`probe/s2-hud-verify.mjs` 注入**完整产物**后读 `hudInfo()`，并同内容 A/B 对照两种 cssText
（9 项判定全过）。
另新增自检接口 `Hud.info()` / `window.__biliLoudness.hudInfo()`，
一次性回答「它在不在、为什么看不见」，下次不必再靠猜。

---

#### S2.1 · 单页内切换失效修复 ✅ **已完成（2026-10-02）→ v0.3.0**

moxia实测反馈：**「单页只能获取到最开始打开的视频，之后不论是分p 还是在当前页打开新视频，
都显示获取失败」**（多标签页正常）。

##### 根因：`__INITIAL_STATE__` / `__playinfo__` 是首屏快照，SPA 导航后不刷新

`probe/s3-nav-probe.mjs` 在真实页面按「打开 → 点右侧推荐换视频 → 再换一个」逐步 dump
四层状态，证据如下（`probe/raw/bls3_nav.json`）：

| 观测点                      | 跳转前              | 跳转后（URL 已是 BV1AR4y1a7L8） |
| ------------------------ | ---------------- | ------------------------ |
| `location.pathname`      | `.../BV1GJ411x7h7/` | `.../BV1AR4y1a7L8/`      |
| `__INITIAL_STATE__.bvid` | BV1GJ411x7h7     | **BV1GJ411x7h7（没变）**      |
| `__INITIAL_STATE__.cid`  | 137649199        | **137649199（上一个视频的）**    |
| `__playinfo__` dash 时长   | 213s             | **213s（上一个视频的）**         |
| `<video>` 元素身份           | #1               | **#1（被复用）**              |
| 脚本 key                   | `v:BV1GJ411x7h7:137649199` | **同一个 key（等于什么都没做）**   |

`probe/s3-nav-fail.mjs` 进一步拿到接口层的判决 —— 同一个 bvid，
分别用「过期 cid」与「正确 cid」调 playurl（`probe/raw/bls3_fail.json`）：

```json
{
  "bvid": "BV11b411L7mg",
  "过期": { "cid": 137649199, "code": -404, "message": "啥都木有", "hasDash": false },
  "正确": { "cid":  86380334, "code":    0, "message": "OK",     "hasDash": true }
}
```

**这就是「获取失败」四个字的全文。**

##### 双重危害（第二个更阴）

| 条件                           | 表现                                               |
| ---------------------------- | ------------------------------------------------ |
| 新旧视频时长差 **> 2s**（原有过期判据生效）   | 丢给接口 → `-404` → **明确报「获取失败」**（用户看到的）              |
| 新旧视频时长差 **< 2s**（原判据漏掉）      | **静默**把上一个视频的响度算到新视频头上 → 数字错，但不报错，且会写进缓存        |
| 同页切分P（bvid 不变，`pages` 属于旧视频） | cid 同样错配；且原 `tick()` 只在「元素被替换」时触发，切分P 往往连触发都没有 |

##### 修复（四层，缺一不可）

**① `state-reader.js`：页面状态新鲜度校验**（地基）

```js
function stateBvid(st) {          // 只有 bvid 能与 URL 交叉校验
  if (st && /^BV/.test(st.bvid || '')) return st.bvid;
  const vd = st && st.videoData;
  if (vd && /^BV/.test(vd.bvid || '')) return vd.bvid;
  return null;                    // 取不到 = 不可信（宁可多一次接口请求）
}
function pageFresh() { return stateBvid(initialState()) === bvid(); }
```

`videoKey()` 里 `stateFresh === false` 时 **cid / duration 一律为 null**，
绝不复用旧值；`cacheKey` 退化成 `v:{bvid}:p{n}` 等接口补全后再定。

**② `playinfo.js`：`__playinfo__` 四重可信度判定**

| 判据 | 条件 | 结论 |
| --- | --- | --- |
| ① | 这份对象 == 已采信对象 **且** key 相同 | 复用（页面内多次触发） |
| ② | `pageFresh()` 为真 | 采信 —— 同源注入，必新鲜 |
| ③ | 页面过期，但对象**被换过**且 `duration` 与元素吻合 | 采信（B 站确实刷新过，仍吃 FastPath 红利） |
| ④ | 其余 | **拒绝** → 回落接口 |

> ②③ 之间那个 `acceptedRef !== null` 的前置条件很关键：没有「基准」就无法证明
> 「对象被换过」。少了它，脚本刚起来就切视频的竞态会把旧元数据当成新视频的用
> （`probe/s3-unit.mjs` 有一节专门钉这条）。

同时 `resolveCid()` 升级为 `resolveVideo()`：走 `x/web-interface/view`，
**按 bvid 缓存整份结果**（含全部 pages），同一视频切分P 零额外请求。

**③ `analyzer.js`：等播放器切流**

SPA 切视频时 URL 几乎立刻变，但播放器换流要晚 1–3 秒。
实测证据：点推荐视频后 **45s** 内 `<video>.duration` 都还是上一个视频的 213s。
这中间若照旧施加，就成了「把新视频的响度压到还在播的旧视频上」。

```js
if (expected && actual && Math.abs(expected - actual) > CONFIG.streamWaitToleranceSec) {
  if (!waitForStream(key, expected, actual)) return;   // 挂起，不写 appliedKey
}
```

`waiting` 是独立阶段（HUD 显示「等待切流 · 已等 Xs」），此时**保持原声**、绝不干预。
宽限期 `streamWaitGraceSec: 20` 兜底 —— 播放器行为异常时永久等待会让功能彻底失效，
比短暂错配更糟；超过宽限期就照常分析并记 warn。

**④ `lifecycle.js`：路由变化检测**

```js
const href = location.href;
const urlChanged = lastHref !== null && href !== lastHref;
if (!urlChanged && el === lastEl && AudioEngine.isAttached(el)) return;
...
if (swapped || urlChanged) Analyzer.maybeRun(el, urlChanged ? '路由变化' : why);
```

必须比对**完整 href**（含 `?p=`），否则切分P 漏触发。

**⑤ 缓存命名空间 `blv1` → `blv2`**

v1 时期可能已写入「用上一个视频的响度算出的增益」这类脏条目，
不升版本会一直命中，改了也看不出效果。**改判定逻辑必须升版本**。

##### 一个必须记住的接口事实

多分P 视频的 `view.data.duration` 是**所有 P 的总时长**，不是单 P 时长：

```
BV11b411L7mg → data.duration = 1266s（总和）   ← 陷阱
               pages[0].duration = 182s（第 1P）  ← 正确的期望时长
```

拿 `data.duration` 当「等切流」的期望值，判据会整个反过来。
已写成断言钉死（`probe/s3-unit.mjs` §3）。

##### 验证

| 套件                  | 结果                          |
| ------------------- | --------------------------- |
| `probe/s3-unit.mjs` | **31/31**（含事故全流程复刻）         |
| `probe/s3-nav-verify.mjs` | **17/17**（真实浏览器两轮换视频）      |
| `probe/s2-unit.mjs` | 52/52（回归；S2.2 后已扩到 101 项）      |
| `probe/s2-verify.mjs` | A/B/C/D 四场景全过，数字与修复前一致（回归） |

`s3-nav-verify.mjs` 两轮各验一半：

- **B 轮（真实等切流）**：key 的 cid 与 `view` 接口一致（`v:BV1AR9GBkEcy:37137810603`）、
  `stateFresh=false`、`source=sample`（**没有**误用过期元数据）、
  首次 `waiting` 出现在 0.5s 而增益直到 **22.6s**（宽限期）才落位 —— 旧实现在 1–3s 就压了。
- **C 轮（强制穿过等待门）**：临时把容差放大，验证 key/cid 正确之后整条链路能跑通：
  `phase=active`、`source=sample`、实测 −8.63 LUFS、增益 −5.37dB、
  `gainLinear=0.5389` 换算回 **−5.370dB** 与显示值吻合（增益真的进了音频图）。
- **网络层**：全程 playurl **75 次、`-404` 零次**。

##### 新增自检入口

```js
__biliLoudness.pageState()
// → { stateFresh, reader:{bvid,p,cid,duration}, pagePlayinfo:{duration,measuredI}, video:{duration} }
```

`stateFresh=false` 就说明页面注入的数据已过期、cid 走的是接口 —— 一眼定位，不必再猜。

#### S2.2 · 抽样提速 + 旁路开关 ✅ **已完成（2026-10-02）→ v0.4.0**

**起因**（moxia实测反馈）：

> 「等待时长还好，但是抽样时长不太稳定，有时候很快，但有时得等 6s 以上。没有旁路开关，感受不明显，希望可以增加一个」

**第一步：把「时长」拆开 —— 不拆开就无从下手。**

原来只有 `sampleMs` 一个笼统的数。现在按环节埋点（`state.timing`）：
索引（init+sidx 并行）/ 首批下载 / 解码 / 响度 / 精修，外加单段最慢与中位耗时。
HUD 直接显示 `耗时 索引0.28s 下载1.05s 解码0.03s 响度0.08s`。

**第二步：复现「6s+」。**

`probe/s2-timing.mjs` 用 CDP 限速（RTT 400ms / 200KB/s）复现慢网络，
同一视频两种模式各跑 2–3 轮（原始输出 `probe/raw/bls22_timing.json`）：

| 场景 | 不分批（S2.1 语义） | 分批 + 够用即开工（S2.2） | 改善 |
| --- | --- | --- | --- |
| 热网络 · 首次可用 | 699–741ms（中位 708） | **212–516ms（中位 213）** | **−70%** |
| 慢网络 · 首次可用 | 6152–6323ms（中位 6323） | **2846–3075ms（中位 3075）** | **−51%** |
| 慢网络 · 最终稳定 | 6323ms | 6562ms | 持平（总工作量没变） |
| 热网络 · 首批下载 | 699–740ms | **211–515ms** | −70% |
| 慢网络 · 首批下载 | 6152–6323ms | **2846–3075ms** | −54% |

**★ 慢网络那行的 6323ms 就是moxia说的「6s 以上」，复现成功。**

根因不是「下载总量大」，而是**木桶效应**：12 段全到齐才开工，
于是「最慢那一段」决定整条链路何时可用。而慢段往往来自 CDN 冷连接、
与播放器抢带宽、偶发重传 —— 恰恰是最不可控的部分。

**第三步：三处结构性修改**

| # | 改动 | 说明 |
| --- | --- | --- |
| 1 | **够用即开工** | 首批发出后不等全到齐，凑够 `firstBatchEagerAt=4` 段就把结果交出去先算，其余在后台继续取。单元测试直接钉死：**`early 5ms / all 406ms`** —— 最慢段彻底离开关键路径 |
| 2 | **分批 + 精修** | 均匀 12 段里**等距**挑 6 段做首批（含首尾 → 覆盖仍是 0%–100%），先落位；剩下的段后台补齐后重测。精修与初测差 ≥ `refineMinDeltaDb=0.5dB` 才重新落位，小差异不动（避免无意义抖动） |
| 3 | **单段容错** | 单段超时从 15s 收紧到 `segTimeoutMs=5s`，失败重试 1 次，仍失败就丢掉这一段并记 warn；凑够 `minSegmentsToProceed=3` 就继续。原来任何一段抛错都让整次分析失败重来 |

另外把 init 与 sidx 两次 Range 改成**并行发**（两个区间互不重叠），省一个完整 RTT。

**代价与取舍（诚实记录）**：
- 初测落在 4 段（≈19s 音频）时，与 12 段精修结果的增益差实测 0.37–0.91dB。
  超过 0.5dB 会重新落位一次 —— 用户可能在视频开头 1 秒内听到一次微调。
  这是「快」换来的代价，HUD 用 `初测` / `已精修` 两个标记把这件事显性化。
- 不分批模式（`progressive=false`）保留，阈值自动变成「等全批」，
  A/B 对照才是在比同一件事。

**旁路开关（A/B 对比原声）**

要「感受」归一前后的差别，就得有个一键来回切的开关。实现要点是把
**「想要施加的增益」与「实际施加的增益」拆成两个变量**：

```js
desiredGainDb  // 归一流程算出来的目标，旁路期间原样保留
bypass         // true 时 applyGain() 一律按 0dB 施加
```

于是旁路 ≠ 停用：**分析照跑、结果照存、目标照记**，切回来是瞬时的
（不用重新等抽样）。三条入口：

| 入口 | 说明 |
| --- | --- |
| 快捷键 `Shift+B` | 默认键。B 站自身快捷键（`d` 弹幕 / `f` 全屏 / `m` 静音 / `w` 网页全屏）里没有 `b`，实测不冲突 |
| 油猴菜单 | 「旁路开关（对比原声 Shift+B）」 |
| 调试 API | `__biliLoudness.setBypass(true)` / `toggleBypass()` / `isBypass()` |

按下时 HUD 会多一行 `旁路 听原声（归一 +X.XXdB 未施加）`，同时弹一个 1.4s 的
小 toast —— HUD 关着的时候也有反馈，否则「按了没反应」会让 A/B 做不下去。

⚠️ 快捷键监听里**故意不调用 preventDefault**（构建守卫也禁止），
我们只是「顺便看一眼」按键，不拦页面行为。单元测试专门断言了这条。

**验证结果**（2026-10-02）

| 验证 | 结果 |
| --- | --- |
| `probe/s2-unit.mjs` | **101 项全通过**（新增：`pickCoarse` 分层选段 / 分块双二阶逐位一致 / 旁路语义 / 单段容错 / 够用即开工 / HUD 旁路行 / 快捷键铁律） |
| `probe/s3-unit.mjs` | 31 项全通过（无回归） |
| `probe/s2-verify.mjs` | A–E 五场景全通过：对表仍差 **0.52 LU**、抽样路径 12 段 57.3s、旁路 8 项断言全绿 |
| `probe/s3-nav-verify.mjs` | **17/17**，全程 playurl `-404` 零次 |
| `probe/s2-timing.mjs` | 上表的 A/B 数据（`probe/raw/bls22_timing.json`） |

实测片段（`probe/raw/bls2_result.json`）：
- 首屏视频 B 场景：初测落位 **394ms**，refined Δ=0.45dB < 0.5 → **增益不重落位**（无抖动）
- 110 分钟视频 D 场景：初测落位 **691ms**（同一脚本此前测到 2164–6986ms）

##### S2.2 新增的三个坑

| # | 坑 | 现象 | 修法 |
| --- | --- | --- | --- |
| 1 | **音频时钟 vs 墙钟** | headless Edge 没音频输出设备，`AudioContext.currentTime` 会**完全停滞**，`setTargetAtTime` 的斜坡冻在半路。轮询 40 次（6s）线性值一动不动 | **这是测试环境的限制，不是实现问题**。`s3-nav-verify` 的断言从「精确相等」降级为「同向且量级一致」；精确落位交给 `s2-verify` 场景 E（那里页面在放音、时钟推进，能精确读到 1.0 / 0.8892） |
| 2 | **中途改配置会污染分析** | timing 脚本在页面自动分析跑到一半时改 `progressive` → 它在 coarse 落位后、进精修前读到新值，**跳过精修**，`refined` 永远停在 false | 测试前先 `settle()` 等上一次彻底收尾，再改配置、再触发 |
| 3 | **诊断表格挡在状态更新前** | `console.table` 排在 `push('active')` 之前，实测把状态落位推迟 **343ms** | 所有诊断输出移到 `push` 之后，且只在开调试时打 |

#### S3.1 · 番剧 / 影视链路适配 ✅ **已完成（2026-10-02）→ v0.5.0**

**开工前先取证**（`probe/s3-pgc-probe.mjs` → `probe/raw/bls3_pgc.json`）。
S0 的结论大体成立，但**字段路径有两处和预想不一样**，现场 dump 才钉死：

| 观测点 | SSR `__playinfo__.result` | 接口 `pgc/player/web/playurl` → `j.result` |
| --- | --- | --- |
| dash 位置 | **`video_info.dash`**（不是 `result.dash`） | **`dash`**（扁平） |
| audio 字段 | **全 snake_case**（`base_url` / `segment_base` / `mime_type`） | **两套并存**（`baseUrl` + `base_url`） |
| 响度元数据 | **`video_info.volume`**（snake_case）✅ | **不存在**（只此一份） |
| cid / bvid | **`arc.cid` / `arc.bvid`** | **无 arc** |
| 试看 / DRM 标志 | `video_info.is_preview` / `is_drm` | `result.is_preview` / `is_drm` |
| 回退流字段 | `result.durl`（SSR） | **`result.durls`**（接口，多个 s） |
| `__INITIAL_STATE__` | **完全不存在（0 次）** | — |

> ⚠️ **两条路的 dash 位置不同**，只兜一条就会「首屏能认、切集后认不出」的半死状态
> —— `normalizePgc` 里多路径兜住（`vi.dash || result.dash`）。

**四处改动**

| # | 改动 | 说明 |
| --- | --- | --- |
| 1 | **`StateReader` 加 pgc 分支** | `kind()` / `epId()` / `seasonId()` / `pgcKey()`；`cacheKey` 前缀 `p:{ep_id}` |
| 2 | **番剧新鲜度换判据** | 番剧页**没有 `__INITIAL_STATE__`**，没法用 bvid 交叉校验 → 改用「**对象身份 + ep_id 配对**」：B 站重新注入（换对象）→ 认新鲜；同一对象但 URL 的 ep 变了 → 判过期 |
| 3 | **`PlayInfo` 加 `result` 分支** | `normalizePgc()` 双路兼容；`fromPgcApi()` 走 `pgc/player/web/playurl?ep_id=`；错误码看**两处**（顶层 `code` 与 `result.error_code`） |
| 4 | **`Analyzer` 加番剧「等切集」** | 接口给出的时长 vs `<video>.duration`，**有界轮询 ≤ 8s**（`pgcStreamWaitMs`）；等到了才施加，避免「把新集的响度压到还在播的旧集尾巴上」 |

**cacheKey 刻意不带 cid**：ep_id 与 cid 是 1:1，而回落接口**只需要 ep_id**（实测）
→ 不带 cid 反而更稳，不会因「首屏有 cid、切集后拿不到 cid」而分裂成两个缓存条目。

**错误码分派**（番剧特有）：

| 码 | 处理 |
| --- | --- |
| `-412` IP 风控 | **fatal：立即停手，不重试**（越试越糟） |
| `-403 / -404 / -688 / -689` | **skip：跳过分析**，标「跳过」而非「失败」（不是故障，是这类内容本就不该分析） |
| `-352 / -799` | 退避重试 **1 次** |
| 顶层 `code=0` 但 `result.error_code=-10403` | **不是错误**，是试看 → 正常返回并标「试看片段」 |

**试看识别（5 条命中路径）**：`is_preview===1` / `error_code===-10403` /
有回退流无 dash / 回退流长度 < `timelength` / `play_check.play_detail !== 'PLAY_WHOLE'`。

##### ⚠️ 一条容易误解的事实：**番剧不「默认跳过归一」**

moxia 2026-10-03 提过这个疑问（他在真机上手开某些番剧时看到面板显示「已跳过」）。
**查证结论：番剧与普通投稿走的是同一条归一流程**（`Analyzer.analyzeKey` 无分叉），
`CONFIG` 里**没有任何「跳过番剧」的开关或默认值**。会 `skipped` 的只有这四类：

| 才 `skipped` 的情况 | 位置 |
| --- | --- |
| `-403 / -404 / -688 / -689`（权限不足 / 资源不存在 / 地区限制 / 版权限制） | `config.js` `pgcSkipCodes` |
| DRM 加密内容 / 试看片段 / 仅返回 durl | `analyzer.js` |
| 未识别到 `ep_id`（季落地页还没定集） | `analyzer.js` |
| 未识别到可分析的页面目标 / bvid | `analyzer.js` |

**反证**：免费集 `ep308426` 实测就是 `phase=active / source=meta`（见上方验证 A）→ 番剧**会**归一。

**「已跳过」是设计行为，不是故障** —— `analyzer.js` 原注释：

> 这不是「故障」，是这类内容本来就不该分析：保持原声、标「跳过」，**不打成 error**，
> 免得用户以为是脚本坏了。

**已知代价（moxia拍板不改）**：面板此时只写「已跳过」，**不显示 `reason`**
（`panel.js` 的 `sampleText()`）。原因是 `reason` 是 debug 串 ——
`pgc playurl code=-689 版权限制，无法观看（ep_id=308426）` —— 直接上屏比「已跳过」更难懂。
把它翻成人话（`已跳过 · 需要大会员` / `地区限制` / `版权限制`）是一条**待办**，
但 2026-10-03 moxia明确「**不改，知道它正常就行**」→ **现状保留**。

> **为什么会误以为「番剧默认跳过」**：① 规划稿里躺着一条从未实现的
> 「接管番剧官方归一（默认关）」（见 §8.2，已标注否决）；② 受限集显示「已跳过」且不给原因。
> 两条叠加，很容易读成「番剧这个品类整体不归一」。

**验证结果（2026-10-02）**

| 验证 | 结果 |
| --- | --- |
| `probe/s3-pgc-unit.mjs` | **70/70**（页型识别 / ep 配对新鲜度 / 两种 dash 形状 / snake_case 与 camelCase 双读 / 5 条试看路径 / DRM / 错误码分派 / 短缓存 / 源码守卫） |
| `probe/s3-pgc-verify.mjs` | **24/24**（真实浏览器：FastPath / 强制抽样 / SPA 切集 / 旁路） |
| `probe/s2-unit.mjs` · `s3-unit.mjs` | 101/101 · 31/31（无回归） |

实测数据（`probe/raw/bls3_pgc_verify.json`）：

- **A** 免费集 `ep308426`：识别 `epId=308426`、SSR 新鲜 → **FastPath `source=meta`，实测 −23.8 LUFS**（与官方元数据逐位一致），302ms
- **B** 强制抽样：12 段取 289 段之一，覆盖 **100%**，sidx 自校验 **206/416** 通过、首段偏移 4420（= anchor），音频 56s
- **B2 精度**：段数 12 → 48 时测量收敛 **1.07 LU → 0.17 LU**（12 段 ≈ 60s ≈ 全片 4%，抽样误差约 1 LU 属正常）
- **C** SPA 点「下一集」：`p:308426 → p:309868`，`source=sample`（**正确识别出陈旧 SSR** —— 实测切集后 `arc.cid` 仍是上一集的 141064726、`volume` 仍是 −23.8），**playurl `-404` 零次**
- **D** 番剧页旁路：`applied 7.72 → 0 → 7.72`，`desired` 全程保留

##### S3.1 新增的两个坑

| # | 坑 | 现象 | 修法 |
| --- | --- | --- | --- |
| 1 | **SSR 与接口的 dash 位置不同** | 按 S0 笔记只兜 `result.video_info.dash`，接口那条路会取不到音频轨 | 两条路径都兜；单元里各写一组夹具钉死 |
| 2 | **「Uncaught (in promise)」误判成我方异常** | 端到端里恒有 2 条 `reason=undefined` 的未捕获 rejection，看着像脚本抛的 | **对照实验**（`probe/s3-pgc-control.mjs`）：**不注入脚本**、只点「下一集」，同样抛 2 条 → 是 B 站自己换集的 unhandled rejection。判据改为「不超过对照基线」，而不是「必须为 0」 |

#### S3.2 / S3.2.1 / S3.2.2 / S3.2.3 / S3.2.4 / S3.2.5 · Evolved 风格设置面板 ✅ **已完成（2026-10-02 初版 v0.5.0 / 2026-10-03：v0.5.1 真机修订 · v0.5.2 真机校准 · v0.5.3 布局交互修订 · v0.5.4 二轮修订 · v0.5.6 文案说人话 + 数值格式统一）**

按 §8.1 的结构实现（`src/panel.js`，构建后 15 个模块），交互按moxia的原话定：

> 未选中时收在左侧边，鼠标移到上面时按钮出现，点击后出现完整菜单；网页全屏时完全隐藏。
> 面板分两个：**当前状态**（悬停圆钮显增益 + 当前响度；展开后上方是「功能是否开启 / 采样完成状态 / 增益来源」，
> 下方是「开启旁路」按钮）和**设置**（功能开关 / 预设 / 目标响度滑块 / 增益上下限滑块 / 缓存内容说明 / 清除缓存）。

**交付物**

- `src/panel.js`（新）—— 样式 + 两个面板 + 交互状态机 + 全屏判据 + 自检入口；**S3.2.3：宿主 `top:33.333vh` + `.btns` 上移半高、删 `.side:hover` 改单钮滑出、去掉 `scale` 二次弹出、宿主 `pointer-events:none` + 冒泡 `document` click 收起、`.tip` 绝对定位按被 hover 按钮对齐、`.pnl { width:176px; box-sizing:border-box }` + 全量短文案**；**S3.2.4：`.side` 恒收起（新增 `--shift`）+ `.bl-pin` 不再改 transform、滑出规则合为 `.rdw:hover`/`.rdw.bl-open`、`.tip`/`.pnl` 的 `left` 改 `calc(var(--rail) + var(--shift))`、`togglePanel(which, btn)` 按各自按钮写 `pnl.style.top` 并切 `.bl-open`**；**S3.2.5：限幅行渲染改「未限幅」、旁路与清除缓存的 note 改直述动作（按钮/悬停/标签一律未动）**
- `src/store.js` —— 新增 `getSettings()` / `setSettings()`，key `blv2:__settings`，**刻意不进 LRU、不吃 TTL**；**S3.2.6：`get()` 命中补 `bump()` 续期（真 LRU）、TTL 过期 `dropFromIndex()` 同摘索引、写失败 `evictOldest()` 腾位再重试**（详见 §12「S3.2.6」）
- `src/config.js` —— `panel` / `fullscreenHide` / `targetRange` / `maxBoostRange` / `minGainRange` / `profiles.custom`；**S3.2.1：`hud: true→false`、`version 0.5.1` / `stage S3.2.1`**；**S3.2.2：`version 0.5.2` / `stage S3.2.2`（真机校准闭环，无功能变更）**；**S3.2.3：`version 0.5.3` / `stage S3.2.3`（布局与交互修订）**；**S3.2.4：`version 0.5.4` / `stage S3.2.4`（二次修订）**；**S3.2.5：`version 0.5.5 → 0.5.6` / `stage S3.2.5`（文案说人话 + 数值格式统一带空格）**；**S3.2.6：`version 0.5.7` / `stage S3.2.6`（`store.js` 缓存语义修正，无面板改动）**
- `src/gain-planner.js` —— **S3.2.5：`limitReason` 改说人话 + 格式统一**（受削波预算 `+1.7 dB（防止爆音）` / 过峰 `+0 dB（素材已过峰）` / `档案上限 +6 dB` / `档案下限 -60 dB`，**数值与单位间一律一个空格**）。该串**面板与日志共用**，改它等于改用户看到的话
- `src/main.js` —— `Panel.init()` 接在 `Lifecycle.start()` **之前**（设置须先落位）+ `try/catch` 护栏 + 调试接口
- `build.mjs` —— `panel.js` 插入 `hud.js` 与 `analyzer.js` 之间（15 模块；S3.2 时 191.4 KB → S3.2.1 后 198.1 KB → S3.2.2 后 199.2 KB → S3.2.3 后 204.6 KB → S3.2.4 后 208.2 KB → S3.2.5 后 209.1 KB → 格式统一后 209.4 KB → S3.2.6 后 212.4 KB → **S3.2.7 后 212.5 KB**）

**验证**

| 套件 | 结果 |
| --- | --- |
| `probe/s3-panel-unit.mjs`（新） | **191/191**（S3.2 时 113 → S3.2.1 后 141 → S3.2.2 后 148 → S3.2.3 后 174 → S3.2.4 后 185 → S3.2.5 后 190 → **格式统一后 191**）—— 样式不变量 / **假 DOM 沙箱里跑真实 `panel.js`** 的交互状态机（含单钮滑出、点外部收起、浮窗对齐、**面板各按自己按钮对齐**、**S3.2.5 三处文案 + 数值带空格**）/ 全屏三路判据（含真机类名回归） / 定位方式 / HUD 开关守门 / 接线完整性 |
| `probe/s3-panel-verify.mjs`（新） | **85/85**（S3.2 时 54 → S3.2.1 后 63 → S3.2.3 后 73 → S3.2.4 后 80 → S3.2.5 后 84 → **格式统一后 85**）—— 真实浏览器，shadow DOM 内真实点击与拖拽 + CDP 真指针验 hover |
| 回归 | `s2-unit` 105/105 · `s3-unit` 31/31 · `s3-pgc-unit` 70/70 · `s3-pgc-verify` 24/24 |

**端到端实测要点**（`probe/raw/bls3_panel_verify.json`，番剧页 `ep308426`，viewport 792×482）

- 定位：挂 `BODY`、shadow 隔离、`fixed`、`z-index=2147483647`、**`x=0`**；**宿主 `y=161`（= `33.333vh`，按钮列中点落视口 1/3）**；圆钮 **42×42**、列中点 `161`（期望 `160.7`）
  - 位置演进：**S3.2** 中心 `y=203+38=241`（视口半高、与 Evolved 重合）→ **S3.2.1** `y=0` 贴顶（moxia嫌太高）→ **S3.2.3** `y=161` = 视口 1/3
- 交互：初始两面板皆收起；**S3.2.3** 真实 hover 状态钮 → 它自己右移 `-20 → 8`、**另一只 `-20 → -20` 不动**；点展开且钉住；切「设」→ 状态面板自动收起；**点面板外 → `open: status → null` 且 `.bl-pin` 摘掉**
- 状态面板文案与 `analysis()` 逐项一致（功能已开启 / 采样已完成 / 来源 官方元数据 · 免下载 / 实测 -23.8 LUFS / 增益 +1.70 dB（TP -2.7）/ **限幅 +1.7 dB（防止爆音）**（S3.2.5 前为 `削波预算 +1.70dB（真峰值 -2.7dBTP，余量 -1dB）`）/ 页型 番剧 / 影视）
- 设置面板：下拉列全 6 档；三滑块范围 `[-28,-8] / [0,18] / [0,-60]`；**面板渲染宽度 176px**；换预设 `night` → 零下载重算；
  **拖目标滑块到 −28 → 自动切 custom → `analysis.targetLufs=-28` → 真实增益 `+1.7 → -4.2 dB`**
- 旁路按钮：`isBypass false→true`、文案翻「关闭旁路」、再点恢复「旁路（听原声）」
- 全屏：`requestFullscreen()` 抛 `TypeError`（已知边界）→ 加全屏 class 的可控路径下 `detected=true`、`.bl-hide`、`display:none`；移除后恢复
- 清除缓存：`entries 1 → 0`，而 `settings`（`profile=custom` / `enabled=true` / `custom` 三元组）**逐字未变**
- 我方模块异常 **0** 条；普通投稿页（`BV1GJ411x7h7`）复检 `kind=video`、面板正常、分析 `active`

##### S3.2 新增的三个坑

| # | 坑 | 现象 | 修法 |
| --- | --- | --- | --- |
| 1 | **往 `ShadowRoot.style` 写主题变量** | `root.style.cssText = ...` → `TypeError: Cannot set properties of undefined (setting 'cssText')`。ShadowRoot 是 DocumentFragment，**没有 `style` 属性**。要命的是它发生在 `boot()` 里，把后面的 `Lifecycle.start()` 与 `exposeDebugApi()` **一起带走** → 现象是「面板建出来了、但 `window.__biliLoudness` 是 undefined、归一完全没启动」 | 主题变量改由 shadow 内一个 `<style>` 承载（`:host{...}`，可继承进 shadow 树）。**此错由端到端抓出** —— 单元没抓到，因为假 DOM 当时给 shadow root 配了 `.style`；假 DOM 已改成忠实复现（`delete s.style`） |
| 2 | **UI 的错拖垮核心功能** | 坑 1 的直接后果：面板起不来 = 归一也用不了 | `main.js` 里 `Panel.init()` 加 `try/catch`：面板起不来就 `setPanelEnabled(false)` 放弃面板，**归一照跑** |
| 3 | **旁路按钮文案不翻面** | 点击后调 `render(lastSnap)`，而 `bypass` 是「实时读」的字段，旧快照里仍是 `false` → 又把旧值画回去 | 改为 `render(Analyzer.snapshot())`。**此错由单元测试先抓到** |

##### S3.2.1 修订（2026-10-03）—— 真机反馈驱动

**moxia真机反馈四条**：① 圆钮看着只有 Evolved 的一半大；② 位置与 Evolved 侧边按钮重合、打架；
③ 调试 HUD 与状态面板重复、且一直留在界面上；④ 按钮文字改图标。

**取证**：从 Evolved 产物（`dist/bilibili-evolved.user.js`）里定位到 `.be-settings > .sidebar`
—— 确认它就是我们撞车的那一个（同样 `position:fixed; top:50%`），随后按它的数值逐条对齐（详见 §8.4 三列对照表）。
谜题解开了：Evolved 圆钮 `width/height:26px` + `padding:8px`（`box-sizing:content-box`）= **外径 42px**；
我们旧版只有 `26px` 且 `padding:0` → **视觉上正好"一半大"**。

**改动清单**：

| 文件 | 改动 |
| --- | --- |
| `src/config.js` | `hud: true → false`（默认关闭）；`version 0.5.1` / `stage S3.2.1` |
| `src/panel.js` | 圆钮 26 → **42px**（content-box + padding）、**去描边**、**文字改 MDI 图标**（`createElementNS` 内联 SVG，规避 CSP / Trusted Types）、间距 `8 → 26px`、热区 `::after` 外扩 20%、**位置改固定左上**（`HOST_CSS` 的 `left:0/top:0`）；**删掉** `positionSelf()` / `playerBox()` / scroll 监听 / rAF 节流；`info()` 新增 `placement` 自检 |
| `probe/s3-panel-unit.mjs` | 假 DOM 补 `createElementNS` / `setAttribute` / `getAttribute` / `querySelectorAll` / **`DOMRect` 的 `top`·`left`**；断言 113 → **141**（S3.2.1）→ 148（S3.2.2）→ **174**（S3.2.3） |
| `probe/s3-panel-verify.mjs` | 圆钮改按 `aria-label` 定位（已无文字）；断言 54 → **63** |

**验证（全绿）**：

| 套件 | 结果 |
| --- | --- |
| `probe/s3-panel-unit.mjs` | **191/191**（S3.2.1 时为 141 → S3.2.2 后 148 → S3.2.3 后 174 → S3.2.4 后 185 → S3.2.5 后 190 → 格式统一后 191） |
| `probe/s3-panel-verify.mjs` | **85/85**（S3.2.1 时为 63 → S3.2.3 后 73 → S3.2.4 后 80 → S3.2.5 后 84 → 格式统一后 85） |
| 回归 | `s2-unit` 105/105 · `s3-unit` 31/31 · `s3-pgc-unit` 70/70 · `s3-pgc-verify` 24/24 |

实测硬证据（`probe/raw/bls3_panel_verify.json`，番剧页）：

- 圆钮 **42×42 / 42×42**（`getBoundingClientRect` 实测），各含 1 个 `<svg>`、`textContent` 为空串
- 两个图标 path 长度 **49 vs 907**（均衡器 vs 齿轮，确实不同款）
- 宿主 `y=0`、按钮 `y=8`（来自 `.side` 的 padding）→ **按钮列从顶部排起，不再是垂直居中**
- `host.style.top === '0px'`（CSS 写死，**无 JS 参与定位**）
- **HUD**：默认页面上没有 HUD 宿主 → `hud(true)` 能开且 `mounted=true` → `hud(false)` 宿主被**摘除**
- 其余（状态面板文案 / 拖滑块真实增益 `+1.7 → -4.2` / 旁路文案翻转 / 全屏隐藏 / 清缓存不抹设置）全部照旧通过

**S3.2.1 的坑：假 DOM 既要「不宽容」，也要「不缺字段」**

- S3.2 的教训是假 DOM **太宽容** —— 给 ShadowRoot 配了 `.style`，把真机上会抛的 `TypeError` 盖住了；
- 这次反过来，是假 DOM **缺字段** —— `getBoundingClientRect()` 只给了 `x/y`，没有真实 `DOMRect` 的 `top/left`，
  于是取 `rect.top` 得到 `undefined` → `Math.round(undefined)` → 宿主被写成 `top: NaNpx`，**7 条定位断言同时变红**。
  **这次是替身的问题、不是产品代码的问题 —— 但两者都得靠断言才能一眼分清。**
- 另一处（端到端）：`host.style.top` 在真实浏览器里会被**规范化**，`HOST_CSS` 里的 `top:0` 读出来是 `'0px'`，
  所以「未被 JS 写过」的断言得写成「等于 `'0px'`」，而不是「为空」。

判据收敛成一句：**假 DOM 与真实对象同构** —— 真实有什么就照着给什么，既不额外宽容，也不缺斤少两。

##### S3.2.2 · 全屏判据真机校准 ✅ **已闭环（2026-10-03）→ v0.5.2**

**背景**：headless 进不了网页全屏（`w` 键 / 按钮 / Fullscreen API 三者皆不成），
所以第 2 路「class 命中」的正则一直是**按常见写法猜的**，留作 S3.2 唯一未闭环项。

**取证**（moxia Edge，全屏前后各跑一次 `__biliLoudness.fsInfo()`）：

| 观测 | 非全屏（baseline） | 网页全屏（按 `w`） |
| --- | --- | --- |
| `bodyClass` | `mac round-corner dark remove-player-popup … promotions` | 同上 **+ `webscreen-fix player-mode-web`** |
| `htmlClass` / `containerClass` | `bilibili-gate-using-dark` / `bpx-player-container bpx-state-paused` | **都不变** |
| `boxRect` → `coversViewport` | `[41,168,685,431]` → false | **`[0,0,1147,956]`（= 视口） → true** |
| `classHit` / `detected` | body·html·container 全 false / false | **body: true** / **true** |

**结论**

1. **命中靠 `webscreen-fix`** —— 现有正则里的 `web-?screen` 正好覆盖 `webscreen`，**代码无需改动**；已用真机原文写进单测钉死（防将来有人误删该分支）。这一点正是「不赌某一个类名」的价值：**猜的也接住了**。
2. **`player-mode-web` 刻意不收** —— 字面是「网页模式播放器」，可能在非全屏的某些播放器设置下也常驻，收进来有误报风险。宁可漏一路（几何兜底会接住）。
3. **html / container 的 class 全屏时一个都不变** —— 这两路实际是死路；但判据是「三路任一命中」，不影响。
4. **几何兜底独立成立** —— `boxRect` 恰好等于视口、`coversViewport=true`。**双保险**：任一路被改版打掉，另一路仍接得住。

**验证**：`s3-panel-unit` 141 → **148**（新增 7 条：真机原文往返 6 条 + `player-mode-web` 不误报 1 条）；其余回归全绿。

**可复现方法**（写进 §8.4，供下次改版再校）：真机开 Console → 挂 300ms 轮询打印 `fsInfo()` 快照 → 点页面空白处（否则 `w` 会被打进控制台）→ 按 `w` 进全屏 → 再按 `w` 退出 → 看两批快照的差异。

##### S3.2.3 · 面板布局与交互修订 ✅ **已完成（2026-10-03）→ v0.5.3**

**moxia真机反馈六条**（原文）：

> 问题2：现在按钮太高了，将中点改为屏幕上三分之一的位置。
> 问题3：现在鼠标移上去两个按钮会同步弹出，分离鼠标移到哪个按钮哪个按钮弹出。
> 问题4：弹出后移到特定按钮上会再次弹出，解决问题3之后二次弹出没有意义了，去掉它，这个问题会导致按钮挡住菜单或者菜单乱跳。
> 问题5：菜单出现后其他区域无法点击，改成点击其他区域收回菜单和按钮。
> 问题6：状态浮窗未横向居中对齐状态按钮。
> 问题7：菜单太宽了，宽度减半，同时优化菜单内文字描述，不要太长。

**逐条解法**

| # | 问题 | 解法（`src/panel.js`） |
| - | -- | -- |
| 2 | 按钮太高 | 宿主 `top:0 → 33.333vh`；`.btns` 增 `top: calc(-1 * var(--btns-half))`（`--btns-half:63px = (8+42+26+42+8)/2`）上移自身半高 → **列中点 = 视口 1/3**。`.tip`/`.pnl` 绝对定位不参与高度 → **展开按钮不移位** |
| 3 | 两钮同步弹 | 删掉 `.side:hover { transform: translateX(0) }`；改 `.side:not(.bl-pin) .rdw:hover .rd { transform: translateX(28px) }` → **只有被 hover 那只滑出** |
| 4 | 二次弹出 | 去掉旧的 `translateX(60%) scale(1.1)`；单钮滑出只为露出来，**无放大、无二次位移**，不再挡菜单 / 抖菜单 |
| 5 | 菜单外点不动 | 宿主与 `.side` `pointer-events:none`，仅 `.btns`/`.tip`/`.pnl`（及 `.rdw`/`.rd`）设 `auto`；`document` 上**冒泡**注册 click → `closeAll()` + 摘 `.bl-pin` |
| 6 | 浮窗没对齐 | `showTip(text, btn)` 多收按钮参数，用**两个 `getBoundingClientRect()` 相减**求中线写进 `tip.style.top`（不能混用 `btn.offsetTop`，见坑） |
| 7 | 菜单太宽 / 字太长 | `.pnl { width:176px; box-sizing:border-box; padding:10px 12px }`（减半）；标签全改最短（实测/目标/增益…）、按钮与 note 短句化、`<option>` 去全角括号 |

**S3.2.3 端到端抓出的三个真 bug**（单测全测不到，全靠真实浏览器）

| # | 坑 | 现象 | 修法 |
| - | -- | -- | -- |
| 1 | **hover 位移自激抖动** | `transform` 挂在按钮自己身上 → 按钮一滑走鼠标就落到外面 → `:hover` 失效 → 滑回来 → 无限循环 | **加一层不动的外壳 `.rdw` 承担 hover 判定**，位移加在内层 `.rd` |
| 2 | **`offsetTop` 坐标系差 63px** | `.tip` 的包含块是 `.side`（带 `transform`），而 `btn.offsetTop` 的 `offsetParent` 是 `.btns`（`position:relative`）→ 浮窗偏移 63px | **两个 `getBoundingClientRect()` 相减**（同坐标系） |
| 3 | **`all:initial` 重置 `box-sizing`** | `all:initial` 把 `box-sizing` 打回 `content-box` → `.pnl { width:176px }` 实际渲染 176 + padding(24) + border(2) = **202px** | 补 `box-sizing:border-box` → 实测 **176px** |

> ⚠️ **`:hover` 不能用合成事件触发**：`dispatchEvent(new MouseEvent('mouseenter'))` 改不了 CSS `:hover` ——
> 端到端必须走 CDP `Input.dispatchMouseEvent`（真实指针）。测完**必须把指针挪开**，否则 `:hover` 一直挂着污染后续断言。

**验证（全绿）**

| 套件 | 结果 |
| --- | --- |
| `probe/s3-panel-unit.mjs` | **174/174**（148 → 174，+26） |
| `probe/s3-panel-verify.mjs` | **73/73**（63 → 73，+10） |
| 回归 | `s2-unit` 101/101 · `s3-unit` 31/31 · `s3-pgc-unit` 70/70 |

实测硬证据（`probe/raw/bls3_panel_verify.json`，番剧页 `ep308426`，792×482）：

- **问题2**：`列中点=161 期望≈160.7`；宿主 `y=161 vh=482` ✅
- **问题3**：hover 状态钮 → `-20 → 8`（右移 28px）；另一只 `-20 → -20`（**不动**）✅
- **问题4**：面板打开时真实 hover → `8 → 8`（**不位移**）✅
- **问题5**：点面板外 → `open: status → null`，`sideClasses: side`（`.bl-pin` 摘掉）✅
- **问题6**：`tipCy=127 btnCy=127`；换按钮 → `styleTop -34px → 34px`（浮窗跟着换位置）✅
- **问题7**：面板渲染宽度 **176px**；旧长文案已去掉 ✅

##### S3.2.4 · 面板二次修订 ✅ **已完成（2026-10-03）→ v0.5.4**

**moxia真机二轮反馈三条**（原文）：

> 问题1:状态和设置的浮窗没有跟随按钮向右移动，会遮挡按钮
> 问题2:状态按钮的菜单对齐到了设置按钮上
> 问题3:菜单呼出后会把两个按钮都触发成选中的位置

**根因（一句话）**：S3.2.3 把「`.side` 收起 −28 + 单个 `.rd` hover 滑出 +28」引入之后，
**浮窗 / 面板的锚点还停在旧坐标系** —— 它们跟着 `.side`（−28），而按钮已经滑到 +28。

| 现象 | 机制 |
| --- | --- |
| 浮窗压住按钮 | `.tip { left: var(--rail) }` 相对 `.side`（−28）→ 视口 **30**；而按钮滑出后是 8..50 → **压在按钮右半** |
| 状态菜单落到设置按钮那一行 | `.pnl { top: 0 }` 相对 `.side`，而 `.side` 顶边 = 按钮列**中点**（S3.2.3 挪到 1/3 的副作用）→ 两个面板共用就落到下方 |
| 打开后两个按钮都弹出来 | `.side.bl-pin { transform: translateX(0) }` → 整条 `.side` 滑出 → **两个按钮一起到「在外」的位置** |

**改动清单**

| 文件 | 改动 |
| --- | --- |
| `src/panel.js` | ① `.side` 恒 `translateX(calc(-1 * var(--shift)))`（新增 `--shift:28px`），**删掉 `.side.bl-pin{translateX(0)}`**；② 滑出规则合为 `.side .rdw:hover .rd, .side .rdw.bl-open .rd { translateX(var(--shift)) }`；③ `.tip`/`.pnl` 的 `left` 改 `calc(var(--rail) + var(--shift))`；④ `togglePanel(which, btn)` 多收按钮参数，写 `pnl.style.top = 按钮rect.top − .side rect.top`，并切 `.rdw.bl-open`；⑤ 按钮 click 传自身（`togglePanel('status', bStatus)`）；⑥ `S.wrapStatus` / `S.wrapSettings` 暴露给状态机 |
| `src/config.js` | `version 0.5.4` / `stage S3.2.4` |
| `probe/s3-panel-unit.mjs` | 改 5 条旧断言（`.side` 恒收起 / `.bl-pin` 不再改 transform / 新滑出规则 / `.tip`·`.pnl` 的 left）；**新增 11 条**（`--shift`、`.bl-open` 绑定、旧的 `left:var(--rail)` 已移除、面板 top 按各自按钮、`wrapOpen=[true,false]`）→ 174 → **185** |
| `probe/s3-panel-verify.mjs` | `blSnap()` 扩 `tip.x` / `pnlRects.y·h·topStyle` / `wrapOpen`（新增页面助手 `blWrapOpen()`）；**新增 7 条端到端**（问题1 浮窗不压按钮 / 问题2 两面板各对齐各自按钮 + 顶边不同 / 问题3 只那一个 `.bl-open`）→ 73 → **80** |

**验证（全绿）**

| 套件 | 结果 |
| --- | --- |
| `probe/s3-panel-unit.mjs` | **185/185**（174 → 185，+11） |
| `probe/s3-panel-verify.mjs` | **80/80**（73 → 80，+7） |
| 回归 | `s2-unit` 101/101 · `s3-unit` 31/31 · `s3-pgc-unit` 70/70 |

实测硬证据（`probe/raw/bls3_panel_verify.json`，番剧页 `ep308426`，792×482）：

- **问题1**：`tip.x=58` vs `btn.right=50` → 浮窗左缘在按钮右缘之外（8px 间距）✅
- **问题2**：`pnl.y=106 / btn.y=106`（状态）、`pnl.y=174 / btn.y=174`（设置）→ 各对齐各自按钮；两面板顶边差 **68px**（不再共用一处）✅
- **问题3**：打开状态 → `wrapOpen=[true,false]`、设置钮 `-20 → -20`（**保持收起**）；切设置 → `[false,true]` ✅

> ⚠️ **本轮又踩、也是本轮记进技能的坑**：CSS 模板字符串的**注释里不能出现反引号** ——
> 写 `` `.rdw.bl-open` `` / `` `top:0` `` 这类会**提前关闭模板串**，报 `SyntaxError: Unexpected token ':'`，
> 而堆栈只指到 `new Function`，看着像测试脚本坏了。已加「扫描 CSS 块内是否残留反引号」的自查脚本。

##### S3.2.5 · 面板文案说人话 + 数值格式统一 ✅ **已完成（2026-10-03）→ v0.5.6**

**起因（moxia原文）**：

> 两个按钮的说明文字太抽象了，限幅的说明文字也抽象。旁路开关的说明仅体现点击后关闭增益听原声。
> 清除缓存的说明仅体现清除视频增益缓存。以上两个我描述的对么。限幅能给我解释一下是什么意思么

**先纠了一个事实**：「清除缓存」清的**不是增益** —— 缓存里存的是**每个视频的响度测量结果**
（`store.js` 头部原话：缓存的是**原始测量值**（`measuredLufs` / `truePeakDb`），**不是最终增益**）。
增益 = 目标 − 实测，**每次现算、不入库**：这正是「改目标立即重算」不必重测的原因，
也是「清缓存不影响设置」的原因（`blv2:__settings` 刻意不进 LRU）。

**为什么「限幅」看不懂**：这个格子原来把内部 debug 串**原样**打上去
（`削波预算 +1.70dB（真峰值 -2.7dBTP，余量 -1dB）`），「削波预算 / dBTP / 余量」三个词都是音频黑话。
更麻烦的是「限幅」在音频圈通常指**限幅器（事后压限，WaveShaper）**，而本项目**刻意不用**它 ——
`audio-engine.js` 靠**事前**峰值预算从源头保证不削波。**术语撞车才是「别扭感」的真正来源。**

**限幅到底什么意思** —— 一句话：**给「音量最多能提多少」划的物理红线，防止提太多把声音撑爆（爆音）**。
数字例子（moxia那个番剧）：目标 −14、实测 −23.8 → **想提 +9.8 dB**；但真峰值 −2.7 dBTP，
天花板取 −1 dB（留 1 dB 安全余量）→ **最多能提 −1 − (−2.7) = +1.7 dB**，于是 9.8 被砍到 1.7。
**只拦「提」，从不拦「降」** —— 降音量不可能爆音，永远放行（`gain-planner.js:58-66`）。

**改动**（moxia拍板：按钮 / 悬停浮窗 / 行标签**一律不动**）

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 限幅 · 受削波预算 | `削波预算 +1.70dB（真峰值 -2.7dBTP，余量 -1dB）` | **`+1.7 dB（防止爆音）`** |
| 限幅 · 素材已过峰 | `素材已过峰（真峰值 0.8dBTP），不提升` | **`+0 dB（素材已过峰）`** |
| 限幅 · 未受限 | `否` | **`未限幅`** |
| 限幅 · 档案上限 / 下限 | `档案上限 +6dB` / `档案下限 -60dB` | **`档案上限 +6 dB` / `档案下限 -60 dB`**（同一行，格式随大流） |
| 旁路 · note | `只把增益归零，结果与目标都留着。` | **`暂停音频归一，播放原始音频。`** |
| 清除缓存 · note | `存原始测量值；改目标立即重算。清理不影响设置。` | **`清除已保存的视频响度测量结果。`** |

**第二轮：格式统一为「X dB」**（moxia拍板：一律带空格）。理由很直白 —— `+1.7 dB` 带空格、
`+0dB` 不带，同一行里看着就不像一套。现在**数值与单位之间一律一个空格**：
`+1.7 dB` / `+0 dB` / `档案上限 +6 dB` / `档案下限 -60 dB`，与面板其它 dB 读数
（`panel.js` 的 `fmt()`：滑块值 / 增益 / 实测响度）对齐。

> moxia另一句：「**清缓存的两条无所谓，符合插件的底层逻辑**」—— 那两句**不再补说明**。

| 文件 | 改动 |
| --- | --- |
| `src/gain-planner.js` | `limitReason` 三条改成「提多少 + 为什么」且**一律带空格**（过峰 `+0 dB（素材已过峰）` / `档案上限 +6 dB` / `档案下限 -60 dB`） |
| `src/panel.js` | 限幅行 `'否'` → `'未限幅'`（fallback `'已限幅'`）；旁路与缓存的 note 文案 |
| `src/config.js` | `version 0.5.6` / `stage S3.2.5` |
| `probe/s2-unit.mjs` | **+3 → +4**：钉死三种限幅原因的**确切字符串**（101 → 104 → 105；下限那条要临时切 `custom` 档才触发 —— `targetLufs` / `minGainDb` 取自 `currentProfile()`，**不从入参读**） |
| `probe/s3-panel-unit.mjs` | **+5 → +6**：未受限 / 受限人话 / 过峰带空格 / 档案上限带空格 / 两处 note（185 → 190 → 191） |
| `probe/s3-panel-verify.mjs` | **+4 → +5**：真机文本里 `!/削波预算/`、`!/dBTP/`、`!/余量/`、`!/只把增益归零/`、`!/原始测量值/`，外加**格式反向断言 `!/\d(?:\.\d+)?dB/`**（80 → 84 → 85） |

**验证（全绿）**

| 套件 | 结果 |
| --- | --- |
| `probe/s3-panel-unit.mjs` | **191/191**（185 → 190 → 191） |
| `probe/s3-panel-verify.mjs` | **85/85**（80 → 84 → 85） |
| `probe/s2-unit.mjs` | **105/105**（101 → 104 → 105） |
| 回归 | `s3-unit` 31/31 · `s3-pgc-unit` 70/70 |

实测硬证据（`probe/raw/bls3_panel_verify.json`，番剧页 `ep308426`）—— 状态面板真机文本：

```
功能 已开启 / 采样 已完成 / 来源 官方元数据 · 免下载
实测 -23.8 LUFS / 目标 -14.0 LUFS / 增益 +1.70 dB（TP -2.7）
限幅 +1.7 dB（防止爆音）
页型 番剧 / 影视
旁路（听原声）
暂停音频归一，播放原始音频。
```

> **三条通用教训**：
> ① `limitReason` 是**面板和日志共用**的同一个字符串 —— 「给用户看的措辞」和「给调试用的字段」
> 必须当成一回事写；想留细节就另开字段，别指望「日志详细、面板简短」两全。
> ② **文案改动：单测只能钉住「写的是什么」，端到端才能钉住「真机上真的是这个」** ——
> 本轮端到端专设 4 条「旧黑话没漏回来」的反向断言。
> ③ **格式一致性也要有断言** —— 「`X dB` 带不带空格」这种肉眼一瞥就过去的事，不写断言
> 就会在下次改文案时悄悄漏回来。反向断言 `!/\d(?:\.\d+)?dB/` 一行就把它钉死了。
> 另外：**档案参数取自 `currentProfile()`，不从 `plan()` 的入参读** —— 想测「档案下限」
> 必须临时切 `CONFIG.profile`（本轮第一次就写错了，断言直接拿到空串）。

##### S3.2.6 · 缓存淘汰语义修正 ✅ **已完成（2026-10-03）→ v0.5.7**

**起因**：moxia问「如果缓存超过 800 之后的逻辑是什么样的」。顺着 `store.js` 读了一遍，
发现三处**与名字对不上**的地方 —— 都不是崩溃型 bug，是「永远不报错、只是慢慢变差」的那种。

| # | 现象 | 后果 |
| -- | -- | -- |
| 1 | 只有 `set()` 续期，`get()` 命中**不**续期 | 淘汰实际按**最早写入**发生 → 是 **FIFO** 不是 LRU。常看的视频只要没重新分析过，照样被清 |
| 2 | TTL 过期只 `delRaw` 数据、**不动索引** | 索引里留下悬空条目，仍占 800 名额；要等它被 `shift` 到才顺手删（那时 `delRaw` 已是空操作） |
| 3 | `setRaw` 失败直接 `return false` | localStorage 配额满时**既不写也不淘汰** → 配额永远释放不出来，此后每条新测量都白跑；返回值在 `analyzer.js:470` 还被忽略，**全程无声** |

**改动清单**

| 文件 | 改动 |
| -- | -- |
| `src/store.js` | 新增 `bump()`（`get` 命中续期，**已在队尾则零写入**）、`dropFromIndex()`（TTL 过期 / `remove` 时同摘索引）、`evictOldest()` + `writeIndex()`（写失败先腾位再重试）；`set()` 失败路径从「静默 return」改为「淘汰 → 重试 → 告警」 |
| `src/config.js` | `version 0.5.7` / `stage S3.2.6` |
| `probe/store-unit.mjs` | **新增**，44 项 |
| `probe/s3-panel-unit.mjs` · `s3-panel-verify.mjs` | 产物版本断言 0.5.6 → **0.5.7**（各 1 条） |

**验证**：`store-unit` **44/44** —— 沙箱里跑**真实 `src/store.js`**（假 localStorage，可设配额、可数索引写入次数）：

| 组 | 钉住什么 |
| -- | -- |
| 容量 | 写第 801 条后仍是 800（不存在中间态）、淘汰的一定是最旧那条、覆盖写不让索引虚长 |
| 真 LRU | 同一条最旧记录：**读一次之后再写第 801 条，被淘汰的不是它**（旧行为会淘汰它） |
| 索引写入 | 读队尾 key → 零写入；读非队尾 key → 恰好一次；未命中 → 零写入 |
| TTL | 过期后 `entries` 2 → 1（索引同步摘）、29 天内仍可用、`ttlDays=0` 视为永不过期 |
| 配额 | 配额不足时**仍写成功**且告警写明淘汰条数；彻底写不进时**如实返回 false** |
| 隔离 | `setSettings` 不占索引名额、`clear()` 不抹设置、`remove()` 数据与索引同删 |

回归全绿：`s2-unit` 105/105 · `s3-unit` 31/31 · `s3-pgc-unit` 70/70 · `s3-panel-unit` 191/191 · `store-unit` 44/44。
构建产物 **v0.5.7 / 212.4 KB / 15 模块 / 铁律守卫通过**。

> **浏览器端到端已补跑通过（2026-10-03）**：无头 Edge 起不来的报错是 `Failed to initialize sandbox`
> → `GPU process isn't usable. Goodbye.` —— 拦点是 **chromium 自身的沙箱初始化**被 macOS seatbelt 拒，
> 所以只加 `--disable-gpu` 确实无效。解法：启动参数加 **`--no-sandbox`**（**无需放开外层沙箱**，
> 见 §12「S3.2.7 · 顺带更正一处旧结论」）。跑通结果：`s3-panel-verify` **85/85**（含场景 G「清除缓存 →
> `entries 1 → 0`、用户设置逐字未变」与产物版本 `v0.5.7` 断言）；`s2-verify` 全绿 —— 其中
> **场景 C「同页重载 → `source=cache` 命中」**正好走在 `get()` 续期这条链上，改动后仍 **314ms 命中**；
> JS 异常 **0** 条。改动落点在 `store.js` 内部、归一链路一行未动，单测 + 端到端双重覆盖。

> **跨平台实测（2026-10-03，moxia手动）**：在 **Windows + Edge + Tampermonkey** 里装 **v0.5.7**，
> 实测三类链路 —— ① 普通投稿视频；② 番剧页内切换（同页新视频）；③ 多页视频。
> **三项均正常响应**。这是产物**首次在 macOS 之外的平台**得到验证。
> 注意口径：Windows 侧为**手动实测**（不是自动化脚本），覆盖的是「装得上 / 跑得动 / 切得准」
> 三条基本盘；精度类断言仍以 macOS 侧的自动化端到端（`s2-verify` / `s3-panel-verify` 等）为准。

**三个刻意的取舍**（免得以后当成 bug 改）：
① 仍是**条数**上限、不是**字节**上限（0.3–0.4MB vs 5MB 配额，条数永远先到）；
② 仍按写入序淘汰，不做访问频率加权；
③ 配额满时宁可留「索引有、数据没有」的悬空项，也不留「数据有、索引没有」的孤儿
（`evictOldest` 先删数据、再写索引）—— 前者下次 `get` 返回 null 无害，后者永远淘汰不到。

---

##### S3.2.7 · 命名与身份确立 ✅ **已完成（2026-10-03）→ v0.5.8**

**起因**：moxia在 **Windows + Edge + Tampermonkey** 上装好并实测通过（见上「跨平台实测」），
随后提了一句「名字里还是要加上 B 站的内容，让人一眼看出来是干什么的」——于是把命名彻底定下来。

**定名决策**

| 项 | 值 | 理由 |
| -- | -- | -- |
| `@name`（中文） | **B站响度归一** | 「响度」是准确术语（我们测的是 BS.1770 积分响度 LUFS，不是主观音量），「归一」= loudness normalization 的行业叫法；带 `B站` 前缀一眼看出适用对象 |
| `@name:en`（英文） | **Bilibili_LoudNorm** | `Bilibili` + `LoudNorm`（loudness normalization 缩写）；刻意避开已被占用的 `BiliLoudness` |
| 产物文件名 | **`Bilibili_LoudNorm.user.js`** | 与 `@name:en` 同词，单一来源、好记 |

**定名前查重**（避免与同类脚本搜混）

| 已有项目 | 冲突点 | 判断 |
| -- | -- | -- |
| GreasyFork **510624 `BiliBiliLoudness`** | 名字几乎相同 | ⚠️ **唯一真撞的一个** —— 因此英文名弃用 `BiliLoudness`，改用 `Bilibili_LoudNorm`。功能上也不同：它是**在视频两侧画电平条**的响度显示，不做归一 |
| GreasyFork **557295「Bilibili 视频音量均衡器」** | 「音量均衡」字样 | 走 `DynamicsCompressor` **实时压缩**，与我们「预先分析 + 整片一个固定增益」是两条路 |
| GreasyFork **587251「B站无损音量平衡」** | **就是本项目的替代对象** | 其自述（只算平均响度整体平移 / 预先分析零干扰 / 持久化缓存）与我们高度重合 —— 但它**明确「取消番剧页面的支持」**，而番剧正是我们啃下来的（S3.1）。这条差异点记在这儿，供以后对外说明用 |

**刻意不动的三处**（改了会出问题，记下来免得以后手滑）

| 东西 | 值 | 为什么不动 |
| -- | -- | -- |
| `@namespace` | `https://github.com/moxia/bili-loudness` | Tampermonkey 用 `@name` + `@namespace` 认脚本身份。改了会被当成**另一个脚本** → 与已装的共存、设置不共享 |
| `window.__biliLoudness` | 调试接口 | 全部端到端 probe 脚本都靠它读状态（`fsInfo()` / `hudInfo()` / `analysis` …），改了端到端全挂 |
| DOM id `bili-loudness-panel-host` / `-hud-host` / `-toast-host` | 宿主节点 id | probe 用 `getElementById` 断言面板 / HUD 存在，改了同样全挂 |

> 一句话：**「展示名」改了，「内部标识」没改**。名字是给人看的，id 是给代码用的，两者不必同源。

**改动清单**

| 文件 | 改动 |
| -- | -- |
| `build.mjs` | `OUTPUT` → `Bilibili_LoudNorm.user.js`；header 新增 `@name:en` 行 |
| `src/config.js` | `version 0.5.8` / `stage S3.2.7` |
| `src/main.js` | 启动日志横幅 `bili-loudness v…` → `Bilibili_LoudNorm v…` |
| `probe/*.mjs`（6 处） | 硬编码的产物名 → 新名（`store-unit` / `s2-hud-verify` / `s3-ui-probe` / `s3-pgc-verify` / `s3-panel-verify` / `s3-panel-unit`） |
| `probe/s3-panel-unit.mjs` · `s3-panel-verify.mjs` | 产物版本断言 0.5.7 → **0.5.8**（各 1 条） |

**验证**：全量回归重跑 —— 单元 `s2-unit` 105 · `s3-unit` 31 · `s3-pgc-unit` 70 ·
`s3-panel-unit` 191 · `store-unit` 44；端到端 `s3-panel-verify` **85/85**（含 `v0.5.8` 断言）、
`s2-verify` 全绿（场景 C 缓存命中 **301ms**、JS 异常 **0**）。**零逻辑改动，纯身份变更。**

> **⚠️ 装过的需要重装一次**：产物文件名变了，Tampermonkey 检查更新认的是**旧文件路径**。
> 由于 `@name` / `@namespace` 均未变，重装会**替换**原脚本（不会多出一条），缓存与设置照旧可用。

**顺带更正一处旧结论**

> §12「S3.2.6」末尾原写「端到端需**非沙箱模式**启动」—— 找到了更省事的解：
> 启动参数加 **`--no-sandbox`**，让 chromium 跳过它自己的沙箱初始化，即可绕开 macOS seatbelt 的拦截，
> **在沙箱内也能起**。拦点始终是 **chromium 自身的 sandbox 初始化**（所以只加 `--disable-gpu` 确实没用），
> 但结论应从「必须放开沙箱」更正为「**换个参数就能起**」。

##### S3.2.8 · 公开发布整理 ✅ **已完成（2026-10-03）→ v1.0.0**

**目标**：整理成可上传 GitHub + GreasyFork 的状态。**零功能逻辑改动**（`src/` 只动了注释措辞）。

| 面 | 改动 |
|---|---|
| 脚本头 | `@namespace` `github.com/moxia/bili-loudness` → **`github.com/ADMA200/Bilibili_LoudNorm`**；新增 `@homepageURL` / `@supportURL`；`@description` **190 字 → 55 字**（只留「脚本做什么」，去掉阶段码与实现细节） |
| 版号 | `0.5.8` → **`1.0.0`**；`stage` → `S3.2.8`（2 处 probe 版本断言同步，注意 `1\.0\.0` 的点要转义） |
| 新增 | `LICENSE`（MIT）/ `.gitignore` / `THIRD-PARTY-NOTICES.md` / `docs/测试说明.md` / 面向用户的 `README.md` |
| 归位 | 原 `README.md`（79KB 阶段日志）→ `docs/开发记录.md`；删除旧产物 `bili-loudness.user.js` |
| 脱敏 | 3 处 `/Users/moxia/...` 绝对路径 → 相对路径；移除账号名与 UID；自称统一为 `moxia` |
| 中性化 | 去掉对第三方脚本的「致命 / 翻车 / 元凶 / 拖死 / 自伤」等措辞，保留技术论证与事实性引用 |
| probe | 40 个文件 → **只发布 5 个纯 Node 单元套件**（其余由 `.gitignore` 排除） |

**为什么保持 MIT 而不改 Apache-2.0**：① 代码 100% 自有；② **无 copyleft 流入** —— 587251 是 MPL-2.0
但一行未用（否则涉事文件都得留在 MPL-2.0），Evolved 是 MIT 天然兼容，**不存在「被迫改许可」的情形**；
③ 唯一外来材料是两个图标（Apache-2.0），而 Apache-2.0 是宽松许可，**不要求**衍生作品换许可，只要求署名。
它相比 MIT 多的是专利授权条款，对本项目（纯 JS、不用专利技术、发在 GreasyFork）**价值 ≈ 0**。

**⚠️ 对用户的影响**：`@namespace` 是油猴认定「脚本身份」的一半（`@name` + `@namespace`）——
改了之后**旧脚本不会被自动替换**，会留在列表里需手动卸载；缓存（800 条测量结果）与面板设置**不共享**。

**验证**：单元 `s2-unit` 105 · `s3-unit` 31 · `s3-pgc-unit` 70 · `s3-panel-unit` 191 · `store-unit` 44 全绿；
端到端 `s3-panel-verify` **85/85**（版本断言已同步为 `v1.0.0`）、`s2-verify` 全绿（同页重载缓存命中 307ms、JS 异常 0）；
产物 **v1.0.0 / 212.3 KB / 15 模块 / 铁律守卫通过**。

---

## 13. 待实跑确认的假设（写着，不装作已知）

1. ~~**B 站播放器是否真的对番剧施加了客户端归一**~~ → **✅ 已证实（§2.7.5）**：`loudnessSwitch=1` 时 B 站创建 AudioContext + `createMediaElementSource(VIDEO)` + `GainNode.setTargetAtTime(3.0903)` = **+9.80 dB**，与元数据公式 `−14−(−23.8)+0.1=9.9dB` 吻合。**默认 `loudnessSwitch=0` 时什么都不做。**
2. ~~番剧切集后 `window.__playinfo__` 是否更新（推测：不更新）~~ → **✅ 已证实（§12.2 坑 5）**：
   **不更新**，而且 `__INITIAL_STATE__` 同样不更新。普通投稿实测拿到 `-404 啥都木有`。
   已做新鲜度校验 + 接口兜底；S3 番剧直接复用同一套。
3. ~~`window.player` 是否暴露更稳的 cid 与音频实例~~ → **✅ `player.mediaElement` 可直接拿 video**（§2.7.6）；仍是私有 API，作兜底而非主路径
4. ~~登录态下大会员集是否返回完整 `dash`~~ → **✅ 已验证（§2.7.4）**：`ep309868` 会员集返回完整 dash（3 条音频），非试看降级
5. ~~`OfflineAudioContext.decodeAudioData` 对拼接过 fMP4 的实际容错度（段间跳变是否产生爆音）~~
   → **❌ 结论反转（§12.2 坑 2）**：多个 moof 拼成一个大 Blob 后**只能解出第一段**。
   必须逐段独立解码再拼 PCM。
6. 真实命中 Widevine 的样本（本轮未遇到）
7. ~~登录态下普通投稿 playurl 是否返回 `volume` 响度元数据~~ → **✅ 部分有（§2.7.2）**：走 `__playinfo__.data.volume`，但**非 100% 覆盖** → **sidx 抽样仍是必需的兜底**，不能砍
8. ~~Edge 154 的 AppleScript `execute` 是否真正接线可用~~ → **❌ 路线作废（§2.7.1）**：WorkBuddy 缺 automation entitlement，所有 Apple Event 一律 `-10004`。**改用 CDP + headless Edge + 复制登录态 profile**（已验证可行）
9. ~~B 站「音量均衡」档位存在哪里~~ → **✅ `bpx_player_profile.media.loudnessSwitch`**（0=关，1=开；§2.7.5）
10. **【新增·必测】** `loudnessSwitch=2` 是否 =「高动态」档（预期 `target_i=-24`）—— 未测
11. **【新增·必测】** 普通投稿在 `loudnessSwitch=1` 时是否也创建 AudioContext（本轮只测了番剧页的开启态）
12. **【新增·必测】** B 站占用音频源后，我们的 `createMediaElementSource` 具体抛什么异常、`volumeOnlyMode` 降级体感损失多少
13. ~~sidx 的 first_offset 基准点~~ → **✅ 已实测（§12.2 坑 1）**：基准点是「sidx box 之后的第一个字节」，漏掉会让全部抽样段错位 1482 字节
14. ~~BS.1770 多声道是求和还是平均~~ → **✅ 求和（§4.3）**：按通道平均会让立体声素材系统性偏低 3.01dB
15. **【新增·待测】** 「素材已过峰」的判定阈值：现在只要真峰值 > 0 dBTP 就完全不提升。
    对整体偏小而峰值偶有过冲的素材，是否该允许小幅提升（配合 S3 的软限幅）？—— S3 定
16. **【新增·待测】** `loudnessSwitch=2`（高动态档）是否真的对应 `target_i=-24`（§13-10 未测）
17. ~~**【新增·待测】** 番剧/影视页（S3）的抽样链路是否与普通投稿完全一致~~
    → **✅ 已验证（§S3.1）**：链路一致（sidx → 逐段解码 → BS.1770 → 增益），
    但 **dash 位置**（`video_info.dash` vs `result.dash`）与**字段命名**（snake_case vs camelCase）
    两条路不同 → 已多路径兜住。番剧页 sidx 自校验 206/416 通过。
18. ~~**【新增·待测】** 试看集 / 大会员集的降级行为（S3）~~
    → **✅ 试看识别已实现并单测覆盖**（5 条命中路径 + DRM 3 条）；
    大会员集 `ep309868` 本次实测经 SPA 切集进入后正常抽样（`p:309868`，覆盖 100%），
    **未触发任何降级**。⚠️ 仍待真机确认的是「未登录/非会员访问会员集」时的实际降级画面。
21. ~~**【新增·待测】** 番剧页是否也有「已知 ep_id 时能从 URL 拿到 cid」的路径~~
    → **✅ 结论：不需要 cid**。番剧回落接口 `pgc/player/web/playurl` **只吃 ep_id**
    （实测），所以 cacheKey 定为 `p:{ep_id}`、刻意不带 cid，避免分裂缓存。
    另：SSR 新鲜时能从 `result.arc` 拿到 cid/bvid，用作诊断信息。
22. **【新增·待测】** `<video>` 元素在**跨 bvid** 的 SPA 导航下是否偶尔会被真正替换
19. ~~SPA 切视频/切分P 后，页面注入的 `__INITIAL_STATE__` / `__playinfo__` 会不会跟着换~~
    → **✅ 都不会（§12.2 坑 5）**。旧 cid 配新 bvid → playurl `-404`。已修（v0.3.0）。
20. ~~真实浏览器里播放器切流的耗时分布~~ → **✅ moxia真机反馈「等待时长还好」（2026-10-02）**，
    宽限期 20s / 回访 700ms 保持不动。仍待补的是「HUD 上『已等 Xs』一般停在几秒」的具体数值。
23. **【新增·待观察】** 渐进式的**初测→精修**会不会在听感上被察觉。
    实测初测与精修的增益差 0.37–0.91dB，> 0.5dB 时会重新落位一次
    （落在视频开头 1 秒内）。真机上如果觉得「开头音量跳了一下」，
    可把 `refineMinDeltaDb` 调大（比如 1.0）或把 `firstBatchEagerAt` 调高（比如 6，牺牲一点速度换初测精度）。
24. **【新增·待观察】** 慢网络下首批仍要 ~2.8–3.1s（等第 4 段到齐）。
    若真机上普遍更慢，可把 `firstBatchEagerAt` 降到 3（≈14s 音频，仍在 BS.1770 建议的 10s 之上）。
25. **【新增·待观察·番剧】** 番剧**切集**时「等切集」有界等待（`pgcStreamWaitMs=8000`）在真机上够不够。
    实测 headless 下点「下一集」到新集落位是流畅的（24/24 无超时），但真机播放器换流可能更慢；
    若偶发「等切集超时 → 按接口信息继续」的 warn，可把这个值调大（代价是落位晚一点）。
26. **【新增·待测·番剧】** 未登录 / 非大会员访问会员集时的实际降级画面
    （预期：试看片段 → 识别为试看并跳过，HUD 标「试看片段」）。
27. ~~**【新增·待测·番剧】** 番剧页**切清晰度**（不是切集）时 `__playinfo__` 会不会被换对象~~
    → **✅ 已实测（`probe/s3-ui-probe.mjs`，2026-10-02）**：`sameObject: true`
    —— 切档后 `__playinfo__` 对象**身份不变**、`dashDuration` 仍 1442、元素时长 1440.883、
    **命中缓存零重算** → 不误触发「等切集」。⚠️ 一处存疑：菜单有 6 档（选中「1080P 高码率大会员」），
    但切档后 `quality` 仍读到 112，疑为 headless 下切换未真正生效或 `video_info` 非实时，**留待真机确认**。
28. ~~**【新增·待真机校准】** 设置面板的**全屏隐藏类名判据**~~
    → **✅ 已闭环（S3.2.2，2026-10-03）**：moxia Edge 实录 —— 网页全屏时 body 多出
    **`webscreen-fix player-mode-web`**，`html` / `.bpx-player-container` 的 class **均不变**；
    `boxRect` 恰好等于视口 → `coversViewport=true`。
    **命中靠 `webscreen-fix`**（现有正则 `web-?screen` 已覆盖，**代码无需改**）；
    `player-mode-web` 怕误报刻意不收。真机原文已写进单测（141 → **148**）。详见 §12「S3.2.2」。
29. ~~**【新增·待观察】** 面板在**小窗口 / 极窄视口**下的观感：面板宽度会不会压到播放器控件~~
    → **✅ 已大幅缓解（S3.2.3）**：面板宽度由 `min-width:320px` **减半到 `176px`**，
    且纵向位置改为**按钮列中点落在视口 1/3**（不再贴顶）。本轮实测 792×482 视口下贴左边、无遮挡。
30. ~~**【新增·待观察】** 面板要不要「跟随播放器容器上边缘」定位~~
    → **✅ 已否决（S3.2.1，2026-10-03）**：先撞车 Evolved（同 `top:50%` 垂直居中），
    中间试过 `positionSelf` 跟随播放器 + scroll 监听 + rAF 节流，**moxia拍板「不用跟随播放器，固定在侧边就行」**。
    已全删，退回纯 CSS 定位（S3.2.1 落 `top:0` → **S3.2.3 再挪到 `top:33.333vh`**）—— 零 JS 定位、零监听。
    **结论：固定，不跟随。**
31. ~~**【新增·待观察】** 常驻调试 HUD 与状态面板信息重复、且一直挡在界面上~~
    → **✅ 已结案（S3.2.1）**：`CONFIG.hud` 默认改 `false`。`Hud.toast()` 是**独立宿主**，
    旁路提示 / 清缓存反馈不受影响；油猴菜单仍可手动开。**结论：默认关，按需开。**
32. ~~**【新增·待观察】** 面板真机体感六条：按钮太高 / 两钮同步弹 / 二次弹出挡菜单 / 菜单外点不动 / 浮窗没对齐 / 菜单太宽字太长~~
    → **✅ 已全部结案（S3.2.3，2026-10-03）→ v0.5.3**：中点移到视口 1/3、单钮滑出、
    去掉二次弹出、点面板外收起、浮窗按被 hover 按钮对齐、面板宽度减半到 176px + 全量短文案。
    端到端还顺带抓出 3 个单测测不到的真 bug（hover 自激抖动 / `offsetTop` 坐标系差 63px / `content-box` 撑大 26px），
    详见 §12「S3.2.3」。验证 `s3-panel-unit` 148 → **174**、`s3-panel-verify` 63 → **73**。
33. ~~**【新增·待观察】** 面板真机二轮三条：浮窗没跟随按钮向右 / 状态菜单对齐到了设置按钮 / 打开菜单后两个按钮都被触发在外~~
    → **✅ 已全部结案（S3.2.4，2026-10-03）→ v0.5.4**：根因是 S3.2.3 改了 `.side`/`.rd` 的位移后
    **浮窗与面板的锚点还停在旧坐标系**。改法：`.tip`/`.pnl` 的 `left` 按滑出后的按钮算（视口 58）、
    面板 `top` 由 JS 按各自按钮顶边写入、`.side` 恒收起并把「在外」改由 `.rdw.bl-open` 精确标记。
    验证 `s3-panel-unit` 174 → **185**、`s3-panel-verify` 73 → **80**。详见 §12「S3.2.4」。
34. ~~**【新增·待观察】** 面板文案「太抽象」：两个圆钮的浮窗、限幅的值、旁路与清除缓存的说明~~
    → **✅ 已结案（S3.2.5，2026-10-03）→ v0.5.6**：限幅原来把内部 debug 串**原样**打上去
    （`削波预算 +1.70dB（真峰值 -2.7dBTP，余量 -1dB）`）；而「限幅」在音频圈通常指**限幅器（事前压限）**，
    与本项目「**事前**峰值预算」撞车 —— **术语撞车本身就是别扭感的来源**。已改成
    **`+1.7 dB（防止爆音）` / `+0 dB（素材已过峰）` / `未限幅`**；第二轮又把**数值格式统一为「X dB」**
    （数值与单位间留一个空格），档案上下限一并跟进。
    顺带纠正一个**事实误解**：「清除缓存」清的**不是增益**，是每个视频的**响度测量结果**
    （增益是现算的派生物，不入库）。moxia明确「清缓存那两句**无所谓，符合插件的底层逻辑**」→ 不再补说明。
    验证 `s3-panel-unit` 185 → **191**、`s3-panel-verify` 80 → **85**、
    `s2-unit` 101 → **105**。详见 §12「S3.2.5」。
35. ~~**【新增·待核实】** 面板端到端（`s3-panel-verify`）**只在番剧页** `ep308426` 上跑，普通投稿页零覆盖~~
    → **📌 已澄清，维持现状（2026-10-03）**：moxia的原始疑问是「番剧不是默认跳过归一了么」。
    查证：**番剧不跳过**（详见 §12「S3.1」的「容易误解的事实」），`ep308426` 实测 `phase=active`，
    所以**现有 85 条断言的前提成立**，不存在「在跳过页面上测归一」的问题。
    之所以当初选番剧页：它有官方元数据 → FastPath 秒出 → `−23.8 / +1.70` 数值稳定、可直接钉死；
    普通投稿要真抽样，数值随抽样浮动、跑得也更慢。
    moxia拍板「**有生效就行**」→ **维持番剧页，不换**。番剧自身的归一 / 切集 / 版权码分支
    由 `s3-pgc-verify`（A~D 四场景）与 `s3-pgc-unit`（70 项）另行覆盖，**没有盲区**。
    （若将来面板某处与页型耦合，再补一个普通投稿页冒烟组。）
36. ~~**【新增·待核实】** 面板文案能不能让人看懂「已跳过」的原因~~
    → **⚪ 已确认为真但决定不改（2026-10-03）**：`panel.js` 的 `sampleText()` 对
    `phase==='skipped'` 只返回 `已跳过`，**`reason` 一字不显示**。而 `reason` 里
    `-403/-404/-688/-689` 与 DRM/试看/durl 是**两种语义完全不同**的原因（前者「这类内容不该动」、
    后者「拿不到可分析的流」），糊成一个「已跳过」确实分不出。**但**：`reason` 是 debug 串
    （`pgc playurl code=-689 版权限制，无法观看（ep_id=308426）`），原样上屏更糊；
    翻成人话（`已跳过 · 需要大会员`）是一条**独立的小改动**。
    moxia 2026-10-03 拍板「**不改，知道它正常就行**」→ 记在此，**想改随时可捡起**。
37. ~~**【新增·待核实】缓存超过 800 条之后到底是什么行为**~~
    → **✅ 已查清并修正（S3.2.6，2026-10-03）→ v0.5.7**：moxia这一问顺出三处「名不副实」——
    淘汰实际是 **FIFO**（`get` 命中不续期）、TTL 过期**只删数据不摘索引**、配额满时**既不写也不淘汰**
    （静默 `return false`）。三处已全修，并新建 `probe/store-unit.mjs`（**44 项**，沙箱里跑真实 `store.js`）。
    详见 §12「S3.2.6」。
38. ~~**【新增】插件的中英文名字**~~ → **✅ 已定名（S3.2.7，2026-10-03）→ v0.5.8**：
    中文 `@name`「**B站响度归一**」（与本文档同名）、英文 `@name:en`「**Bilibili_LoudNorm**」、
    产物文件 `Bilibili_LoudNorm.user.js`。定名前查重，避开了已被占用的 `BiliLoudness`（GreasyFork 510624）。
    `@namespace` / `window.__biliLoudness` / DOM id **刻意不动** —— 改了分别会：多出一条脚本、
    端到端全挂、端到端全挂。详见 §12「S3.2.7」。

---

## 14. 关键文件

| 文件 | 动作 |
| --- | --- |
| `Bilibili_LoudNorm.user.js` | **交付物**（构建产物，**v1.0.0**（= 15 模块 / 铁律守卫通过），装 Tampermonkey / GreasyFork 即可；脚本名 `@name` **B站响度归一** / `@name:en` **Bilibili_LoudNorm**） |
| `src/*.js` | 源码，15 个模块（改这里，再 `node build.mjs`） |
| `build.mjs` | 拼接构建 + 铁律守卫 |
| `probe/s2-unit.mjs` | 单元验证 **105 项**（普通投稿全链路 + 增益规划含三种限幅原因的**确切文案**与**带空格格式**）【S2 + S2.2 + S3.2.5】 |
| `probe/s3-unit.mjs` | 单元验证 31 项（页面状态新鲜度 / `__playinfo__` 可信度 / `view` 补全）【S2.1】 |
| `probe/s3-pgc-unit.mjs` | 单元验证 **70 项**（番剧页型/ep 配对新鲜度/两种 dash 形状/试看 5 路径/DRM/错误码分派）【S3.1】 |
| `probe/s3-panel-unit.mjs` | 单元验证 **191 项**（面板样式不变量 / 假 DOM 沙箱跑真实 `panel.js` 的交互状态机（含单钮滑出、点外部收起、浮窗对齐、**面板各按自己按钮对齐**、**只标一个 `.bl-open`**、**S3.2.5 限幅/旁路/缓存文案 + 数值带空格**）/ 全屏三路判据（含真机类名回归）/ **定位方式 + HUD 守门** / 接线完整性）【S3.2 · S3.2.1 · S3.2.2 · S3.2.3 · S3.2.4 · S3.2.5】 |
| `probe/store-unit.mjs` | 单元验证 **44 项**（假 localStorage 沙箱里跑**真实 `store.js`**：容量上限与淘汰顺序 / `get` 命中续期（真 LRU vs 旧 FIFO）/ 索引写入次数 / TTL 过期同摘索引 / 配额满腾位重试 / 设置隔离）【S3.2.6】 |
| `probe/s2-verify.mjs` | 端到端五场景（FastPath / 抽样对表 / 缓存 / 110 分钟长视频 / 旁路）【S2 + S2.2】 |
| `probe/s2-timing.mjs` | 抽样耗时归因 + 分批 A/B + CDP 限速慢网络复现【S2.2】 |
| `probe/s3-pgc-verify.mjs` | 端到端四场景（番剧 FastPath / 强制抽样 / SPA 切集 / 旁路）**24 项**【S3.1】 |
| `probe/s3-panel-verify.mjs` | 端到端面板验证 **85 项**（shadow DOM 内真实点击/拖拽、CDP 真指针验 hover、圆钮 42px/图标、**列中点 1/3**、**单钮滑出不二次弹**、**点外部收回**、**面板宽 176px**、**浮窗不压按钮 / 面板各对齐各自按钮 / 打开只留那一个按钮在外**、**S3.2.5 真机文本无旧黑话 + 格式反向断言（无「数字紧跟 dB」）**、全屏隐藏、清除缓存不抹设置、HUD 开关）【S3.2 · S3.2.1 · S3.2.3 · S3.2.4 · S3.2.5】 |
| `probe/s3-pgc-probe.mjs` · `s3-pgc-api-shape.mjs` | 番剧取证：SSR 与接口的 `result` 形状对照【S3.1】 |
| `probe/s3-pgc-control.mjs` | 对照实验：不注入脚本也抛同样的 rejection → 证明异常归属 B 站【S3.1】 |
| `probe/s3-ui-probe.mjs` · `s3-fullscreen-probe.mjs` | 取证：番剧切清晰度（对象不变/命中缓存）+ 网页全屏标记（headless 未触发 → **真机已校准，见 §12 S3.2.2**）【S3.2】 |
| `probe/s3-nav-verify.mjs` | 端到端两轮换视频（17 项）【S2.1】 |
| `probe/s3-nav-probe.mjs` · `probe/s3-nav-fail.mjs` | 事故取证：状态不刷新 + `-404` 错误码【S2.1】 |
| `probe/raw/*.json` | 上述每一条结论的原始输出（**本地保留，不随仓库发布** —— 含真实账号指纹） |
| `reference/`（**本地保留，不随仓库发布**） | 对照用的第三方脚本（MPL-2.0），仅为本地只读参考 |

> **随仓库发布的只有 5 个纯 Node 单元套件**：`s2-unit` / `s3-unit` / `s3-pgc-unit` / `s3-panel-unit` / `store-unit`。
> 上表中的**端到端脚本**（`*-verify`）依赖本机 headless 浏览器 + 已登录 B 站 profile，**一次性取证脚本**（`bl_*` / `*-probe`）是开发期摸底产物 —— 两者都不随仓库发布，跑法与结论见 `docs/测试说明.md`。
