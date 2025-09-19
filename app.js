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
  const resetFramesBtn = document.getElementById('resetFramesBtn');
  const progress = document.getElementById('progress');
  const progressBar = document.getElementById('progressBar');
  const framesTray = document.querySelector('.frames-tray');
  const templateList = document.getElementById('templateList');
  const templateHint = document.getElementById('templateHint');
  const durationHintEl = document.getElementById('durationHint');
  const compressionSlider = document.getElementById('compressionLevel');
  const compressionHintEl = document.getElementById('compressionHint');

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
  let minPalette = 32; // minimum allowed palette size when compressing further
  let posterizeLimit = 4; // allowed lowest bits per channel (4/5/6) or 'none'
  let customTimes = false;
  let isPlaying = false;
  let playTimer = null;
  let playIndex = 0;
  let selectedTemplateIds = [];
  let templateBaseFrames = null;
  let compressionLevel = 1;
  let estimateTimer = null;
  let estimating = false;
  let estimatePending = false;

  // Utils
  const byId = (id) => document.getElementById(id);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmtKB = (b) => `${(b / 1024).toFixed(1)} KB`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cloneFrame(frame) {
    return {
      id: frame.id,
      name: frame.name,
      file: frame.file || null,
      thumbUrl: frame.thumbUrl,
      rgba: frame.rgba ? new Uint8Array(frame.rgba) : null,
      delayMs: frame.delayMs,
    };
  }

  const TEMPLATE_DEFS = [
    {
      id: 'none',
      name: 'なし',
      description: 'アップロードした写真をそのまま利用します。',
      frameCount: MIN_FRAMES,
    },
    {
      id: 'soft-zoom',
      name: 'ソフトズーム',
      description: 'ゆっくりと拡大するシンプルなズーム演出。',
      frameCount: 12,
      coversBase: true,
      render({ ctx, bitmap, progress, aspect }) {
        const eased = easeInOut(progress);
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        drawImageWithAspect(ctx, bitmap, aspect, {
          scale: 1 + 0.15 * eased,
        });
        ctx.save();
        const fade = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
        fade.addColorStop(0, 'rgba(255, 255, 255, 0.04)');
        fade.addColorStop(1, 'rgba(255, 255, 255, 0.08)');
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.restore();
      },
    },
    {
      id: 'wiggle',
      name: 'ウィグル',
      description: 'ランダムな揺れで躍動感を付けます。',
      frameCount: 12,
      coversBase: true,
      render({ ctx, bitmap, index, count = 12, aspect }) {
        const baseAngle = index * 137.5;
        const amp = 10;
        const offsetX = Math.sin((baseAngle * Math.PI) / 180) * amp;
        const offsetY = Math.cos(((baseAngle + 45) * Math.PI) / 180) * amp;
        const rotation = Math.sin((index / Math.max(1, count)) * Math.PI * 2) * 3;
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        drawImageWithAspect(ctx, bitmap, aspect, {
          scale: 1.01,
          offsetX,
          offsetY,
          rotation,
        });
      },
    },
    {
      id: 'pulse-glow',
      name: 'グローパルス',
      description: '中心から柔らかい光が脈打つアニメーション。',
      frameCount: 8,
      coversBase: false,
      render({ ctx, bitmap, progress }) {
        const wave = Math.sin(progress * Math.PI);
        ctx.save();
        const glow = ctx.createRadialGradient(CANVAS_W / 2, CANVAS_H / 2, CANVAS_W * 0.05, CANVAS_W / 2, CANVAS_H / 2, CANVAS_W * 0.6);
        glow.addColorStop(0, `rgba(255, 255, 255, ${0.55 * wave})`);
        glow.addColorStop(0.7, `rgba(255, 255, 255, ${0.25 * wave})`);
        glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.restore();
      },
    },
    {
      id: 'alert-frame',
      name: 'アラートフレーム',
      description: '赤いフレームが点滅する注意喚起アニメーション。',
      frameCount: 10,
      coversBase: false,
      render({ ctx, bitmap, index = 0, aspect }) {
        const pulse = index % 2 === 0 ? 1 : 0;
        if (pulse > 0) {
          ctx.save();
          ctx.lineWidth = 14;
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
          ctx.strokeRect(7, 7, CANVAS_W - 14, CANVAS_H - 14);
          ctx.restore();
        }
      },
    },
  ];

  const COMPRESSION_PRESETS = [
    {
      level: 0,
      label: '品質優先',
      quality: 'high',
      minPalette: 128,
      posterize: 0,
    },
    {
      level: 1,
      label: 'バランス',
      quality: 'high',
      minPalette: 32,
      posterize: 0,
    },
    {
      level: 2,
      label: 'サイズ優先',
      quality: 'medium',
      minPalette: 16,
      posterize: 4,
    },
  ];

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
      if (typeof s.minPalette === 'number') minPalette = clamp(s.minPalette, 4, 256);
      if (typeof s.posterizeLimit === 'number') {
        posterizeLimit = s.posterizeLimit === 0 ? 0 : clamp(s.posterizeLimit, 4, 6);
      }
      if (Array.isArray(s.selectedTemplates)) {
        selectedTemplateIds = s.selectedTemplates.filter((id) => typeof id === 'string');
      }
    } catch {}
    compressionLevel = deriveCompressionLevel();
  }
  function saveSettings() {
    const s = { useFrameCount, durationSec, loops, aspect, quality, minPalette, posterizeLimit, selectedTemplates: selectedTemplateIds };
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
    updateFpsInfo();
    syncCompressionSlider();
  }

  function updateDurationHint() {
    if (!durationHintEl) return;
    const rounded = Math.round(durationSec * 10) / 10;
    durationHintEl.textContent = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function deriveCompressionLevel() {
    const preset = COMPRESSION_PRESETS.find((p) =>
      p.quality === quality && p.minPalette === minPalette && p.posterize === posterizeLimit
    );
    return preset ? preset.level : 1;
  }

  function applyCompressionPreset(level, { updateSlider = true } = {}) {
    const preset = COMPRESSION_PRESETS.find((p) => p.level === level) || COMPRESSION_PRESETS[1];
    compressionLevel = preset.level;
    quality = preset.quality;
    minPalette = preset.minPalette;
    posterizeLimit = preset.posterize;
    if (updateSlider && compressionSlider) compressionSlider.value = String(compressionLevel);
    if (compressionHintEl) compressionHintEl.textContent = preset.label;
    saveSettings();
    queueSizeEstimate();
  }

  function syncCompressionSlider() {
    if (!compressionSlider) return;
    const derived = deriveCompressionLevel();
    const preset = COMPRESSION_PRESETS.find((p) => p.level === derived);
    if (!preset) {
      applyCompressionPreset(1);
      return;
    }
    compressionLevel = derived;
    compressionSlider.value = String(compressionLevel);
    if (compressionHintEl) compressionHintEl.textContent = preset.label;
  }

  function updateFpsInfo() {
    const n = effectiveTargetCount();
    const ms = Math.round((durationSec * 1000) / n);
    fpsInfo.textContent = `フレーム時間: ${ms} ms / フレーム`;
    updateDurationHint();
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
  if (resetFramesBtn) {
    resetFramesBtn.addEventListener('click', () => {
      stopPreview();
      frames = [];
      templateBaseFrames = null;
      selectedTemplateIds = [];
      renderThumbs();
      refreshTemplateState();
      previewCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      saveSettings();
      setWarn('すべてのフレームをリセットしました。');
      setSizeInfoText('推定サイズ: -');
      queueSizeEstimate();
    });
  }

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
    let incoming = Array.from(fileList);
    const current = frames.length;
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
    templateBaseFrames = frames.map(cloneFrame);
    refreshTemplateState();
    if (selectedTemplateIds.length) {
      await applySelectedTemplates({ silent: true });
    } else {
      queueSizeEstimate();
    }
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

  function drawImageWithAspect(ctx, bitmap, aspectMode, opts = {}) {
    const { scale = 1, offsetX = 0, offsetY = 0, rotation = 0 } = opts;
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    let drawW = CANVAS_W;
    let drawH = CANVAS_H;

    if (aspectMode === 'stretch') {
      drawW = CANVAS_W;
      drawH = CANVAS_H;
    } else if (aspectMode === 'fit') {
      const s = Math.min(CANVAS_W / srcW, CANVAS_H / srcH);
      drawW = srcW * s;
      drawH = srcH * s;
    } else {
      const s = Math.max(CANVAS_W / srcW, CANVAS_H / srcH);
      drawW = srcW * s;
      drawH = srcH * s;
    }

    drawW *= scale;
    drawH *= scale;

    const centerX = CANVAS_W / 2 + offsetX;
    const centerY = CANVAS_H / 2 + offsetY;

    ctx.save();
    ctx.translate(centerX, centerY);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  function easeInOut(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  async function generateTemplateFrames(templates, baseFrames, opts = {}) {
    const list = Array.isArray(templates) ? templates : [templates];
    if (!list.length) throw new Error('テンプレートが指定されていません。');
    list.forEach((tpl) => {
      if (!tpl || typeof tpl.render !== 'function') {
        throw new Error('テンプレートのレンダリング処理が定義されていません。');
      }
    });
    const sources = Array.isArray(baseFrames) ? baseFrames : [baseFrames];
    if (!sources.length) throw new Error('テンプレートを適用する元フレームがありません。');

    const singleSource = sources.length === 1;
    const frameCount = singleSource
      ? clamp(
          Math.max(...list.map((tpl) => tpl.frameCount || MIN_FRAMES), MIN_FRAMES),
          MIN_FRAMES,
          MAX_FRAMES,
        )
      : sources.length;
    const progressCb = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const baseTemplate = list.find((tpl) => tpl.coversBase);
    const overlayTemplates = list.filter((tpl) => !tpl.coversBase);

    const generated = [];
    for (let i = 0; i < frameCount; i++) {
      const progress = frameCount === 1 ? 0 : i / (frameCount - 1);
      const source = singleSource ? sources[0] : sources[i % sources.length];
      let bitmap = null;
      if (source?.file) {
        bitmap = await loadImage(source.file);
      }
      const baseStem = source?.name ? source.name.replace(/\.[^.]+$/, '') : 'frame';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      if (baseTemplate) {
        if (bitmap) {
          baseTemplate.render({ ctx, bitmap, progress, index: i, count: frameCount, aspect });
        } else if (source?.rgba) {
          const imgData = new ImageData(new Uint8ClampedArray(source.rgba), CANVAS_W, CANVAS_H);
          ctx.putImageData(imgData, 0, 0);
        }
      } else if (source?.rgba) {
        const imgData = new ImageData(new Uint8ClampedArray(source.rgba), CANVAS_W, CANVAS_H);
        ctx.putImageData(imgData, 0, 0);
      } else if (bitmap) {
        drawImageWithAspect(ctx, bitmap, aspect, { scale: 1 });
      }

      overlayTemplates.forEach((tpl) => {
        const overlayBitmap = bitmap;
        tpl.render({ ctx, bitmap: overlayBitmap, progress, index: i, count: frameCount, aspect });
      });

      if (bitmap && typeof bitmap.close === 'function') {
        bitmap.close();
      }

      const imgData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      const rgba = new Uint8Array(imgData.data);
      const thumbUrl = canvas.toDataURL('image/png', 0.6);
      generated.push({
        id: uid(),
        name: `${baseStem}-${String(i + 1).padStart(2, '0')}`,
        file: source?.file || null,
        thumbUrl,
        rgba,
        delayMs: 0,
      });
      if (progressCb) progressCb(Math.round(((i + 1) / frameCount) * 100));
    }
    const frameDelay = Math.round((durationSec * 1000) / frameCount);
    generated.forEach((frame) => { frame.delayMs = frameDelay; });
    return generated;
  }

  function validateOutputConditions() {
    const errors = [];
    if (frameCount && (useFrameCount < MIN_FRAMES || useFrameCount > MAX_FRAMES)) {
      errors.push(`フレーム数は${MIN_FRAMES}～${MAX_FRAMES}枚にしてください。`);
    }
    if (durationSec < 1 || durationSec > 4) {
      errors.push('再生時間は1～4秒にしてください。');
    }
    if (loops < 1 || loops > 4) {
      errors.push('ループ回数は1～4回にしてください。');
    }
    if (!frames.length) {
      errors.push('画像を追加してください。');
    }
    return errors;
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

    if (selectedTemplateIds.length === 0) {
      templateBaseFrames = frames.map(cloneFrame);
    }
    refreshTemplateState();
    if (framesTray) framesTray.hidden = frames.length === 0;
    if (frames.length === 0) {
      templateBaseFrames = null;
      selectedTemplateIds = [];
      saveSettings();
    }
    queueSizeEstimate();
  }

  function setSizeInfoText(text) {
    if (sizeInfo) sizeInfo.textContent = text;
  }

  function queueSizeEstimate() {
    if (!sizeInfo) return;
    if (frames.length === 0) {
      setSizeInfoText('推定サイズ: -');
      return;
    }
    setSizeInfoText('推定サイズ: 計測中...');
    if (estimateTimer) clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => {
      estimateTimer = null;
      void runSizeEstimate();
    }, 400);
  }

  async function runSizeEstimate() {
    if (estimating) {
      estimatePending = true;
      return;
    }
    if (typeof UPNG === 'undefined' || typeof pako === 'undefined') {
      setSizeInfoText('推定サイズ: -');
      return;
    }
    estimating = true;
    try {
      const result = await encodeWithBudget({ onProgress: null, fast: true });
      if (!result) return;
      const label = result.ok
        ? `推定サイズ: ${fmtKB(result.size)}`
        : `推定サイズ: ${fmtKB(result.size)} (300KB超の可能性)`;
      setSizeInfoText(label);
    } catch (err) {
      console.error('Failed to estimate size', err);
      setSizeInfoText('推定サイズ: 計測できませんでした');
    } finally {
      estimating = false;
      if (estimatePending) {
        estimatePending = false;
        queueSizeEstimate();
      }
    }
  }

  function getTemplateById(id) {
    return TEMPLATE_DEFS.find((tpl) => tpl.id === id);
  }

  function renderTemplateOptions() {
    if (!templateList) return;
    const cleaned = selectedTemplateIds.filter((id) => getTemplateById(id));
    if (cleaned.length !== selectedTemplateIds.length) {
      selectedTemplateIds = cleaned;
      saveSettings();
    }
    templateList.innerHTML = '';
    TEMPLATE_DEFS.forEach((tpl) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'template-card';
      btn.dataset.templateId = tpl.id;
      btn.innerHTML = `
        <span class="name">${tpl.name}</span>
        <span class="desc">${tpl.description}</span>
      `;
      btn.addEventListener('click', () => { void handleTemplateToggle(tpl.id); });
      templateList.appendChild(btn);
    });
    refreshTemplateState();
  }

  function refreshTemplateState() {
    if (!templateList) return;
    const cleaned = selectedTemplateIds.filter((id) => getTemplateById(id));
    if (cleaned.length !== selectedTemplateIds.length) {
      selectedTemplateIds = cleaned;
      saveSettings();
    }
    const canUseTemplates = frames.length > 0;
    templateList.querySelectorAll('.template-card').forEach((btn) => {
      const tplId = btn.dataset.templateId;
      const isNone = tplId === 'none';
      const isActive = isNone ? selectedTemplateIds.length === 0 : selectedTemplateIds.includes(tplId);
      btn.classList.toggle('active', isActive);
      if (isNone) {
        const disableNone = frames.length === 0;
        btn.disabled = disableNone;
        btn.classList.toggle('disabled', disableNone);
      } else {
        const isDisabled = !canUseTemplates && !selectedTemplateIds.includes(tplId);
        btn.disabled = isDisabled;
        btn.classList.toggle('disabled', isDisabled);
      }
    });
    if (!templateHint) return;
    if (selectedTemplateIds.length > 0) {
      const names = selectedTemplateIds
        .map((id) => getTemplateById(id)?.name)
        .filter(Boolean)
        .join('、');
      templateHint.textContent = `${names} を適用中です。もう一度クリックで解除できます。`;
    } else if (frames.length === 0) {
      templateHint.textContent = 'テンプレートを適用するには画像を読み込んでください。';
    } else {
      templateHint.textContent = 'テンプレートをクリックして適用できます（複数選択可）。';
    }
  }

  function syncTemplateBase() {
    if (frames.length === 0) {
      templateBaseFrames = null;
      return;
    }
    if (selectedTemplateIds.length === 0) {
      templateBaseFrames = frames.map(cloneFrame);
    }
  }

  function handleTemplateToggle(templateId) {
    if (!frames.length) {
      setWarn('テンプレートを適用するには画像を読み込んでください。');
      return;
    }

    if (templateId === 'none') {
      if (selectedTemplateIds.length === 0) return;
      selectedTemplateIds = [];
      saveSettings();
      refreshTemplateState();
      void applySelectedTemplates();
      return;
    }

    if (selectedTemplateIds.length === 0) {
      templateBaseFrames = frames.map(cloneFrame);
    }

    if (selectedTemplateIds.includes(templateId)) {
      selectedTemplateIds = selectedTemplateIds.filter((id) => id !== templateId);
    } else {
      selectedTemplateIds = [...selectedTemplateIds, templateId];
    }
    saveSettings();
    refreshTemplateState();
    void applySelectedTemplates();
  }

  async function applySelectedTemplates(opts = {}) {
    const { silent = false } = opts;
    stopPreview();
    if (selectedTemplateIds.length === 0) {
      if (templateBaseFrames) {
        frames = templateBaseFrames.map(cloneFrame);
      }
      templateBaseFrames = null;
      customTimes = false;
      updateFpsInfo();
      renderThumbs();
      renderPreviewStatic();
      queueSizeEstimate();
      if (!silent) setWarn('');
      return;
    }

    if (!templateBaseFrames || !templateBaseFrames.length) {
      templateBaseFrames = frames.map(cloneFrame);
    }

    const templates = selectedTemplateIds
      .map(getTemplateById)
      .filter(Boolean);
    if (!templates.length) {
      selectedTemplateIds = [];
      saveSettings();
      refreshTemplateState();
      return;
    }

    try {
      if (!silent) {
        showProgress(true);
        setProgress(12);
      }
      const generated = await generateTemplateFrames(templates, templateBaseFrames, {
        onProgress: silent ? null : (pct) => setProgress(12 + Math.round((pct / 100) * 75)),
      });
      frames = generated;
      useFrameCount = clamp(generated.length, MIN_FRAMES, MAX_FRAMES);
      customTimes = false;
      updateFpsInfo();
      renderThumbs();
      renderPreviewStatic();
      if (!silent) setWarn('');
    } catch (err) {
      console.error(err);
      if (!silent) setWarn(`テンプレート適用に失敗しました: ${err?.message || err}`);
    } finally {
      if (!silent) showProgress(false);
      refreshTemplateState();
      queueSizeEstimate();
    }
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
    queueSizeEstimate();
  });
  frameCountNum.addEventListener('change', () => {
    useFrameCount = clamp(parseInt(frameCountNum.value, 10) || MIN_FRAMES, MIN_FRAMES, MAX_FRAMES);
    ensureUseCountMultiple();
    frameCount.value = String(useFrameCount);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
    renderThumbs();
    queueSizeEstimate();
  });

  duration.addEventListener('input', () => {
    durationSec = +duration.value;
    durationNum.value = String(durationSec);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
    queueSizeEstimate();
  });
  durationNum.addEventListener('change', () => {
    durationSec = clamp(parseFloat(durationNum.value) || 1, 1, 4);
    duration.value = String(durationSec);
    customTimes = false;
    updateFpsInfo();
    saveSettings();
    queueSizeEstimate();
  });

  loopsInput.addEventListener('change', () => {
    loops = clamp(parseInt(loopsInput.value, 10) || 1, 1, 4);
    loopsInput.value = String(loops);
    saveSettings();
    queueSizeEstimate();
  });

  document.querySelectorAll('input[name="aspect"]').forEach((el) => {
    el.addEventListener('change', async () => {
      if (!el.checked) return;
      aspect = el.value;
      saveSettings();
      // Rebuild all frames rgba with new aspect
      if (frames.length) {
        if (selectedTemplateIds.length && templateBaseFrames) {
          await applySelectedTemplates({ silent: true });
        } else {
          showProgress(true);
          let i = 0; const total = frames.length;
          for (const f of frames) {
            i++; setProgress(Math.round((i / total) * 100));
            if (f.file) {
              const bmp = await loadImage(f.file);
              f.rgba = await rasterizeToRGBA(bmp, aspect);
              f.thumbUrl = rgbaToDataURL(f.rgba, CANVAS_W, CANVAS_H, 0.6);
              if (typeof bmp.close === 'function') bmp.close();
            }
          }
          showProgress(false);
          renderThumbs();
          renderPreviewStatic();
          if (selectedTemplateIds.length === 0) {
            templateBaseFrames = frames.map(cloneFrame);
          }
        }
      }
    });
  });

  if (compressionSlider) {
    compressionSlider.addEventListener('input', () => {
      const lvl = clamp(parseInt(compressionSlider.value, 10) || 1, 0, 2);
      applyCompressionPreset(lvl, { updateSlider: false });
    });
  }

  resetTimesBtn.addEventListener('click', (e) => {
    e.preventDefault();
    customTimes = false;
    updateFpsInfo();
    queueSizeEstimate();
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
    setWarn('');
    setSizeInfoText('推定サイズ: 計測中...');
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
      setSizeInfoText('推定サイズ: -');
      return;
    }
    showProgress(true); setProgress(5);
    try {
      const result = await encodeWithBudget({ onProgress: setProgress });
      setProgress(100);
      showProgress(false);
      if (result && result.ok) {
        const { blob, size } = result;
        setSizeInfoText(`推定サイズ (生成結果): ${fmtKB(size)} / 上限 300KB`);
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
        setSizeInfoText(`推定サイズ (生成結果): ${fmtKB(result.size)} (300KB超)`);
        setWarn('サイズが300KBを超えています。可能な限り自動圧縮を試みましたが到達しませんでした。圧縮バランスを右へ寄せるか、フレーム数や再生時間を調整してください。');
      } else {
        setWarn('生成に失敗しました。');
        setSizeInfoText('推定サイズ: 計測できませんでした');
      }
    } catch (err) {
      console.error(err);
      showProgress(false);
      setWarn(`生成でエラーが発生しました: ${err?.message || err}`);
      setSizeInfoText('推定サイズ: 計測できませんでした');
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

  async function encodeWithBudget(opts = {}) {
    const { onProgress, fast = false } = opts;
    const reportProgress = typeof onProgress === 'function' ? (value) => onProgress(value) : () => {};
    // Build padded sequence to match selected frame count (5..20)
    const { imgs, delays } = buildEncodingSequence();
    if (imgs.length === 0) throw new Error('フレームがありません');

    const baseOrders = {
      high: [256, 128, 64],
      medium: [128, 64, 32],
      low: [64, 32, 16, 8, 4],
    };

    // Palette candidates respecting user's floor
    const allCnums = [256, 128, 64, 32, 16, 8, 4];
    const allowedCnums = allCnums.filter((c) => c >= minPalette);

    const tried = [];

    const trySet = async (images, orders, stageLabel = '') => {
      let i = 0;
      for (const cnum of orders) {
        i++;
        reportProgress(Math.min(95, 10 + Math.round(((tried.length + i) / (orders.length + tried.length + 1)) * 80)));
        const apngBuf = UPNG.encode(images, CANVAS_W, CANVAS_H, cnum, delays);
        const looped = setApngLoops(apngBuf, loops);
        const blob = new Blob([looped], { type: 'image/png' });
        const size = blob.size;
        if (size <= SIZE_LIMIT) return { ok: true, blob, size };
      }
      tried.push(stageLabel || 'stage');
      return null;
    };

    // Stage 1: user-selected quality order, filtered by floor
    let order1 = (baseOrders[quality] || baseOrders.high).filter((c) => c >= minPalette);
    if (order1.length === 0) {
      // ensure at least the floor is attempted
      order1 = [Math.max(...allowedCnums) || 256];
    }
    let r = await trySet(imgs, order1, 'base');
    if (r) return r;

    // Stage 2: extend to lower palettes if needed (>= floor only)
    const more = allowedCnums.filter((n) => !order1.includes(n));
    if (more.length) {
      r = await trySet(imgs, more, 'more');
      if (r) return r;
    }

    // Stage 3: posterize colors to reduce entropy, then try a broad set
    const broad = allowedCnums; // keep within floor
    const bitsCandidates = [6, 5, 4];
    const bitsAllowed = (posterizeLimit && posterizeLimit >= 4)
      ? bitsCandidates.filter((b) => b >= posterizeLimit)
      : [];
    for (const bits of bitsAllowed) {
      const qImgs = posterizeImgs(imgs, bits);
      r = await trySet(qImgs, broad, `posterize${bits}`);
      if (r) return r;
      if (!fast) await sleep(30);
    }

    // Final attempt (most aggressive result) for info
    const finalBits = bitsAllowed[bitsAllowed.length - 1];
    const finalImgs = finalBits ? posterizeImgs(imgs, finalBits) : imgs;
    const finalCnum = allowedCnums[allowedCnums.length - 1] || 256;
    const apngBuf = UPNG.encode(finalImgs, CANVAS_W, CANVAS_H, finalCnum, delays);
    const looped = setApngLoops(apngBuf, loops);
    const blob = new Blob([looped], { type: 'image/png' });
    return { ok: false, blob, size: blob.size };
  }

  function posterizeImgs(imgs, bitsRGB = 5) {
    const out = [];
    const levels = 1 << bitsRGB; // e.g., 32 for 5 bits, 16 for 4 bits
    const step = 255 / (levels - 1);
    for (const src of imgs) {
      const buf = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i += 4) {
        const r = src[i], g = src[i + 1], b = src[i + 2], a = src[i + 3];
        buf[i] = Math.round(Math.round(r / step) * step);
        buf[i + 1] = Math.round(Math.round(g / step) * step);
        buf[i + 2] = Math.round(Math.round(b / step) * step);
        buf[i + 3] = a; // keep alpha
      }
      out.push(buf);
    }
    return out;
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
    syncTemplateBase();
    renderTemplateOptions();
    syncControls();
    if (framesTray) framesTray.hidden = frames.length === 0;
    queueSizeEstimate();
  }

  init();
})();
