import { useEffect, useRef } from "react";
import type { DotDirGlobalApi, ViewerExtensionApi, ViewerProps } from "@/features/extensions/extensionApi";

const SCROLLBAR_WIDTH = 10;
const SCROLLBAR_PADDING = 6;
const TAB_SIZE = 8;
const LINE_HEIGHT_RATIO = 1.5;
const BLOCK_SIZE = 64 * 1024;
const BACKWARD_SEARCH_MAX = 100_000;

type EncodingId = "ascii" | "utf-8" | "windows-1251" | "koi8-r" | "iso-8859-1";

interface Seg {
  text: string;
  style?: string;
}

interface GridLine {
  text: string;
  byteStart: number;
  byteEnd: number;
  charOffsets: number[];
}

interface FileViewerSurfaceProps {
  hostApi: DotDirGlobalApi;
  props: ViewerProps;
  active?: boolean;
  onInteract?: () => void;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

const hex8 = (value: number) => value.toString(16).toUpperCase().padStart(8, "0");
const hex2 = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

function createFileViewerExtensionApi(hostApi: DotDirGlobalApi): ViewerExtensionApi {
  let mounted = false;
  let path = "";
  let fileSize = 0;
  let dpyStart = 0;
  let wrapMode = true;
  let dpyParagraphSkipLines = 0;
  let dpyTextColumn = 0;
  let hexMode = false;
  let hexCursor = 0;
  let bytesPerLine = 16;
  let encoding: EncodingId = "ascii";
  let singleByteDecoder: TextDecoder | null = null;
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  let inputBarMode: "search" | "goto" | null = null;
  let searchQuery = "";
  let searchMatchStart = -1;
  let searchMatchEnd = -1;
  let searchCaseSensitive = true;

  let charW = 8;
  let charH = 16;
  let rowH = 24;
  let rows = 20;
  let cols = 80;

  let frameDiv: HTMLDivElement | null = null;
  let contentDiv: HTMLDivElement | null = null;
  let statusDiv: HTMLDivElement | null = null;
  let inputBarDiv: HTMLDivElement | null = null;
  let inputBarInput: HTMLInputElement | null = null;
  let inputBarLabel: HTMLSpanElement | null = null;
  let inputBarStatus: HTMLSpanElement | null = null;
  let inputBarCase: HTMLInputElement | null = null;
  let scrollbarTrack: HTMLDivElement | null = null;
  let scrollbarThumb: HTMLDivElement | null = null;
  let hexBtn: HTMLButtonElement | null = null;
  let wrapChk: HTMLInputElement | null = null;
  let rootEl: HTMLElement | null = null;

  let resizeHandler: (() => void) | null = null;
  let wheelHandler: ((event: WheelEvent) => void) | null = null;
  let ptrMoveHandler: ((event: PointerEvent) => void) | null = null;
  let ptrUpHandler: ((event: PointerEvent) => void) | null = null;
  let inputKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  let commandDisposers: Array<{ dispose: () => void }> = [];
  let inertiaFrame: number | null = null;
  let lastTouchY = 0;
  let lastTouchTime = 0;
  let touchVelocity = 0;
  let dragging = false;
  let dragOffsetY = 0;
  let lastEndByte = 0;

  let cacheOff = -1;
  let cacheBuf: Uint8Array | null = null;
  let cacheLen = 0;
  let disposeFileChange: (() => void) | null = null;

  function clamp(value: number) {
    return fileSize <= 0 ? 0 : Math.max(0, Math.min(value, fileSize - 1));
  }

  function disposeCommands() {
    for (const disposable of commandDisposers) {
      try {
        disposable.dispose();
      } catch {
        // ignore
      }
    }
    commandDisposers = [];
  }

  async function readRange(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(await hostApi.readFileRange(path, offset, length));
  }

  async function loadBlock(index: number) {
    const blockOffset = Math.max(0, Math.min(fileSize, Math.floor(index / BLOCK_SIZE) * BLOCK_SIZE));
    if (cacheBuf && cacheOff === blockOffset) return;
    const block = await readRange(blockOffset, BLOCK_SIZE);
    cacheOff = blockOffset;
    cacheBuf = block;
    cacheLen = block.length;
  }

  async function getByte(index: number): Promise<number | null> {
    if (index < 0 || index >= fileSize) return null;
    await loadBlock(index);
    if (!cacheBuf) return null;
    const localIndex = index - cacheOff;
    return localIndex >= 0 && localIndex < cacheLen ? cacheBuf[localIndex]! : null;
  }

  async function peekBytes(index: number, count: number): Promise<Uint8Array> {
    const out = new Uint8Array(Math.min(count, Math.max(0, fileSize - index)));
    for (let i = 0; i < out.length; i++) {
      const byte = await getByte(index + i);
      if (byte == null) return out.subarray(0, i);
      out[i] = byte;
    }
    return out;
  }

  function setEnc(nextEncoding: EncodingId) {
    encoding = nextEncoding;
    singleByteDecoder = nextEncoding === "ascii" || nextEncoding === "utf-8" ? null : new TextDecoder(nextEncoding);
  }

  function asciiChar(byte: number): string {
    return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }

  async function readCharAt(index: number): Promise<{ ch: string; len: number; nl: boolean }> {
    const first = await getByte(index);
    if (first == null) return { ch: " ", len: 0, nl: true };
    if (first === 0x0a) return { ch: "\n", len: 1, nl: true };
    if (first === 0x0d) {
      return {
        ch: "\n",
        len: (await getByte(index + 1)) === 0x0a ? 2 : 1,
        nl: true,
      };
    }
    if (first === 0x09) return { ch: "\t", len: 1, nl: false };
    if (encoding === "ascii") return { ch: asciiChar(first), len: 1, nl: false };
    if (encoding === "utf-8") {
      if (first < 0x80) return { ch: String.fromCharCode(first), len: 1, nl: false };
      let seqLen = 2;
      if (first >= 0xf0) seqLen = 4;
      else if (first >= 0xe0) seqLen = 3;
      const bytes = await peekBytes(index, seqLen);
      try {
        const text = utf8Decoder.decode(bytes);
        if (text.length > 0) return { ch: text, len: seqLen, nl: false };
      } catch {
        // ignore
      }
      return { ch: "\ufffd", len: 1, nl: false };
    }
    if (!singleByteDecoder) singleByteDecoder = new TextDecoder(encoding);
    const text = singleByteDecoder.decode(new Uint8Array([first]));
    return { ch: text || "\ufffd", len: 1, nl: false };
  }

  async function findPrevLine(before: number): Promise<number> {
    if (before <= 0) return 0;
    let searchLength = 256;
    while (searchLength <= BACKWARD_SEARCH_MAX) {
      const start = Math.max(0, before - searchLength);
      const bytes = await readRange(start, before - start);
      for (let i = bytes.length - 2; i >= 0; i--) {
        if (bytes[i] === 0x0a) return start + i + 1;
      }
      if (start === 0) return 0;
      searchLength *= 2;
    }
    return 0;
  }

  async function buildLine(start: number, maxColumns: number, wrap: boolean, skip = 0): Promise<GridLine> {
    let out = "";
    let column = 0;
    let pos = start;
    const charOffsets: number[] = [];
    const total = wrap ? maxColumns : maxColumns + skip;

    while (column < total && pos < fileSize) {
      const result = await readCharAt(pos);
      if (result.len === 0) break;
      if (result.nl) {
        pos += result.len;
        break;
      }
      if (result.ch === "\t") {
        const spaces = TAB_SIZE - (column % TAB_SIZE);
        for (let i = 0; i < spaces && column < total; i++) {
          if (column >= skip) {
            out += " ";
            charOffsets.push(pos);
          }
          column++;
        }
        pos += result.len;
        continue;
      }
      if (column >= skip) {
        out += result.ch;
        charOffsets.push(pos);
      }
      column++;
      pos += result.len;
    }

    if (!wrap) {
      while (pos < fileSize) {
        const byte = await getByte(pos);
        if (byte == null) break;
        if (byte === 0x0a) {
          pos++;
          break;
        }
        if (byte === 0x0d) {
          pos += (await getByte(pos + 1)) === 0x0a ? 2 : 1;
          break;
        }
        pos++;
      }
    }

    while (out.length < maxColumns) {
      out += " ";
      charOffsets.push(-1);
    }

    return { text: out, byteStart: start, byteEnd: pos, charOffsets };
  }

  async function textGrid(): Promise<GridLine[]> {
    const lines: GridLine[] = [];
    let pos = dpyStart;
    const skip = wrapMode ? 0 : dpyTextColumn;

    if (wrapMode && dpyParagraphSkipLines > 0) {
      for (let i = 0; i < dpyParagraphSkipLines; i++) {
        const line = await buildLine(pos, cols, true);
        if (line.byteEnd === pos) break;
        pos = line.byteEnd;
        if (pos >= fileSize) break;
      }
    }
    for (let row = 0; row < rows; row++) {
      const line = await buildLine(pos, cols, wrapMode, skip);
      lines.push(line);
      pos = line.byteEnd;
      if (pos >= fileSize) break;
    }
    return lines;
  }

  function calcBytesPerLine(columnCount: number): number {
    if (columnCount < 26) return 4;
    return Math.max(4, 4 * Math.floor((columnCount - 9) / (columnCount <= 80 ? 17 : 18)));
  }

  function highlightStyle(index: number): string | undefined {
    if (hexMode && index === hexCursor) return "background:var(--fg);color:var(--bg);";
    if (searchMatchStart >= 0 && index >= searchMatchStart && index < searchMatchEnd) {
      return "background:var(--search-hl, #c6a800);color:var(--search-hl-fg, #000);";
    }
    return undefined;
  }

  async function hexLineSegments(offset: number): Promise<Seg[]> {
    const segments: Seg[] = [];
    const bytes: Array<number | null> = [];
    for (let i = 0; i < bytesPerLine; i++) {
      bytes.push(offset + i < fileSize ? await getByte(offset + i) : null);
    }

    segments.push({ text: `${hex8(offset)}  ` });
    for (let i = 0; i < bytesPerLine; i++) {
      if (i > 0 && i % 4 === 0) segments.push({ text: " " });
      const byte = bytes[i];
      segments.push({
        text: byte != null ? hex2(byte) : "  ",
        style: byte != null ? highlightStyle(offset + i) : undefined,
      });
      if (i < bytesPerLine - 1) segments.push({ text: " " });
    }

    segments.push({ text: "  " });
    for (let i = 0; i < bytesPerLine; i++) {
      const byte = bytes[i];
      segments.push({
        text: byte != null ? asciiChar(byte) : " ",
        style: byte != null ? highlightStyle(offset + i) : undefined,
      });
    }

    return mergeSegments(segments);
  }

  function mergeSegments(segments: Seg[]): Seg[] {
    const merged: Seg[] = [];
    for (const segment of segments) {
      const last = merged[merged.length - 1];
      if (last && last.style === segment.style) {
        last.text += segment.text;
      } else {
        merged.push({ ...segment });
      }
    }
    return merged;
  }

  function textLineSegments(line: GridLine): Seg[] {
    if (searchMatchStart < 0) return [{ text: line.text }];
    const segments: Seg[] = [];
    let current = "";
    let currentStyle: string | undefined;
    for (let i = 0; i < line.text.length; i++) {
      const byteOffset = line.charOffsets[i]!;
      const style =
        byteOffset >= 0 && byteOffset >= searchMatchStart && byteOffset < searchMatchEnd
          ? "background:var(--search-hl, #c6a800);color:var(--search-hl-fg, #000);"
          : undefined;
      if (style !== currentStyle) {
        if (current) segments.push({ text: current, style: currentStyle });
        current = line.text[i]!;
        currentStyle = style;
      } else {
        current += line.text[i]!;
      }
    }
    if (current) segments.push({ text: current, style: currentStyle });
    return segments;
  }

  function bytesEqual(data: Uint8Array, offset: number, query: Uint8Array, caseSensitive: boolean): boolean {
    for (let i = 0; i < query.length; i++) {
      let left = data[offset + i]!;
      let right = query[i]!;
      if (!caseSensitive) {
        if (left >= 0x41 && left <= 0x5a) left += 0x20;
        if (right >= 0x41 && right <= 0x5a) right += 0x20;
      }
      if (left !== right) return false;
    }
    return true;
  }

  async function searchForward(from: number, query: Uint8Array, caseSensitive: boolean): Promise<number> {
    const overlap = query.length - 1;
    let pos = from;
    while (pos < fileSize) {
      const len = Math.min(BLOCK_SIZE, fileSize - pos);
      const data = await readRange(pos, len);
      for (let i = 0; i <= data.length - query.length; i++) {
        if (bytesEqual(data, i, query, caseSensitive)) return pos + i;
      }
      if (len < BLOCK_SIZE) break;
      pos += len - overlap;
    }
    return -1;
  }

  async function searchBackward(from: number, query: Uint8Array, caseSensitive: boolean): Promise<number> {
    let high = from;
    while (high > 0) {
      const low = Math.max(0, high - BLOCK_SIZE);
      const readLen = Math.min(high - low + query.length - 1, fileSize - low);
      const data = await readRange(low, readLen);
      const maxIndex = Math.min(high - 1 - low, data.length - query.length);
      for (let i = maxIndex; i >= 0; i--) {
        if (bytesEqual(data, i, query, caseSensitive)) return low + i;
      }
      high = low;
    }
    return -1;
  }

  async function findLineOffset(lineNumber: number): Promise<number> {
    let current = 1;
    let pos = 0;
    while (pos < fileSize && current < lineNumber) {
      const byte = await getByte(pos);
      if (byte == null) break;
      if (byte === 0x0a) current++;
      pos++;
    }
    return pos;
  }

  function renderSegments(segments: Seg[], parent: HTMLElement) {
    const div = document.createElement("div");
    div.style.cssText = `white-space:pre;line-height:${LINE_HEIGHT_RATIO};height:${rowH}px;`;
    if (segments.length === 1 && !segments[0]!.style) {
      div.textContent = segments[0]!.text;
    } else {
      for (const segment of segments) {
        if (segment.style) {
          const span = document.createElement("span");
          span.style.cssText = segment.style;
          span.textContent = segment.text;
          div.appendChild(span);
        } else {
          div.appendChild(document.createTextNode(segment.text));
        }
      }
    }
    parent.appendChild(div);
  }

  function updateThumb() {
    if (!scrollbarTrack || !scrollbarThumb) return;
    const trackHeight = scrollbarTrack.clientHeight;
    if (trackHeight <= 0 || fileSize <= 0) {
      scrollbarThumb.style.display = "none";
      return;
    }
    const visibleBytes = Math.max(1, rows * (hexMode ? bytesPerLine : cols));
    const thumbHeight = Math.max(18, Math.floor((visibleBytes / Math.max(visibleBytes, fileSize)) * trackHeight));
    const maxOffset = Math.max(0, fileSize - visibleBytes);
    const position = maxOffset === 0 ? 0 : dpyStart / maxOffset;
    scrollbarThumb.style.height = `${thumbHeight}px`;
    scrollbarThumb.style.top = `${Math.floor((trackHeight - thumbHeight) * Math.max(0, Math.min(1, position)))}px`;
    scrollbarThumb.style.display = "block";
  }

  function stopInertia() {
    if (inertiaFrame != null) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    }
    touchVelocity = 0;
  }

