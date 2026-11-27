/**
 * api.js — Backend REST & WebSocket integration for NEON DRIVE.
 *
 * Existing FastAPI backend endpoints:
 *   GET  /api/health          -> backend health check
 *   GET  /api/status          -> full snapshot
 *   GET  /api/history         -> stored telemetry history (up to 600 points)
 *   GET  /api/camera/status   -> camera health & latest frame age
 *   GET  /latest.jpg          -> latest JPEG frame from ESP32-CAM
 *   POST /api/alerts/{id}/ack -> acknowledge safety alert
 *   POST /api/command         -> send command when WS is busy
 *   WS   /ws/dashboard        -> live 4 Hz snapshot stream + command channel
 */

const API = (() => {
    const STORAGE_KEY = 'neon_drive_backend_url';
    const MAX_BACKOFF_MS = 30000;

    let _baseUrl = _resolveInitialUrl();
    let _ws = null;
    let _reconnectTimer = null;
    let _backoffMs = 1000;
    let _intentionalClose = false;

    const _listeners = {
        snapshot: [],
        wsOpen: [],
        wsClose: [],
        error: [],
    };

    function _resolveInitialUrl() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved && /^https?:\/\/.+/.test(saved)) {
                return saved.replace(/\/+$/, '');
            }
        } catch (_) {
            // ignore storage restrictions
        }
        return window.location.origin.replace(/\/+$/, '');
    }

    function setBaseUrl(url) {
        const clean = (url || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/.+/.test(clean)) {
            throw new Error('Invalid backend URL. Expected http:// or https://');
        }
        _baseUrl = clean;
        try {
            localStorage.setItem(STORAGE_KEY, _baseUrl);
        } catch (_) {
            // ignore
        }
    }

    function getBaseUrl() {
        return _baseUrl;
    }

    function on(event, cb) {
        if (_listeners[event] && typeof cb === 'function') {
            _listeners[event].push(cb);
        }
    }

    function _emit(event, payload) {
        (_listeners[event] || []).forEach(cb => {
            try {
                cb(payload);
            } catch (err) {
                console.error(`[API:${event}] listener error:`, err);
            }
        });
    }

    async function fetchJSON(path, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(`${_baseUrl}${path}`, {
                ...options,
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function checkHealth() {
        return fetchJSON('/api/health');
    }

    function getStatus() {
        return fetchJSON('/api/status');
    }

    function getHistory() {
        return fetchJSON('/api/history');
    }

    function getCameraStatus() {
        return fetchJSON('/api/camera/status');
    }

    function ackAlert(alertId) {
        return fetchJSON(`/api/alerts/${encodeURIComponent(alertId)}/ack`, {
            method: 'POST',
        });
    }

    function connect() {
        if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) {
            return;
        }

        _intentionalClose = false;
        const wsUrl = `${_baseUrl.replace(/^http/, 'ws')}/ws/dashboard`;

        try {
            _ws = new WebSocket(wsUrl);
        } catch (err) {
            _emit('error', err);
            _scheduleReconnect();
            return;
        }

        _ws.onopen = () => {
            _backoffMs = 1000;
            if (_reconnectTimer) {
                clearTimeout(_reconnectTimer);
                _reconnectTimer = null;
            }
            _emit('wsOpen', { url: wsUrl });
        };

        _ws.onmessage = event => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            if (!data || typeof data !== 'object') return;
            if (data.error) {
                _emit('error', new Error(data.error));
                return;
            }
            _emit('snapshot', data);
        };

        _ws.onclose = () => {
            _ws = null;
            _emit('wsClose', {});
            if (!_intentionalClose) {
                _scheduleReconnect();
            }
        };

        _ws.onerror = () => {
            // Browser always triggers onclose after onerror
        };
    }

    function _scheduleReconnect() {
        if (_reconnectTimer || _intentionalClose) return;
        const delay = _backoffMs;
        _backoffMs = Math.min(Math.round(_backoffMs * 1.5), MAX_BACKOFF_MS);
        _reconnectTimer = setTimeout(() => {
            _reconnectTimer = null;
            connect();
        }, delay);
    }

    function disconnect() {
        _intentionalClose = true;
        if (_reconnectTimer) {
            clearTimeout(_reconnectTimer);
            _reconnectTimer = null;
        }
        if (_ws) {
            _ws.onclose = null;
            _ws.close();
            _ws = null;
        }
    }

    function isConnected() {
        return Boolean(_ws && _ws.readyState === WebSocket.OPEN);
    }

    async function sendCommand(payload) {
        if (isConnected()) {
            _ws.send(JSON.stringify(payload));
            return { sent: true };
        }
        return fetchJSON('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload }),
        });
    }

    window.addEventListener('beforeunload', () => disconnect());

    return {
        setBaseUrl,
        getBaseUrl,
        on,
        checkHealth,
        getStatus,
        getHistory,
        getCameraStatus,
        ackAlert,
        connect,
        disconnect,
        isConnected,
        sendCommand,
    };
})();
