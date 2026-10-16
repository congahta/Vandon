// ══════════════════════════════════════════════════════
// hangdoi.js — HÀNG ĐỢI GỬI ĐƠN dùng chung cho index.html (quét hoàn) và Scan.html (quét nhanh)
//   • Mỗi đơn có MÃ YÊU CẦU (reqId) → gửi lại bao nhiêu lần máy chủ cũng chỉ ghi 1 lần.
//   • Chỉ xoá đơn khi máy chủ trả "ok". Lỗi mạng / máy chủ bận → thử lại mãi (3s → 60s). KHÔNG BAO GIỜ bỏ đơn.
//     Đơn máy chủ từ chối hẳn (thiếu mã...) → giữ lại, đánh dấu lỗi, không gửi nữa.
//   • Trong app Hàng hoàn 1.3.11+: giao đơn cho app (window.AndroidQueue) — app lưu xuống máy và gửi nền,
//     thoát trang / về màn chọn / tắt app vẫn không mất. App cũ / trình duyệt: lưu IndexedDB (không giới hạn 5MB
//     như localStorage → không tràn khi hàng đợi dài có ảnh).
//   • Quét nhanh gửi theo lô 50 mã (addScanBatch). Gửi xong → gọi 'xuLy' để máy chủ chuyển vào sheet ngay.
// ══════════════════════════════════════════════════════
(function () {
  const DB_NAME = 'mps_hangdoi', STORE = 'q', LS_KEY = 'hd_q';
  const NGHI_GIAY = [3, 5, 10, 30, 60];
  const LO = 50;

  let url = '', onSent = function () {}, onCount = function () {};
  let dbP = null, dangGui = false, hen = null, loi = 0, lanKick = 0, demApp = 0, demWeb = 0;

  function coApp() { return !!(window.AndroidQueue && typeof window.AndroidQueue.enqueue === 'function'); }

  // ── Lưu trữ: IndexedDB, hỏng thì localStorage ──
  function moDb() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        const rq = indexedDB.open(DB_NAME, 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE, { keyPath: 'reqId' }); };
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { resolve(null); };
        rq.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  function lsDoc() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; } }
  function lsGhi(a) { localStorage.setItem(LS_KEY, JSON.stringify(a)); }

  function txDone(tx) { return new Promise(function (ok, no) { tx.oncomplete = function () { ok(); }; tx.onerror = tx.onabort = function () { no(tx.error || new Error('IndexedDB lỗi')); }; }); }

  async function tatCa() {
    const db = await moDb();
    if (!db) return lsDoc().sort(function (a, b) { return a._t - b._t; });
    return new Promise(function (ok) {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      rq.onsuccess = function () { ok((rq.result || []).sort(function (a, b) { return a._t - b._t; })); };
      rq.onerror = function () { ok([]); };
    });
  }
  async function luu(items) {
    const db = await moDb();
    if (!db) { const a = lsDoc(); items.forEach(function (it) { const i = a.findIndex(function (x) { return x.reqId === it.reqId; }); if (i >= 0) a[i] = it; else a.push(it); }); lsGhi(a); return; }
    const tx = db.transaction(STORE, 'readwrite');
    items.forEach(function (it) { tx.objectStore(STORE).put(it); });
    return txDone(tx);
  }
  async function xoa(ids) {
    const db = await moDb();
    if (!db) { lsGhi(lsDoc().filter(function (x) { return ids.indexOf(x.reqId) < 0; })); return; }
    const tx = db.transaction(STORE, 'readwrite');
    ids.forEach(function (id) { tx.objectStore(STORE).delete(id); });
    return txDone(tx);
  }
  async function co(reqId) {
    const db = await moDb();
    if (!db) return lsDoc().some(function (x) { return x.reqId === reqId; });
    return new Promise(function (ok) {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getKey(reqId);
      rq.onsuccess = function () { ok(rq.result !== undefined); };
      rq.onerror = function () { ok(false); };
    });
  }

  function baoDem() { try { onCount(demApp + demWeb); } catch (e) {} }
  async function demLai() {
    const ds = await tatCa();
    demWeb = ds.filter(function (x) { return !x._loi; }).length;
    if (coApp()) { try { demApp = Number(window.AndroidQueue.count()) || 0; } catch (e) {} }
    baoDem();
    return ds;
  }

  function sach(it) { const o = Object.assign({}, it); delete o._t; delete o._loi; delete o._lan; return o; }

  async function post(body, msTimeout) {
    const ctl = window.AbortController ? new AbortController() : null;
    const t = ctl ? setTimeout(function () { ctl.abort(); }, msTimeout || 90000) : 0;
    try {
      const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined });
      const txt = await res.text();
      try { return JSON.parse(txt); } catch (e) { return null; }   // trang lỗi của Google (bận) → coi như lỗi tạm
    } catch (e) {
      return null;   // mất mạng / hết giờ chờ
    } finally { clearTimeout(t); }
  }

  async function dayXuongCuoi(items) {
    const now = Date.now();
    items.forEach(function (it, i) { it._t = now + i; it._lan = (it._lan || 0) + 1; });
    try { await luu(items); } catch (e) {}
  }
  async function tuChoi(it, msg) {
    it._loi = msg || 'Máy chủ từ chối';
    try { await luu([it]); } catch (e) {}
    try { onSent(it.reqId, 'err', it._loi, it); } catch (e) {}
  }

  async function guiMot(it) {
    const j = await post(sach(it));
    if (!j) { await dayXuongCuoi([it]); return false; }
    if (j.status === 'ok' || j.status === 'duplicate') {
      await xoa([it.reqId]);
      try { onSent(it.reqId, 'ok', j.phien || '', it); } catch (e) {}
      return true;
    }
    if (j.khongThuLai) { await tuChoi(it, j.message); return true; }
    await dayXuongCuoi([it]);
    return false;
  }

  async function guiLo(lo) {
    const j = await post({ action: 'addScanBatch', items: lo.map(sach) });
    if (!j) { await dayXuongCuoi(lo); return false; }
    if (j.status !== 'ok') {
      if (String(j.message || '').indexOf('Unknown action') >= 0) {   // máy chủ bản cũ → gửi từng mã
        for (let i = 0; i < lo.length; i++) if (!(await guiMot(lo[i]))) return false;
        return true;
      }
      await dayXuongCuoi(lo);
      return false;
    }
    const kq = {};
    (j.results || []).forEach(function (r) { kq[r.reqId] = r; });
    const xong = [], lai = [];
    let tatCaOk = true;
    for (let i = 0; i < lo.length; i++) {
      const it = lo[i], r = kq[it.reqId];
      if (r && r.status === 'ok') { xong.push(it); }
      else if (r && r.khongThuLai) { await tuChoi(it, r.message); }
      else { tatCaOk = false; lai.push(it); }
    }
    if (xong.length) await xoa(xong.map(function (x) { return x.reqId; }));
    xong.forEach(function (it) { try { onSent(it.reqId, 'ok', (kq[it.reqId] || {}).phien || '', it); } catch (e) {} });
    if (lai.length) await dayXuongCuoi(lai);
    return tatCaOk;
  }

  async function gui() {
    if (dangGui || !url) return;
    dangGui = true;
    clearTimeout(hen); hen = null;
    let daGui = false;
    try {
      // App có hàng đợi riêng → chuyển hết đơn còn trong trình duyệt sang app
      if (coApp()) {
        const ds = (await tatCa()).filter(function (x) { return !x._loi; });
        for (let i = 0; i < ds.length; i++) {
          let r = '';
          try { r = window.AndroidQueue.enqueue(JSON.stringify(sach(ds[i]))); } catch (e) { r = 'error'; }
          if (r === 'ok') await xoa([ds[i].reqId]); else break;
        }
        if (!(await tatCa()).some(function (x) { return !x._loi; })) return;
      }
      for (let vong = 0; vong < 1000; vong++) {
        if (coApp()) { hen = setTimeout(gui, 0); return; }   // app vừa sẵn sàng → giao cho app
        const ds = (await tatCa()).filter(function (x) { return !x._loi; });
        if (!ds.length) break;
        const ok = ds[0].action === 'addScan'
          ? await guiLo(ds.filter(function (x) { return x.action === 'addScan'; }).slice(0, LO))
          : await guiMot(ds[0]);
        await demLai();
        if (!ok) {
          loi++;
          hen = setTimeout(gui, NGHI_GIAY[Math.min(loi, NGHI_GIAY.length) - 1] * 1000);
          return;
        }
        loi = 0;
        daGui = true;
      }
    } catch (e) {
      hen = setTimeout(gui, 10000);
    } finally {
      dangGui = false;
      demLai();
    }
    if (daGui) kick();
  }

  function kick() {
    const now = Date.now();
    if (now - lanKick < 20000) return;
    lanKick = now;
    post({ action: 'xuLy' }, 360000);   // không chờ kết quả
  }

  // ── Giao tiếp với app ──
  const cuSent = window.onNativeSent;
  window.onNativeSent = function (reqId, st, info) {
    try { onSent(reqId, st, info, null); } catch (e) {}
    if (cuSent) try { cuSent(reqId, st, info); } catch (e) {}
  };
  window.onNativeQueueCount = function (n) { demApp = Number(n) || 0; baoDem(); };

  window.HangDoi = {
    /** opts: {url, onSent(reqId, 'ok'|'err', phienHoacLyDo, item), onCount(soDonCho)} */
    init: function (opts) {
      url = opts.url; onSent = opts.onSent || onSent; onCount = opts.onCount || onCount;
      window.addEventListener('online', gui);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) gui(); });
      setInterval(function () { if (!hen) gui(); }, 60000);
      demLai().then(gui);
    },
    /** Thêm đơn (payload phải có action + reqId). Trả 'app' | 'web'. Lỗi chỉ khi không lưu được ở đâu cả. */
    them: async function (payload) {
      if (!payload.reqId) payload.reqId = 'w:' + Date.now() + ':' + Math.random().toString(36).slice(2, 10);
      if (coApp()) {
        let r = '';
        try { r = window.AndroidQueue.enqueue(JSON.stringify(payload)); } catch (e) { r = 'error: ' + e; }
        if (r === 'ok') { try { demApp = Number(window.AndroidQueue.count()) || demApp; } catch (e) {} baoDem(); return 'app'; }
      }
      if (await co(payload.reqId)) return 'web';
      await luu([Object.assign({}, payload, { _t: Date.now() })]);
      await demLai();
      gui();
      return 'web';
    },
    coApp: coApp,
    gui: gui,
    /** Đơn bị máy chủ từ chối hẳn (để hiển thị) */
    loi: async function () { return (await tatCa()).filter(function (x) { return x._loi; }); },
    _tatCa: tatCa
  };
})();
