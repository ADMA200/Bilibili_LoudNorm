#!/usr/bin/env node
/* ================================================================
 * s3-pgc-unit.mjs — S3.1 番剧/影视链路的单元验证（纯 Node，零浏览器）
 *
 * 针对的实测事实（probe/raw/bls3_pgc.json）：
 *   ① 番剧页 **没有 __INITIAL_STATE__**（0 次）→ 不能用 bvid 交叉校验，
 *      改用「对象身份 + ep_id 配对」判新鲜度；
 *   ② __playinfo__ 顶层是 `result`（不是 data）；
 *   ③ dash 位置两条路不同：SSR 在 `result.video_info.dash`、
 *      接口在 `result.dash`（扁平）→ 必须多路径兜；
 *   ④ audio 字段：SSR 全 snake_case、接口 camel+snake 并存；
 *   ⑤ 响度元数据只在 SSR（`result.video_info.volume`），接口永远没有；
 *   ⑥ 回退流字段名：SSR `durl`、接口 `durls`；
 *   ⑦ 试看/DRM 的标志位分散在 video_info / result 两处。
 *
 * 这些全部用**真实抓下来的结构**做夹具，不凭想象。
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ------------------------------------------------ 沙箱装载 */

const CONFIG = {
  preferAudioId: 30232,
  excludeAudioIds: [30250, 30251, 30280],
  viewCacheTtlMs: 600000,
  pgcApi: 'https://api.bilibili.com/pgc/player/web/playurl',
  pgcQn: 80,
  pgcFnval: 4048,
  pgcCacheTtlMs: 600000,
  pgcSkipCodes: [-403, -404, -688, -689],
  pgcAbortCodes: [-412],
  streamWaitGraceSec: 20,
};
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeEnv({ href, initialState, playinfo, fetchImpl }) {
  const u = new URL(href);
  const win = { __INITIAL_STATE__: initialState, __playinfo__: playinfo };
  return {
    location: { href, pathname: u.pathname, search: u.search },
    unsafeWindow: win,
    window: win,
    CONFIG,
    Log: silentLog,
    fetch: fetchImpl || (async () => { throw new Error('未提供 fetch'); }),
  };
}

