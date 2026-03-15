import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { commandRegistry } from './commands';
import { FileHandle } from './fsa';
import { focusContext } from './focusContext';
import { basename } from './path';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif', 'tiff', 'tif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v']);

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
};

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getExt(name));
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(getExt(name));
}

export function isMediaFile(name: string): boolean {
  return isImageFile(name) || isVideoFile(name);
}

export interface MediaFileEntry {
  path: string;
  name: string;
  size: number;
}

interface ImageViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  mediaFiles: MediaFileEntry[];
  onClose: () => void;
  onNavigateMedia: (file: MediaFileEntry) => void;
  /** When true, render inside a div (e.g. panel tab) instead of a modal dialog. */
  inline?: boolean;
}

export function ImageViewer({ filePath, fileName, fileSize, mediaFiles, onClose, onNavigateMedia, inline = false }: ImageViewerProps) {
  const isVideo = isVideoFile(fileName);
  const isVideoRef = useRef(isVideo);
  isVideoRef.current = isVideo;

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  // Image state
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const panXRef = useRef(panX);
  panXRef.current = panX;
  const panYRef = useRef(panY);
  panYRef.current = panY;

  // Video state
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const currentIndex = useMemo(
    () => mediaFiles.findIndex((f) => f.path === filePath),
    [mediaFiles, filePath],
  );

  // ── Dialog lifecycle ──────────────────────────────────────────────

  useEffect(() => {
    if (inline) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    focusContext.push('viewer');
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('viewer');
    };
  }, [inline, onClose]);

  useEffect(() => {
    if (objectUrl) bodyRef.current?.focus();
  }, [objectUrl]);

  // ── Reset on file change ──────────────────────────────────────────

  useEffect(() => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
    setNaturalSize(null);
    setError(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [filePath]);

  // ── File loading ──────────────────────────────────────────────────

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setObjectUrl(null);

    (async () => {
      try {
        const handle = new FileHandle(filePath, basename(filePath));
        const file = await handle.getFile();
        const buf = await file.arrayBuffer();
        if (cancelled) return;

        const ext = getExt(fileName);
        const mime = MIME_MAP[ext] || 'application/octet-stream';
        const blob = new Blob([buf], { type: mime });
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [filePath, fileName]);

  // ── Sync volume/muted to video element ────────────────────────────

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = isMuted;
    }
  }, [volume, isMuted, objectUrl]);

  // ── Image handlers ────────────────────────────────────────────────

  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    setNaturalSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(20, Math.max(0.05, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  }, []);

  const handleImgMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX: panXRef.current, panY: panYRef.current };
    if (bodyRef.current) bodyRef.current.style.cursor = 'grabbing';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const start = dragStartRef.current;
      if (!start) return;
      setPanX(start.panX + e.clientX - start.x);
      setPanY(start.panY + e.clientY - start.y);
    };
    const onUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      dragStartRef.current = null;
      if (bodyRef.current) bodyRef.current.style.cursor = 'grab';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(20, z * 1.2)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.05, z / 1.2)), []);
  const zoomFit = useCallback(() => { setZoom(1); setPanX(0); setPanY(0); }, []);

  // ── Video handlers ────────────────────────────────────────────────

  const handleVideoMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
    setDuration(v.duration);
  }, []);

  const handleTimeUpdate = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    setCurrentTime(e.currentTarget.currentTime);
  }, []);

  const togglePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  }, []);
  const togglePlayPauseRef = useRef(togglePlayPause);
  togglePlayPauseRef.current = togglePlayPause;

  const toggleMute = useCallback(() => setIsMuted((m) => !m), []);

  const seekToPosition = useCallback((clientX: number) => {
    const bar = seekBarRef.current;
    const v = videoRef.current;
    if (!bar || !v || !isFinite(v.duration)) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * v.duration;
  }, []);

  const handleSeekMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    seekToPosition(e.clientX);
    bodyRef.current?.focus();
    const onMove = (me: MouseEvent) => seekToPosition(me.clientX);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [seekToPosition]);

  const handleVideoBodyClick = useCallback(() => {
    togglePlayPauseRef.current();
  }, []);

  // ── Keyboard ──────────────────────────────────────────────────────

  const mediaFilesRef = useRef(mediaFiles);
  mediaFilesRef.current = mediaFiles;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const onNavigateMediaRef = useRef(onNavigateMedia);
  onNavigateMediaRef.current = onNavigateMedia;

  // Register media viewer commands
  useEffect(() => {
    const disposables: (() => void)[] = [];

    disposables.push(commandRegistry.registerCommand(
      'media.previousFile',
      'Previous File',
      () => {
        const idx = currentIndexRef.current;
        const files = mediaFilesRef.current;
        if (idx > 0) onNavigateMediaRef.current(files[idx - 1]);
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.previousFile',
      key: 'left',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'media.nextFile',
      'Next File',
      () => {
        const idx = currentIndexRef.current;
        const files = mediaFilesRef.current;
        if (idx >= 0 && idx < files.length - 1) onNavigateMediaRef.current(files[idx + 1]);
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.nextFile',
      key: 'right',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'media.togglePlayPause',
      'Play/Pause',
      () => {
        if (isVideoRef.current) togglePlayPauseRef.current();
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.togglePlayPause',
      key: 'space',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'media.zoomIn',
      'Zoom In / Volume Up',
      () => {
        if (isVideoRef.current) {
          setVolume((v) => Math.min(1, +(v + 0.1).toFixed(1)));
        } else {
          setZoom((z) => Math.min(20, z * 1.2));
        }
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.zoomIn',
      key: '+',
      when: 'focusViewer',
    }));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.zoomIn',
      key: '=',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'media.zoomOut',
      'Zoom Out / Volume Down',
      () => {
        if (isVideoRef.current) {
          setVolume((v) => Math.max(0, +(v - 0.1).toFixed(1)));
        } else {
          setZoom((z) => Math.max(0.05, z / 1.2));
        }
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.zoomOut',
      key: '-',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'media.resetZoom',
      'Reset Zoom / Toggle Mute',
      () => {
        if (isVideoRef.current) {
          setIsMuted((m) => !m);
        } else {
          setZoom(1);
          setPanX(0);
          setPanY(0);
        }
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'media.resetZoom',
      key: '0',
      when: 'focusViewer',
    }));

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const content = (
    <>
      <div className="file-viewer-header">
        <span style={{ flex: 1 }}>{fileName}</span>
        <button
          className="dialog-close-btn"
          onClick={() => (inline ? onClose() : dialogRef.current?.close())}
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {error ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--error-fg)' }}>{error}</div>
      ) : !objectUrl ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
      ) : isVideo ? (
        <div className="video-player-body" ref={bodyRef} tabIndex={0} onClick={handleVideoBodyClick}>
          <video
            ref={videoRef}
            src={objectUrl}
            autoPlay
            muted={isMuted}
            onLoadedMetadata={handleVideoMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />
        </div>
      ) : (
        <div
          className="image-viewer-body"
          ref={bodyRef}
          onWheel={handleWheel}
          onMouseDown={handleImgMouseDown}
          tabIndex={0}
          style={{ cursor: 'grab' }}
        >
          <img
            src={objectUrl}
            alt={fileName}
            onLoad={handleImgLoad}
            style={{
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
            draggable={false}
          />
        </div>
      )}

      {isVideo && objectUrl && (
        <div className="video-seek-row" ref={seekBarRef} onMouseDown={handleSeekMouseDown}>
          <div className="video-seek-fill" style={{ width: `${progress}%` }} />
          <div className="video-seek-thumb" style={{ left: `${progress}%` }} />
        </div>
      )}

      <div className="image-viewer-footer">
        {isVideo ? (
          <div className="video-controls">
            <button onMouseDown={preventFocus} onClick={togglePlayPause} title="Play/Pause (Space)">
              {isPlaying ? '\u23F8' : '\u25B6'}
            </button>
            <span className="video-time">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
            <button onMouseDown={preventFocus} onClick={toggleMute} title="Mute (0)">
              {isMuted ? '\u{1F507}' : '\u{1F50A}'}
            </button>
          </div>
        ) : (
          <div className="image-viewer-zoom-controls">
            <button onMouseDown={preventFocus} onClick={zoomOut} title="Zoom out (-)">−</button>
            <span className="image-viewer-zoom-label">{Math.round(zoom * 100)}%</span>
            <button onMouseDown={preventFocus} onClick={zoomIn} title="Zoom in (+)">+</button>
            <button onMouseDown={preventFocus} onClick={zoomFit} title="Reset zoom (0)">Fit</button>
          </div>
        )}
        <div className="image-viewer-info">
          {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
          {isVideo && duration > 0 && <span>{formatDuration(duration)}</span>}
          <span>{formatBytes(fileSize)}</span>
          {mediaFiles.length > 0 && (
            <span>{currentIndex >= 0 ? currentIndex + 1 : '?'} / {mediaFiles.length}</span>
          )}
        </div>
      </div>
    </>
  );

  if (inline) {
    return (
      <div className="file-viewer image-viewer-inline">
        {content}
      </div>
    );
  }

  return (
    <dialog ref={(el) => { dialogRef.current = el; }} className="file-viewer">
      {content}
    </dialog>
  );
}

function preventFocus(e: React.MouseEvent) {
  e.preventDefault();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
