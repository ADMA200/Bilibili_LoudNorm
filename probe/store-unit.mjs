#!/usr/bin/env node
/* ================================================================
 * store-unit.mjs — 测量缓存（LRU / TTL / 配额）的单元验证
 *
 * store.js 是那种「平时看不见、坏了也很难察觉」的模块：
 *   · 淘汰策略写错   → 缓存越用越少，但界面一切正常
 *   · get 不续期     → 淘汰按「最早写入」发生，常看的视频照样被清（实为 FIFO）
 *   · TTL 只删数据   → 索引里堆悬空条目，白占名额
 *   · 写入失败被吞掉 → 配额满了之后每条新测量都白跑，且**永不恢复**
 * 这些都得靠断言钉死。沙箱里跑的是**真实的 src/store.js**。
 *
 * 【S3.2.6】后三项均为本轮修正，断言带 ★ 标注。
 * ================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ================================================================
 * 假 localStorage —— 可设配额，可数索引写入次数
 * ================================================================ */

function makeStorage(opts = {}) {
  const map = new Map();
  const stat = { index: 0, data: 0, settings: 0 };
  let quota = opts.quota ?? Infinity;

  const size = (m) => {
    let n = 0;
    for (const [k, v] of m) n += k.length + String(v).length;
    return n;
  };

  return {
    map, stat,
    used: () => size(map),
    setQuota(v) { quota = v; },

    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      const next = new Map(map);
      next.set(k, v);
      if (size(next) > quota) {
        const e = new Error('QuotaExceededError: the quota has been exceeded.');
        e.name = 'QuotaExceededError';
        throw e;
      }
      if (k.endsWith('__index')) stat.index++;
      else if (k.endsWith('__settings')) stat.settings++;
      else stat.data++;
      map.set(k, v);
    },
    removeItem(k) { map.delete(k); },
  };
}

/** 在沙箱里加载**真实的 store.js**（GM_* 传 undefined → 走 localStorage 分支） */
function load(opts = {}) {
  const storage = makeStorage(opts);
  const logs = { debug: [], info: [], warn: [] };
  const str = (...a) => a.map(x => String(x)).join(' ');
  const Log = {
    debug: (...a) => logs.debug.push(str(...a)),
    info: (...a) => logs.info.push(str(...a)),
    warn: (...a) => logs.warn.push(str(...a)),
    error: (...a) => logs.warn.push(str(...a)),
  };
  const CONFIG = {
    cacheMaxEntries: opts.maxEntries ?? 800,
    cacheTtlDays: opts.ttlDays ?? 30,
  };

  const src = read('src/store.js');
  const factory = new Function('CONFIG', 'Log', 'localStorage',
    'GM_getValue', 'GM_setValue', 'GM_deleteValue', `${src}\nreturn Store;`);
  const Store = factory(CONFIG, Log, storage, undefined, undefined, undefined);

  return { Store, storage, logs, CONFIG };
}

const rec = (lufs = -14, at = Date.now()) => ({
  measuredLufs: lufs, truePeakDb: -1.2, source: 'sample', analyzedAt: at,
});

/* ================================================================
 * 1. 容量上限与淘汰
 * ================================================================ */

function testCapacity() {
  section('1. 容量上限与淘汰（真实配置 800）');

  const { Store } = load();
  for (let i = 0; i < 800; i++) Store.set(`k${i}`, rec());

  check('写满 800 条 → entries = 800', Store.stats().entries === 800, String(Store.stats().entries));

  Store.set('k800', rec());
  check('★ 写入第 801 条后仍是 800 条（封顶，不存在 801 的中间态）',
    Store.stats().entries === 800, String(Store.stats().entries));
  check('★ 淘汰的是**队首**（最久未使用）k0', Store.get('k0') === null);
  check('次旧的 k1 不受牵连', Store.get('k1') !== null);
  check('刚写的 k800 在', Store.get('k800') !== null);

  section('1b. 覆盖写不让索引虚长');
  const { Store: S2 } = load({ maxEntries: 3 });
  S2.set('a', rec()); S2.set('b', rec()); S2.set('c', rec());
  S2.set('a', rec());
  check('覆盖写同名 key → 长度不变（3）', S2.stats().entries === 3, String(S2.stats().entries));

  S2.set('d', rec());
  check('★ 容量 3 时写第 4 个不同 key → 淘汰最旧的 b', S2.get('b') === null);
  check('★ 刚被覆盖写过的 a 反而存活（覆盖写也算一次使用）', S2.get('a') !== null);
  check('c 仍在', S2.get('c') !== null);
}

