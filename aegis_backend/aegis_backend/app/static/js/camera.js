/**
 * camera.js — Live camera feed integration for NEON DRIVE.
 *
 * Uses backend endpoints only (never exposes ESP32-CAM IP or secrets to frontend):
 *   GET /latest.jpg         -> latest JPEG frame fetched by backend cam_loop()
 *   GET /api/camera/status  -> camera health / frame age / cam_ok / fps
 */

const Camera = (() => {
    const POLL_INTERVAL_MS = 900;

    let _pollTimer = null;
    let _inFlight = false;
    let _failCount = 0;
    let _lastFrameTime = 0;
    let _currentState = 'offline'; // 'live' | 'reconnecting' | 'offline'
    let _lastFps = null;
    let _camDiag = null;

    let _feedEl, _offlineEl, _offlineMsgEl, _offlineSubEl;
    let _statusBadgeEl, _liveDotEl, _reconnOverlayEl;
    let _infoTextEl, _fpsTextEl, _reconnBtnEl, _fsBtnEl;

    function init() {
        _feedEl = document.getElementById('cam-feed');
        _offlineEl = document.getElementById('cam-offline-state');
        _offlineMsgEl = document.getElementById('cam-offline-msg');
        _offlineSubEl = document.getElementById('cam-offline-sub');
        _statusBadgeEl = document.getElementById('cam-status-badge');
        _liveDotEl = document.getElementById('cam-live-dot');
        _reconnOverlayEl = document.getElementById('cam-reconnecting-overlay');
        _infoTextEl = document.getElementById('cam-info-text');
        _fpsTextEl = document.getElementById('cam-fps-text');
        _reconnBtnEl = document.getElementById('cam-reconnect-btn');
        _fsBtnEl = document.getElementById('cam-fullscreen-btn');

        if (_reconnBtnEl) _reconnBtnEl.addEventListener('click', reconnect);
        if (_fsBtnEl) _fsBtnEl.addEventListener('click', _toggleFullscreen);

        setOffline('STREAM UNAVAILABLE', 'Waiting for backend and ESP32-CAM connection');
    }

    function updateFromSnapshot(snap) {
        if (!snap) return;
        const nodes = snap.nodes || [];
        const camNode = nodes.find(n => n.id === 'cam');
        const camStatus = camNode ? camNode.status : 'OFFLINE';
        const camData = camNode && camNode.data ? camNode.data : {};

        _lastFps = camData.fps != null ? Number(camData.fps).toFixed(1) : null;
        _camDiag = camData;

        if (_fpsTextEl) {
            _fpsTextEl.textContent = _lastFps !== null && camStatus === 'ONLINE'
                ? `FPS: ${_lastFps}`
                : 'FPS: --';
        }

        const canStream = Boolean(snap.cam) && (camStatus === 'ONLINE' || Boolean(snap.cam));
        if (camStatus === 'ONLINE' && camData.cam_ok === false) {
            _stopPolling();
            setOffline(
                'CAMERA SENSOR INIT FAILED',
                `ESP32-CAM connected but sensor error (${camData.cam_err || 'unknown'})`
            );
            return;
        }

        if (canStream && camStatus !== 'OFFLINE') {
            if (!_pollTimer) {
                _startPolling();
            } else if (_currentState === 'live') {
                _updateTimestampLabel();
            }
        } else if (snap.cam) {
            // Upstream fallback frame exists even without WS cam node
            if (!_pollTimer) _startPolling();
        } else {
            _stopPolling();
            const sub = camStatus === 'ONLINE'
                ? 'ESP32-CAM online — waiting for first JPEG frame'
                : 'Waiting for ESP32-CAM video stream via backend';
            setOffline('STREAM UNAVAILABLE', sub);
        }
    }

    function setOffline(title = 'STREAM UNAVAILABLE', subtitle = 'Backend or ESP32-CAM disconnected') {
        _stopPolling();
        _currentState = 'offline';
        _inFlight = false;

        if (_feedEl) {
            _feedEl.classList.remove('visible');
            _feedEl.removeAttribute('src');
        }
        if (_offlineEl) _offlineEl.style.display = 'flex';
        if (_offlineMsgEl) _offlineMsgEl.textContent = title;
        if (_offlineSubEl) _offlineSubEl.textContent = subtitle;
        if (_reconnOverlayEl) _reconnOverlayEl.classList.add('hidden');
        if (_statusBadgeEl) {
            _statusBadgeEl.className = 'status-badge badge-danger';
            _statusBadgeEl.textContent = 'STREAM UNAVAILABLE';
        }
        if (_liveDotEl) _liveDotEl.className = 'indicator-dot text-danger';
        if (_infoTextEl) _infoTextEl.textContent = `Camera: ${title}`;
        if (_fpsTextEl) _fpsTextEl.textContent = 'FPS: --';
    }

    function _setLive() {
        _currentState = 'live';
        if (_feedEl) _feedEl.classList.add('visible');
        if (_offlineEl) _offlineEl.style.display = 'none';
        if (_reconnOverlayEl) _reconnOverlayEl.classList.add('hidden');
        if (_statusBadgeEl) {
            _statusBadgeEl.className = 'status-badge badge-success';
            _statusBadgeEl.textContent = 'LIVE';
        }
        if (_liveDotEl) _liveDotEl.className = 'indicator-dot text-teal';
        _updateTimestampLabel();
    }

    function _setReconnecting() {
        _currentState = 'reconnecting';
        if (_reconnOverlayEl) _reconnOverlayEl.classList.remove('hidden');
        if (_statusBadgeEl) {
            _statusBadgeEl.className = 'status-badge badge-warning';
            _statusBadgeEl.textContent = 'RECONNECTING';
        }
        if (_liveDotEl) _liveDotEl.className = 'indicator-dot text-amber';
        if (_infoTextEl) _infoTextEl.textContent = 'Camera: Attempting to reconnect stream...';
    }

    function _startPolling() {
        if (_pollTimer) return;
        _failCount = 0;
        _pollTimer = setInterval(_fetchFrame, POLL_INTERVAL_MS);
        _fetchFrame();
    }

    function _stopPolling() {
        if (_pollTimer) {
            clearInterval(_pollTimer);
            _pollTimer = null;
        }
    }

    function _fetchFrame() {
        if (!_feedEl || _inFlight) return;
        _inFlight = true;

        const baseUrl = API.getBaseUrl();
        const tok = API.getToken ? API.getToken() : null;
        const frameUrl = `${baseUrl}/latest.jpg?t=${Date.now()}${tok ? '&token=' + encodeURIComponent(tok) : ''}`;
        const loader = new Image();

        loader.onload = () => {
            _inFlight = false;
            _failCount = 0;
            _lastFrameTime = Date.now();
            _feedEl.src = frameUrl;
            _setLive();
        };

        loader.onerror = () => {
            _inFlight = false;
            _failCount += 1;
            if (_failCount >= 2 && _failCount < 5) {
                _setReconnecting();
            } else if (_failCount >= 5) {
                setOffline('STREAM UNAVAILABLE', 'Unable to fetch frames from backend /latest.jpg');
            }
        };

        loader.src = frameUrl;
    }

    function _updateTimestampLabel() {
        if (!_infoTextEl || !_lastFrameTime) return;
        const ts = new Date(_lastFrameTime).toLocaleTimeString();
        _infoTextEl.textContent = `Camera: LIVE • Last frame ${ts}`;
    }

    async function reconnect() {
        _failCount = 0;
        _setReconnecting();
        try {
            const camStatus = await API.getCameraStatus();
            if (camStatus && camStatus.frame_available) {
                _startPolling();
                _fetchFrame();
            } else {
                setOffline(
                    'STREAM UNAVAILABLE',
                    camStatus && camStatus.cam_node_status === 'ONLINE'
                        ? 'ESP32-CAM connected — no frame captured yet'
                        : 'ESP32-CAM is offline'
                );
            }
        } catch (_) {
            setOffline('STREAM UNAVAILABLE', 'Backend unreachable');
        }
    }

    function _toggleFullscreen() {
        const vp = document.getElementById('camera-viewport');
        if (!vp) return;
        if (!document.fullscreenElement) {
            if (vp.requestFullscreen) vp.requestFullscreen().catch(() => {});
        } else if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    }

    return { init, updateFromSnapshot, setOffline, reconnect };
})();
