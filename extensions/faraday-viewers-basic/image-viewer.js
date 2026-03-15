/**
 * Faraday Image & Video Viewer Extension
 *
 * Renders images (with zoom/pan) and videos in the host iframe.
 * Uses Comlink (available as window.Comlink) for RPC with the host.
 */
(function () {
  const Comlink = window.Comlink;
  let hostApi = null;

  const MIME_MAP = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
    tiff: 'image/tiff', tif: 'image/tiff',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
    ogv: 'video/ogg', ogg: 'video/ogg', mov: 'video/quicktime',
  };
  const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v']);

  function getExt(name) {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  }

  let currentBlobUrl = null;
  let zoom = 1, panX = 0, panY = 0;
  let isDragging = false, dragStart = null;

  const extensionApi = {
    async mount(props) {
      cleanup();
      document.body.innerHTML = '';
      zoom = 1; panX = 0; panY = 0;

      const ext = getExt(props.fileName);
      const isVideo = VIDEO_EXTS.has(ext);

      addStyles();

      // Header
      const header = document.createElement('div');
      header.className = 'iv-header';
      const title = document.createElement('span');
      title.className = 'iv-title';
      title.textContent = props.fileName;
      header.appendChild(title);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'iv-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.title = 'Close (Esc)';
      closeBtn.onclick = () => hostApi && hostApi.onClose();
      header.appendChild(closeBtn);
      document.body.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'iv-body';
      body.tabIndex = 0;
      document.body.appendChild(body);

      // Footer
      const footer = document.createElement('div');
      footer.className = 'iv-footer';
      document.body.appendChild(footer);

      // Load file
      try {
        const buf = await hostApi.readFile(props.filePath);
        const mime = MIME_MAP[ext] || 'application/octet-stream';
        const blob = new Blob([buf], { type: mime });
        currentBlobUrl = URL.createObjectURL(blob);

        if (isVideo) {
          renderVideo(body, footer, currentBlobUrl, props);
        } else {
          renderImage(body, footer, currentBlobUrl, props);
        }
      } catch (e) {
        body.textContent = 'Failed to load: ' + e;
        body.style.color = '#f44';
      }

      body.focus();
      body.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          hostApi && hostApi.onClose();
        }
      });
    },

    async unmount() {
      cleanup();
      document.body.innerHTML = '';
    },
  };

  function cleanup() {
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
  }

  function renderImage(body, footer, url, props) {
    body.classList.add('iv-image-body');
    const img = document.createElement('img');
    img.src = url;
    img.alt = props.fileName;
    img.draggable = false;
    img.style.transform = 'scale(1)';
    img.style.transformOrigin = 'center center';
    body.appendChild(img);

    function updateTransform() {
      img.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
    }

    body.style.cursor = 'grab';
    body.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom = Math.min(20, Math.max(0.05, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      updateTransform();
    });
    body.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      isDragging = true;
      dragStart = { x: e.clientX, y: e.clientY, panX: panX, panY: panY };
      body.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', function (e) {
      if (!isDragging || !dragStart) return;
      panX = dragStart.panX + e.clientX - dragStart.x;
      panY = dragStart.panY + e.clientY - dragStart.y;
      updateTransform();
    });
    document.addEventListener('mouseup', function () {
      if (!isDragging) return;
      isDragging = false;
      dragStart = null;
      body.style.cursor = 'grab';
    });

    img.onload = function () {
      const info = document.createElement('span');
      info.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight +
        '  \u2022  ' + formatBytes(props.fileSize);
      footer.appendChild(info);
    };

    // Zoom controls
    const controls = document.createElement('div');
    controls.className = 'iv-controls';
    const zoomOut = document.createElement('button');
    zoomOut.textContent = '\u2212';
    zoomOut.onclick = function () { zoom = Math.max(0.05, zoom / 1.2); updateTransform(); };
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'iv-zoom-label';
    zoomLabel.textContent = '100%';
    const zoomIn = document.createElement('button');
    zoomIn.textContent = '+';
    zoomIn.onclick = function () { zoom = Math.min(20, zoom * 1.2); updateTransform(); };
    const fit = document.createElement('button');
    fit.textContent = 'Fit';
    fit.onclick = function () { zoom = 1; panX = 0; panY = 0; updateTransform(); };
    controls.append(zoomOut, zoomLabel, zoomIn, fit);
    footer.insertBefore(controls, footer.firstChild);

    // Update zoom label periodically (simple approach)
    setInterval(function () { zoomLabel.textContent = Math.round(zoom * 100) + '%'; }, 100);
  }

  function renderVideo(body, footer, url, props) {
    body.classList.add('iv-video-body');
    const video = document.createElement('video');
    video.src = url;
    video.autoplay = true;
    video.controls = true;
    body.appendChild(video);

    video.onloadedmetadata = function () {
      const info = document.createElement('span');
      info.textContent = video.videoWidth + ' \u00d7 ' + video.videoHeight +
        '  \u2022  ' + formatDuration(video.duration) +
        '  \u2022  ' + formatBytes(props.fileSize);
      footer.appendChild(info);
    };
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function addStyles() {
    if (document.getElementById('iv-styles')) return;
    const style = document.createElement('style');
    style.id = 'iv-styles';
    style.textContent = `
      html, body { display: flex; flex-direction: column; height: 100%; margin: 0; }
      .iv-header {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 8px; min-height: 28px;
        border-bottom: 1px solid rgba(128,128,128,0.3);
        font-size: 12px;
      }
      .iv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .iv-close {
        background: none; border: none; color: inherit; font-size: 18px;
        cursor: pointer; padding: 0 4px; line-height: 1; opacity: 0.7;
      }
      .iv-close:hover { opacity: 1; }
      .iv-body {
        flex: 1; display: flex; align-items: center; justify-content: center;
        overflow: hidden; outline: none; position: relative;
      }
      .iv-image-body img {
        max-width: 100%; max-height: 100%; object-fit: contain;
        user-select: none; -webkit-user-drag: none;
      }
      .iv-video-body video {
        max-width: 100%; max-height: 100%; outline: none;
      }
      .iv-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 8px; min-height: 28px;
        border-top: 1px solid rgba(128,128,128,0.3);
        font-size: 12px; color: rgba(128,128,128,0.8);
      }
      .iv-controls { display: flex; align-items: center; gap: 4px; }
      .iv-controls button {
        background: none; border: 1px solid rgba(128,128,128,0.3);
        color: inherit; padding: 2px 6px; cursor: pointer; border-radius: 3px;
        font-size: 12px;
      }
      .iv-controls button:hover { background: rgba(128,128,128,0.2); }
      .iv-zoom-label { min-width: 40px; text-align: center; }
    `;
    document.head.appendChild(style);
  }

  var handshakeId = typeof window.__faradayHandshakeId !== 'undefined' ? window.__faradayHandshakeId : null;
  function sendLoaded() {
    window.parent.postMessage(
      handshakeId != null ? { type: 'faraday-loaded', handshakeId: handshakeId } : { type: 'faraday-loaded' },
      '*'
    );
  }
  function sendReady(port) {
    window.parent.postMessage(
      handshakeId != null ? { type: 'faraday-ready', port: port, handshakeId: handshakeId } : { type: 'faraday-ready', port: port },
      '*',
      [port]
    );
  }
  function sendError(msg) {
    window.parent.postMessage(
      handshakeId != null ? { type: 'faraday-error', message: msg, handshakeId: handshakeId } : { type: 'faraday-error', message: msg },
      '*'
    );
  }
  function onInit(event) {
    if (!event.data || event.data.type !== 'faraday-init') return;
    window.removeEventListener('message', onInit);
    if (typeof window.Comlink === 'undefined') {
      sendError('Comlink not loaded');
      return;
    }
    var Comlink = window.Comlink;
    var port = event.data.port;
    if (!port) {
      sendError('No port in faraday-init');
      return;
    }
    try {
      hostApi = Comlink.wrap(port);
      var channel = new MessageChannel();
      Comlink.expose(extensionApi, channel.port1);
      sendReady(channel.port2);
    } catch (e) {
      sendError(String(e && e.message));
    }
  }
  window.addEventListener('message', onInit);
  sendLoaded();
})();