/* ================================================================
 * 2. 真 LRU —— get 命中也要续期（S3.2.6）
 * ================================================================ */

function testLru() {
  section('2. get 命中续期（S3.2.6：把 FIFO 修成真 LRU）');

  const { Store } = load({ maxEntries: 3 });
  Store.set('a', rec());
  Store.set('b', rec());
  Store.set('c', rec());
  // 索引写入序 = [a, b, c]，此刻 a 最旧

  Store.get('a');          // ← 只有 S3.2.6 才会把 a 挪到队尾
  Store.set('d', rec());   // 超量 → 淘汰队首

  check('★ 读过一次后，被淘汰的是 b 而不是 a（旧行为会淘汰 a）',
    Store.get('a') !== null && Store.get('b') === null,
    `a=${Store.get('a') === null ? 'null' : '在'} b=${Store.get('b') === null ? 'null' : '在'}`);

  section('2b. 连续读也没问题（幂等）');
  const { Store: S2 } = load({ maxEntries: 3 });
  S2.set('x', rec()); S2.set('y', rec()); S2.set('z', rec());
  S2.get('x'); S2.get('x'); S2.get('x');
  S2.set('w', rec());
  check('★ 反复读 x 只占一个名额，且仍存活',
    S2.stats().entries === 3 && S2.get('x') !== null && S2.get('y') === null);
}

/* ================================================================
 * 3. 索引写入次数 —— 读热 key 不该反复落盘
 * ================================================================ */

function testIndexWrites() {
  section('3. 索引写入次数（analyzer 一轮里会连读同一个 key）');

  const { Store, storage } = load({ maxEntries: 5 });
  Store.set('a', rec());
  const base = storage.stat.index;
  Store.get('a');
  check('★ 读**已在队尾**的 key → 零索引写入', storage.stat.index === base,
    `${base} → ${storage.stat.index}`);

  Store.set('b', rec());   // 索引变成 [a, b]
  const base2 = storage.stat.index;
  Store.get('a');          // a 不在队尾 → 续期
  check('★ 读**不在队尾**的 key → 写一次索引', storage.stat.index === base2 + 1,
    `${base2} → ${storage.stat.index}`);

  const base3 = storage.stat.index;
  Store.get('a');          // 此时 a 已在队尾
  check('★ 续期之后再读同一个 key → 又回到零写入', storage.stat.index === base3,
    `${base3} → ${storage.stat.index}`);

  const base4 = storage.stat.data;
  Store.get('不存在');
  check('未命中的 get 不产生任何写入', storage.stat.data === base4 && storage.stat.index === base3);
}

/* ================================================================
 * 4. TTL 过期：数据与索引一起清（S3.2.6）
 * ================================================================ */

function testTtl() {
  section('4. TTL 过期（S3.2.6：不再留悬空索引项）');

  const { Store } = load({ maxEntries: 10, ttlDays: 30 });
  const stale = Date.now() - 31 * 86400000;

  Store.set('fresh', rec(-14, Date.now()));
  Store.set('stale', rec(-14, stale));

  check('未访问时，过期条目照样占索引名额（2）', Store.stats().entries === 2,
    String(Store.stats().entries));

  check('★ 取过期条目 → 返回 null', Store.get('stale') === null);
  check('★ 取过期条目后索引同步摘掉（2 → 1）', Store.stats().entries === 1,
    String(Store.stats().entries));
  check('★ 索引里不再有 stale 的悬空项', !Store.list().some(e => e.key === 'blv2:stale'));
  check('未过期的 fresh 不受影响', Store.get('fresh') !== null);

  section('4b. TTL 边界');
  const { Store: S2 } = load({ ttlDays: 30 });
  const edge = Date.now() - 29 * 86400000;
  S2.set('almost', rec(-14, edge));
  check('29 天前的条目仍可用（未到 30 天）', S2.get('almost') !== null);

  const { Store: S3 } = load({ ttlDays: 0 });
  S3.set('forever', rec(-14, Date.now() - 3650 * 86400000));
  check('ttlDays = 0 → 视为永不过期', S3.get('forever') !== null);
}

/* ================================================================
 * 5. 写入失败（配额满）：先腾位再重试（S3.2.6）
 * ================================================================ */

