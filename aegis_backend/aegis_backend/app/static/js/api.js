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
    const MAX_BACKOFF_MS = 30000;

    // Clear any stale saved endpoint override from earlier versions
    try {
        localStorage.removeItem('neon_drive_backend_url');
    } catch (_) {
        // ignore storage restrictions
    }

    const _baseUrl = window.location.origin.replace(/\/+$/, '');
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
            // Read body ONCE — either as error detail or as JSON result
            const text = await response.text();
            if (!response.ok) {
                let detail = '';
                try { const j = JSON.parse(text); detail = j.detail || j.message || ''; } catch (_) {}
                throw new Error(`HTTP ${response.status}${detail ? ': ' + detail : ''}`);
            }
            try {
                return JSON.parse(text);
            } catch (_) {
                throw new Error('Backend returned non-JSON response');
            }
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('Request timed out — is the backend reachable at ' + _baseUrl + '?');
            throw err;
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

    function getSessions(dateStr) {
        const q = dateStr ? `?date=${encodeURIComponent(dateStr)}` : '';
        return fetchJSON(`/api/sessions${q}`);
    }

    function getDailyReportPdfUrl(dateStr) {
        const q = dateStr ? `?date=${encodeURIComponent(dateStr)}` : '';
        return `${_baseUrl}/api/sessions/report.pdf${q}`;
    }

    function getSessionPdfUrl(sessionUid) {
        return `${_baseUrl}/api/sessions/${encodeURIComponent(sessionUid)}/report.pdf`;
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
        getBaseUrl,
        on,
        checkHealth,
        getStatus,
        getHistory,
        getCameraStatus,
        ackAlert,
        getSessions,
        getDailyReportPdfUrl,
        getSessionPdfUrl,
        connect,
        disconnect,
        isConnected,
        sendCommand,
    };
})();
