(() => {
  'use strict';

  // Constants
  const CANVAS_W = 600;
  const CANVAS_H = 400;
  const MIN_FRAMES = 5;
  const MAX_FRAMES = 20;
  const MAX_FILES = 20;
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const SIZE_LIMIT = 300 * 1024; // 300KB

  // Elements
  const dropzone = document.getElementById('dropzone');
  const pickBtn = document.getElementById('pickBtn');
  const fileInput = document.getElementById('fileInput');
  const thumbs = document.getElementById('thumbs');
  const errors = document.getElementById('errors');
  const fpsInfo = document.getElementById('fpsInfo');
  const frameCount = document.getElementById('frameCount');
  const frameCountNum = document.getElementById('frameCountNum');
  const duration = document.getElementById('duration');
  const durationNum = document.getElementById('durationNum');
  const loopsInput = document.getElementById('loops');
  const resetTimesBtn = document.getElementById('resetTimes');
  const previewCanvas = document.getElementById('previewCanvas');
  const previewCtx = previewCanvas.getContext('2d');
  const playBtn = document.getElementById('playBtn');
  const stopBtn = document.getElementById('stopBtn');
  const generateBtn = document.getElementById('generateBtn');
  const sizeInfo = document.getElementById('sizeInfo');
  const warn = document.getElementById('warn');
  const progress = document.getElementById('progress');
  const progressBar = document.getElementById('progressBar');

  // State
  /**
   * @typedef {Object} Frame
   * @property {string} id
   * @property {string} name
   * @property {string} blobUrl
   * @property {string} thumbUrl
   * @property {Uint8Array} rgba // length = w*h*4
   * @property {number} delayMs
   */
  /** @type {Frame[]} */
  let frames = [];
  let useFrameCount = MIN_FRAMES;
  let durationSec = 2.0;
  let loops = 1;
  let aspect = 'crop'; // crop|fit|stretch
  let quality = 'high'; // high|medium|low
  let customTimes = false;
  let isPlaying = false;
  let playTimer = null;
  let playIndex = 0;

  // Utils
  const byId = (id) => document.getElementById(id);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmtKB = (b) => `${(b / 1024).toFixed(1)} KB`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setError(msg) { errors.textContent = msg || ''; }
  function setWarn(msg) { warn.textContent = msg || ''; }
  function showProgress(show) { progress.hidden = !show; if (!show) setProgress(0); }
  function setProgress(pct) { progressBar.style.width = `${clamp(pct, 0, 100)}%`; }

  // Local storage
  const LS_KEY = 'apng:settings';
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.useFrameCount === 'number') useFrameCount = clamp(s.useFrameCount, MIN_FRAMES, MAX_FRAMES);
      if (typeof s.durationSec === 'number') durationSec = clamp(s.durationSec, 1, 4);
      if ([1,2,3,4].includes(s.loops)) loops = s.loops;
      if (['crop','fit','stretch'].includes(s.aspect)) aspect = s.aspect;
      if (['high','medium','low'].includes(s.quality)) quality = s.quality;
    } catch {}
  }
  function saveSettings() {
    const s = { useFrameCount, durationSec, loops, aspect, quality };
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  function syncControls() {
    // Frame count
    frameCount.value = String(useFrameCount);
    frameCountNum.value = String(useFrameCount);
    duration.value = String(durationSec);
    durationNum.value = String(durationSec);
    loopsInput.value = String(loops);
    document.querySelectorAll('input[name="aspect"]').forEach((el) => {
      el.checked = el.value === aspect;
    });
    document.querySelectorAll('input[name="quality"]').forEach((el) => {
      el.checked = el.value === quality;
    });
    updateFpsInfo();
  }

  function updateFpsInfo() {
    const n = effectiveTargetCount();
    const ms = Math.round((durationSec * 1000) / n);
    fpsInfo.textContent = `フレーム時間: ${ms} ms / フレーム`;
    if (!customTimes) {
      // Update existing frames' base delays; duplicates will follow same delay
      getActiveFrames().forEach((f) => (f.delayMs = ms));
      renderThumbs();
    }
  }

  function getActiveFrames() {
    return frames.slice(0, Math.min(frames.length, useFrameCount));
  }

  function effectiveTargetCount() {
    const baseCount = Math.max(1, getActiveFrames().length);
    let selected = clamp(useFrameCount, MIN_FRAMES, MAX_FRAMES);
    // At least MIN_FRAMES via whole-loop repeats
    let m = Math.ceil(selected / baseCount);
    let target = baseCount * m;
    // Ensure not below MIN_FRAMES due to small baseCount
    if (target < MIN_FRAMES) {
      m = Math.ceil(MIN_FRAMES / baseCount);
      target = baseCount * m;
    }
    // Cap to MAX_FRAMES by reducing loops
    if (target > MAX_FRAMES) {
      const fm = Math.floor(MAX_FRAMES / baseCount);
      target = fm > 0 ? baseCount * fm : MAX_FRAMES;
    }
    target = clamp(target, MIN_FRAMES, MAX_FRAMES);
    return target;
  }

  function ensureUseCountMultiple() {
    const eff = effectiveTargetCount();
    if (eff !== useFrameCount) {
      useFrameCount = eff;
      syncControls();
    }
  }

  function buildEncodingSequence() {
    const base = getActiveFrames();
    const baseCount = base.length;
    const target = effectiveTargetCount();
    // If there are no images at all, caller should guard.
    const imgs = [];
    const delays = [];
    if (baseCount === 0) return { imgs, delays };
    for (let i = 0; i < target; i++) {
      const b = base[i % baseCount];
      imgs.push(b.rgba);
      delays.push(clamp(b.delayMs | 0, 10, 4000));
    }
    return { imgs, delays };
  }

  // Drag & drop handling
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('hover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('hover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('hover');
    handleFiles(e.dataTransfer?.files);
  });
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  function isSupportedFile(file) {
    const t = (file.type || '').toLowerCase();
    if (t.startsWith('image/')) {
      if (/jpeg|jpg|png|gif|webp/.test(t)) return true;
    }
    // fallback by extension
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return ['jpg','jpeg','png','gif','webp'].includes(ext);
  }

  async function handleFiles(fileList) {
    setError('');
    if (!fileList || fileList.length === 0) return;
    const current = frames.length;
    const incoming = Array.from(fileList);
    const filtered = [];
    for (const f of incoming) {
      if (!isSupportedFile(f)) {
        setError('未対応のファイル形式が含まれています。');
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        setError(`サイズ超過: ${f.name} (${fmtKB(f.size)})`);
        continue;
      }
      filtered.push(f);
    }
    const available = MAX_FILES - current;
    if (filtered.length > available) {
      setError(`追加できるのはあと ${available} 枚までです。`);
    }
    const toAdd = filtered.slice(0, Math.max(0, available));
    if (toAdd.length === 0) return;

    // Resize & ingest
    showProgress(true);
    let i = 0;
    for (const f of toAdd) {
      i++;
      setProgress(Math.round((i / toAdd.length) * 100));
      try {
        const fr = await fileToFrame(f, aspect);
        frames.push(fr);
      } catch (err) {
        console.error(err);
        setError(`読み込み失敗: ${f.name}`);
      }
    }
    showProgress(false);

    // Default delays even
    const n = frames.length;
    // Default to number of images if between 5..20, else the nearest whole-loop count
    if (n >= MIN_FRAMES && n <= MAX_FRAMES) {
      useFrameCount = n;
    } else {
      // choose smallest multiple of n that is within 5..20 (fallback to MIN_FRAMES)
      const base = Math.max(1, n);
      let m = Math.ceil(MIN_FRAMES / base);
      let t = base * m;
      if (t > MAX_FRAMES) {
        const fm = Math.floor(MAX_FRAMES / base);
        t = fm > 0 ? base * fm : MIN_FRAMES;
      }
      useFrameCount = clamp(t, MIN_FRAMES, MAX_FRAMES);
    }
    customTimes = false;
    updateFpsInfo();
    saveSettings();
    renderThumbs();
    renderPreviewStatic();
  }

  async function fileToFrame(file, aspectMode) {
    const bmp = await loadImage(file);
    const rgba = await rasterizeToRGBA(bmp, aspectMode);
    const thumbUrl = rgbaToDataURL(rgba, CANVAS_W, CANVAS_H, 0.6);
    return {
      id: uid(),
      name: file.name,
      file, // keep original for reprocessing
      thumbUrl,
      rgba,
      delayMs: Math.round((durationSec * 1000) / clamp(frames.length || 1, MIN_FRAMES, MAX_FRAMES)),
    };
  }

  function loadImage(src) {
    // Accept Blob/File or URL string
    if (src instanceof Blob) {
      if (window.createImageBitmap) {
        return createImageBitmap(src);
      }
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(src);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
      });
    } else {
      if (window.createImageBitmap) {
        return fetch(src).then((r) => r.blob()).then((b) => createImageBitmap(b));
      }
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }
  }

  async function rasterizeToRGBA(imageBitmap, aspectMode) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // default transparent background
    // Compute draw dimensions
    const srcW = imageBitmap.width;
    const srcH = imageBitmap.height;
    let dx = 0, dy = 0, dw = CANVAS_W, dh = CANVAS_H;
    if (aspectMode === 'stretch') {
      // dw, dh already set
    } else if (aspectMode === 'fit') {
      const scale = Math.min(CANVAS_W / srcW, CANVAS_H / srcH);
      dw = Math.round(srcW * scale);
      dh = Math.round(srcH * scale);
      dx = Math.floor((CANVAS_W - dw) / 2);
      dy = Math.floor((CANVAS_H - dh) / 2);
    } else { // crop
      const scale = Math.max(CANVAS_W / srcW, CANVAS_H / srcH);
      dw = Math.round(srcW * scale);
      dh = Math.round(srcH * scale);
      dx = Math.floor((CANVAS_W - dw) / 2);
      dy = Math.floor((CANVAS_H - dh) / 2);
    }

    // Draw
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imageBitmap, dx, dy, dw, dh);
    const imgData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    return new Uint8Array(imgData.data);
  }

  function rgbaToDataURL(rgba, w, h, quality = 0.8) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(rgba), w, h);
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png', quality);
  }

  // Thumbnails rendering & reorder
  function renderThumbs() {
    thumbs.innerHTML = '';
    const activeIds = new Set(getActiveFrames().map((f) => f.id));
    frames.forEach((f, idx) => {
      const card = document.createElement('div');
      card.className = 'thumb';
      card.draggable = true;
      card.dataset.id = f.id;
      card.innerHTML = `
        <div class="img"><img src="${f.thumbUrl}" alt="frame ${idx+1}" /></div>
        <div class="meta">
          <div class="row">
            <span class="badge">${idx+1}${activeIds.has(f.id) ? ' / 使用中' : ''}</span>
            <div class="controls">
              <button class="small-btn" data-act="left">←</button>
              <button class="small-btn" data-act="right">→</button>
              <button class="small-btn" data-act="del">削除</button>
            </div>
          </div>
          <div class="row">
            <label>時間(ms)</label>
            <input type="number" class="delay" min="10" max="4000" step="10" value="${f.delayMs}" />
          </div>
        </div>
      `;
      // drag events
      card.addEventListener('dragstart', (e) => {
        card.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', f.id);
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (e) => e.preventDefault());
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        const srcId = e.dataTransfer?.getData('text/plain');
        const dstId = f.id;
        if (!srcId || !dstId || srcId === dstId) return;
        const si = frames.findIndex((x) => x.id === srcId);
        const di = frames.findIndex((x) => x.id === dstId);
        if (si < 0 || di < 0) return;
        const [moved] = frames.splice(si, 1);
        frames.splice(di, 0, moved);
        renderThumbs();
        renderPreviewStatic();
      });
      // buttons
      card.querySelectorAll('button.small-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const act = btn.dataset.act;
          const i = frames.findIndex((x) => x.id === f.id);
          if (act === 'left' && i > 0) {
            const [m] = frames.splice(i, 1);
            frames.splice(i - 1, 0, m);
          } else if (act === 'right' && i < frames.length - 1) {
            const [m] = frames.splice(i, 1);
            frames.splice(i + 1, 0, m);
          } else if (act === 'del') {
            frames.splice(i, 1);
            useFrameCount = clamp(useFrameCount, MIN_FRAMES, MAX_FRAMES);
          }
          renderThumbs();
          renderPreviewStatic();
        });
      });
      // delay input
      const delayInput = card.querySelector('input.delay');
      delayInput.addEventListener('change', () => {
        const v = clamp(parseInt(delayInput.value || '0', 10) || 0, 10, 4000);
        f.delayMs = v;
        delayInput.value = String(v);
        customTimes = true;
        renderPreviewStatic();
      });

      thumbs.appendChild(card);
    });

    // sync frameCount bounds to current frames
    // Slider range remains 5..20 regardless of current images; duplicates will pad
    frameCount.max = String(MAX_FRAMES);
    frameCountNum.max = String(MAX_FRAMES);
  }

  function renderPreviewStatic() {
    if (frames.length === 0) {
      previewCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      return;
    }
    const f = frames[0];
    const img = new Image();
    img.onload = () => {
      previewCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      previewCtx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
    };
    img.src = f.thumbUrl;
  }

  // Controls events
  frameCount.addEventListener('input', () => {
    useFrameCount = clamp(parseInt(frameCount.value, 10) || MIN_FRAMES, MIN_FRAMES, MAX_FRAMES);
    ensureUseCountMultiple();
    frameCountNum.value = String(useFrameCount);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
    renderThumbs();
  });
  frameCountNum.addEventListener('change', () => {
    useFrameCount = clamp(parseInt(frameCountNum.value, 10) || MIN_FRAMES, MIN_FRAMES, MAX_FRAMES);
    ensureUseCountMultiple();
    frameCount.value = String(useFrameCount);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
    renderThumbs();
  });

  duration.addEventListener('input', () => {
    durationSec = +duration.value;
    durationNum.value = String(durationSec);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
  });
  durationNum.addEventListener('change', () => {
    durationSec = clamp(parseFloat(durationNum.value) || 1, 1, 4);
    duration.value = String(durationSec);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
  });

  loopsInput.addEventListener('change', () => {
    loops = clamp(parseInt(loopsInput.value, 10) || 1, 1, 4);
    loopsInput.value = String(loops);
    saveSettings();
  });

  document.querySelectorAll('input[name="aspect"]').forEach((el) => {
    el.addEventListener('change', async () => {
      if (!el.checked) return;
      aspect = el.value;
      saveSettings();
      // Rebuild all frames rgba with new aspect
      if (frames.length) {
        showProgress(true);
        let i = 0; const total = frames.length;
        for (const f of frames) {
          i++; setProgress(Math.round((i / total) * 100));
          const bmp = await loadImage(f.file);
          f.rgba = await rasterizeToRGBA(bmp, aspect);
          // refresh thumbnail based on new aspect fit
          f.thumbUrl = rgbaToDataURL(f.rgba, CANVAS_W, CANVAS_H, 0.6);
        }
        showProgress(false);
        renderThumbs();
        renderPreviewStatic();
      }
    });
  });

  document.querySelectorAll('input[name="quality"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      quality = el.value; saveSettings();
    });
  });

  resetTimesBtn.addEventListener('click', (e) => {
    e.preventDefault();
    customTimes = false;
    updateFpsInfo();
  });

  // Preview playback
  playBtn.addEventListener('click', () => startPreview());
  stopBtn.addEventListener('click', () => stopPreview());

  function startPreview() {
    if (isPlaying || frames.length === 0) return;
    isPlaying = true; playIndex = 0;
    const base = getActiveFrames();
    const baseCount = base.length;
    const target = effectiveTargetCount();
    const sequence = [];
    if (baseCount === 0) return;
    for (let i = 0; i < target; i++) sequence.push(base[i % baseCount]);
    const drawNext = () => {
      if (!isPlaying) return;
      const f = sequence[playIndex % sequence.length];
      const img = new Image();
      img.onload = () => {
        previewCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        previewCtx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
      };
      img.src = f.thumbUrl;
      const delay = clamp(f.delayMs | 0, 10, 4000);
      playIndex++;
      playTimer = setTimeout(() => requestAnimationFrame(drawNext), delay);
    };
    drawNext();
  }
  function stopPreview() {
    isPlaying = false; if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  }

  // APNG generation
  generateBtn.addEventListener('click', async () => {
    setWarn(''); sizeInfo.textContent = '';
    const defaultText = generateBtn.textContent;
    generateBtn.textContent = '生成中...';
    generateBtn.disabled = true;
    if (typeof pako === 'undefined') {
      setWarn('pakoの読み込みに失敗しました。vendor/pako.min.js の読み込みを確認してください。');
      generateBtn.textContent = defaultText;
      generateBtn.disabled = false;
      return;
    }
    if (typeof UPNG === 'undefined') {
      setWarn('UPNG.jsの読み込みに失敗しました。vendor/UPNG.js の読み込みを確認してください。');
      generateBtn.textContent = defaultText;
      generateBtn.disabled = false;
      return;
    }
    if (frames.length === 0) {
      setWarn('画像を追加してください。');
      generateBtn.textContent = defaultText;
      generateBtn.disabled = false;
      return;
    }
    const active = getActiveFrames();
    showProgress(true); setProgress(5);
    try {
      const result = await encodeWithBudget();
      setProgress(100);
      showProgress(false);
      if (result && result.ok) {
        const { blob, size } = result;
        sizeInfo.textContent = `出力サイズ: ${fmtKB(size)} (上限 300KB)`;
        // Trigger download immediately
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestFilename();
        document.body.appendChild(a);
        a.click();
        requestAnimationFrame(() => {
          document.body.removeChild(a);
          // release the URL a bit later to allow download to start
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        });
        setWarn('');
      } else if (result && !result.ok) {
        sizeInfo.textContent = `出力サイズ: ${fmtKB(result.size)} > 300KB`;
        setWarn('サイズが300KBを超えています。品質を下げるか、フレーム数/時間を調整してください。');
      } else {
        setWarn('生成に失敗しました。');
      }
    } catch (err) {
      console.error(err);
      showProgress(false);
      setWarn(`生成でエラーが発生しました: ${err?.message || err}`);
    }
    generateBtn.textContent = defaultText;
    generateBtn.disabled = false;
  });

  function suggestFilename() {
    const base = 'animation';
    // Try first frame name stem if available
    const first = frames[0]?.name || base;
    const stem = (first.split('.').slice(0, -1).join('.') || base).slice(0, 50);
    return `${stem}.png`;
  }

  async function encodeWithBudget() {
    // Map quality preference to palette sizes (UPNG cnum)
    const qualityOrder = (() => {
      if (quality === 'high') return [256, 128, 64];
      if (quality === 'medium') return [128, 64];
      return [64];
    })();
    // Build padded sequence to match selected frame count (5..20)
    const { imgs, delays } = buildEncodingSequence();
    if (imgs.length === 0) throw new Error('フレームがありません');
    let attempt = 0;
    for (const cnum of qualityOrder) {
      attempt++;
      setProgress(Math.min(95, 10 + Math.round((attempt / qualityOrder.length) * 80)));
      const apngBuf = UPNG.encode(imgs, CANVAS_W, CANVAS_H, cnum, delays);
      const looped = setApngLoops(apngBuf, loops);
      const blob = new Blob([looped], { type: 'image/png' });
      const size = blob.size;
      if (size <= SIZE_LIMIT) {
        return { ok: true, blob, size };
      }
      // continue to next lower quality
      await sleep(50);
    }
    // final (lowest quality) result for info
    const lastCnum = qualityOrder[qualityOrder.length - 1];
    const apngBuf = UPNG.encode(imgs, CANVAS_W, CANVAS_H, lastCnum, delays);
    const looped = setApngLoops(apngBuf, loops);
    const blob = new Blob([looped], { type: 'image/png' });
    return { ok: false, blob, size: blob.size };
  }

  // PNG chunk helpers: set acTL.num_plays
  function setApngLoops(apngArrayBuffer, numPlays) {
    try {
      const data = new Uint8Array(apngArrayBuffer);
      // PNG signature 8 bytes
      let p = 8;
      while (p + 8 <= data.length) {
        const len = readU32(data, p); p += 4;
        const type = readType(data, p); p += 4;
        if (type === 'acTL') {
          // acTL: num_frames(4) + num_plays(4)
          if (len >= 8 && p + len + 4 <= data.length) {
            const numFrames = readU32(data, p);
            writeU32(data, p + 4, numPlays >>> 0);
            // Recompute CRC over type+data
            const crcStart = p - 4; // type starts 4 bytes before p
            const crcData = data.subarray(crcStart, crcStart + 4 + len);
            const crc = crc32(crcData);
            writeU32(data, p + len, crc);
            return data.buffer;
          } else {
            return data.buffer;
          }
        }
        // skip data + crc
        p += len + 4; // data + CRC
      }
      return data.buffer;
    } catch (e) {
      console.warn('Failed to set loops:', e);
      return apngArrayBuffer;
    }
  }

  function readU32(arr, off) {
    return (arr[off] << 24) | (arr[off + 1] << 16) | (arr[off + 2] << 8) | arr[off + 3];
  }
  function writeU32(arr, off, val) {
    arr[off] = (val >>> 24) & 0xff;
    arr[off + 1] = (val >>> 16) & 0xff;
    arr[off + 2] = (val >>> 8) & 0xff;
    arr[off + 3] = val & 0xff;
  }
  function readType(arr, off) {
    return String.fromCharCode(arr[off], arr[off + 1], arr[off + 2], arr[off + 3]);
  }

  // CRC32 for PNG chunks
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // Init
  function init() {
    loadSettings();
    // defaults
    frameCount.min = String(MIN_FRAMES); frameCount.max = String(MAX_FRAMES);
    frameCountNum.min = String(MIN_FRAMES); frameCountNum.max = String(MAX_FRAMES);
    duration.min = '1'; duration.max = '4';
    durationNum.min = '1'; durationNum.max = '4';
    loopsInput.min = '1'; loopsInput.max = '4';
    syncControls();
  }

  init();
})();