function testQuota() {
  section('5. 配额满：淘汰一批后重试（S3.2.6：不再静默失败）');

  const { Store, storage, logs } = load({ maxEntries: 10 });
  for (let i = 0; i < 10; i++) Store.set(`k${i}`, rec());
  check('先写满 10 条', Store.stats().entries === 10);

  // 配额卡到「刚好只差一点」：新记录塞不下，但淘汰一条腾出的空间足够
  storage.setQuota(storage.used() + 20);
  const ok = Store.set('kNew', rec());

  check('★ 配额不足时仍写成功（自动腾位）', ok === true);
  check('★ 有明确告警，且写明淘汰了几条',
    logs.warn.some(s => /淘汰 1 条最旧记录后重试成功/.test(s)), logs.warn.join(' / '));
  check('★ 淘汰的是最旧的 k0', Store.get('k0') === null);
  check('★ 新记录已落盘', Store.get('kNew') !== null);
  check('★ 索引长度回到上限 10', Store.stats().entries === 10, String(Store.stats().entries));

  section('5b. 彻底写不进时如实返回 false');
  const e = load({ maxEntries: 10 });
  for (let i = 0; i < 10; i++) e.Store.set(`k${i}`, rec());
  e.storage.setQuota(1);   // 连索引都写不进去
  const ok2 = e.Store.set('kX', rec());

  check('★ 配额彻底写不进 → 返回 false（不假装成功）', ok2 === false);
  check('★ 明确告警「不落盘」', e.logs.warn.some(s => /不落盘/.test(s)),
    e.logs.warn.join(' / '));
}

/* ================================================================
 * 6. 设置隔离（沿用 S3.2 约定）
 * ================================================================ */

function testSettings() {
  section('6. 设置不进缓存索引、不被清缓存波及');

  const { Store } = load({ maxEntries: 5 });
  Store.set('a', rec());
  Store.setSettings({ profile: 'night', enabled: false });

  check('★ setSettings 不占索引名额', Store.stats().entries === 1,
    String(Store.stats().entries));

  Store.clear();
  check('clear() 清掉测量缓存', Store.stats().entries === 0);
  check('★ clear() 不抹设置（profile 还在）', Store.getSettings().profile === 'night');
  check('★ clear() 不抹设置（enabled 还在）', Store.getSettings().enabled === false);

  section('6b. remove() 同时摘索引');
  const { Store: S2 } = load({ maxEntries: 5 });
  S2.set('a', rec()); S2.set('b', rec());
  S2.remove('a');
  check('★ remove 后索引长度 1', S2.stats().entries === 1, String(S2.stats().entries));
  check('★ remove 后数据真的没了（不是只摘索引）', S2.get('a') === null);
  check('b 还在', S2.get('b') !== null);
}

/* ================================================================
 * 7. 源码级硬约束
 * ================================================================ */

function testSourceInvariants() {
  section('7. 源码级硬约束');

  const src = read('src/store.js');
  check('★ get() 命中会续期（调 bump）', /bump\(k\);\s*\/\//.test(src) || /bump\(k\);/.test(src));
  check('★ TTL 过期时摘索引（调 dropFromIndex）', /dropFromIndex\(k\);/.test(src));
  check('★ 配额失败路径：先淘汰再重试',
    /evictOldest\(Math\.max\(1, Math\.ceil\(CONFIG\.cacheMaxEntries \* 0\.1\)\)\)/.test(src)
    && /freed > 0 && setRaw\(k, rec\)/.test(src));
  check('★ 索引写入失败不静默（有 warn）', /缓存索引写入失败/.test(src));
  check('★ 淘汰仍只按 CONFIG.cacheMaxEntries 封顶',
    /while \(idx\.length > CONFIG\.cacheMaxEntries\)/.test(src));

  const touchBody = (src.match(/function touch\s*\(key\)\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
  check('★ 淘汰逻辑里不出现 settings（不会删到用户设置）',
    !!touchBody && !/settings/i.test(touchBody));

  check('构建产物已同步（store 段含 bump）', /function bump\s*\(key\)/.test(read('Bilibili_LoudNorm.user.js')));
}

/* ================================================================ */

(() => {
  console.log('测量缓存（store.js）单元验证\n');
  testCapacity();
  testLru();
  testIndexWrites();
  testTtl();
  testQuota();
  testSettings();
  testSourceInvariants();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
