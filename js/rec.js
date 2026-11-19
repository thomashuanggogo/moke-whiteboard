/* ============================================================
 * T 探索版（explore/record-mp4 分支限定）：邊寫邊錄影（T2 現行模型）
 * ------------------------------------------------------------
 * 現行模型（T2，南勛 2026-11-20 拍板）：
 * - 課檔不保留聲音——課檔就是純筆跡時間軸；除非主動按「錄影」，否則沒有
 *   聲音。聲音只存在於主動錄製的影片裡。
 * - 按下錄影＝只開一個影片 recorder：畫布 captureStream＋麥克風合錄成一支
 *   連續影片（翻頁不中斷、聲音連續一整條），按停即完成、出現下載入口。
 * - 暫停只作用在影片 recorder 本身；影片與時間軸時鐘脫鉤，不依賴頁鐘守衛。
 * 歷史（T1／T1.1，已退役，僅供考古）：
 * - T1：錄音與筆跡共用頁面 LessonClock，聲音存每頁 _trec、同步重播、匯出影片。
 * - T1.1：錄音改 session／段落兩層可跨頁；特許暫停（MR 與頁鐘一起凍結、擋筆）。
 * - T2 起上述聲音段錄製與同步播放退役：段落函式群保留為未觸發死碼（見第 1 節
 *   「T1.1 退役死碼」），同步重播的輪詢還在跑，但 _trec 永遠不再被寫入而靜默；
 *   匯出影片（第 3 節）保留，其混音來源 pageRec() 同理永遠為 null、只出畫面。
 * - app.js／board.js 的 isRecording() 守衛（抑制錄製中自動停時鐘）原地保留、
 *   不拆不改：對一般編輯無害，T2 session 亦不依賴它們。
 * 已知缺口（探索版接受）：影片 blob 只留記憶體（lastVid），不寫進課程檔；
 *   存檔、匯出課程檔、重整後皆不保留——與「課檔不留聲音」的模型一致。
 * ============================================================ */
