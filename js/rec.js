/* ============================================================
 * T1 探索版（explore/record-mp4 分支限定）：Doceri 式錄音＋筆跡同步＋匯出影片
 * ------------------------------------------------------------
 * 設計：
 * - 錄音與筆跡共用「目前頁的 LessonClock」：錄音開始時記下時鐘讀數 offsetTl，
 *   音訊時間 a（秒）⇔ 時間軸時間 offsetTl + a*1000（ms）。
 * - 錄音期間所有「停時鐘」入口都被抑制（app.js 5 秒閒置暫停＋board.js 提筆/旋轉/
 *   雙指手勢後的暫停，皆以 window.MokeRec.isRecording() 守衛）：墨課的頁面時鐘
 *   本是「動作時間」（提筆就停、base 吸附最後一筆），錄音中改走牆鐘時間，
 *   筆跡 tlT 才跟牆鐘錄音對得齊。這是本探索最關鍵的發現。
 * - 同步重播：不改 TLC，只輪詢 board.tlCutoff（TLC 播放時逐幀寫入的欄位），
 *   依 playhead 前進速率驅動一個 Audio 元素（播放/暫停/跳轉/變速都跟）。
 * - 匯出影片：自備 rAF 驅動器重播目前頁（寫 board.tlCutoff＋render），
 *   canvas.captureStream(30)＋WebAudio 混入錄音 → MediaRecorder → 下載。
 * 已知缺口（探索版接受）：
 * - 音訊只掛在頁面物件的執行期欄位 pg._trec，不寫進課程 JSON/IndexedDB，
 *   存檔、匯出課程檔、換頁重整後錄音都不保留。
 * - 錄音中換頁：聲音續錄、仍歸給開始錄的那一頁（該頁筆跡才對齊）。
 * - 錄音中若「清除本頁/復原」造成時間軸漣波搬移（tlT 被平移），已錄音訊不會跟著搬，對齊會跑掉。
 * 改基註記（v205→v207）：v206 新增的選取手勢結束暫停點（board.js _selGestureEnd）
 * 已補上 isRecording() 守衛；pageEdge 改依 v206 起的結束戳語意（頁尾＝最大 tlT）。
 * ============================================================ */
