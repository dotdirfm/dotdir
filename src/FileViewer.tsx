import { useCallback, useEffect, useRef, useState } from 'react';
import { commandRegistry } from './commands';
import { DirectoryHandle, FileHandle, FileSystemObserver } from './fsa';
import { focusContext } from './focusContext';
import { basename, dirname } from './path';

const LINE_HEIGHT = 20;
const CHUNK_SIZE = 65536; // 64KB
const BACKWARD_SEARCH_INITIAL = 256;
const BACKWARD_SEARCH_MAX = 8192;

interface FileViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
  /** When true, render inside a div (e.g. panel tab) instead of a modal dialog. */
  inline?: boolean;
}

interface ScreenLine {
  text: string;
  byteStart: number;
  byteEnd: number;
  wrapOffset: number;
}

interface ChunkCache {
  offset: number;
  length: number;
  data: Uint8Array;
}

async function readChunkAt(file: File, offset: number, length: number): Promise<Uint8Array> {
  const clamped = Math.min(length, file.size - offset);
  if (clamped <= 0) return new Uint8Array(0);
  const buf = await file.slice(offset, offset + clamped).arrayBuffer();
  return new Uint8Array(buf);
}

export function FileViewer({ filePath, fileName, fileSize, onClose, inline = false }: FileViewerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const charMeasureRef = useRef<HTMLSpanElement>(null);

  const fileRef = useRef<File | null>(null);
  const fileSizeRef = useRef(fileSize);
  const screenLinesRef = useRef<ScreenLine[]>([]);
  const filePosRef = useRef(0);
  const viewportRowsRef = useRef(30);
  const viewportColsRef = useRef(120);
  const charWidthRef = useRef(7.8);
  const chunkCacheRef = useRef<ChunkCache | null>(null);
  const avgBytesPerLineRef = useRef(80);
  const atEndRef = useRef(false);

  const [screenLines, setScreenLines] = useState<ScreenLine[]>([]);
  const [displayedSize, setDisplayedSize] = useState(fileSize);
  const [wrap, setWrap] = useState(false);
  const [ready, setReady] = useState(false);

  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;

  const getCachedBytes = useCallback(async (file: File, offset: number, length: number): Promise<Uint8Array> => {
    const cache = chunkCacheRef.current;
    if (cache && offset >= cache.offset && offset + length <= cache.offset + cache.length) {
      return cache.data.subarray(offset - cache.offset, offset - cache.offset + length);
    }
    const readStart = Math.max(0, offset - CHUNK_SIZE / 2);
    const readLen = Math.min(CHUNK_SIZE * 2, file.size - readStart);
    const data = await readChunkAt(file, readStart, readLen);
    chunkCacheRef.current = { offset: readStart, length: data.length, data };
    const s = offset - readStart;
    const e = Math.min(s + length, data.length);
    return data.subarray(s, e);
  }, []);

  const decoderRef = useRef(new TextDecoder());

  function splitBytesToLines(bytes: Uint8Array, baseOffset: number): { text: string; byteStart: number; byteEnd: number }[] {
    const lines: { text: string; byteStart: number; byteEnd: number }[] = [];
    let lineStart = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x0A) {
        const text = decoderRef.current.decode(bytes.subarray(lineStart, i));
        lines.push({
          text,
          byteStart: baseOffset + lineStart,
          byteEnd: baseOffset + (i < bytes.length ? i + 1 : i),
        });
        lineStart = i + 1;
      }
    }
    return lines;
  }

  function wrapLine(line: { text: string; byteStart: number; byteEnd: number }, cols: number): ScreenLine[] {
    if (!wrapRef.current || line.text.length <= cols) {
      return [{ ...line, wrapOffset: 0 }];
    }
    const segments: ScreenLine[] = [];
    for (let i = 0; i < line.text.length; i += cols) {
      segments.push({
        text: line.text.slice(i, i + cols),
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
        wrapOffset: i,
      });
    }
    return segments;
  }

  const fillScreen = useCallback(async (file: File, fromByte: number, rowCount: number): Promise<ScreenLine[]> => {
    if (file.size === 0) return [];
    const cols = viewportColsRef.current;
    const lines: ScreenLine[] = [];
    let offset = Math.max(0, Math.min(fromByte, file.size));

    let readLen = Math.max(avgBytesPerLineRef.current * rowCount * 3, 4096);
    let attempts = 0;

    while (lines.length < rowCount && offset < file.size && attempts < 3) {
      const bytes = await getCachedBytes(file, offset, readLen);
      if (bytes.length === 0) break;

      const rawLines = splitBytesToLines(bytes, offset);

      for (const raw of rawLines) {
        const wrapped = wrapLine(raw, cols);
        for (const sl of wrapped) {
          lines.push(sl);
          if (lines.length >= rowCount) break;
        }
        if (lines.length >= rowCount) break;
      }

      const lastLine = rawLines[rawLines.length - 1];
      if (lastLine) {
        offset = lastLine.byteEnd;
      } else {
        break;
      }
      readLen *= 2;
      attempts++;
    }

    const result = lines.slice(0, rowCount);

    if (result.length > 0) {
      const lastSl = result[result.length - 1];
      const bytesUsed = lastSl.byteEnd - fromByte;
      const newAvg = bytesUsed / result.length;
      avgBytesPerLineRef.current = avgBytesPerLineRef.current * 0.7 + newAvg * 0.3;
    }

    return result;
  }, [getCachedBytes]);

  const findPrevLineStart = useCallback(async (file: File, beforeByte: number): Promise<number> => {
    if (beforeByte <= 0) return 0;
    let searchLen = BACKWARD_SEARCH_INITIAL;
    while (searchLen <= BACKWARD_SEARCH_MAX) {
      const start = Math.max(0, beforeByte - searchLen);
      const len = beforeByte - start;
      const bytes = await getCachedBytes(file, start, len);

      for (let i = bytes.length - 2; i >= 0; i--) {
        if (bytes[i] === 0x0A) {
          return start + i + 1;
        }
      }
      if (start === 0) return 0;
      searchLen *= 2;
    }
    return 0;
  }, [getCachedBytes]);

  const updateThumb = useCallback((filePos: number) => {
    const thumb = thumbRef.current;
    const track = scrollbarRef.current;
    if (!thumb || !track) return;

    const fSize = fileSizeRef.current;
    if (fSize === 0) {
      thumb.style.display = 'none';
      return;
    }
    thumb.style.display = '';

    const trackH = track.clientHeight;
    const estimatedTotal = fSize / avgBytesPerLineRef.current;
    const thumbH = Math.max(20, Math.min(trackH, (viewportRowsRef.current / estimatedTotal) * trackH));
    const scrollableRange = trackH - thumbH;
    const ratio = Math.min(1, filePos / Math.max(1, fSize));
    const top = ratio * scrollableRange;

    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${top}px`;
  }, []);

  const commitScreen = useCallback((lines: ScreenLine[], filePos: number) => {
    screenLinesRef.current = lines;
    filePosRef.current = filePos;
    atEndRef.current = lines.length > 0 && lines[lines.length - 1].byteEnd >= fileSizeRef.current;
    setScreenLines([...lines]);
    updateThumb(filePos);
  }, [updateThumb]);

  const seekTo = useCallback(async (targetByte: number) => {
    const file = fileRef.current;
    if (!file) return;

    let adjustedPos: number;
    if (targetByte <= 0) {
      adjustedPos = 0;
    } else if (targetByte >= file.size) {
      adjustedPos = file.size;
      const rows = viewportRowsRef.current;
      for (let i = 0; i < rows; i++) {
        adjustedPos = await findPrevLineStart(file, adjustedPos);
        if (adjustedPos === 0) break;
      }
    } else {
      adjustedPos = await findPrevLineStart(file, targetByte + 1);
    }

    const lines = await fillScreen(file, adjustedPos, viewportRowsRef.current);
    commitScreen(lines, adjustedPos);
  }, [fillScreen, findPrevLineStart, commitScreen]);

  const scrollDown = useCallback(async (count: number) => {
    const file = fileRef.current;
    if (!file) return;
    const current = screenLinesRef.current;
    if (current.length === 0) return;

    if (current[current.length - 1].byteEnd >= file.size) return;

    if (count >= viewportRowsRef.current) {
      const lastLine = current[current.length - 1];
      const newPos = lastLine.byteStart;
      const lines = await fillScreen(file, newPos, viewportRowsRef.current);
      commitScreen(lines, newPos);
    } else {
      const remaining = current.slice(count);
      const appendFrom = current[current.length - 1].byteEnd;
      const newLines = await fillScreen(file, appendFrom, count);

      const allLines = [...remaining, ...newLines].slice(0, viewportRowsRef.current);
      const newPos = allLines.length > 0 ? allLines[0].byteStart : filePosRef.current;
      commitScreen(allLines, newPos);
    }
  }, [fillScreen, commitScreen]);

  const scrollUp = useCallback(async (count: number) => {
    const file = fileRef.current;
    if (!file) return;
    const current = screenLinesRef.current;
    if (current.length === 0) return;
    if (filePosRef.current === 0 && (current.length === 0 || current[0].wrapOffset === 0)) return;

    if (count >= viewportRowsRef.current) {
      let pos = filePosRef.current;
      const cols = viewportColsRef.current;

      if (wrapRef.current) {
        const logicalLines: { text: string; byteStart: number; byteEnd: number }[] = [];
        let totalScreenLines = 0;
        let walkPos = pos;
        const needed = viewportRowsRef.current;

        while (totalScreenLines < needed && walkPos > 0) {
          const prevStart = await findPrevLineStart(file, walkPos);
          const lineBytes = await getCachedBytes(file, prevStart, walkPos - prevStart);
          const text = decoderRef.current.decode(lineBytes).replace(/\n$/, '');
          const screenCount = Math.max(1, Math.ceil(text.length / cols));
          logicalLines.unshift({ text, byteStart: prevStart, byteEnd: walkPos });
          totalScreenLines += screenCount;
          walkPos = prevStart;
        }

        const allWrapped: ScreenLine[] = [];
        for (const ll of logicalLines) {
          const wrapped = wrapLine(ll, cols);
          allWrapped.push(...wrapped);
        }
        const startIdx = Math.max(0, allWrapped.length - needed);
        const result = allWrapped.slice(startIdx, startIdx + needed);
        const newPos = result.length > 0 ? result[0].byteStart : 0;
        commitScreen(result, newPos);
      } else {
        for (let i = 0; i < count; i++) {
          pos = await findPrevLineStart(file, pos);
          if (pos === 0) break;
        }
        const lines = await fillScreen(file, pos, viewportRowsRef.current);
        commitScreen(lines, pos);
      }
    } else {
      const cols = viewportColsRef.current;
      const prepended: ScreenLine[] = [];

      if (wrapRef.current && current.length > 0 && current[0].wrapOffset > 0) {
        const firstLine = current[0];
        const lineBytes = await getCachedBytes(file, firstLine.byteStart, firstLine.byteEnd - firstLine.byteStart);
        const fullText = decoderRef.current.decode(lineBytes).replace(/\n$/, '');
        const allSegments = wrapLine({ text: fullText, byteStart: firstLine.byteStart, byteEnd: firstLine.byteEnd }, cols);
        const curIdx = allSegments.findIndex(s => s.wrapOffset === firstLine.wrapOffset);
        const startIdx = Math.max(0, curIdx - count);
        const toAdd = allSegments.slice(startIdx, curIdx);
        prepended.push(...toAdd);
        const still = count - toAdd.length;
        if (still > 0 && firstLine.byteStart > 0) {
          let walkPos = firstLine.byteStart;
          for (let i = 0; i < still && walkPos > 0;) {
            const prevStart = await findPrevLineStart(file, walkPos);
            const lineBytes2 = await getCachedBytes(file, prevStart, walkPos - prevStart);
            const text = decoderRef.current.decode(lineBytes2).replace(/\n$/, '');
            const segments = wrapLine({ text, byteStart: prevStart, byteEnd: walkPos }, cols);
            const take = Math.min(segments.length, still - i);
            prepended.unshift(...segments.slice(segments.length - take));
            i += take;
            walkPos = prevStart;
          }
        }
      } else {
        let walkPos = filePosRef.current;
        for (let i = 0; i < count && walkPos > 0;) {
          const prevStart = await findPrevLineStart(file, walkPos);
          if (wrapRef.current) {
            const lineBytes = await getCachedBytes(file, prevStart, walkPos - prevStart);
            const text = decoderRef.current.decode(lineBytes).replace(/\n$/, '');
            const segments = wrapLine({ text, byteStart: prevStart, byteEnd: walkPos }, cols);
            const take = Math.min(segments.length, count - i);
            prepended.unshift(...segments.slice(segments.length - take));
            i += take;
          } else {
            const lineBytes = await getCachedBytes(file, prevStart, walkPos - prevStart);
            const text = decoderRef.current.decode(lineBytes).replace(/\n$/, '');
            prepended.unshift({ text, byteStart: prevStart, byteEnd: walkPos, wrapOffset: 0 });
            i++;
          }
          walkPos = prevStart;
        }
      }

      const allLines = [...prepended, ...current].slice(0, viewportRowsRef.current);
      const newPos = allLines.length > 0 ? allLines[0].byteStart : 0;
      commitScreen(allLines, newPos);
    }
  }, [fillScreen, findPrevLineStart, commitScreen, getCachedBytes]);

  const measureViewport = useCallback(() => {
    const body = bodyRef.current;
    const measure = charMeasureRef.current;
    if (!body || !measure) return;

    const textEl = body;
    const h = textEl.clientHeight;
    const rows = Math.max(1, Math.floor(h / LINE_HEIGHT));
    viewportRowsRef.current = rows;

    const cw = measure.getBoundingClientRect().width / 10;
    if (cw > 0) {
      charWidthRef.current = cw;
      const textWidth = textEl.clientWidth - 24;
      viewportColsRef.current = Math.max(10, Math.floor(textWidth / cw));
    }
  }, []);

  const doLoad = useCallback(async () => {
    const handle = new FileHandle(filePath, basename(filePath));
    const file = await handle.getFile();
    fileRef.current = file;
    fileSizeRef.current = file.size;
    setDisplayedSize(file.size);
    chunkCacheRef.current = null;

    measureViewport();
    const lines = await fillScreen(file, 0, viewportRowsRef.current);
    commitScreen(lines, 0);
    setReady(true);
  }, [filePath, fillScreen, commitScreen, measureViewport]);

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
    requestAnimationFrame(() => {
      measureViewport();
      doLoad();
    });
  }, [doLoad, measureViewport]);

  const initialFocusDoneRef = useRef(false);
  useEffect(() => {
    if (ready && !initialFocusDoneRef.current) {
      initialFocusDoneRef.current = true;
      bodyRef.current?.focus();
    }
  }, [ready]);

  useEffect(() => {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const debounceRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };

    const observer = new FileSystemObserver((records) => {
      const relevant = records.some(
        (r) => r.relativePathComponents[0] === name && (r.type === 'modified' || r.type === 'appeared'),
      );
      if (!relevant) return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        debounceRef.current = null;

        const wasAtEnd = atEndRef.current;
        const prevPos = filePosRef.current;

        const handle = new FileHandle(filePath, basename(filePath));
        const file = await handle.getFile();
        fileRef.current = file;
        fileSizeRef.current = file.size;
        setDisplayedSize(file.size);
        chunkCacheRef.current = null;

        if (wasAtEnd) {
          let pos = file.size;
          const rows = viewportRowsRef.current;
          for (let i = 0; i < rows; i++) {
            pos = await findPrevLineStart(file, pos);
            if (pos === 0) break;
          }
          const lines = await fillScreen(file, pos, rows);
          commitScreen(lines, pos);
        } else {
          const pos = Math.min(prevPos, file.size);
          const lines = await fillScreen(file, pos, viewportRowsRef.current);
          commitScreen(lines, pos);
        }
      }, 150);
    });

    observer.observe(new DirectoryHandle(dir));

    return () => {
      observer.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [filePath, fillScreen, findPrevLineStart, commitScreen]);

  // Keep refs to functions for command handlers
  const scrollDownRef = useRef(scrollDown);
  scrollDownRef.current = scrollDown;
  const scrollUpRef = useRef(scrollUp);
  scrollUpRef.current = scrollUp;
  const seekToRef = useRef(seekTo);
  seekToRef.current = seekTo;

  // Register viewer commands
  useEffect(() => {
    const disposables: (() => void)[] = [];

    disposables.push(commandRegistry.registerCommand(
      'viewer.scrollDown',
      'Scroll Down',
      () => scrollDownRef.current(1),
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.scrollDown',
      key: 'down',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'viewer.scrollUp',
      'Scroll Up',
      () => scrollUpRef.current(1),
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.scrollUp',
      key: 'up',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'viewer.scrollPageDown',
      'Scroll Page Down',
      () => scrollDownRef.current(viewportRowsRef.current),
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.scrollPageDown',
      key: 'pagedown',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'viewer.scrollPageUp',
      'Scroll Page Up',
      () => scrollUpRef.current(viewportRowsRef.current),
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.scrollPageUp',
      key: 'pageup',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'viewer.scrollToTop',
      'Scroll to Top',
      () => seekToRef.current(0),
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.scrollToTop',
      key: 'home',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'viewer.scrollToBottom',
      'Scroll to Bottom',
      () => seekToRef.current(fileSizeRef.current),
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.scrollToBottom',
      key: 'end',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'viewer.toggleWrap',
      'Toggle Word Wrap',
      () => {
        setWrap(prev => {
          const next = !prev;
          wrapRef.current = next;
          const file = fileRef.current;
          if (file) {
            measureViewport();
            fillScreen(file, filePosRef.current, viewportRowsRef.current).then(lines => {
              commitScreen(lines, filePosRef.current);
            });
          }
          return next;
        });
      },
      { when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'viewer.toggleWrap',
      key: 'f2',
      when: 'focusViewer',
    }));

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [fillScreen, commitScreen, measureViewport]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const lines = Math.round(e.deltaY / LINE_HEIGHT);
    if (lines > 0) {
      scrollDown(Math.max(1, lines));
    } else if (lines < 0) {
      scrollUp(Math.max(1, -lines));
    }
  }, [scrollDown, scrollUp]);

  const onThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const track = scrollbarRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;

    const startY = e.clientY;
    const startTop = thumb.offsetTop;
    const trackH = track.clientHeight;
    const thumbH = thumb.offsetHeight;
    const scrollableRange = trackH - thumbH;

    const onMove = (me: MouseEvent) => {
      const dy = me.clientY - startY;
      const newTop = Math.max(0, Math.min(scrollableRange, startTop + dy));
      const ratio = scrollableRange > 0 ? newTop / scrollableRange : 0;
      const targetByte = Math.round(ratio * fileSizeRef.current);
      seekTo(targetByte);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [seekTo]);

  const onTrackClick = useCallback((e: React.MouseEvent) => {
    if (e.target === thumbRef.current) return;
    const track = scrollbarRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const thumbTop = thumb.offsetTop;
    const thumbH = thumb.offsetHeight;

    if (clickY < thumbTop) {
      scrollUp(viewportRowsRef.current);
    } else if (clickY > thumbTop + thumbH) {
      scrollDown(viewportRowsRef.current);
    }
  }, [scrollUp, scrollDown]);

  const header = (
    <div className="file-viewer-header">
      <span style={{ flex: 1 }}>{fileName}</span>
      {wrap && <span style={{ marginLeft: 12 }}>Wrap</span>}
      <span style={{ marginLeft: 12 }}>{displayedSize > 0 ? formatBytes(displayedSize) : '0 B'}</span>
      <button
        className="dialog-close-btn"
        onClick={() => (inline ? onClose() : dialogRef.current?.close())}
        title="Close (Esc)"
      >
        ×
      </button>
    </div>
  );

  const body = (
    <>
      <div
        className="file-viewer-body"
        style={inline ? { flex: 1, minHeight: 0, display: 'flex' } : undefined}
      >
        <div
          className="file-viewer-text"
          ref={bodyRef}
          tabIndex={0}
          onWheel={onWheel}
        >
          <span
            ref={charMeasureRef}
            style={{
              position: 'absolute',
              visibility: 'hidden',
              whiteSpace: 'pre',
              fontFamily: 'monospace',
              fontSize: '13px',
            }}
          >
            MMMMMMMMMM
          </span>
          {screenLines.map((line, i) => (
            <div key={i} className="file-viewer-line">
              {line.text || '\u00A0'}
            </div>
          ))}
        </div>
        <div
          className="file-viewer-scrollbar"
          ref={scrollbarRef}
          onMouseDown={onTrackClick}
        >
          <div
            className="file-viewer-thumb"
            ref={thumbRef}
            onMouseDown={onThumbMouseDown}
          />
        </div>
      </div>
    </>
  );

  if (inline) {
    return (
      <div
        ref={(el) => {
          containerRef.current = el;
        }}
        className="file-viewer file-viewer-inline"
      >
        {header}
        {body}
      </div>
    );
  }

  return (
    <dialog
      ref={(el) => {
        dialogRef.current = el;
      }}
      className="file-viewer"
    >
      {header}
      {body}
    </dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
