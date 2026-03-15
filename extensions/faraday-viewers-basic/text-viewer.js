/**
 * Faraday Text Viewer Extension
 *
 * Renders plain text in a scrollable monospace view inside the host iframe.
 * Uses Comlink (available as window.Comlink) for RPC with the host.
 */
(function () {
  const Comlink = window.Comlink;
  let hostApi = null;

  const extensionApi = {
    async mount(props) {
      document.body.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'tv-header';

      const title = document.createElement('span');
      title.className = 'tv-title';
      title.textContent = props.fileName;
      header.appendChild(title);

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'tv-size';
      sizeSpan.textContent = formatBytes(props.fileSize);
      header.appendChild(sizeSpan);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tv-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.title = 'Close (Esc)';
      closeBtn.onclick = () => hostApi && hostApi.onClose();
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'tv-body';
      body.tabIndex = 0;

      document.body.appendChild(header);
      document.body.appendChild(body);

      addStyles();

      try {
        const text = await hostApi.readFileText(props.filePath);
        body.textContent = text;
      } catch (e) {
        body.textContent = 'Failed to load file: ' + e;
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
      document.body.innerHTML = '';
    },
  };

  function addStyles() {
    if (document.getElementById('tv-styles')) return;
    const style = document.createElement('style');
    style.id = 'tv-styles';
    style.textContent = `
      html, body { display: flex; flex-direction: column; height: 100%; margin: 0; }
      .tv-header {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 8px; min-height: 28px;
        border-bottom: 1px solid rgba(128,128,128,0.3);
        font-size: 12px;
      }
      .tv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tv-size { color: rgba(128,128,128,0.8); }
      .tv-close {
        background: none; border: none; color: inherit; font-size: 18px;
        cursor: pointer; padding: 0 4px; line-height: 1; opacity: 0.7;
      }
      .tv-close:hover { opacity: 1; }
      .tv-body {
        flex: 1; overflow: auto; padding: 8px 12px;
        font-family: monospace; font-size: 13px; line-height: 20px;
        white-space: pre-wrap; word-break: break-all;
        outline: none;
      }
    `;
    document.head.appendChild(style);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
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