(function () {
  'use strict';
  const board = window._mokeBoard;
  if (!board) return;
  const $ = id => document.getElementById(id);
  const toast = (m, ms) => { if (window._mokeToast) window._mokeToast(m, ms || 2600); };
  const T = s => (typeof window.t === 'function' ? window.t(s) : s);

  const btnRec = $('btn-rec');
  const btnExport = $('btn-rec-export');

  // 錄音中按鈕呼吸燈（探索版自帶最小樣式，不動 style.css）
  try {
    const st = document.createElement('style');
    st.textContent = '#btn-rec.rec-on{background:#e03131;color:#fff;border-color:#e03131;animation:mokeRecPulse 1.2s ease-in-out infinite}' +
      '@keyframes mokeRecPulse{0%,100%{opacity:1}50%{opacity:.5}}';
    document.head.appendChild(st);
  } catch (e) {}

  function pageRec(pg) { return (pg && pg._trec) || null; }

  function pickMime(cands) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
    return '';
  }
  const pickAudioMime = () => pickMime(['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']);
  const pickVideoMime = () => pickMime(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);

  /* ---------------- 1. 錄音 ---------------- */
  let cur = null; // { mr, stream, chunks, page, offsetTl, mime }

  function setRecBtn() {
    if (!btnRec) return;
    const on = !!cur;
    btnRec.innerHTML = on
      ? '⏹ <span class="btn-label">' + T('停止') + '</span>'
      : '🔴 <span class="btn-label">' + T('錄音') + '</span>';
    btnRec.classList.toggle('rec-on', on);
  }

  async function startRec() {
    if (cur) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast(T('此瀏覽器不支援錄音（需要麥克風授權與 MediaRecorder）'), 3400);
      return;
    }
    const pg = board.page;
    if (!pg) return;
    if (!pg.tl) pg.tl = { events: [], stops: [], clock: null, unadded: [], erased: [] };
    // 對齊關鍵：確保本頁時鐘存在且在走，記下錄音起點的 tl 讀數
    try {
      if (!pg.tl.clock) { pg.tl.clock = new LessonClock(); pg.tl.clock.start(); }
      else if (!pg.tl.clock.running) pg.tl.clock.resume();
    } catch (e) {}
    const offsetTl = pg.tl.clock ? Math.round(pg.tl.clock.now()) : 0;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast(T('麥克風無法使用（被拒絕或沒有裝置）'), 3400);
      return;
    }
    const mime = pickAudioMime();
    let mr;
    try {
      mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      try { stream.getTracks().forEach(t => t.stop()); } catch (e2) {}
      toast(T('此瀏覽器不支援錄音'), 3400);
      return;
    }
    cur = { mr, stream, chunks: [], page: pg, offsetTl, mime: mr.mimeType || mime || '' };
    mr.ondataavailable = e => { if (cur && e.data && e.data.size) cur.chunks.push(e.data); };
    mr.onstop = finishRec;
    try { mr.start(250); } catch (e) { cur = null; toast(T('錄音啟動失敗'), 3000); return; }
    setRecBtn();
    toast(T('🔴 錄音中：聲音會跟這一頁的筆跡同步'), 2200);
  }

  function finishRec() {
    if (!cur) return;
    const done = cur; cur = null;
    try { done.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    setRecBtn();
    const blob = new Blob(done.chunks, { type: done.mime || 'audio/webm' });
    if (!blob.size) { toast(T('錄音失敗：沒有收到聲音資料'), 3000); return; }
    const old = done.page._trec;
    if (old && old.url) { try { URL.revokeObjectURL(old.url); } catch (e) {} }
    done.page._trec = {
      blob, url: URL.createObjectURL(blob),
      offsetTl: done.offsetTl, mime: blob.type, at: Date.now()
    };
    if (pbSrcFor === done.page) pbSrcFor = null; // 強制同步播放器換新來源
    toast(T('⏹ 錄音完成：播放這一頁的時間軸就會同步播聲音'), 2800);
  }

  function stopRec() {
    if (cur && cur.mr.state !== 'inactive') {
      try { cur.mr.stop(); } catch (e) { finishRec(); }
    }
  }

  if (btnRec) btnRec.onclick = () => { if (cur) stopRec(); else startRec(); };

  /* ---------------- 2. 同步重播（輪詢 board.tlCutoff） ---------------- */
  const pbAudio = new Audio();
  pbAudio.preload = 'auto';
  let pbSrcFor = null;   // pbAudio.src 目前對應的頁面物件
  let lastCut = null, lastWall = 0, stillCount = 0;
  let exporting = false;
  let pbErr = null;      // 最後一次 play() 被拒絕的錯誤名（自動播放政策診斷用）
  let expStage = null;   // 匯出階段標記（卡住時定位用）
  pbAudio.addEventListener('playing', () => { pbErr = null; });

  function poll() {
    if (exporting) return;
    const pg = board.page;
    const rec = pageRec(pg);
    const cut = board.tlCutoff;
    if (!rec || cut === null || cut === undefined) {
      if (!pbAudio.paused) pbAudio.pause();
      lastCut = null; stillCount = 0;
      return;
    }
    if (pbSrcFor !== pg) { pbSrcFor = pg; try { pbAudio.src = rec.url; } catch (e) {} }
    const target = (cut - rec.offsetTl) / 1000;   // 目前 playhead 對應的音訊秒數
    const now = performance.now();
    if (lastCut === null) { lastCut = cut; lastWall = now; return; }
    const dTl = cut - lastCut, dWall = now - lastWall;
    lastCut = cut; lastWall = now;
    if (target < 0) {
      if (!pbAudio.paused) pbAudio.pause();
      if (pbAudio.currentTime !== 0) { try { pbAudio.currentTime = 0; } catch (e) {} }
      return;
    }
    const dur = pbAudio.duration;
    if (isFinite(dur) && dur > 0 && target >= dur - 0.05) {
      if (!pbAudio.paused) pbAudio.pause();
      return;
    }
    const rateRaw = dWall > 0 ? dTl / dWall : 0;
    if (dTl > 5 && rateRaw <= 4.5) {
      // playhead 正在前進＝播放中
      stillCount = 0;
      const rate = Math.min(4, Math.max(0.25, rateRaw));
      if (pbAudio.paused) {
        try { pbAudio.currentTime = target; } catch (e) {}
        const p = pbAudio.play();
        if (p && p.catch) p.catch(e => { pbErr = (e && e.name) || 'play-rejected'; });
      } else {
        if (Math.abs(pbAudio.currentTime - target) > 0.4) { try { pbAudio.currentTime = target; } catch (e) {} }
        if (Math.abs(pbAudio.playbackRate - rate) > 0.2) { try { pbAudio.playbackRate = rate; } catch (e) {} }
      }
    } else if (dTl !== 0) {
      // 大跳躍＝使用者拖曳/跳段：只把聲音定位過去，不改變播放狀態
      stillCount = 0;
      try { pbAudio.currentTime = target; } catch (e) {}
    } else {
      stillCount++;
      if (stillCount >= 2 && !pbAudio.paused) pbAudio.pause();
    }
  }
  setInterval(poll, 120);

  /* ---------------- 3. 匯出影片（目前頁） ---------------- */
  function pageEdge(pg) {
    let m = 0;
    for (const s of pg.strokes || []) {
      // 改基 v207 相容：v206 起 tlT 統一為「結束戳」（區間 [tlT−dur, tlT]），頁尾＝最大 tlT，不再加 dur
      const e = (s.tlT === undefined ? 0 : s.tlT);
      if (e > m) m = e;
    }
    const tl = pg.tl;
    if (tl && tl.erased) for (const x of tl.erased) { if (x.eraseT > m) m = x.eraseT; }
    return m;
  }

  async function exportVideo() {
    if (exporting) return;
    if (cur) { toast(T('請先停止錄音再匯出影片'), 2600); return; }
    const pg = board.page;
    if (!pg || !(pg.strokes && pg.strokes.length)) { toast(T('這一頁還沒有筆跡，先寫幾個字吧'), 2600); return; }
    if (!window.MediaRecorder || !board.canvas.captureStream) { toast(T('此瀏覽器不支援匯出影片'), 3400); return; }
    const mime = pickVideoMime();
    if (!mime) { toast(T('此瀏覽器不支援匯出影片'), 3400); return; }
    const edge = pageEdge(pg);
    const rec = pageRec(pg);
    const modal = $('modal-lessons');
    if (modal) modal.classList.add('hidden');   // 關掉課程面板，讓使用者看到重播過程
    exporting = true;
    if (btnExport) btnExport.disabled = true;
    if (!pbAudio.paused) pbAudio.pause();
    toast(T('🎬 匯出中：即時重播錄影（長度同本頁時間軸），請勿切換頁面'), 3000);

    const prevCutoff = board.tlCutoff;
    let actx = null, srcNode = null;
    try {
      const tracks = board.canvas.captureStream(30).getVideoTracks().slice();
      if (rec) {
        // 混音準備（resume/decode 在某些環境會卡住或失敗）→ 6 秒逾時就只出畫面，不讓匯出掛死
        expStage = 'audio-prep';
        const prep = (async () => {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          try { await ac.resume(); } catch (e) {}   // 不 resume 的話混音軌沒有樣本，容器會把音軌丟掉
          const raw = await (await fetch(rec.url)).arrayBuffer();
          const audioBuf = await ac.decodeAudioData(raw);
          const dest = ac.createMediaStreamDestination();
          const src = ac.createBufferSource();
          src.buffer = audioBuf;
          src.connect(dest);
          return { ac, src, dest };
        })().catch(() => null);
        const got = await Promise.race([prep, new Promise(res => setTimeout(() => res(null), 6000))]);
        if (got) {
          actx = got.ac; srcNode = got.src;
          for (const t of got.dest.stream.getAudioTracks()) tracks.push(t);
        } else {
          toast(T('⚠️ 錄音混入失敗或逾時，這次只匯出畫面'), 2600);
        }
      }
      expStage = 'record';
      const mr = new MediaRecorder(new MediaStream(tracks),
        { mimeType: mime, videoBitsPerSecond: 5000000, audioBitsPerSecond: 128000 });
      const chunks = [];
      mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(res => { mr.onstop = res; mr.onerror = res; });

      board.tlCutoff = 0;
      board.render();
      mr.start(250);
      // 對齊：影片 t=0 ≒ 重播 tl=0；音訊在 offsetTl 處進場（offsetTl<0 時從音訊中段開始）
      const startWall = performance.now() + 150;
      if (srcNode && actx) {
        try {
          srcNode.start(actx.currentTime + 0.15 + Math.max(0, rec.offsetTl) / 1000,
                        Math.max(0, -rec.offsetTl) / 1000);
        } catch (e) {}
      }
      await new Promise(res => {
        const step = () => {
          const t = performance.now() - startWall;
          if (t >= edge) { board.tlCutoff = edge; board.render(); res(); return; }
          if (t >= 0) { board.tlCutoff = t; board.render(); }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      try { mr.stop(); } catch (e) {}
      await stopped;
      if (srcNode) { try { srcNode.stop(); } catch (e) {} }
      if (actx) { try { actx.close(); } catch (e) {} }

      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      const ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'moke-video-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + ext;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} a.remove(); }, 4000);
      toast(T('🎬 影片已下載') + '（' + ext.toUpperCase() + '，' + Math.round(blob.size / 1024) + ' KB）', 3200);
    } catch (e) {
      toast(T('匯出影片失敗'), 3000);
    } finally {
      expStage = null;
      board.tlCutoff = prevCutoff;
      board.render();
      exporting = false;
      if (btnExport) btnExport.disabled = false;
    }
  }

  if (btnExport) btnExport.onclick = exportVideo;

  /* ---------------- 對外介面（app.js 抑制閒置暫停＋測試鉤子） ---------------- */
  window.MokeRec = {
    isRecording: () => !!cur,
    isExporting: () => exporting,
    _debug: () => {
      const pg = board.page;
      const rec = pageRec(pg);
      return {
        version: 'T1',
        recording: !!cur,
        mrState: cur ? cur.mr.state : null,
        curOffsetTl: cur ? cur.offsetTl : null,
        hasRec: !!rec,
        blobSize: rec ? rec.blob.size : 0,
        recMime: rec ? rec.mime : null,
        offsetTl: rec ? rec.offsetTl : null,
        pbPaused: pbAudio.paused,
        pbTime: pbAudio.currentTime || 0,
        pbRate: pbAudio.playbackRate || 1,
        pbErr,
        expStage,
        exporting
      };
    }
  };
})();
