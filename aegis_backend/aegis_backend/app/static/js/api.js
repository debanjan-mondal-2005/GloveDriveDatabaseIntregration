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
    const AUTH_KEY = 'aegis_auth_session';

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
    let _session = _loadStoredSession();

    const _listeners = {
        snapshot: [],
        wsOpen: [],
        wsClose: [],
        error: [],
        authExpired: [],
    };

    function _loadStoredSession() {
        try {
            const raw = localStorage.getItem(AUTH_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.token) return null;
            if (parsed.expires_at && parsed.expires_at * 1000 <= Date.now()) {
                localStorage.removeItem(AUTH_KEY);
                return null;
            }
            return parsed;
        } catch (_) {
            return null;
        }
    }

    function getSession() {
        return _session;
    }

    function getToken() {
        return _session ? _session.token : null;
    }

    function setSession(data) {
        if (!data || !data.token) return;
        _session = {
            token: data.token,
            expires_at: data.expires_at,
            user: data.user || null,
        };
        try {
            localStorage.setItem(AUTH_KEY, JSON.stringify(_session));
        } catch (_) {
            // ignore
        }
    }

    function clearSession() {
        _session = null;
        try {
            localStorage.removeItem(AUTH_KEY);
        } catch (_) {
            // ignore
        }
    }

    function authHeaders(extra = {}) {
        const h = { ...extra };
        if (_session && _session.token) {
            h.Authorization = `Bearer ${_session.token}`;
        }
        return h;
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

    async function fetchJSON(path, options = {}, { skipAuthEvent = false } = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(`${_baseUrl}${path}`, {
                ...options,
                credentials: 'same-origin',
                headers: authHeaders(options.headers || {}),
                signal: controller.signal,
            });
            // Read body ONCE — either as error detail or as JSON result
            const text = await response.text();
            let parsed = null;
            try { parsed = text ? JSON.parse(text) : null; } catch (_) {}

            if (!response.ok) {
                if (response.status === 401 && !skipAuthEvent) {
                    clearSession();
                    _emit('authExpired', { message: (parsed && parsed.detail) || 'Session expired' });
                }
                const detail = (parsed && (parsed.detail || parsed.message)) || '';
                const err = new Error(detail || `HTTP ${response.status}`);
                err.status = response.status;
                err.data = parsed;
                throw err;
            }
            if (parsed === null && text) {
                throw new Error('Backend returned non-JSON response');
            }
            return parsed;
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('Request timed out — please try again.');
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function getAuthConfig() {
        return fetchJSON('/api/auth/config', {}, { skipAuthEvent: true });
    }

    function getAuthMe() {
        return fetchJSON('/api/auth/me', {}, { skipAuthEvent: true });
    }

    function signup(name, email, password) {
        return fetchJSON('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password }),
        }, { skipAuthEvent: true });
    }

    function verifyOtp(email, otp) {
        return fetchJSON('/api/auth/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp }),
        }, { skipAuthEvent: true });
    }

    function resendOtp(email) {
        return fetchJSON('/api/auth/resend-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        }, { skipAuthEvent: true });
    }

    function login(email, password) {
        return fetchJSON('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        }, { skipAuthEvent: true });
    }

    function googleAuth(credential) {
        return fetchJSON('/api/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential }),
        }, { skipAuthEvent: true });
    }

    async function logout() {
        try {
            await fetchJSON('/api/auth/logout', { method: 'POST' }, { skipAuthEvent: true });
        } catch (_) {
            // always clear client state
        }
        clearSession();
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
        const tok = getToken();
        const q = tok ? `?token=${encodeURIComponent(tok)}` : '';
        const wsUrl = `${_baseUrl.replace(/^http/, 'ws')}/ws/dashboard${q}`;

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
                if (data.code === 401) {
                    disconnect();
                    clearSession();
                    _emit('authExpired', { message: data.error });
                    return;
                }
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
        getSession,
        getToken,
        setSession,
        clearSession,
        authHeaders,
        getAuthConfig,
        getAuthMe,
        signup,
        verifyOtp,
        resendOtp,
        login,
        googleAuth,
        logout,
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
