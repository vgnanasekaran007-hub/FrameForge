import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';
import { apiUrl } from './api.js';

/* ─────────── helpers ─────────── */
const fmt = (s) => {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return `${String(m).padStart(2, '0')}:${sec.padStart(6, '0')}`;
};

const fmtShort = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const fileSizeStr = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

/* ─────────── main ─────────── */
function App() {
  /* video state */
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [videoMeta, setVideoMeta] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);

  /* backend session */
  const [sessionId, setSessionId] = useState(null);
  const [backendStatus, setBackendStatus] = useState('idle'); // idle | uploading | ready | error
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFile, setUploadFile] = useState(null);
  const [backendError, setBackendError] = useState(null);

  /* extraction settings */
  const [mode, setMode] = useState('interval'); // 'single' | 'interval' | 'all'
  const [interval, setInterval_] = useState(5.0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [format, setFormat] = useState('jpg'); // 'jpg' | 'png'
  const [quality, setQuality] = useState(92);
  const [scale, setScale] = useState(100);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);
  const [extractMsg, setExtractMsg] = useState('');

  /* extracted frames */
  const [frames, setFrames] = useState([]);
  const [selectedFrames, setSelectedFrames] = useState(new Set());

  /* modals */
  const [showShortcuts, setShowShortcuts] = useState(false);

  /* interval pills */
  const INTERVALS = [0.5, 1.0, 2.0, 5.0, 10.0];

  /* estimate frames */
  const estimatedFrames = mode === 'single' ? 1 :
    mode === 'all' ? (videoMeta ? Math.floor(duration * (videoMeta.fps || 30)) : 0) :
    Math.max(1, Math.floor((outPoint - inPoint) / interval) + 1);

  const estSizePerFrame = format === 'jpg' ? (2.8 * (quality / 92)) : 5.2;
  const estTotalSize = (estimatedFrames * estSizePerFrame).toFixed(1);

  /* ─── backend upload ─── */
  const uploadToBackend = useCallback(async (file) => {
    setBackendStatus('uploading');
    setBackendError(null);
    setUploadProgress(0);

    const fd = new FormData();
    fd.append('file', file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl('/upload'));

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const data = JSON.parse(xhr.responseText);
          setSessionId(data.session_id);
          setBackendStatus('ready');
          resolve(data);
        } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (_) {}
          setBackendStatus('error');
          setBackendError(msg);
          reject(new Error(msg));
        }
      };

      xhr.onerror = () => {
        const msg = 'Network error — is the Python backend running on port 8000?';
        setBackendStatus('error');
        setBackendError(msg);
        reject(new Error(msg));
      };

      xhr.send(fd);
    });
  }, []);

  /* ─── video handlers ─── */
  const handleFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('video/')) return;
    setUploadFile(file);

    // Show local preview immediately
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setFrames([]);
    setSelectedFrames(new Set());
    setSessionId(null);

    // Upload to Python backend in parallel
    try {
      const meta = await uploadToBackend(file);
      // Update videoMeta with server-probed values (accurate FPS, codec, etc.)
      setVideoMeta(prev => ({
        ...prev,
        fps: meta.fps,
        codec: meta.codec,
        width: meta.width || prev?.width,
        height: meta.height || prev?.height,
        nb_frames: meta.nb_frames,
      }));
    } catch (err) {
      console.warn('Backend upload failed, falling back to browser-only mode:', err.message);
    }
  }, [uploadToBackend]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    handleFile(file);
  }, [handleFile]);

  const handleVideoLoad = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = v.duration;
    setDuration(dur);
    setOutPoint(dur);
    setInPoint(0);

    const w = v.videoWidth;
    const h = v.videoHeight;
    setVideoMeta(prev => ({
      width: w,
      height: h,
      fps: prev?.fps || 30,
      codec: prev?.codec || 'unknown',
      duration: dur,
    }));
  }, []);

  /* sync time */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurTime(v.currentTime);
    const onEnded = () => setPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnded);
    };
  }, [videoSrc]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, [videoSrc]);

  const stepFrame = useCallback((dir) => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    v.pause();
    setPlaying(false);
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dir / 30));
  }, [videoSrc]);

  const seekTo = useCallback((t) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, t));
  }, [duration]);

  /* ─── BACKEND frame extraction ─── */
  const extractFramesBackend = useCallback(async () => {
    if (!sessionId) return false;

    setExtractMsg('Sending to server…');
    const fd = new FormData();
    fd.append('session_id', sessionId);
    fd.append('mode', mode);
    fd.append('interval', interval);
    fd.append('in_point', inPoint);
    fd.append('out_point', outPoint > inPoint ? outPoint : duration);
    fd.append('fmt', format);
    fd.append('quality', quality);
    fd.append('scale', scale);
    if (mode === 'single') fd.append('timestamp', currentTime);

    const res = await fetch(apiUrl('/extract'), { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Extraction failed' }));
      throw new Error(err.detail || 'Extraction failed');
    }
    const data = await res.json();
    return data.frames; // [{id, index, filename, size, url}]
  }, [sessionId, mode, interval, inPoint, outPoint, duration, format, quality, scale, currentTime]);

  /* ─── BROWSER-ONLY fallback extraction ─── */
  const extractFramesBrowser = useCallback(async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !videoSrc) return [];

    v.pause();
    setPlaying(false);

    const ctx = c.getContext('2d');
    const sw = Math.round(v.videoWidth * (scale / 100));
    const sh = Math.round(v.videoHeight * (scale / 100));
    c.width = sw;
    c.height = sh;

    const times = [];
    if (mode === 'single') {
      times.push(currentTime);
    } else if (mode === 'interval') {
      for (let t = inPoint; t <= outPoint; t += interval) times.push(t);
    } else {
      const step = 1 / (videoMeta?.fps || 30);
      for (let t = 0; t <= duration; t += step) times.push(t);
      if (times.length > 300) times.length = 300;
    }

    const newFrames = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      v.currentTime = t;
      await new Promise((r) => { v.onseeked = r; });
      ctx.drawImage(v, 0, 0, sw, sh);
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const q = format === 'jpg' ? quality / 100 : undefined;
      const blob = await new Promise((r) => c.toBlob(r, mime, q));
      const url = URL.createObjectURL(blob);
      newFrames.push({
        id: `frame_${Date.now()}_${i}`,
        time: t,
        url,
        blob,
        size: blob.size,
        index: i + 1,
        isBrowserFrame: true,
      });
      setExtractProgress(((i + 1) / times.length) * 100);
      setExtractMsg(`Extracting frame ${i + 1} / ${times.length}`);
    }
    return newFrames;
  }, [videoSrc, mode, interval, inPoint, outPoint, format, quality, scale, currentTime, duration, videoMeta]);

  /* ─── unified extract ─── */
  const extractFrames = useCallback(async () => {
    if (!videoSrc) return;

    setExtracting(true);
    setExtractProgress(0);
    setExtractMsg('Starting…');

    try {
      let result;
      if (sessionId && backendStatus === 'ready') {
        // Server-side path (FFmpeg)
        setExtractMsg('FFmpeg processing on server…');
        result = await extractFramesBackend();
        // result is array of {id, index, filename, size, url}
        const enriched = result.map(f => ({
          ...f,
          time: (f.index - 1) * (mode === 'interval' ? interval : 1 / (videoMeta?.fps || 30)),
          url: apiUrl(f.url),   // backend URL — prefixed for production
        }));
        setFrames(enriched);
        setExtractMsg(`✓ ${enriched.length} frames extracted by FFmpeg`);
      } else {
        // Browser canvas fallback
        setExtractMsg('Using browser canvas (backend unavailable)…');
        result = await extractFramesBrowser();
        setFrames(result);
        setExtractMsg(`✓ ${result.length} frames extracted`);
      }
      setSelectedFrames(new Set());
    } catch (err) {
      console.error('Extraction error:', err);
      setExtractMsg(`Error: ${err.message}`);
      // Try browser fallback if backend failed
      if (sessionId) {
        try {
          setExtractMsg('Backend failed — retrying in browser…');
          const result = await extractFramesBrowser();
          setFrames(result);
          setSelectedFrames(new Set());
          setExtractMsg(`✓ ${result.length} frames (browser fallback)`);
        } catch (e2) {
          setExtractMsg(`Failed: ${e2.message}`);
        }
      }
    } finally {
      setExtracting(false);
      setExtractProgress(100);
    }
  }, [videoSrc, sessionId, backendStatus, extractFramesBackend, extractFramesBrowser, mode, interval, videoMeta]);

  /* ─── capture single frame (keyboard E / tile click) ─── */
  const captureSingleFrame = useCallback(async () => {
    if (!videoSrc) return;

    if (sessionId && backendStatus === 'ready') {
      // Use backend for single frame
      try {
        const fd = new FormData();
        fd.append('session_id', sessionId);
        fd.append('mode', 'single');
        fd.append('timestamp', currentTime);
        fd.append('fmt', format);
        fd.append('quality', quality);
        fd.append('scale', scale);
        fd.append('in_point', 0);
        fd.append('out_point', duration);

        const res = await fetch(apiUrl('/extract'), { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          const f = data.frames[0];
          if (f) {
            setFrames(prev => [...prev, {
              ...f,
              time: currentTime,
              index: prev.length + 1,
            }]);
            return;
          }
        }
      } catch (e) {
        console.warn('Backend single capture failed, using canvas', e);
      }
    }

    // Canvas fallback
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const ctx = c.getContext('2d');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    ctx.drawImage(v, 0, 0);
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      setFrames(prev => [...prev, {
        id: `frame_${Date.now()}`,
        time: currentTime,
        url,
        blob,
        size: blob.size,
        index: prev.length + 1,
        isBrowserFrame: true,
      }]);
    }, format === 'jpg' ? 'image/jpeg' : 'image/png', format === 'jpg' ? quality / 100 : undefined);
  }, [videoSrc, sessionId, backendStatus, currentTime, format, quality, scale, duration]);

  /* ─── frame selection ─── */
  const toggleFrameSelect = (id) => {
    setSelectedFrames(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  const selectAll = () => {
    if (selectedFrames.size === frames.length) setSelectedFrames(new Set());
    else setSelectedFrames(new Set(frames.map(f => f.id)));
  };

  /* ─── download ─── */
  const downloadSingle = (frame) => {
    const a = document.createElement('a');
    a.href = frame.url;
    const ext = format === 'jpg' ? 'jpg' : 'png';
    const timeStr = frame.time !== undefined ? fmt(frame.time).replace(/[:.]/g, '-') : frame.filename || 'frame';
    a.download = `frame_${String(frame.index).padStart(3, '0')}_${timeStr}.${ext}`;
    a.click();
  };

  const downloadZip = async () => {
    // Use backend ZIP endpoint if session available
    if (sessionId && backendStatus === 'ready' && !frames[0]?.isBrowserFrame) {
      const a = document.createElement('a');
      a.href = apiUrl(`/download/${sessionId}`);
      a.download = `frameforge_export.zip`;
      a.click();
      return;
    }

    // Browser ZIP fallback
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const toDownload = selectedFrames.size > 0
      ? frames.filter(f => selectedFrames.has(f.id))
      : frames;
    const ext = format === 'jpg' ? 'jpg' : 'png';
    for (const f of toDownload) {
      if (f.blob) {
        zip.file(`frame_${String(f.index).padStart(3, '0')}_t${f.time?.toFixed(3) || '0'}.${ext}`, f.blob);
      }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `frameforge_export_${toDownload.length}_frames.zip`;
    a.click();
  };

  /* ─── keyboard shortcuts ─── */
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); stepFrame(e.shiftKey ? -5 : -1); break;
        case 'ArrowRight': e.preventDefault(); stepFrame(e.shiftKey ? 5 : 1); break;
        case 'i': case 'I': setInPoint(currentTime); break;
        case 'o': case 'O': setOutPoint(currentTime); break;
        case 'e': case 'E': captureSingleFrame(); break;
        case 'Escape': setShowShortcuts(false); break;
        case '/': if (e.ctrlKey || e.metaKey) { e.preventDefault(); setShowShortcuts(s => !s); } break;
        default: break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [videoSrc, currentTime, togglePlay, stepFrame, captureSingleFrame]);

  /* ─── timeline scrub ─── */
  const handleTimelineScrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pct * duration);
  };

  /* ─── computed ─── */
  const currentFrame = duration > 0 ? Math.floor(currentTime * (videoMeta?.fps || 30)) : 0;
  const totalFrames = duration > 0 ? Math.floor(duration * (videoMeta?.fps || 30)) : 0;
  const inPct = duration > 0 ? (inPoint / duration) * 100 : 0;
  const outPct = duration > 0 ? (outPoint / duration) * 100 : 0;
  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const selectedSize = frames.filter(f => selectedFrames.has(f.id)).reduce((s, f) => s + (f.size || 0), 0);

  /* ─── resolution string ─── */
  const resLabel = scale === 100 ? '4K' : scale === 50 ? '1080p' : '720p';

  /* ─── file name ─── */
  const fileName = uploadFile?.name || null;

  /* ─── backend status badge ─── */
  const statusBadge = backendStatus === 'ready' ? { label: 'FFmpeg Ready', color: 'var(--primary-container)' }
    : backendStatus === 'uploading' ? { label: `Uploading ${uploadProgress}%`, color: 'var(--tertiary-fixed-dim)' }
    : backendStatus === 'error' ? { label: 'Backend Error', color: 'var(--error)' }
    : { label: 'Browser Mode', color: 'var(--outline)' };

  return (
    <>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files[0])}
      />

      {/* ═══ TOP BAR ═══ */}
      <header className="top-bar">
        <div className="top-bar__left">
          <div className="brand">
            <div className="brand__icon">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>movie</span>
            </div>
            <span className="text-headline-md brand__name">FrameForge</span>
            <span className="brand__badge text-label-sans-caps">VIDEO FRAME EXTRACTOR</span>
          </div>
          <nav className="top-nav">
            <a href="#timeline" className="top-nav__link top-nav__link--active">Timeline</a>
            <a href="#inspector" className="top-nav__link">Inspector</a>
            <a href="#batch-queue" className="top-nav__link">
              Batch Queue
              {frames.length > 0 && <span className="top-nav__badge">{frames.length}</span>}
            </a>
          </nav>
        </div>
        {/* Active Media Badge */}
        {videoMeta && (
          <div className="media-badge">
            <span className="media-badge__dot animate-pulse" />
            <span className="text-label-mono-sm" style={{ color: 'var(--primary)', fontWeight: 500 }}>
              {fileName || 'loaded_video.mp4'}
            </span>
            <span className="media-badge__sep">|</span>
            <span className="text-label-mono-sm" style={{ color: 'var(--secondary)' }}>
              {videoMeta.width}×{videoMeta.height} · {videoMeta.fps}fps · {fmt(duration)} · {fileSizeStr(uploadFile?.size || 0)}
            </span>
            <span className="media-badge__sep">|</span>
            <span className="text-label-mono-sm" style={{ color: statusBadge.color, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="material-symbols-outlined filled" style={{ fontSize: 13 }}>bolt</span>
              {statusBadge.label}
            </span>
          </div>
        )}
        <div className="top-bar__right">
          <div className="privacy-pill text-label-mono-sm">
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>lock</span>
            <span>Local Client Only</span>
          </div>
          <button className="btn-ghost text-label-mono-sm" onClick={() => setShowShortcuts(s => !s)}>
            ⌘/ Shortcuts
          </button>
          <button
            className="btn-secondary text-headline-sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>video_file</span>
            <span>{videoSrc ? 'Replace Video' : 'Load Video'}</span>
          </button>
          <button className="btn-icon" title="Dark Mode">
            <span className="material-symbols-outlined">dark_mode</span>
          </button>
        </div>
      </header>

      {/* ─── Backend Error Banner ─── */}
      {backendError && (
        <div style={{
          background: 'var(--error-container)',
          borderBottom: '1px solid var(--error)',
          color: 'var(--on-error-container)',
          padding: '6px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          flexShrink: 0,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>warning</span>
          <span>Backend: {backendError} — falling back to browser-only mode.</span>
          <button
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
            onClick={() => setBackendError(null)}
          >✕</button>
        </div>
      )}

      {/* ═══ MAIN WORKSPACE ═══ */}
      <main className="workspace">
        {/* ─── LEFT: Viewport + Timeline ─── */}
        <section className="viewport-panel">
          {/* Video Monitor */}
          <div
            className="monitor"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            {videoSrc ? (
              <>
                {/* HUD Top Left */}
                <div className="hud hud--tl">
                  <span className="hud__chip text-label-mono-sm">
                    CANVAS {videoMeta ? `${videoMeta.width > videoMeta.height ? '16:9' : '9:16'}` : ''} REC.709
                  </span>
                  <span className="hud__chip hud__chip--accent text-label-mono-sm">
                    {videoMeta ? `${videoMeta.width}×${videoMeta.height}` : ''} @ {videoMeta?.fps || 30}.00 FPS
                  </span>
                </div>
                {/* HUD Top Right */}
                <div className="hud hud--tr">
                  <div className="hud__chip text-label-mono-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="hud__dot" />
                    <span style={{ color: 'var(--secondary)' }}>FRAME:</span>
                    <span style={{ color: 'var(--primary)', fontWeight: 500 }}>{currentFrame}</span>
                    <span style={{ color: 'var(--secondary)' }}>/ {totalFrames}</span>
                  </div>
                </div>
                {/* Upload progress overlay */}
                {backendStatus === 'uploading' && (
                  <div style={{
                    position: 'absolute', inset: 0, background: 'rgba(13,14,15,0.7)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    zIndex: 30, gap: 12,
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 36, color: 'var(--primary-container)' }}>upload</span>
                    <span className="text-headline-sm" style={{ color: 'var(--primary)' }}>Uploading to FFmpeg backend…</span>
                    <div style={{ width: 240, height: 4, background: 'var(--surface-container-high)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${uploadProgress}%`, background: 'var(--primary-container)', transition: 'width 0.2s' }} />
                    </div>
                    <span className="text-label-mono-sm" style={{ color: 'var(--secondary)' }}>{uploadProgress}%</span>
                  </div>
                )}
                {/* Cinema Viewport */}
                <div className="cinema-viewport">
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    onLoadedMetadata={handleVideoLoad}
                    className="cinema-viewport__video"
                  />
                  {/* Corner Crosshairs */}
                  <div className="cinema-viewport__frame" />
                  <div className="crosshair crosshair--tl" />
                  <div className="crosshair crosshair--tr" />
                  <div className="crosshair crosshair--bl" />
                  <div className="crosshair crosshair--br" />
                  {/* Center Reticle */}
                  <div className="reticle">
                    <div className="reticle__h" />
                    <div className="reticle__v" />
                  </div>
                  {/* Timestamp Pill */}
                  <div className="timestamp-pill text-label-mono-lg">{fmt(currentTime)}</div>
                </div>
              </>
            ) : (
              /* Drop Zone */
              <div className="drop-zone" onClick={() => fileInputRef.current?.click()}>
                <span className="material-symbols-outlined" style={{ fontSize: 48, color: 'var(--secondary)' }}>upload_file</span>
                <span className="text-headline-md" style={{ color: 'var(--primary)', marginTop: 12 }}>
                  Drop MP4/WebM/MOV Here
                </span>
                <span className="text-body-sm" style={{ color: 'var(--secondary)', marginTop: 4 }}>
                  or click to browse · FFmpeg server-side processing
                </span>
              </div>
            )}
          </div>

          {/* Transport Strip */}
          <div className="transport">
            <div className="transport__left">
              <button className="transport-btn" onClick={() => stepFrame(-5)} title="Step Back 5 Frames (Shift+Left)">
                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>fast_rewind</span>
              </button>
              <button className="transport-btn" onClick={() => stepFrame(-1)} title="Step Back 1 Frame (Left)">
                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>skip_previous</span>
              </button>
              <button className="transport-btn transport-btn--primary" onClick={togglePlay} title="Play / Pause (Space)">
                <span className="material-symbols-outlined filled">{playing ? 'pause' : 'play_arrow'}</span>
              </button>
              <button className="transport-btn" onClick={() => stepFrame(1)} title="Step Forward 1 Frame (Right)">
                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>skip_next</span>
              </button>
              <button className="transport-btn" onClick={() => stepFrame(5)} title="Step Forward 5 Frames (Shift+Right)">
                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>fast_forward</span>
              </button>
              <div className="transport__divider" />
              <button className="transport-btn-label text-label-mono-sm" onClick={() => setInPoint(currentTime)} title="Mark In-Point (I)">
                IN [
              </button>
              <button className="transport-btn-label text-label-mono-sm" onClick={() => setOutPoint(currentTime)} title="Mark Out-Point (O)">
                OUT ]
              </button>
            </div>
            {/* Timecode Center */}
            <div className="timecode">
              <span className="text-label-mono-md" style={{ fontWeight: 600, color: 'var(--primary)' }}>{fmt(currentTime)}</span>
              <span className="text-label-mono-sm" style={{ color: 'var(--secondary)' }}>/</span>
              <span className="text-label-mono-sm" style={{ color: 'var(--secondary)' }}>{fmt(duration)}</span>
            </div>
            {/* Right controls */}
            <div className="transport__right">
              <div className="zoom-segment text-label-mono-sm">
                <button className="zoom-segment__btn zoom-segment__btn--active">Fit</button>
                <button className="zoom-segment__btn">100%</button>
                <button className="zoom-segment__btn">200%</button>
              </div>
            </div>
          </div>

          {/* Timeline Scrubber */}
          <div className="timeline" id="timeline">
            {/* Ruler */}
            <div className="timeline__ruler text-label-mono-sm">
              {duration > 0 && Array.from({ length: 10 }, (_, i) => {
                const t = (i / 9) * duration;
                return <div key={i} className="timeline__tick"><span>{fmtShort(t)}</span></div>;
              })}
            </div>
            {/* Scrub Track */}
            <div className="timeline__track" onClick={handleTimelineScrub}>
              {/* Gradient filmstrip bg */}
              <div className="timeline__filmstrip" />
              {/* Selection range */}
              {mode === 'interval' && duration > 0 && (
                <div
                  className="timeline__range"
                  style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }}
                >
                  <div className="timeline__range-label text-label-mono-sm">IN {fmt(inPoint)}</div>
                  <div className="timeline__range-label text-label-mono-sm">OUT {fmt(outPoint)}</div>
                </div>
              )}
              {/* Interval ticks */}
              {mode === 'interval' && duration > 0 && (() => {
                const ticks = [];
                for (let t = inPoint; t <= outPoint; t += interval) {
                  ticks.push(
                    <div
                      key={t}
                      className="timeline__interval-tick"
                      style={{ left: `${(t / duration) * 100}%` }}
                    />
                  );
                }
                return ticks;
              })()}
              {/* Playhead */}
              {duration > 0 && (
                <div className="timeline__playhead" style={{ left: `${playPct}%` }}>
                  <div className="timeline__playhead-diamond" />
                  <div className="timeline__playhead-tooltip text-label-mono-sm">{fmt(currentTime)}</div>
                </div>
              )}
            </div>
            {/* Timeline Footer */}
            <div className="timeline__footer text-label-mono-sm">
              <div className="timeline__footer-left">
                <span>Range Selected: <span style={{ color: 'var(--primary)', fontWeight: 500 }}>{fmt(outPoint - inPoint)}</span></span>
                <span style={{ color: 'var(--outline-variant)' }}>·</span>
                <span>Frames in Region: <span style={{ color: 'var(--primary)', fontWeight: 500 }}>
                  {mode === 'interval' ? estimatedFrames.toLocaleString() : totalFrames.toLocaleString()}
                </span></span>
              </div>
              <div className="timeline__footer-right">
                <span className="timeline__footer-dot" />
                <span style={{ color: 'var(--primary-container)' }}>
                  {estimatedFrames} extraction keypoints at {interval.toFixed(3)}s step
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ─── RIGHT: Inspector ─── */}
        <aside className="inspector" id="inspector">
          <div className="inspector__body">
            {/* Header */}
            <div className="inspector__header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--primary-container)' }}>tune</span>
                <h2 className="text-headline-md" style={{ color: 'var(--primary)' }}>EXTRACTION SETTINGS</h2>
              </div>
              <span className="inspector__version text-label-mono-sm">
                {backendStatus === 'ready' ? 'FFmpeg Backend' : 'v2.4 Engine'}
              </span>
            </div>

            {/* Mode Selector */}
            <div className="setting-group">
              <label className="text-label-sans-caps setting-label">EXTRACTION MODE</label>
              <div className="segmented">
                {[['single', 'Single Frame'], ['interval', 'By Interval'], ['all', 'All Frames']].map(([k, label]) => (
                  <button
                    key={k}
                    className={`segmented__btn text-headline-sm ${mode === k ? 'segmented__btn--active' : ''}`}
                    onClick={() => setMode(k)}
                  >
                    {label}
                    {mode === k && <span className="segmented__indicator" />}
                  </button>
                ))}
              </div>
            </div>

            {/* Interval Settings */}
            {mode === 'interval' && (
              <div className="params-card">
                {/* Interval Quick Select */}
                <div className="setting-group">
                  <div className="setting-group__row">
                    <span className="text-label-sans-caps setting-label">INTERVAL FREQUENCY</span>
                    <span className="text-label-mono-sm" style={{ color: 'var(--primary-container)', fontWeight: 600 }}>{interval.toFixed(3)}s</span>
                  </div>
                  <div className="pill-grid">
                    {INTERVALS.map(v => (
                      <button
                        key={v}
                        className={`pill text-label-mono-sm ${interval === v ? 'pill--active' : ''}`}
                        onClick={() => setInterval_(v)}
                      >
                        {v.toFixed(1)}s
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom Step Input */}
                <div className="stepper-row">
                  <div className="stepper-input">
                    <span className="stepper-input__prefix text-label-mono-sm">Step:</span>
                    <input
                      type="text"
                      className="stepper-input__field text-label-mono-md"
                      value={interval.toFixed(3)}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v > 0) setInterval_(v);
                      }}
                    />
                    <span className="stepper-input__suffix text-label-mono-sm">sec</span>
                  </div>
                  <div className="stepper-btns">
                    <button className="stepper-btn" onClick={() => setInterval_(i => Math.max(0.1, i - 0.5))}>
                      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>remove</span>
                    </button>
                    <button className="stepper-btn" onClick={() => setInterval_(i => i + 0.5)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>add</span>
                    </button>
                  </div>
                </div>

                {/* Range Inputs */}
                <div className="range-section">
                  <label className="text-label-sans-caps setting-label">EXTRACTION RANGE</label>
                  <div className="range-inputs">
                    <div className="range-input-group">
                      <div className="range-input-group__header text-label-mono-sm">
                        <span>Start (IN)</span>
                        <button className="link-btn" onClick={() => setInPoint(0)}>Use Head</button>
                      </div>
                      <input
                        type="text"
                        className="range-input text-label-mono-sm"
                        value={fmt(inPoint)}
                        onChange={(e) => {
                          const parts = e.target.value.split(':');
                          if (parts.length === 2) {
                            const s = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
                            if (!isNaN(s)) setInPoint(Math.max(0, Math.min(s, duration)));
                          }
                        }}
                      />
                    </div>
                    <div className="range-input-group">
                      <div className="range-input-group__header text-label-mono-sm">
                        <span>End (OUT)</span>
                        <button className="link-btn" onClick={() => setOutPoint(duration)}>Use Tail</button>
                      </div>
                      <input
                        type="text"
                        className="range-input text-label-mono-sm"
                        value={fmt(outPoint)}
                        onChange={(e) => {
                          const parts = e.target.value.split(':');
                          if (parts.length === 2) {
                            const s = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
                            if (!isNaN(s)) setOutPoint(Math.max(inPoint, Math.min(s, duration)));
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Estimate Banner */}
                <div className="estimate-banner">
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--primary-container)' }}>analytics</span>
                  <div>
                    <div className="text-headline-sm" style={{ color: 'var(--primary)' }}>Estimated: {estimatedFrames} Frames</div>
                    <div className="text-label-mono-sm" style={{ color: 'var(--secondary)' }}>
                      ~{estTotalSize} MB at {resLabel} {format === 'jpg' ? `High JPG (${quality}%)` : 'PNG Lossless'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Format & Quality */}
            <div className="setting-group">
              <label className="text-label-sans-caps setting-label">IMAGE FORMAT &amp; COMPRESSION</label>
              <div className="format-grid">
                <button
                  className={`format-btn text-headline-sm ${format === 'jpg' ? 'format-btn--active' : ''}`}
                  onClick={() => setFormat('jpg')}
                >
                  <span>JPG Format</span>
                  <span className={`format-dot ${format === 'jpg' ? 'format-dot--active' : ''}`} />
                </button>
                <button
                  className={`format-btn text-headline-sm ${format === 'png' ? 'format-btn--active' : ''}`}
                  onClick={() => setFormat('png')}
                >
                  <span>PNG (Lossless)</span>
                  <span className={`format-dot ${format === 'png' ? 'format-dot--active' : ''}`} />
                </button>
              </div>
              {format === 'jpg' && (
                <div className="quality-slider">
                  <div className="quality-slider__header text-label-mono-sm">
                    <span style={{ color: 'var(--secondary)' }}>Quality Level:</span>
                    <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{quality}%</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="100"
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                  />
                  <div className="quality-slider__labels">
                    <span>Balanced (80%)</span>
                    <span style={{ color: 'var(--primary-container)', fontFamily: "'JetBrains Mono', monospace" }}>
                      High Fidelity ({quality}%)
                    </span>
                    <span>Ultra (100%)</span>
                  </div>
                </div>
              )}
            </div>

            {/* Resolution & Naming */}
            <div className="setting-group setting-group--border">
              <div className="setting-group__row">
                <span className="text-label-sans-caps setting-label">OUTPUT RESOLUTION &amp; NAMING</span>
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: 'var(--secondary)' }}>expand_more</span>
              </div>
              <div className="scale-grid text-label-mono-sm">
                {[[100, '100% (4K)'], [50, '50% (1080p)'], [25, '25% (720p)']].map(([v, label]) => (
                  <button
                    key={v}
                    className={`pill ${scale === v ? 'pill--active-subtle' : ''}`}
                    onClick={() => setScale(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="naming-preview">
                <div className="naming-preview__header text-label-mono-sm">
                  <span style={{ color: 'var(--secondary)' }}>File Naming Pattern:</span>
                  <span style={{ color: 'var(--primary)', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                    {'{name}_{time}_{frame}'}
                  </span>
                </div>
                <div className="naming-preview__box text-label-mono-sm">
                  <span style={{ color: 'var(--secondary)' }}>Preview:</span>
                  <span style={{ color: 'var(--primary)', fontFamily: "'JetBrains Mono', monospace" }}>
                    frame_001_{fmt(currentTime).replace(/[:.]/g, '-')}.{format === 'jpg' ? 'jpg' : 'png'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Extract CTA */}
          <div className="inspector__footer">
            <button
              className="extract-btn"
              onClick={extractFrames}
              disabled={!videoSrc || extracting}
            >
              {extracting ? (
                <>
                  <span className="material-symbols-outlined filled" style={{ animation: 'pulse 1s infinite' }}>hourglass_top</span>
                  <span>{extractMsg || `Extracting… ${Math.round(extractProgress)}%`}</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined filled">bolt</span>
                  <span>Extract {estimatedFrames} Frames {backendStatus === 'ready' ? '(FFmpeg)' : ''}</span>
                </>
              )}
            </button>
            {extracting && (
              <div style={{ width: '100%', height: 3, background: 'var(--surface-container-high)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${extractProgress}%`, background: 'var(--primary-container)', transition: 'width 0.3s' }} />
              </div>
            )}
            <div className="extract-note text-label-mono-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: 'var(--primary-container)' }}>memory</span>
              <span>
                {backendStatus === 'ready'
                  ? 'FFmpeg server · high-quality frame extraction'
                  : 'Zero cloud upload · Processed locally in memory'}
              </span>
            </div>
          </div>
        </aside>
      </main>

      {/* ═══ BOTTOM: Extracted Frames Gallery ═══ */}
      <section className="gallery" id="batch-queue">
        {/* Gallery Action Bar */}
        <div className="gallery__bar">
          <div className="gallery__bar-left">
            <div className="gallery__title">
              <span className="material-symbols-outlined" style={{ fontSize: 15, color: 'var(--primary-container)' }}>view_carousel</span>
              <span className="text-headline-sm" style={{ color: 'var(--primary)' }}>EXTRACTED FRAMES</span>
            </div>
            <span className="gallery__count text-label-mono-sm">{frames.length} frames generated</span>
            <span style={{ color: 'var(--outline-variant)' }}>|</span>
            <div className="text-label-mono-sm">
              <span style={{ color: 'var(--primary-container)', fontWeight: 500 }}>{selectedFrames.size} selected</span>
              <span style={{ color: 'var(--secondary)', marginLeft: 4 }}>({fileSizeStr(selectedSize)})</span>
            </div>
          </div>
          <div className="gallery__bar-right">
            <button className="btn-ghost text-label-mono-sm" onClick={selectAll}>
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>check_box</span>
              <span>Select All</span>
            </button>
            <button className="btn-ghost text-label-mono-sm" onClick={() => setFrames([])}>
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>delete_sweep</span>
              <span>Clear All</span>
            </button>
            <div className="gallery__divider" />
            <button
              className="btn-primary-sm text-headline-sm"
              onClick={downloadZip}
              disabled={frames.length === 0}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
              <span>Download ZIP ({fileSizeStr(frames.reduce((s, f) => s + (f.size || 0), 0))})</span>
            </button>
          </div>
        </div>
        {/* Filmstrip */}
        <div className="filmstrip">
          {frames.map((frame) => {
            const isSel = selectedFrames.has(frame.id);
            const isCurrent = frame.time !== undefined && Math.abs(frame.time - currentTime) < 0.05;
            return (
              <div
                key={frame.id}
                className={`frame-card ${isSel ? 'frame-card--selected' : ''} ${isCurrent ? 'frame-card--current' : ''}`}
                onClick={() => toggleFrameSelect(frame.id)}
              >
                <div className="frame-card__img-wrap">
                  <img src={frame.url} alt={`Frame ${frame.index}`} className="frame-card__img" />
                  <div className="frame-card__index text-label-mono-sm">
                    #{String(frame.index).padStart(3, '0')}{isSel ? ' SELECTED' : isCurrent ? ' CURRENT' : ''}
                  </div>
                  {isSel ? (
                    <div className="frame-card__check">
                      <span className="material-symbols-outlined filled">check</span>
                    </div>
                  ) : (
                    <button
                      className="frame-card__dl"
                      onClick={(e) => { e.stopPropagation(); downloadSingle(frame); }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>download</span>
                    </button>
                  )}
                </div>
                <div className={`frame-card__footer text-label-mono-sm ${isSel || isCurrent ? 'frame-card__footer--highlighted' : ''}`}>
                  <span style={{ color: isCurrent ? 'var(--primary-container)' : 'var(--primary)', fontWeight: 500 }}>
                    {frame.time !== undefined ? fmt(frame.time) : frame.filename}
                  </span>
                  <span style={{ color: 'var(--secondary)' }}>{fileSizeStr(frame.size || 0)}</span>
                </div>
              </div>
            );
          })}
          {/* Capture Current tile */}
          {videoSrc && (
            <div
              className="frame-card frame-card--add"
              onClick={captureSingleFrame}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 24, color: 'var(--secondary)' }}>add_photo_alternate</span>
              <span className="text-headline-sm" style={{ color: 'var(--secondary)', marginTop: 4 }}>Capture Current</span>
              <span className="text-label-mono-sm" style={{ color: 'var(--outline)' }}>Press [E]</span>
            </div>
          )}
          {frames.length === 0 && !videoSrc && (
            <div className="filmstrip__empty text-body-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 32, color: 'var(--outline-variant)' }}>photo_library</span>
              <span style={{ color: 'var(--secondary)', marginTop: 8 }}>Extracted frames will appear here</span>
            </div>
          )}
        </div>
      </section>

      {/* ═══ KEYBOARD SHORTCUTS MODAL ═══ */}
      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-outlined" style={{ color: 'var(--primary-container)' }}>keyboard</span>
                <h3 className="text-headline-md" style={{ color: 'var(--primary)' }}>Keyboard Shortcuts</h3>
              </div>
              <button className="btn-icon" onClick={() => setShowShortcuts(false)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="modal__body text-label-mono-md">
              {[
                ['Play / Pause', 'Space'],
                ['Step ±1 Frame', '← →'],
                ['Step ±5 Frames', 'Shift + ← / →'],
                ['Set In-Point', 'I'],
                ['Set Out-Point', 'O'],
                ['Extract Single Frame', 'E'],
                ['Batch Convert Range', '⌘ + Enter'],
              ].map(([action, key], i) => (
                <div key={i} className="shortcut-row">
                  <span style={{ color: 'var(--secondary)' }}>{action}</span>
                  <kbd className={i === 6 ? 'kbd kbd--accent' : 'kbd'}>{key}</kbd>
                </div>
              ))}
            </div>
            <div className="modal__footer">
              <button className="btn-secondary text-headline-sm" onClick={() => setShowShortcuts(false)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