(function () {
  'use strict';
  const board = window._mokeBoard;
  if (!board) return;
  const $ = id => document.getElementById(id);
  const toast = (m, ms) => { if (window._mokeToast) window._mokeToast(m, ms || 2600); };
  const T = s => (typeof window.t === 'function' ? window.t(s) : s);

  const btnRec = $('btn-rec');
  const btnPause = $('btn-rec-pause');
  const btnExport = $('btn-rec-export');
  const btnVideo = $('btn-rec-video');

  // 錄音中按鈕呼吸燈（探索版自帶最小樣式，不動 style.css）
  try {
    const st = document.createElement('style');
    st.textContent = '#btn-rec.rec-on{background:#e03131;color:#fff;border-color:#e03131;animation:mokeRecPulse 1.2s ease-in-out infinite}' +
      '#btn-rec.rec-paused{animation:none;background:#f08c00;border-color:#f08c00}' +
      '#btn-rec-video{text-decoration:none;background:#1971c2;color:#fff;border:1px solid #1971c2;border-radius:10px;padding:8px 12px;font-size:15px;cursor:pointer;white-space:nowrap}' +
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

  /* ---------------- 1. 錄影（T2：session = 一支連續影片） ----------------
   * session（cur）：一次「按錄影→按停止」的整體，只持有一個影片 recorder。
   * 課檔不保留聲音（南勛 2026-11-20 拍板）：聲音只活在主動錄製的影片裡，
   * 故 T2 不再跑每頁聲音段、不寫任何 _trec；T1.1 的段落函式群保留為未觸發的
   * 死碼（見下方「T1.1 退役死碼」段），同步重播因其資料來源不再產生而自然靜默。
   * 暫停只作用在影片 recorder 本身——影片是即時擷取畫布，與時間軸時鐘脫鉤，
   * 不需要頁鐘配合、也不需要擋筆（暫停中寫的字會在繼續錄影後出現在畫面裡，
   * 那正是即時擷取的語意）。app.js／board.js 的 isRecording() 守衛原地保留、
   * 不拆不改，T2 session 不依賴它們成立。 */
  let cur = null; // { stream, vid, paused }
                  // vid = { mr, chunks, mime, cv, raf }（T2 連續影片）

  /* ---------------- T2：邊寫邊錄影（連續影片，不分段） ----------------
   * board 是單一 canvas（底圖/筆跡/覆蓋全畫在同一塊上），但其 backing store 是
   * 裝置像素解析度（cssW×dpr），直接 capture 檔案會過大；故一律經離屏 canvas：
   * 以畫布「邏輯尺寸」（CSS px、偶數化）建立離屏 canvas，錄影期間 rAF 逐幀把
   * board.canvas 等比疊繪上去，再對離屏 canvas captureStream(30)。
   * 音軌直接取 mic stream 的 audio tracks，合錄成同一支影片。 */
  let lastVid = null; // { blob, url, mime, at } 上一場完成的影片（只留記憶體）

  function startVideo(stream) {
    try {
      if (!board.canvas || typeof board.canvas.getBoundingClientRect !== 'function') return null;
      const probe = document.createElement('canvas');
      if (typeof probe.captureStream !== 'function') return null;
      const mime = pickVideoMime();
      if (!mime) return null;
      const rect = board.canvas.getBoundingClientRect();
      let w = Math.max(2, Math.round(rect.width)), h = Math.max(2, Math.round(rect.height));
      w -= w % 2; h -= h % 2;   // AVC 要求偶數邊長
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      const v = { chunks: [], mime, cv, raf: 0, mr: null };
      const draw = () => {
        try {
          cx.fillStyle = '#ffffff';
          cx.fillRect(0, 0, w, h);
          cx.drawImage(board.canvas, 0, 0, w, h);
        } catch (e) {}
        v.raf = requestAnimationFrame(draw);
      };
      draw();
      const tracks = [];
      try { for (const t of cv.captureStream(30).getVideoTracks()) tracks.push(t); } catch (e) {}
      try { for (const t of stream.getAudioTracks()) tracks.push(t); } catch (e) {}
      if (!tracks.length) { cancelAnimationFrame(v.raf); return null; }
      let mr;
      try {
        mr = new MediaRecorder(new MediaStream(tracks),
          { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
      } catch (e) { cancelAnimationFrame(v.raf); return null; }
      v.mr = mr;
      mr.ondataavailable = e => { if (e.data && e.data.size) v.chunks.push(e.data); };
      mr.onstop = () => finalizeVideo(v);
      try { mr.start(250); } catch (e) { cancelAnimationFrame(v.raf); return null; }
      return v;
    } catch (e) { return null; }
  }

  function stopVideo() {
    if (!cur || !cur.vid) return;
    const v = cur.vid;
    if (v.raf) { cancelAnimationFrame(v.raf); v.raf = 0; }
    if (v.mr && v.mr.state !== 'inactive') { try { v.mr.stop(); } catch (e) { finalizeVideo(v); } }
  }

  function finalizeVideo(v) {
    const blob = new Blob(v.chunks, { type: (v.mime || 'video/webm').split(';')[0] });
    if (!blob.size) return;
    if (lastVid && lastVid.url) { try { URL.revokeObjectURL(lastVid.url); } catch (e) {} }
    lastVid = { blob, url: URL.createObjectURL(blob), mime: blob.type, at: Date.now() };
    showVideoDownload();
  }

  function videoFileName(mime) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return '墨課錄影_' + stamp + '.' + (mime && mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm');
  }

  function showVideoDownload() {
    if (!btnVideo || !lastVid) return;
    btnVideo.href = lastVid.url;
    btnVideo.setAttribute('download', videoFileName(lastVid.mime));
    btnVideo.innerHTML = '🎥 <span class="btn-label">' + T('下載影片') + '（' +
      Math.max(1, Math.round(lastVid.blob.size / 1024)) + ' KB）</span>';
    btnVideo.classList.remove('hidden');
  }

  function clearVideoDownload() {
    if (lastVid && lastVid.url) { try { URL.revokeObjectURL(lastVid.url); } catch (e) {} }
    lastVid = null;
    if (btnVideo) { btnVideo.classList.add('hidden'); btnVideo.removeAttribute('href'); }
  }

  function setRecBtn() {
    if (btnRec) {
      const on = !!cur;
      btnRec.innerHTML = on
        ? '⏹ <span class="btn-label">' + T('停止') + '</span>'
        : '🔴 <span class="btn-label">' + T('錄影') + '</span>';
      btnRec.classList.toggle('rec-on', on);
      btnRec.classList.toggle('rec-paused', !!(cur && cur.paused));
    }
    if (btnPause) {
      btnPause.classList.toggle('hidden', !cur);
      const p = !!(cur && cur.paused);
      btnPause.innerHTML = p
        ? '▶ <span class="btn-label">' + T('繼續') + '</span>'
        : '⏸ <span class="btn-label">' + T('暫停') + '</span>';
    }
  }

  /* ===== T1.1 退役死碼（T2 起未被呼叫，保留僅供考古） =====
   * 以下 ensureClock／openSegment／storeSegment／onSegmentStop／beginSwitch／
   * watchPage 是 T1.1「每頁聲音段」時代的函式群：新模型沒有任何路徑呼叫
   * openSegment，故永遠不會寫入 _trec；watchPage 的輪詢雖仍在跑，但新 session
   * 的 cur 沒有 seg 欄位，第一道守衛即返回，完全不觸發。 */
  // 對齊關鍵：確保該頁有 tl 與正在走的時鐘，回傳目前時鐘讀數（段落的 offsetTl）
  function ensureClock(pg) {
    if (!pg.tl) pg.tl = { events: [], stops: [], clock: null, unadded: [], erased: [] };
    try {
      if (!pg.tl.clock) { pg.tl.clock = new LessonClock(); pg.tl.clock.start(); }
      else if (!pg.tl.clock.running) pg.tl.clock.resume();
    } catch (e) {}
    return pg.tl.clock ? Math.round(pg.tl.clock.now()) : 0;
  }

  function openSegment(pg) {
    const s = { chunks: [], page: pg, offsetTl: ensureClock(pg), mr: null };
    let mr;
    try {
      mr = cur.mime ? new MediaRecorder(cur.stream, { mimeType: cur.mime }) : new MediaRecorder(cur.stream);
    } catch (e) { return false; }
    s.mr = mr;
    mr.ondataavailable = e => { if (e.data && e.data.size) s.chunks.push(e.data); };
    mr.onstop = () => onSegmentStop(s);
    cur.seg = s;
    try { mr.start(250); } catch (e) { cur.seg = null; return false; }
    return true;
  }

  function storeSegment(s) {
    const blob = new Blob(s.chunks, { type: cur.mime || 'audio/webm' });
    if (!blob.size) return false;   // 空段不寫 _trec（連翻途中頁不留空段／壞狀態）
    const old = s.page._trec;
    if (old && old.url) { try { URL.revokeObjectURL(old.url); } catch (e) {} }
    s.page._trec = {
      blob, url: URL.createObjectURL(blob),
      offsetTl: s.offsetTl, mime: blob.type, at: Date.now()
    };
    if (pbSrcFor === s.page) pbSrcFor = null; // 強制同步播放器換新來源
    return true;
  }

  function onSegmentStop(s) {
    if (!cur || cur.seg !== s) return;   // 過期回呼（段落已被取代）忽略
    storeSegment(s);
    cur.seg = null;
    if (cur.stopReq) { endSession(true); return; }
    cur.switching = false;
    if (cur.paused) return;   // 暫停中翻頁：舊段結算到暫停點為止，新段等「繼續」再開
    if (!openSegment(board.page)) { endSession(false); toast(T('錄音中斷：無法在新頁繼續錄音'), 3000); return; }
    if (cur.wantPause) { cur.wantPause = false; pauseRec(); }   // 切段途中排隊的暫停，落到新段上
  }

  function beginSwitch() {
    if (!cur || cur.switching || !cur.seg) return;
    cur.switching = true;
    const s = cur.seg;
    if (s.mr.state !== 'inactive') {
      try { s.mr.stop(); } catch (e) { onSegmentStop(s); }
    } else onSegmentStop(s);
  }

  // 翻頁偵測：120ms 輪詢目前頁物件（為何不用匯流點通知，見檔頭 T1.1 註記）。
  // 以輪詢當下所在頁為準——連翻多頁時途中頁不會被開段，自然不留空 _trec。
  function watchPage() {
    if (!cur || cur.switching || cur.stopReq || !cur.seg) return;
    const pg = board.page;
    if (pg && pg !== cur.seg.page) beginSwitch();
  }
  setInterval(() => { if (cur) watchPage(); }, 120);
  /* ===== T1.1 退役死碼結束 ===== */

  function endSession(completed) {
    stopVideo();   // 先停影片 MR（趁 mic tracks 還活著讓它把尾段 flush 完），onstop 非同步組裝 blob 並亮出下載入口
    const done = cur; cur = null;
    if (done) { try { done.stream.getTracks().forEach(t => t.stop()); } catch (e) {} }
    setRecBtn();
    if (completed) toast(T('⏹ 錄影完成：點上方「下載影片」把這支影片存下來'), 2800);
  }

  async function startRec() {
    if (cur) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast(T('此瀏覽器不支援錄影（需要麥克風授權與 MediaRecorder）'), 3400);
      return;
    }
    if (!board.page) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast(T('麥克風無法使用（被拒絕或沒有裝置）'), 3400);
      return;
    }
    // T2：session 只開影片 recorder（畫布＋麥克風合錄）；開不起來整場不成立——
    // 沒有「只錄聲音」的降級路徑，因為聲音段模型已退役、課檔不留聲音。
    clearVideoDownload();   // 上一支影片的下載入口存活到新 session 開始為止
    cur = { stream, vid: null, paused: false };
    cur.vid = startVideo(stream);
    if (!cur.vid) {
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      cur = null;
      toast(T('此瀏覽器不支援錄影'), 3400);
      return;
    }
    setRecBtn();
    toast(T('🔴 錄影中：畫布和聲音一起錄，翻頁照樣連續'), 2200);
  }

  function stopRec() {
    if (!cur) return;
    endSession(true);
  }

  /* ----- 暫停／繼續（T2：只作用在影片 recorder 本身） -----
   * 影片是即時擷取畫布，與時間軸時鐘脫鉤：暫停＝只 pause 影片 MR，
   * 不碰頁鐘、不擋筆。feature-detect：MR 不支援 pause 就明說並維持錄影，
   * 絕不假裝——session 裡只有這一個 recorder，不存在半套狀態。 */
  function pauseRec() {
    if (!cur || cur.paused) return;
    const v = cur.vid;
    if (!v || !v.mr || typeof v.mr.pause !== 'function') { toast(T('此瀏覽器錄影中不支援暫停'), 2600); return; }
    try { v.mr.pause(); } catch (e) { toast(T('此瀏覽器錄影中不支援暫停'), 2600); return; }
    if (v.mr.state !== 'paused') { toast(T('此瀏覽器錄影中不支援暫停'), 2600); return; }
    cur.paused = true;
    setRecBtn();
    toast(T('⏸ 已暫停錄影'), 2000);
  }

  function resumeRec() {
    if (!cur || !cur.paused) { setRecBtn(); return; }
    const v = cur.vid;
    if (v && v.mr.state === 'paused') { try { v.mr.resume(); } catch (e) {} }
    cur.paused = false;
    setRecBtn();
  }

  if (btnRec) btnRec.onclick = () => { if (cur) stopRec(); else startRec(); };
  if (btnPause) btnPause.onclick = () => {
    if (!cur) return;
    if (cur.paused) resumeRec(); else pauseRec();
  };

  /* （T1.1 的「暫停期間擋筆」攔截器已隨聲音段模型一併退役移除：新模型暫停
     只凍結影片擷取，筆跡照常記錄在時間軸上，沒有時間戳對齊問題需要擋。） */

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
    if (cur) { toast(T('請先停止錄影再匯出影片'), 2600); return; }
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
        version: 'T2',
        recording: !!cur,
        paused: !!(cur && cur.paused),
        vidState: cur && cur.vid ? cur.vid.mr.state : null,
        vidMime: cur && cur.vid ? cur.vid.mime : null,
        hasVideo: !!lastVid,
        videoSize: lastVid ? lastVid.blob.size : 0,
        videoMime: lastVid ? lastVid.mime : null,
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