  async function mountViewer(root: HTMLElement, props: ViewerProps): Promise<void> {
    path = props.filePath;
    fileSize = props.fileSize;
    try {
      const stat = await hostApi.statFile(path);
      fileSize = stat.size;
    } catch {
      // ignore
    }

    dpyStart = 0;
    wrapMode = true;
    dpyParagraphSkipLines = 0;
    dpyTextColumn = 0;
    hexMode = false;
    hexCursor = 0;
    cacheOff = -1;
    cacheBuf = null;
    cacheLen = 0;
    searchMatchStart = -1;
    searchMatchEnd = -1;
    searchQuery = "";
    inputBarMode = null;
    setEnc("ascii");

    disposeCommands();
    if (inputKeydownHandler && inputBarInput) {
      inputBarInput.removeEventListener("keydown", inputKeydownHandler);
      inputKeydownHandler = null;
    }
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    if (wheelHandler && frameDiv) frameDiv.removeEventListener("wheel", wheelHandler);
    if (ptrMoveHandler) window.removeEventListener("pointermove", ptrMoveHandler);
    if (ptrUpHandler) window.removeEventListener("pointerup", ptrUpHandler);
    stopInertia();

    if (disposeFileChange) {
      disposeFileChange();
      disposeFileChange = null;
    }
    disposeFileChange = hostApi.onFileChange(async () => {
      try {
        const stat = await hostApi.statFile(path);
        fileSize = stat.size;
      } catch {
        // ignore
      }
      cacheOff = -1;
      cacheBuf = null;
      cacheLen = 0;
      dpyStart = clamp(dpyStart);
    });

    rootEl = root;
    root.innerHTML = "";
    root.style.cssText = "margin:0;padding:0;height:100%;display:flex;flex-direction:column;overflow:hidden;";

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--border);background:var(--bg-secondary);color:var(--fg);font:12px system-ui,-apple-system,sans-serif;";
    root.appendChild(header);

