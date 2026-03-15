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

  // Comlink handshake: signal ready first so host sends faraday-init after we're listening
  function onInit(event) {
    if (!event.data || event.data.type !== 'faraday-init') return;
    window.removeEventListener('message', onInit);
    if (typeof window.Comlink === 'undefined') {
      window.parent.postMessage({ type: 'faraday-error', message: 'Comlink not loaded' }, '*');
      return;
    }
    var Comlink = window.Comlink;
    var port = event.data.port;
    if (!port) {
      window.parent.postMessage({ type: 'faraday-error', message: 'No port in faraday-init' }, '*');
      return;
    }
    try {
      hostApi = Comlink.wrap(port);
      var channel = new MessageChannel();
      Comlink.expose(extensionApi, channel.port1);
      window.parent.postMessage(
        { type: 'faraday-ready', port: channel.port2 },
        '*',
        [channel.port2]
      );
    } catch (e) {
      window.parent.postMessage({ type: 'faraday-error', message: String(e && e.message) }, '*');
    }
  }
  window.addEventListener('message', onInit);
  window.parent.postMessage({ type: 'faraday-loaded' }, '*');
})();
