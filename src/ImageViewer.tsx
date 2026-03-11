import { useEffect, useRef, useState, useCallback } from 'react';
import { FileHandle } from './fsa';
import { basename } from './path';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif', 'tiff', 'tif']);

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
};

export function isImageFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

interface ImageViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
}

export function ImageViewer({ filePath, fileName, fileSize, onClose }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  useEffect(() => {
    if (objectUrl) bodyRef.current?.focus();
  }, [objectUrl]);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    (async () => {
      try {
        const handle = new FileHandle(filePath, basename(filePath));
        const file = await handle.getFile();
        const buf = await file.arrayBuffer();
        if (cancelled) return;

        const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
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

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(10, Math.max(0.1, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(10, z * 1.2));
    else if (e.key === '-') setZoom((z) => Math.max(0.1, z / 1.2));
    else if (e.key === '0') setZoom(1);
  }, []);

  return (
    <dialog ref={dialogRef} className="file-viewer" onKeyDown={handleKeyDown}>
      <div className="file-viewer-header">
        <span style={{ flex: 1 }}>{fileName}</span>
        <span>{formatBytes(fileSize)}</span>
        {naturalSize && <span style={{ marginLeft: 12 }}>{naturalSize.w} × {naturalSize.h}</span>}
        <span style={{ marginLeft: 12 }}>{Math.round(zoom * 100)}%</span>
      </div>
      {error ? (
        <div className="file-viewer-scanning">{error}</div>
      ) : !objectUrl ? (
        <div className="file-viewer-scanning">Loading…</div>
      ) : (
        <div className="image-viewer-body" ref={bodyRef} onWheel={handleWheel} tabIndex={0}>
          <img
            src={objectUrl}
            alt={fileName}
            onLoad={handleLoad}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            draggable={false}
          />
        </div>
      )}
    </dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