    const nameEl = document.createElement("div");
    nameEl.style.cssText = "flex:1;color:var(--fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    nameEl.textContent = `${props.fileName} - ${fmtBytes(fileSize)}`;
    header.appendChild(nameEl);

    hexBtn = document.createElement("button");
    hexBtn.style.cssText =
      "border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;";
    hexBtn.textContent = "Hex";
    hexBtn.title = "Toggle hex mode";
    header.appendChild(hexBtn);

    const wrapLabel = document.createElement("label");
    wrapLabel.style.cssText = "display:flex;align-items:center;gap:4px;color:var(--fg-muted);user-select:none;font-size:11px;";
    wrapChk = document.createElement("input");
    wrapChk.type = "checkbox";
    wrapChk.checked = wrapMode;
    wrapChk.style.cssText = "accent-color:var(--action-bar-fg);";
    wrapLabel.appendChild(wrapChk);
    wrapLabel.appendChild(document.createTextNode("Wrap"));
    wrapLabel.title = "Toggle wrap (F2)";
    header.appendChild(wrapLabel);

    const encodingSelect = document.createElement("select");
    encodingSelect.style.cssText =
      "border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 6px;font-size:11px;";
    const encodings: Array<{ id: EncodingId; label: string }> = [
      { id: "ascii", label: "ASCII" },
      { id: "utf-8", label: "UTF-8" },
      { id: "windows-1251", label: "Win-1251" },
      { id: "koi8-r", label: "KOI8-R" },
      { id: "iso-8859-1", label: "ISO-8859-1" },
    ];
    for (const { id, label } of encodings) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      encodingSelect.appendChild(option);
    }
    encodingSelect.value = encoding;
    header.appendChild(encodingSelect);

    const frame = document.createElement("div");
    frame.style.cssText = "flex:1;min-height:0;position:relative;overflow:hidden;background:var(--bg);";
    frame.tabIndex = 0;
    frame.dataset.dotdirFocusTarget = "true";
    frameDiv = frame;
    root.appendChild(frame);

    contentDiv = document.createElement("div");
    contentDiv.style.cssText = `position:absolute;left:8px;top:4px;right:${8 + SCROLLBAR_WIDTH + SCROLLBAR_PADDING}px;bottom:4px;overflow:hidden;font:12px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--fg);`;
    frame.appendChild(contentDiv);

    scrollbarTrack = document.createElement("div");
    scrollbarTrack.style.cssText = `position:absolute;top:8px;bottom:8px;right:8px;width:${SCROLLBAR_WIDTH}px;border-radius:999px;background:var(--bg-secondary);border:1px solid var(--border);`;
    frame.appendChild(scrollbarTrack);

    scrollbarThumb = document.createElement("div");
    scrollbarThumb.style.cssText =
      "position:absolute;left:1px;right:1px;top:1px;height:20px;border-radius:999px;background:var(--entry-selected);border:1px solid var(--border-active);";
    scrollbarTrack.appendChild(scrollbarThumb);

    inputBarDiv = document.createElement("div");
    inputBarDiv.style.cssText =
      "display:none;position:absolute;left:0;right:0;bottom:0;background:var(--bg-secondary);border-top:1px solid var(--border);padding:4px 8px;font:12px system-ui,sans-serif;color:var(--fg);align-items:center;gap:6px;z-index:10;";
    frame.appendChild(inputBarDiv);

    inputBarLabel = document.createElement("span");
    inputBarLabel.style.cssText = "color:var(--fg-muted);font-size:11px;";
    inputBarLabel.textContent = "Search:";
    inputBarDiv.appendChild(inputBarLabel);

    inputBarInput = document.createElement("input");
    inputBarInput.type = "text";
    inputBarInput.style.cssText =
      "flex:1;border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 6px;font:12px ui-monospace,monospace;min-width:80px;";
    inputBarDiv.appendChild(inputBarInput);

    const caseLabel = document.createElement("label");
    caseLabel.style.cssText = "display:flex;align-items:center;gap:3px;color:var(--fg-muted);user-select:none;font-size:11px;";
    inputBarCase = document.createElement("input");
    inputBarCase.type = "checkbox";
    inputBarCase.checked = searchCaseSensitive;
    caseLabel.appendChild(inputBarCase);
    caseLabel.appendChild(document.createTextNode("Case"));
    inputBarDiv.appendChild(caseLabel);

    inputBarStatus = document.createElement("span");
    inputBarStatus.style.cssText = "color:var(--fg-muted);font-size:11px;";
    inputBarDiv.appendChild(inputBarStatus);

    statusDiv = document.createElement("div");
    statusDiv.style.cssText =
      "padding:2px 8px;border-top:1px solid var(--border);background:var(--bg-secondary);color:var(--fg-muted);font:11px ui-monospace,monospace;white-space:nowrap;overflow:hidden;";
    root.appendChild(statusDiv);

    const measure = () => {
      if (!contentDiv) return;
      const probe = document.createElement("span");
      probe.textContent = "M";
      probe.style.cssText = "visibility:hidden;position:absolute;left:-10000px;top:-10000px;";
      contentDiv.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      contentDiv.removeChild(probe);
      charW = Math.max(6, rect.width || 8);
      charH = Math.max(10, rect.height || 16);
      rowH = Math.max(15, Math.round(charH * LINE_HEIGHT_RATIO));
      cols = Math.max(10, Math.floor(contentDiv.clientWidth / charW));
      rows = Math.max(1, Math.floor(contentDiv.clientHeight / rowH));
      if (hexMode) bytesPerLine = calcBytesPerLine(cols);
    };

    const updateStatus = () => {
      if (!statusDiv) return;
      const pct = fileSize > 0 ? Math.min(100, Math.floor((lastEndByte / fileSize) * 100)) : 100;
      if (hexMode) {
        statusDiv.textContent = `Hex  0x${hex8(hexCursor)}  ${hexCursor}/${fileSize}  [${encoding.toUpperCase()}]  ${pct}%`;
      } else {
        let status = `${dpyStart}/${fileSize}`;
        if (!wrapMode && dpyTextColumn > 0) status += `  Col:${dpyTextColumn}`;
        status += `  [${encoding.toUpperCase()}]  ${pct}%`;
        statusDiv.textContent = status;
      }
    };

    const render = async () => {
      if (!contentDiv) return;
      contentDiv.innerHTML = "";
      if (hexMode) {
        let pos = dpyStart;
        for (let row = 0; row < rows && pos < fileSize; row++) {
          renderSegments(await hexLineSegments(pos), contentDiv);
          pos += bytesPerLine;
        }
        lastEndByte = Math.min(pos, fileSize);
      } else {
        const grid = await textGrid();
        for (const line of grid) {
          renderSegments(textLineSegments(line), contentDiv);
        }
        lastEndByte = grid.length > 0 ? grid[grid.length - 1]!.byteEnd : dpyStart;
      }
      updateThumb();
      updateStatus();
    };

    const hexScrollToCursor = () => {
      const currentRow = Math.floor(hexCursor / bytesPerLine);
      const startRow = Math.floor(dpyStart / bytesPerLine);
      if (currentRow < startRow) dpyStart = currentRow * bytesPerLine;
      else if (currentRow >= startRow + rows) dpyStart = (currentRow - rows + 1) * bytesPerLine;
      dpyStart = Math.max(0, dpyStart);
    };

    const scrollDown = async (count: number) => {
      if (hexMode) {
        hexCursor = clamp(hexCursor + count * bytesPerLine);
        hexScrollToCursor();
        await render();
        return;
      }
      if (!wrapMode) {
        let pos = dpyStart;
        for (let i = 0; i < count; i++) {
          const line = await buildLine(pos, cols, false, dpyTextColumn);
          if (line.byteEnd === pos) break;
          pos = line.byteEnd;
          if (pos >= fileSize) break;
        }
        dpyStart = clamp(pos);
        await render();
        return;
      }
      let pos = dpyStart;
      let skip = dpyParagraphSkipLines;
      for (let i = 0; i < count; i++) {
        const line = await buildLine(pos, cols, true);
        if (line.byteEnd === pos) break;
        const lastByte = await getByte(line.byteEnd - 1);
        if (lastByte === 0x0a || lastByte === 0x0d) {
          pos = line.byteEnd;
          dpyStart = clamp(pos);
          skip = 0;
          dpyParagraphSkipLines = 0;
        } else {
          skip++;
          dpyParagraphSkipLines = skip;
        }
        pos = line.byteEnd;
        if (pos >= fileSize) break;
      }
      await render();
    };

    const scrollUp = async (count: number) => {
      if (hexMode) {
        hexCursor = Math.max(0, hexCursor - count * bytesPerLine);
        hexScrollToCursor();
        await render();
        return;
      }
      if (!wrapMode) {
        let pos = dpyStart;
        for (let i = 0; i < count; i++) {
          pos = await findPrevLine(pos);
          if (pos === 0) break;
        }
        dpyStart = clamp(pos);
        await render();
        return;
      }
      for (let i = 0; i < count; i++) {
        if (dpyParagraphSkipLines > 0) {
          dpyParagraphSkipLines--;
          continue;
        }
        dpyStart = clamp(await findPrevLine(dpyStart));
        let pos = dpyStart;
        let wrappedCount = 0;
        for (let j = 0; j < 5000; j++) {
          const line = await buildLine(pos, cols, true);
          if (line.byteEnd === pos) break;
          const lastByte = await getByte(line.byteEnd - 1);
          if (lastByte === 0x0a || lastByte === 0x0d) break;
          pos = line.byteEnd;
          wrappedCount++;
        }
        dpyParagraphSkipLines = Math.max(0, wrappedCount);
      }
      await render();
    };

    const scrollLeft = async (count: number) => {
      if (hexMode || wrapMode) return;
      dpyTextColumn = Math.max(0, dpyTextColumn - count);
      await render();
    };

    const scrollRight = async (count: number) => {
      if (hexMode || wrapMode) return;
      dpyTextColumn += count;
      await render();
    };

    const jumpToRatio = async (ratio: number) => {
      if (hexMode) {
        hexCursor = clamp(Math.floor(ratio * Math.max(0, fileSize - 1)));
        dpyStart = Math.floor(hexCursor / bytesPerLine) * bytesPerLine;
      } else {
        const next = clamp(Math.floor(ratio * Math.max(0, fileSize - 1)));
        dpyStart = await findPrevLine(next);
        dpyParagraphSkipLines = 0;
      }
      await render();
    };

    const doSearch = async (direction: "forward" | "backward") => {
      if (!searchQuery) return;
      const query = new TextEncoder().encode(searchQuery);
      if (query.length === 0) return;
      const current = hexMode ? hexCursor : dpyStart;
      let result: number;

      if (direction === "forward") {
        const from = searchMatchStart >= 0 ? searchMatchStart + 1 : current;
        result = await searchForward(from, query, searchCaseSensitive);
        if (result < 0 && from > 0) result = await searchForward(0, query, searchCaseSensitive);
      } else {
        const from = searchMatchStart >= 0 ? searchMatchStart : current;
        result = await searchBackward(from, query, searchCaseSensitive);
        if (result < 0) result = await searchBackward(fileSize, query, searchCaseSensitive);
      }

      if (result >= 0) {
        searchMatchStart = result;
        searchMatchEnd = result + query.length;
        if (hexMode) {
          hexCursor = result;
          hexScrollToCursor();
        } else {
          dpyStart = await findPrevLine(result);
          dpyParagraphSkipLines = 0;
        }
        if (inputBarStatus) inputBarStatus.textContent = "";
      } else {
        searchMatchStart = -1;
        searchMatchEnd = -1;
        if (inputBarStatus) inputBarStatus.textContent = "Not found";
      }
      await render();
    };

    const doGoto = async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      let offset: number;
      if (trimmed.startsWith(":")) {
        const lineNumber = parseInt(trimmed.slice(1), 10);
        if (Number.isNaN(lineNumber) || lineNumber < 1) return;
        offset = await findLineOffset(lineNumber);
      } else if (trimmed.endsWith("%")) {
        const pct = parseFloat(trimmed.slice(0, -1));
        if (Number.isNaN(pct)) return;
        offset = Math.floor((Math.max(0, Math.min(100, pct)) / 100) * fileSize);
      } else if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
        offset = parseInt(trimmed, 16);
        if (Number.isNaN(offset)) return;
      } else {
        offset = parseInt(trimmed, 10);
        if (Number.isNaN(offset)) return;
      }
      offset = clamp(offset);
      if (hexMode) {
        hexCursor = offset;
        hexScrollToCursor();
      } else {
        dpyStart = await findPrevLine(offset);
        dpyParagraphSkipLines = 0;
        dpyTextColumn = 0;
      }
      hideBar();
      await render();
    };

    const showBar = (mode: "search" | "goto") => {
      inputBarMode = mode;
      if (inputBarDiv) inputBarDiv.style.display = "flex";
      if (inputBarLabel) inputBarLabel.textContent = mode === "search" ? "Search:" : "Go to:";
      if (inputBarInput) {
        inputBarInput.value = mode === "search" ? searchQuery : "";
        inputBarInput.placeholder = mode === "goto" ? "offset, 0xHEX, NN%, :line" : "";
        inputBarInput.focus();
        inputBarInput.select();
      }
      if (inputBarStatus) inputBarStatus.textContent = "";
      if (inputBarCase && inputBarCase.parentElement) {
        inputBarCase.parentElement.style.display = mode === "search" ? "flex" : "none";
      }
    };

    const hideBar = () => {
      inputBarMode = null;
      if (inputBarDiv) inputBarDiv.style.display = "none";
      frameDiv?.focus();
    };

    const closeViewer = () => {
      hostApi.onClose();
    };

    const scrollLineDown = async () => {
      await scrollDown(1);
    };

    const scrollLineUp = async () => {
      await scrollUp(1);
    };

    const scrollViewerLeft = async () => {
      if (hexMode) {
        hexCursor = Math.max(0, hexCursor - 1);
        hexScrollToCursor();
        await render();
        return;
      }
      await scrollLeft(1);
    };

    const scrollViewerRight = async () => {
      if (hexMode) {
        hexCursor = clamp(hexCursor + 1);
        hexScrollToCursor();
        await render();
        return;
      }
      await scrollRight(1);
    };

    const scrollPageDown = async () => {
      await scrollDown(rows);
    };

    const scrollPageUp = async () => {
      await scrollUp(rows);
    };

    const scrollToStart = async () => {
      if (hexMode) {
        hexCursor = 0;
        dpyStart = 0;
      } else {
        dpyStart = 0;
        dpyParagraphSkipLines = 0;
        dpyTextColumn = 0;
      }
      await render();
    };

    const scrollToEnd = async () => {
      await jumpToRatio(1);
    };

    const toggleWrap = async () => {
      if (!wrapChk) return;
      wrapChk.checked = !wrapChk.checked;
      wrapChk.dispatchEvent(new Event("change"));
    };

    const toggleHex = async () => {
      hexBtn?.click();
    };

    const openGoto = async () => {
      showBar("goto");
    };

    const openSearch = async () => {
      showBar("search");
    };

    const searchNext = async () => {
      if (searchQuery) await doSearch("forward");
      else showBar("search");
    };

    const searchPrevious = async () => {
      if (searchQuery) await doSearch("backward");
      else showBar("search");
    };

    measure();

    encodingSelect.addEventListener("change", async () => {
      setEnc(encodingSelect.value as EncodingId);
      await render();
    });

    hexBtn.addEventListener("click", async () => {
      hexMode = !hexMode;
      if (hexMode) {
        hexCursor = dpyStart;
        bytesPerLine = calcBytesPerLine(cols);
        dpyStart = Math.floor(hexCursor / bytesPerLine) * bytesPerLine;
      } else {
        dpyStart = await findPrevLine(hexCursor);
        dpyParagraphSkipLines = 0;
        dpyTextColumn = 0;
      }
      if (hexBtn) {
        hexBtn.style.background = hexMode ? "var(--entry-selected)" : "var(--bg)";
      }
      await render();
    });

    wrapChk.addEventListener("change", async () => {
      if (!wrapChk) return;
      wrapMode = wrapChk.checked;
      dpyParagraphSkipLines = 0;
      dpyTextColumn = 0;
      if (wrapMode) dpyStart = await findPrevLine(dpyStart);
      await render();
    });

    if (inputBarCase) {
      inputBarCase.addEventListener("change", () => {
        if (inputBarCase) searchCaseSensitive = inputBarCase.checked;
      });
    }

    if (!hostApi.commands) throw new Error("Host commands API is unavailable");
    disposeCommands();
    commandDisposers = [
      hostApi.commands.registerCommand("fileViewer.close", closeViewer),
      hostApi.commands.registerCommand("fileViewer.scrollLineDown", scrollLineDown),
      hostApi.commands.registerCommand("fileViewer.scrollLineUp", scrollLineUp),
      hostApi.commands.registerCommand("fileViewer.scrollLeft", scrollViewerLeft),
      hostApi.commands.registerCommand("fileViewer.scrollRight", scrollViewerRight),
      hostApi.commands.registerCommand("fileViewer.scrollPageDown", scrollPageDown),
      hostApi.commands.registerCommand("fileViewer.scrollPageUp", scrollPageUp),
      hostApi.commands.registerCommand("fileViewer.scrollToStart", scrollToStart),
      hostApi.commands.registerCommand("fileViewer.scrollToEnd", scrollToEnd),
      hostApi.commands.registerCommand("fileViewer.toggleWrap", toggleWrap),
      hostApi.commands.registerCommand("fileViewer.toggleHex", toggleHex),
      hostApi.commands.registerCommand("fileViewer.openGoto", openGoto),
      hostApi.commands.registerCommand("fileViewer.openSearch", openSearch),
      hostApi.commands.registerCommand("fileViewer.searchNext", searchNext),
      hostApi.commands.registerCommand("fileViewer.searchPrevious", searchPrevious),
    ];

    wheelHandler = (event: WheelEvent) => {
      event.preventDefault();
      const lines = Math.round(event.deltaY / rowH);
      if (lines > 0) void scrollDown(Math.max(1, lines));
      else if (lines < 0) void scrollUp(Math.max(1, -lines));
    };
    frame.addEventListener("wheel", wheelHandler, { passive: false });

    frame.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      stopInertia();
      lastTouchY = event.clientY;
      lastTouchTime = performance.now();
    });

    frame.addEventListener("pointermove", (event: PointerEvent) => {
      if (event.pointerType !== "touch" || lastTouchTime === 0) return;
      const now = performance.now();
      const deltaY = event.clientY - lastTouchY;
      const deltaTime = now - lastTouchTime || 1;
      const lines = deltaY / rowH;
      if (lines > 0) void scrollUp(Math.max(1, Math.round(lines)));
      else if (lines < 0) void scrollDown(Math.max(1, Math.round(-lines)));
      touchVelocity = deltaY / deltaTime;
      lastTouchY = event.clientY;
      lastTouchTime = now;
    });

    frame.addEventListener("pointerup", (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      lastTouchTime = 0;
      stopInertia();
      if (Math.abs(touchVelocity) < 0.01) return;
      const step = async () => {
        if (Math.abs(touchVelocity) < 0.01) {
          stopInertia();
          return;
        }
        const px = touchVelocity * 16;
        const lines = px / rowH;
        if (lines > 0) await scrollDown(Math.max(1, Math.round(lines)));
        else if (lines < 0) await scrollUp(Math.max(1, Math.round(-lines)));
        touchVelocity *= 0.95;
        inertiaFrame = requestAnimationFrame(() => {
          void step();
        });
      };
      inertiaFrame = requestAnimationFrame(() => {
        void step();
      });
    });

    scrollbarThumb.addEventListener("pointerdown", (event: PointerEvent) => {
      if (!scrollbarThumb) return;
      dragging = true;
      dragOffsetY = event.clientY - scrollbarThumb.getBoundingClientRect().top;
      event.preventDefault();
    });

    scrollbarTrack.addEventListener("pointerdown", (event: PointerEvent) => {
      if (!scrollbarTrack || !scrollbarThumb) return;
      const rect = scrollbarTrack.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const thumbHeight = scrollbarThumb.clientHeight;
      void jumpToRatio(Math.max(0, Math.min(1, (y - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight))));
      event.preventDefault();
    });

    ptrMoveHandler = (event: PointerEvent) => {
      if (!dragging || !scrollbarTrack || !scrollbarThumb) return;
      const rect = scrollbarTrack.getBoundingClientRect();
      const thumbHeight = scrollbarThumb.clientHeight;
      void jumpToRatio(
        Math.max(0, Math.min(1, (event.clientY - rect.top - dragOffsetY) / Math.max(1, rect.height - thumbHeight))),
      );
    };
    window.addEventListener("pointermove", ptrMoveHandler);

    ptrUpHandler = () => {
      dragging = false;
    };
    window.addEventListener("pointerup", ptrUpHandler);

    inputKeydownHandler = (event: KeyboardEvent) => {
      if (!inputBarInput || document.activeElement !== inputBarInput) return;
      if (event.key === "Escape") {
        event.preventDefault();
        hideBar();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (inputBarMode === "search") {
          searchQuery = inputBarInput.value;
          void doSearch(event.shiftKey ? "backward" : "forward");
        } else if (inputBarMode === "goto") {
          void doGoto(inputBarInput.value);
        }
      }
    };
    inputBarInput.addEventListener("keydown", inputKeydownHandler);

    resizeHandler = () => {
      measure();
      if (wrapMode) dpyParagraphSkipLines = 0;
      void render();
    };
    window.addEventListener("resize", resizeHandler);

    await render();
  }

  function unmountViewer(): void {
    stopInertia();
    if (disposeFileChange) {
      disposeFileChange();
      disposeFileChange = null;
    }
    disposeCommands();
    if (inputKeydownHandler && inputBarInput) {
      inputBarInput.removeEventListener("keydown", inputKeydownHandler);
      inputKeydownHandler = null;
    }
    if (resizeHandler) {
      window.removeEventListener("resize", resizeHandler);
      resizeHandler = null;
    }
    if (wheelHandler && frameDiv) frameDiv.removeEventListener("wheel", wheelHandler);
    wheelHandler = null;
    if (ptrMoveHandler) {
      window.removeEventListener("pointermove", ptrMoveHandler);
      ptrMoveHandler = null;
    }
    if (ptrUpHandler) {
      window.removeEventListener("pointerup", ptrUpHandler);
      ptrUpHandler = null;
    }
    if (rootEl) {
      rootEl.innerHTML = "";
    }
    rootEl = null;
    frameDiv = null;
    contentDiv = null;
    statusDiv = null;
    scrollbarTrack = null;
    scrollbarThumb = null;
    inputBarDiv = null;
    inputBarInput = null;
    inputBarLabel = null;
    inputBarStatus = null;
    inputBarCase = null;
    hexBtn = null;
    wrapChk = null;
  }

  return {
    async mount(root: HTMLElement, props: ViewerProps): Promise<void> {
      if (mounted) {
        unmountViewer();
      }
      await mountViewer(root, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountViewer();
      mounted = false;
    },
    focus(): void {
      frameDiv?.focus();
    },
  };
}

