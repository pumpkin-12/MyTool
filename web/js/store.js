'use strict';

/* ============================================================
 * 存储抽象层（双形态：浏览器 / 桌面端）
 * 自动探测三种后端，接口签名完全一致，工具代码无需改动：
 *   - Tauri   ：window.__TAURI__.core.invoke('store_read'/'store_write')
 *   - Electron：window.NativeStore.readAll()/writeAll()（preload 注入）
 *   - 浏览器  ：localStorage
 * 桌面端是异步文件读写：界面初始化必须等 AppStore.ready 之后。
 * ============================================================ */
/* ===TESTABLE:AppStore:begin=== */
/* ============================================================
 * AppStore：唯一的存储入口。三后端自动探测，接口签名一致，
 * 工具代码不感知运行环境。键前缀统一 toolbox:<tool>:<field>。
 *
 * 桌面端采用「分键存储」：每个键一个文件，改一个键只重写该键。
 * 早期版本把全部键塞进一个 store.json，画板改一下就要把整个
 * 题库（约 160 KB）重新 stringify + 写盘，纯属浪费。
 *
 * 内存里仍保留一份完整副本（mem）—— get() 是同步接口，
 * 不能每读一次都走一次 IPC。
 * ============================================================ */
const AppStore = (function () {
  const PREFIX = 'toolbox:';
  const K = k => PREFIX + k;
  /* 🔴 绝不导出的键（第二层防线，定义在 TESTABLE:AppStore 段内以便被 verify 脚本抽到）。
   * 只匹配 key / secret / token 三类 —— 不能用 `toolbox:ai:` 全前缀，
   * 否则会误伤将来要能导出的 `toolbox:ai:usage`（用量统计）。 */
  const NEVER_EXPORT = /^toolbox:ai:(key|secret|token)/i;
  const T = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  const E = (typeof window !== 'undefined' && window.NativeStore) ? window.NativeStore : null;
  const native = !!(T || E);
  let mem = null;

  function clone(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }

  // 写盘串行化 + 失败可见。
  // 原来每次 set 都直接 invoke 一次，而多个 invoke 的完成顺序没有保证，
  // 快速连续保存时存在「后写覆盖先写」的竞态；串成一条 Promise 链即可消除。
  // 同时把失败暴露出来 —— 桌面端磁盘写满/权限异常时不能再静默。
  let writeChain = Promise.resolve();
  let writeErr = null;

  /* 待写盘的键（分键模式下只需重写这些）。
   * 只有在真正轮到这一批写盘时才结算 dirty 集合 —— 若在 persist() 里
   * 立刻结算，连续 3 次 set 会各自成一个批次、写 3 次盘；推迟到链上执行时
   * 再取，就能把这 3 次合并成 1 次。 */
  let dirty = new Set();
  let queued = false;

  function persist(keys) {
    if (!T && !E) return;
    if (keys) {
      for (let i = 0; i < keys.length; i++) dirty.add(keys[i]);
    } else {
      // 全量模式（导入数据）：所有键都算脏
      for (const k in (mem || {})) dirty.add(k);
    }
    if (queued) return;   // 已排队，交给那一批一起结算
    queued = true;

    const run = () => {
      queued = false;
      const batch = Array.from(dirty);
      dirty = new Set();
      if (!batch.length) return undefined;

      // 桌面端：逐键写自己的文件。浏览器/Electron 无分键能力，退化为全量写。
      if (T) {
        return Promise.all(batch.map(k => {
          const v = (mem || {})[k];
          if (v === undefined) return T.invoke('store_del_key', { key: k });
          return T.invoke('store_write_key', { key: k, data: JSON.stringify(v) });
        }));
      }
      return Promise.resolve(E.writeAll(mem || {}));
    };

    writeChain = writeChain.then(run).then(
      () => { writeErr = null; },
      (e) => {
        writeErr = (e && e.message) ? e.message : String(e);
        showToast('保存失败：' + writeErr);
      }
    );
  }

  // 启动时逐键把数据读进内存；失败也不能让界面卡死
  let ready = Promise.resolve();
  if (T) {
    ready = T.invoke('store_keys').then(function (s) {
      /* store_keys 只返回文件名与体积，拿不到键名（键被哈希了）。
       * 所以这里仍需一次全量读取来建立内存副本 —— 但只发生一次，
       * 且迁移后 store.json 已归档，走的是分键目录逐文件读。 */
      return T.invoke('store_read_all');
    }).then(function (s) {
      try { mem = JSON.parse(s || '{}'); } catch (e) { mem = {}; }
      if (!mem || typeof mem !== 'object') mem = {};
    }).catch(function () { mem = {}; });
  } else if (E) {
    ready = Promise.resolve().then(function () { return E.readAll(); }).then(function (d) {
      mem = (d && typeof d === 'object') ? d : {};
    }).catch(function () { mem = {}; });
  }

  return {
    ready: ready,
    isNative: native,
    // 等待所有排队中的写入落盘。导入数据后要等它完成再刷新，否则可能读到旧值。
    flush() { return writeChain; },
    lastError() { return writeErr; },
    get(key, fallback) {
      if (native) {
        if (!mem) return fallback;
        const v = mem[K(key)];
        return (v === undefined || v === null) ? fallback : clone(v);
      }
      try {
        const v = localStorage.getItem(K(key));
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    /* 写入一个键。**不返回任何表示成功与否的值** —— 落盘是异步的，
     * 同步返回值必然是滞后的（旧实现在这里返回「上一次」的结果，
     * 调用方 `if (!AppStore.set(...))` 会读到过期判断）。
     * 要确认本批数据是否真的落盘，写成：
     *   AppStore.set(k, v); await AppStore.flush(); if (AppStore.lastError()) 失败处理
     * 失败本身总会弹 toast，不会静默。 */
    set(key, value) {
      if (native) {
        if (!mem) mem = {};
        mem[K(key)] = clone(value);
        persist([K(key)]);   // 只重写这一个键
        return;
      }
      // 浏览器模式是同步写，配额满等错误当场就能拿到，记进 writeErr 与桌面端对齐
      try {
        localStorage.setItem(K(key), JSON.stringify(value));
        writeErr = null;
      } catch (e) {
        writeErr = (e && e.message) ? e.message : String(e);
        showToast('保存失败：' + writeErr);
      }
    },
    remove(key) {
      if (native) {
        if (mem) { delete mem[K(key)]; persist([K(key)]); }
        return;
      }
      try { localStorage.removeItem(K(key)); } catch (e) {}
    },
    /* 全量导出 / 导入：浏览器版 → 桌面版迁移的唯一通道。
     * 导出的键一律带 PREFIX，导入时原样写回，两端格式对称。 */
    /* 🔴 绝不导出的键（防御性闸门）。
     * 背景：`exportAll()` 是「把内存里所有键原样搬运」，**没有任何字段过滤** ——
     * 首页那个「导出全部数据」会把它原样写进 JSON 文件，将来发给别人/传网盘就跟着走了。
     * 所以我们把 AI 的 API Key 放在 `data/ai/secret.json`（AppStore 根本不管的目录），
     * 从物理上隔离。这道正则只是**第二层防线**：万一将来有人图省事把密钥写进了 AppStore，
     * 也不会被导出。
     * ⚠️ 只匹配 key / secret / token 三类 —— **不能用 `toolbox:ai:` 全前缀**，
     * 那会把将来要能导出的 `toolbox:ai:usage`（用量统计）一起误伤。 */
    exportAll() {
      const out = {};
      if (native) {
        const src = mem || {};
        for (const k in src) {
          if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
          if (NEVER_EXPORT.test(k)) continue;
          out[k] = clone(src[k]);
        }
        return out;
      }
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k.indexOf(PREFIX) !== 0) continue;
          if (NEVER_EXPORT.test(k)) continue;
          try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
        }
      } catch (e) {}
      return out;
    },
    /* 批量写入：合并后只落一次盘。一次业务保存常要写多个 key，
     * 逐个 set 会把「全量 stringify + 全量写盘」重复 N 倍。 */
    setMany(obj) {
      if (!obj || typeof obj !== 'object') return false;
      const touched = [];
      for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (native) {
          if (!mem) mem = {};
          mem[K(k)] = clone(obj[k]);
          touched.push(K(k));
        } else {
          try { localStorage.setItem(K(k), JSON.stringify(obj[k])); }
          catch (e) { return false; }
        }
      }
      if (native && touched.length) persist(touched);
      return true;
    },
    importAll(obj) {
      if (!obj || typeof obj !== 'object') return 0;
      let n = 0;
      if (native) {
        if (!mem) mem = {};
        const touched = [];
        for (const k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k)) {
            mem[k] = clone(obj[k]);
            touched.push(k);
            n++;
          }
        }
        if (n) persist(touched);
        return n;
      }
      try {
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          localStorage.setItem(k, JSON.stringify(obj[k]));
          n++;
        }
      } catch (e) {}
      return n;
    },

    /* ---------- 图片资产（画板专用） ----------
     * 桌面端把图片落到 data/assets/，浏览器端没有文件系统，
     * 退化为把 dataURL 直接存进 localStorage 的一个键。 */

    /* 存一张图，返回资产名（桌面端是 <sha1>.<ext>，浏览器端是内联键名）。
     * dataUrl 形如 "data:image/png;base64,xxxx"。 */
    assetPut(dataUrl) {
      const m = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl || ''));
      if (!m) return Promise.reject(new Error('不是合法的 data URL'));
      const mime = m[1], b64 = m[2];
      const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      if (T) return T.invoke('asset_put', { dataBase64: b64, ext: ext });
      // 浏览器兜底：存进 localStorage，键名用内容哈希避免重复
      try {
        const name = 'inline-' + hashStr(b64) + '.' + ext;
        localStorage.setItem('toolbox:asset:' + name, dataUrl);
        return Promise.resolve(name);
      } catch (e) { return Promise.reject(e); }
    },

    /* 取回资产的 data URL。取不到返回 null（不抛错，渲染路径要能容忍）。 */
    assetGet(name) {
      if (!name) return Promise.resolve(null);
      if (T) return T.invoke('asset_get', { name: name }).catch(() => null);
      try { return Promise.resolve(localStorage.getItem('toolbox:asset:' + name)); }
      catch (e) { return Promise.resolve(null); }
    },

    /* 删除资产。用于形状被删除后回收文件。 */
    assetDel(name) {
      if (!name) return Promise.resolve(false);
      if (T) return T.invoke('asset_del', { name: name }).catch(() => false);
      try { localStorage.removeItem('toolbox:asset:' + name); return Promise.resolve(true); }
      catch (e) { return Promise.resolve(false); }
    }
  };
})();
/* ===TESTABLE:AppStore:end=== */
