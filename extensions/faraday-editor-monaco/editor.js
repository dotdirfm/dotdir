/**
 * Faraday Basic Text Editor Extension
 *
 * A simple textarea-based editor inside the host iframe.
 * Uses Comlink (available as window.Comlink) for RPC with the host.
 */
(function () {
  const Comlink = window.Comlink;
  let hostApi = null;
  let dirty = false;
  let textarea = null;

  const extensionApi = {
    async mount(props) {
      document.body.innerHTML = '';
      dirty = false;

      addStyles();

      // Header
      const header = document.createElement('div');
      header.className = 'ed-header';

      const title = document.createElement('span');
      title.className = 'ed-title';
      title.textContent = props.fileName;
      header.appendChild(title);

      const dirtyIndicator = document.createElement('span');
      dirtyIndicator.className = 'ed-dirty';
      dirtyIndicator.textContent = '';
      header.appendChild(dirtyIndicator);

      const langLabel = document.createElement('span');
      langLabel.className = 'ed-lang';
      langLabel.textContent = props.langId || '';
      header.appendChild(langLabel);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'ed-save';
      saveBtn.textContent = 'Save';
      saveBtn.title = 'Save (F2 / Ctrl+S)';
      saveBtn.onclick = doSave;
      header.appendChild(saveBtn);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'ed-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.title = 'Close (Esc)';
      closeBtn.onclick = doClose;
      header.appendChild(closeBtn);

      document.body.appendChild(header);

      // Textarea
      textarea = document.createElement('textarea');
      textarea.className = 'ed-body';
      textarea.spellcheck = false;
      textarea.autocapitalize = 'off';
      textarea.autocomplete = 'off';
      document.body.appendChild(textarea);

      // Load content
      try {
        const text = await hostApi.readFileText(props.filePath);
        textarea.value = text;
      } catch (e) {
        textarea.value = '';
        textarea.placeholder = 'Failed to load: ' + e;
      }

      textarea.addEventListener('input', function () {
        if (!dirty) {
          dirty = true;
          dirtyIndicator.textContent = '\u25cf';
        }
      });

      textarea.addEventListener('keydown', function (e) {
        // Tab inserts actual tab
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
          textarea.selectionStart = textarea.selectionEnd = start + 4;
          if (!dirty) {
            dirty = true;
            dirtyIndicator.textContent = '\u25cf';
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          doClose();
          return;
        }
        if (e.key === 'F2' || ((e.ctrlKey || e.metaKey) && e.key === 's')) {
          e.preventDefault();
          doSave();
        }
      });

      textarea.focus();

      async function doSave() {
        if (!hostApi || !textarea) return;
        try {
          await hostApi.writeFile(props.filePath, textarea.value);
          dirty = false;
          dirtyIndicator.textContent = '';
        } catch (e) {
          console.error('Save failed:', e);
        }
      }

      function doClose() {
        if (dirty) {
          if (!confirm('Discard unsaved changes?')) return;
        }
        hostApi && hostApi.onClose();
      }
    },

    async unmount() {
      textarea = null;
      dirty = false;
      document.body.innerHTML = '';
    },
  };

  function addStyles() {
    if (document.getElementById('ed-styles')) return;
    const style = document.createElement('style');
    style.id = 'ed-styles';
    style.textContent = `
      html, body { display: flex; flex-direction: column; height: 100%; margin: 0; }
      .ed-header {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 8px; min-height: 28px;
        border-bottom: 1px solid rgba(128,128,128,0.3);
        font-size: 12px;
      }
      .ed-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ed-dirty { color: #f90; margin-right: -4px; }
      .ed-lang { color: rgba(128,128,128,0.8); }
      .ed-save, .ed-close {
        background: none; border: none; color: inherit;
        cursor: pointer; padding: 0 4px; opacity: 0.7;
      }
      .ed-save { font-size: 12px; border: 1px solid rgba(128,128,128,0.3); border-radius: 3px; padding: 2px 8px; }
      .ed-save:hover, .ed-close:hover { opacity: 1; }
      .ed-close { font-size: 18px; line-height: 1; }
      .ed-body {
        flex: 1; width: 100%; border: none; outline: none; resize: none;
        font-family: monospace; font-size: 13px; line-height: 20px;
        padding: 8px 12px; tab-size: 4;
        background: inherit; color: inherit;
      }
    `;
    document.head.appendChild(style);
  }

  // Comlink handshake: signal ready first so host sends faraday-init after we're listening
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