function focusViewerRoot(root: HTMLElement | null): void {
  if (!root) return;
  const target = root.querySelector<HTMLElement>("[data-dotdir-focus-target='true'], textarea.inputarea, textarea, [contenteditable='true']");
  if (!target) return;
  try {
    target.focus();
  } catch {
    // ignore
  }
}

export function FileViewerSurface({ hostApi, props, active, onInteract }: FileViewerSurfaceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ViewerExtensionApi | null>(null);

  if (!apiRef.current) {
    apiRef.current = createFileViewerExtensionApi(hostApi);
  }

  useEffect(() => {
    const root = rootRef.current;
    const api = apiRef.current;
    if (!root || !api) return;
    void api.mount(root, props);
  }, [props.filePath, props.fileName, props.fileSize]);

  useEffect(() => {
    const api = apiRef.current;
    return () => {
      void api?.unmount();
    };
  }, []);

  useEffect(() => {
    if (active === false) return;
    const run = () => {
      focusViewerRoot(rootRef.current);
    };
    const frame = requestAnimationFrame(run);
    const timeoutId = setTimeout(run, 0);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeoutId);
    };
  }, [active]);

  return (
    <div
      ref={rootRef}
      style={{ width: "100%", height: "100%" }}
      onFocusCapture={() => onInteract?.()}
      onMouseDownCapture={() => onInteract?.()}
    />
  );
}