function loadModules(env) {
  const code = ['state-reader.js', 'playinfo.js'].map(f => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n');
  const names = Object.keys(env);
  const factory = new Function(...names, `${code}\nreturn { StateReader, PlayInfo };`);
  return factory(...names.map(n => env[n]));
}

/* ------------------------------------------------ 真实夹具 */

/** SSR 形状：__playinfo__.result（实测 bls3_pgc.json） */
const SSR_RESULT = {
  play_video_type: 0,
  video_info: {
    timelength: 1441042,
    quality: 80,
    is_preview: 0,
    is_drm: false,
    dash: {
      duration: 1442,
      audio: [
        { id: 30280, base_url: 'https://x/30280.m4s', backup_url: [], bandwidth: 323182, mime_type: 'audio/mp4', codecs: 'mp4a.40.2', segment_base: { initialization: '0-919', index_range: '920-4419' } },
        { id: 30232, base_url: 'https://x/30232.m4s', backup_url: [], bandwidth: 132000, mime_type: 'audio/mp4', codecs: 'mp4a.40.2', segment_base: { initialization: '0-919', index_range: '920-4419' } },
      ],
    },
    volume: {
      measured_i: -23.8, measured_lra: 8.1, measured_tp: -2.7, measured_threshold: -34.7,
      target_offset: 0.1, target_i: -14, target_tp: -1,
      multi_scene_args: { high_dynamic_target_i: '-24', normal_target_i: '-14', undersized_target_i: '-28' },
    },
    /* 当前集的 ep_id 也在清晰度档位的上报参数里（实测是 string） */
    support_formats: [{ quality: 125, report: { ep_id: '308426' } }],
  },
  arc: { biz_type: 1, aid: 82446074, cid: 141064726, bvid: 'BV1GJ41157f6' },
  play_check: { play_detail: 'PLAY_WHOLE' },
  /* 实测（CDP 抓 ss29308 落地页）：季落地页 URL 里没有 ep，但这两处写着
   * 「当前正在播的那一集」—— 这就是 ss 页此前整个被跳过的原因 */
  play_view_business_info: { episode_info: { ep_id: 308426, aid: 82446074, cid: 141064726 } },
  supplement: {
    ogv_episode_info: { episode_id: 308426 },
    ogv_season_watch_progress: { last_ep_id: 308426 },
  },
};

/** 接口形状：j.result（扁平 + camelCase，实测 s3-pgc-api-shape） */
const API_RESULT = {
  is_preview: 0, is_drm: false, error_code: 0, timelength: 1441042, quality: 80,
  durls: [],
  dash: {
    duration: 1442,
    audio: [{
      id: 30232, baseUrl: 'https://y/30232.m4s', bandwidth: 132000,
      mimeType: 'audio/mp4', codecs: 'mp4a.40.2',
      SegmentBase: { Initialization: '0-919', indexRange: '920-4419' },
    }],
  },
};

const EP_A = 'https://www.bilibili.com/bangumi/play/ep308426';
const EP_B = 'https://www.bilibili.com/bangumi/play/ep309868';
const SSR_PI = { result: SSR_RESULT };

const pgcEnv = (extra) => makeEnv(Object.assign({
  href: EP_A, initialState: null, playinfo: SSR_PI,
}, extra || {}));

/* ------------------------------------------------ 1. 页型与 ep_id 识别 */

section('1. StateReader：页型与 ep_id / season_id 识别');
{
  const env = pgcEnv({ href: 'https://www.bilibili.com/bangumi/play/ep308426' });
  const { StateReader } = loadModules(env);
  check('★ /bangumi/play/ep308426 → kind=pgc', StateReader.kind() === 'pgc', StateReader.kind());
  check('★ 从路径解析出 ep_id=308426', StateReader.epId() === '308426', StateReader.epId());

  const env2 = pgcEnv({ href: 'https://www.bilibili.com/bangumi/play/ss12345?ep_id=308426' });
  const s2 = loadModules(env2).StateReader;
  check('季路径 + ?ep_id= → ep_id 取 query', s2.epId() === '308426', s2.epId());
  check('季路径 → seasonId=12345', s2.seasonId() === '12345', s2.seasonId());

  /* 季落地页：URL 里没有 ep，但 B 站已自动选集**并在播** → 从 SSR 取当前集。
   * （旧实现只认 URL，这里返回 null，于是整页被跳过 —— 实测 ss29308 复现） */
  const env3 = pgcEnv({ href: 'https://www.bilibili.com/bangumi/play/ss12345' });
  const s3 = loadModules(env3).StateReader;
  check('★ 季落地页（URL 无 ep，B 站已自动在播一集）→ 从 SSR 取当前集 ep_id',
    s3.epId() === '308426', String(s3.epId()));

  /* SSR 里确实没有「当前集」信息 → 仍是 null（真的无集可分析，该跳过） */
  const env3b = pgcEnv({
    href: 'https://www.bilibili.com/bangumi/play/ss12345',
    playinfo: { result: { video_info: { dash: { duration: 1442 } } } },
  });
  const s3b = loadModules(env3b).StateReader;
  check('★ 季落地页且 SSR 无「当前集」字段 → epId 为 null（无集可分析）',
    s3b.epId() === null, String(s3b.epId()));

  /* 关键防护：URL 有 ep 时必须压过 SSR —— 否则 SPA 切集后 SSR 还是上一集，会压错 */
  const env3c = pgcEnv({
    href: 'https://www.bilibili.com/bangumi/play/ep309868',
    playinfo: SSR_PI,                       // SSR 这一份仍是 308426
  });
  const s3c = loadModules(env3c).StateReader;
  check('★ URL 的 ep 优先于 SSR（SSR 还是上一集时不得采信）',
    s3c.epId() === '309868', String(s3c.epId()));

  /* 三条来源各自单独可用（多路径兜底，跨页型） */
  const ssrOnly = (mk) => pgcEnv({
    href: 'https://www.bilibili.com/bangumi/play/ss12345',
    playinfo: { result: mk() },
  });
  const s3d = loadModules(ssrOnly(() => ({ supplement: { ogv_episode_info: { episode_id: 309869 } } }))).StateReader;
  check('★ 仅 supplement.ogv_episode_info 一条路径 → 也能取到',
    s3d.epId() === '309869', String(s3d.epId()));

  const s3e = loadModules(ssrOnly(() => ({ video_info: { support_formats: [{ report: { ep_id: '309870' } }] } }))).StateReader;
  check('★ 仅清晰度档位 report.ep_id（字符串）一条路径 → 也能取到',
    s3e.epId() === '309870', String(s3e.epId()));

  const s3f = loadModules(ssrOnly(() => ({ supplement: { ogv_episode_info: { episode_id: '309871' } } }))).StateReader;
  check('★ 集号以字符串给出时同样接受', s3f.epId() === '309871', String(s3f.epId()));

  const env4 = makeEnv({ href: 'https://www.bilibili.com/video/BV1GJ411x7h7/', initialState: null, playinfo: null });
  const s4 = loadModules(env4).StateReader;
  check('普通投稿仍是 kind=video', s4.kind() === 'video', s4.kind());

  const env5 = makeEnv({ href: 'https://www.bilibili.com/cheese/play/ep1', initialState: null, playinfo: null });
  const s5 = loadModules(env5).StateReader;
  check('课程页（已明确不做）→ kind=other', s5.kind() === 'other', s5.kind());
}

/* ------------------------------------------------ 2. 番剧新鲜度（对象身份 + ep 配对） */

section('2. StateReader：番剧新鲜度 = 对象身份 + ep_id 配对');
{
  const env = pgcEnv({ href: EP_A });
  const { StateReader } = loadModules(env);
  check('★ 首屏（第一次见该对象）→ 新鲜', StateReader.pgcFresh() === true, StateReader.pgcFresh());
  check('同一对象、同一 ep → 仍新鲜', StateReader.pgcFresh() === true, StateReader.pgcFresh());

  // SPA 切集：URL 变了，但 __playinfo__ 还是同一个对象（实测行为）
  env.location.href = EP_B;
  const u = new URL(EP_B);
  env.location.pathname = u.pathname;
  env.location.search = u.search;
  check('★★ 同一对象 + 换了 ep → 判过期（切集后未刷新）', StateReader.pgcFresh() === false, StateReader.pgcFresh());

  // B 站重新注入了一份（换了对象）→ 认新鲜
  env.unsafeWindow.__playinfo__ = { result: Object.assign({}, SSR_RESULT) };
  check('换过对象 → 重新认新鲜', StateReader.pgcFresh() === true, StateReader.pgcFresh());

  check('番剧页 pageFresh()（bvid 校验）恒为 false —— 因为根本没有 __INITIAL_STATE__',
    StateReader.pageFresh() === false, String(StateReader.pageFresh()));
}

/* ------------------------------------------------ 3. pgcKey / cacheKey */

section('3. StateReader：pgcKey 与 cacheKey');
{
  const env = pgcEnv({ href: EP_A });
  const { StateReader } = loadModules(env);
  const k = StateReader.pgcKey();
  check('★ pgcKey.kind=pgc', k.kind === 'pgc', k.kind);
  check('★ pgcKey.epId=308426', k.epId === '308426', k.epId);
  check('新鲜时取到 arc.cid', k.cid === 141064726, k.cid);
  check('新鲜时取到 arc.bvid', k.bvid === 'BV1GJ41157f6', k.bvid);
  check('时长取 dash.duration=1442', k.duration === 1442, k.duration);
  check('★ cacheKey = p:308426（不含 cid，接口只需 ep_id）',
    StateReader.cacheKey(k) === 'p:308426', StateReader.cacheKey(k));

  // 切集后：SSR 陈旧 → cid/bvid/duration 一律不采信
  env.location.href = EP_B;
  const u2 = new URL(EP_B);
  env.location.pathname = u2.pathname; env.location.search = u2.search;
  const k2 = StateReader.pgcKey();
  check('★★ 切集后 cid 不采信（陈旧 SSR）', k2.cid === null, String(k2.cid));
  check('★★ 切集后时长不采信', k2.duration === null, String(k2.duration));
  check('切集后 cacheKey 跟着换成 p:309868', StateReader.cacheKey(k2) === 'p:309868', StateReader.cacheKey(k2));

  const envV = makeEnv({
    href: 'https://www.bilibili.com/video/BV1GJ411x7h7/', initialState: null, playinfo: null,
  });
  const sv = loadModules(envV).StateReader;
  check('cacheKey 普通投稿仍是 v:bvid:cid', sv.cacheKey({ kind: 'video', bvid: 'BV1', cid: 99, p: 1 }) === 'v:BV1:99');
}

/* ------------------------------------------------ 4. normalizePgc：SSR 形状 */

section('4. PlayInfo.normalizePgc：SSR 形状（video_info.dash + snake_case）');
{
  const env = pgcEnv({ href: EP_A });
  const { PlayInfo } = loadModules(env);
  const n = PlayInfo.normalizePgc(SSR_RESULT, 'page');
  check('★ kind=pgc', n.kind === 'pgc', n.kind);
  check('★★ 从 video_info.dash 取到音频轨（不是 result.dash）', !!n.audio, n.audio && n.audio.id);
  check('★ 优选 30232（排除了 30280）', n.audio && n.audio.id === 30232, n.audio && n.audio.id);
  check('snake_case base_url 被正确解析', n.audio && n.audio.url === 'https://x/30232.m4s', n.audio && n.audio.url);
  check('★ segment_base.initialization 解析成 initRange', n.audio && n.audio.initRange && n.audio.initRange.start === 0 && n.audio.initRange.end === 919, JSON.stringify(n.audio && n.audio.initRange));
  check('★ segment_base.index_range 解析成 indexRange', n.audio && n.audio.indexRange && n.audio.indexRange.start === 920 && n.audio.indexRange.end === 4419, JSON.stringify(n.audio && n.audio.indexRange));
  check('snake_case mime_type 被识别', n.audio && n.audio.mimeType === 'audio/mp4', n.audio && n.audio.mimeType);
  check('★ 响度元数据从 video_info.volume 取到', !!n.volumeMeta && n.volumeMeta.measuredI === -23.8, n.volumeMeta && n.volumeMeta.measuredI);
  check('元数据 target_i / measured_tp 都在', n.volumeMeta && n.volumeMeta.targetI === -14 && n.volumeMeta.measuredTp === -2.7, JSON.stringify(n.volumeMeta));
  check('multi_scene_args 保留（B 站两档目标：−14 / −24）', !!n.volumeMeta && !!n.volumeMeta.sceneArgs, JSON.stringify(n.volumeMeta && n.volumeMeta.sceneArgs));
  check('时长取 dash.duration', n.duration === 1442, n.duration);
  check('arc.cid / arc.bvid 带出来', n.cid === 141064726 && n.bvid === 'BV1GJ41157f6', `${n.cid} / ${n.bvid}`);
  check('未误判试看', n.isPreview === false, n.isPreview);
  check('未误判 DRM', n.isDrm === false, n.isDrm);
  check('play_check=PLAY_WHOLE → 不算试看', n.isPreview === false);
}

/* ------------------------------------------------ 5. normalizePgc：接口形状 */

section('5. PlayInfo.normalizePgc：接口形状（扁平 result.dash + camelCase）');
{
  const env = pgcEnv({ href: EP_A });
  const { PlayInfo } = loadModules(env);
  const n = PlayInfo.normalizePgc(API_RESULT, 'api');
  check('★★ 从扁平 result.dash 取到音频轨（另一条路）', !!n.audio, n.audio && n.audio.id);
  check('camelCase baseUrl 被正确解析', n.audio && n.audio.url === 'https://y/30232.m4s', n.audio && n.audio.url);
  check('★ camelCase SegmentBase.Initialization 解析成 initRange', n.audio && n.audio.initRange && n.audio.initRange.end === 919, JSON.stringify(n.audio && n.audio.initRange));
  check('★ camelCase indexRange 解析成 indexRange', n.audio && n.audio.indexRange && n.audio.indexRange.start === 920, JSON.stringify(n.audio && n.audio.indexRange));
  check('★ 接口无 volume → volumeMeta 为 null（元数据只在 SSR）', n.volumeMeta === null, String(n.volumeMeta));
  check('时长优先取 dash.duration=1442', n.duration === 1442, n.duration);
  const noDur = PlayInfo.normalizePgc({
    is_preview: 0, error_code: 0, timelength: 1441042,
    dash: { audio: [{ id: 30232, baseUrl: 'u', SegmentBase: { Initialization: '0-9', indexRange: '10-19' } }] },
  }, 'api');
  check('★ dash 无 duration 时退 timelength/1000 = 1441.042', Math.abs(noDur.duration - 1441.042) < 0.01, noDur.duration);
  check('接口无 arc → cid/bvid 为 null', n.cid === null && n.bvid === null, `${n.cid} / ${n.bvid}`);
}

/* ------------------------------------------------ 6. 试看 / DRM 判定 */

section('6. 试看判定（5 条命中路径）与 DRM');
{
  const env = pgcEnv({ href: EP_A });
  const { PlayInfo } = loadModules(env);
  const asApi = (o) => PlayInfo.normalizePgc(o, 'api');

  check('路径① is_preview=1', asApi(Object.assign({}, API_RESULT, { is_preview: 1 })).isPreview === true);
  check('路径② error_code=-10403', asApi(Object.assign({}, API_RESULT, { is_preview: 0, error_code: -10403 })).isPreview === true);

  const durlOnly = asApi({ is_preview: 0, error_code: 0, timelength: 1441042, durls: [{ length: 360000 }] });
  check('★ 路径③ 有 durls 无 dash → 试看', durlOnly.isPreview === true);
  check('★ 同时 hasDurlOnly=true（无法抽样）', durlOnly.hasDurlOnly === true);

  const shortDurl = asApi({
    is_preview: 0, error_code: 0, timelength: 1441042,
    dash: { duration: 1442, audio: [{ id: 30232, baseUrl: 'u', SegmentBase: { Initialization: '0-9', indexRange: '10-19' } }] },
    durls: [{ length: 360000 }],
  });
  check('★ 路径④ durl 长度 < timelength → 试看', shortDurl.isPreview === true);

  check('路径⑤ play_check.play_detail !== PLAY_WHOLE', asApi(Object.assign({}, API_RESULT, { play_check: { play_detail: 'PLAY_PART' } })).isPreview === true);
  check('play_check=PLAY_WHOLE 且其它正常 → 不算试看', asApi(Object.assign({}, API_RESULT, { play_check: { play_detail: 'PLAY_WHOLE' } })).isPreview === false);

  check('★ DRM：result.is_drm=true（接口层）', asApi(Object.assign({}, API_RESULT, { is_drm: true })).isDrm === true);
  const ssrDrm = PlayInfo.normalizePgc({ video_info: { is_drm: true, dash: { duration: 100, audio: [] } }, arc: {} }, 'page');
  check('★ DRM：video_info.is_drm=true（SSR 层）', ssrDrm.isDrm === true);
  check('DRM：widevine_pssh 存在也算', asApi(Object.assign({}, API_RESULT, { widevine_pssh: 'AAAA' })).isDrm === true);
}

/* ------------------------------------------------ 7. fromPgcApi 错误码分派 */

section('7. PlayInfo.fromPgcApi：错误码分派与短缓存');
{
  let calls = 0;
  const mkFetch = (payload) => async () => { calls++; return { ok: true, status: 200, json: async () => payload }; };

  // 正常：code=0，result 完整
  {
    calls = 0;
    const env = pgcEnv({ href: EP_A, fetchImpl: mkFetch({ code: 0, message: 'success', result: API_RESULT }) });
    const { PlayInfo } = loadModules(env);
    const n = await PlayInfo.fromPgcApi({ kind: 'pgc', epId: '308426' });
    check('code=0 → 正常返回，抓到音频轨', !!n && !!n.audio, n && n.audio && n.audio.id);
    check('★ 请求 URL 带 ep_id 且用 pgc 接口', calls === 1);
    const n2 = await PlayInfo.fromPgcApi({ kind: 'pgc', epId: '308426' });
    check('★ 同 ep 第二次调用命中短缓存（零请求）', calls === 1, `calls=${calls}`);
  }

  // -412 IP 风控：fatal，且**不重试**
  {
    calls = 0;
    const env = pgcEnv({ href: EP_A, fetchImpl: mkFetch({ code: -412, message: '请求被拦截' }) });
    const { PlayInfo } = loadModules(env);
    let err = null;
    try { await PlayInfo.fromPgcApi({ kind: 'pgc', epId: '308427' }); } catch (e) { err = e; }
    check('★ code=-412 → 抛错且标记 fatal', !!err && err.fatal === true, err && String(err.code));
    check('★ -412 不重试（只请求 1 次）', calls === 1, `calls=${calls}`);
  }

  // -404：skip（跳过分析）
  {
    calls = 0;
    const env = pgcEnv({ href: EP_A, fetchImpl: mkFetch({ code: -404, message: '啥都木有' }) });
    const { PlayInfo } = loadModules(env);
    let err = null;
    try { await PlayInfo.fromPgcApi({ kind: 'pgc', epId: '308428' }); } catch (e) { err = e; }
    check('★ code=-404 → 标记 skip（不是故障）', !!err && err.skip === true, err && String(err.code));
    check('-404 不重试', calls === 1, `calls=${calls}`);
  }

  // -352：暂时性 → 退避重试一次
  {
    calls = 0;
    const env = pgcEnv({ href: EP_A, fetchImpl: mkFetch({ code: -352, message: '风控校验失败' }) });
    const { PlayInfo } = loadModules(env);
    let err = null;
    try { await PlayInfo.fromPgcApi({ kind: 'pgc', epId: '308429' }); } catch (e) { err = e; }
    check('★ code=-352 → 退避重试（共 2 次）', calls === 2, `calls=${calls}`);
    check('-352 两次都失败 → 最终抛出', !!err && String(err.code) === '-352', err && String(err.code));
  }

  // 顶层 code=0 但 result.error_code=-10403：试看，不是错误
  {
    const env = pgcEnv({ href: EP_A, fetchImpl: mkFetch({ code: 0, message: 'success', result: Object.assign({}, API_RESULT, { is_preview: 1, error_code: -10403 }) }) });
    const { PlayInfo } = loadModules(env);
    const n = await PlayInfo.fromPgcApi({ kind: 'pgc', epId: '308430' });
    check('★★ 顶层 0 + result.error_code=-10403 → 正常返回并标试看（不是抛错）', !!n && n.isPreview === true, n && n.isPreview);
  }
}

/* ------------------------------------------------ 8. 源码守卫 */

section('8. 源码守卫：番剧接口参数与铁律');
{
  const src = readFileSync(join(ROOT, 'src', 'playinfo.js'), 'utf8');
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const code = strip(src);
  check('★ 番剧接口用 ep_id（不是 bvid+cid 那套）', /ep_id=\$\{encodeURIComponent\(info\.epId\)\}/.test(code));
  check('★ 番剧接口同时多路径兜 dash（video_info.dash 与 result.dash）',
    /vi && vi\.dash/.test(code) && /result\.dash/.test(code));
  check('回退流双读 durl / durls', /result\.durl\b/.test(code) && /result\.durls/.test(code));

  const reader = strip(readFileSync(join(ROOT, 'src', 'state-reader.js'), 'utf8'));
  check('★ 番剧 cacheKey 前缀是 p:', /`p:\$\{info\.epId\}`/.test(reader));
  check('番剧新鲜度用 objects 身份 + ep 配对（pgcRef / pgcRefEp）', /pgcRef/.test(reader) && /pgcRefEp/.test(reader));
}

/* ------------------------------------------------ 汇总 */
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
