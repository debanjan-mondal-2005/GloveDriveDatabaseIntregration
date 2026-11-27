/**
 * app.js — Main controller for NEON DRIVE Smart Vehicle IoT Telemetry.
 *
 * Strictly live-backend driven (no simulated data).
 * Preserves all 5 views, NEON DRIVE visual design, vehicle animations,
 * live camera feed, and the 3 sidebar system node status indicators
 * (red dot when disconnected -> green dot when connected).
 */

(() => {
    const VIEW_TITLES = {
        overview: 'Vehicle Overview',
        telemetry: 'Live Telemetry',
        analytics: 'Sensor Analytics',
        safety: 'Safety & Alerts',
        device: 'Device Information',
    };

    const DEFAULT_NODES = [
        { id: 'glove', title: 'ESP32 Glove', proto: 'ESP-NOW + WS', status: 'OFFLINE', rtt: null },
        { id: 'main', title: 'ESP32 Car', proto: 'WebSocket', status: 'OFFLINE', rtt: null },
        { id: 'cam', title: 'ESP32-CAM Vision', proto: 'HTTP + WS', status: 'OFFLINE', rtt: null },
    ];

    const DIR_ALIASES = {
        FORWARD: 'forward',
        FWD: 'forward',
        F: 'forward',
        BACKWARD: 'backward',
        REVERSE: 'backward',
        REV: 'backward',
        B: 'backward',
        LEFT: 'left',
        STEER_L: 'left',
        LFT: 'left',
        L: 'left',
        RIGHT: 'right',
        STEER_R: 'right',
        RGT: 'right',
        R: 'right',
        STOP: 'stop',
        HALT: 'stop',
        IDLE: 'stop',
        S: 'stop',
    };

    const DIR_LABELS = {
        forward: 'FORWARD',
        backward: 'BACKWARD',
        left: 'LEFT',
        right: 'RIGHT',
        stop: 'STOP',
    };

    const HUMIDITY_CIRCUMFERENCE = 238.76; // 2 * PI * 38

    let _packetCount = 0;
    let _lastSnapshot = null;
    let _historyLoaded = false;
    let _lastChartTickMs = 0;
    let _backendOnline = false;
    let _mainOnline = false;
    let _prevMainOnline = null;
    let _lastSessionRefreshMs = 0;
    let _ctrlFeedbackTimer = null;
    let _expiryTimer = null;
    let _pendingOtpEmail = '';
    let _otpResendCooldownTimer = null;
    let _dashboardStarted = false;
    let _authAnimRaf = null;
    let _dashAnimRaf = null;
    const _dashSceneState = {
        motion: 'stop',
        blocked: false,
        estop: false,
        speedPct: 0,
        speedAPct: 0,
        speedBPct: 0,
        near: false,
    };
    const _ctrlDragging = { speedA: false, speedB: false, servo: false, stopCm: false };

    document.addEventListener('DOMContentLoaded', () => {
        _initNavigation();
        _initMobileSidebar();
        _initEStop();
        _initControls();
        _initSessionHistory();
        _initInteractiveEffects();
        _initAuth();

        Charts.init();
        Camera.init();

        // Render initial offline state (including 3 red node dots)
        _setDisconnectedState();

        // Wire API listeners
        API.on('wsOpen', _onWsOpen);
        API.on('wsClose', _onWsClose);
        API.on('snapshot', _onSnapshot);
        API.on('authExpired', err => {
            _exitToAuth(err && err.message ? err.message : 'Session expired. Please sign in again.');
        });
        API.on('error', err => {
            console.warn('[Dashboard]', err.message);
            _showControlFeedback(err.message, false);
        });

        _checkAuthOnStartup();
    });

    async function _bootstrapBackend() {
        _setText('info-gateway-url', API.getBaseUrl());
        try {
            const snap = await API.getStatus();
            if (snap && snap.tel) {
                _backendOnline = true;
                _onSnapshot(snap);
            }
        } catch (_) {
            _setDisconnectedState();
        }
        API.connect();
    }

    /* ── Navigation & Mobile Sidebar ─────────────────────────── */
    function _initNavigation() {
        const links = document.querySelectorAll('.nav-link[data-target]');
        links.forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const target = link.dataset.target;
                _switchView(target);
                _closeMobileSidebar();
            });
        });

        const hash = (window.location.hash || '').replace('#', '');
        if (hash && VIEW_TITLES[hash]) {
            _switchView(hash);
        }
    }

    function _switchView(target) {
        if (!VIEW_TITLES[target]) return;

        document.querySelectorAll('.nav-link').forEach(l => {
            l.classList.toggle('active', l.dataset.target === target);
        });

        document.querySelectorAll('.view-section').forEach(sec => {
            const isTarget = sec.id === `view-${target}`;
            sec.classList.toggle('active', isTarget);
            sec.classList.toggle('hidden', !isTarget);
        });

        _setText('navbar-page-title', VIEW_TITLES[target]);
        if (window.location.hash !== `#${target}`) {
            history.replaceState(null, '', `#${target}`);
        }

        if (target === 'analytics') {
            if (!_historyLoaded) {
                _historyLoaded = true;
                Charts.loadHistory().then(() => Charts.refresh());
            } else {
                Charts.refresh();
            }
        } else if (target === 'device') {
            _loadSessionHistory();
        }
    }

    function _initMobileSidebar() {
        const toggleBtn = document.getElementById('mobile-sidebar-toggle');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (toggleBtn) toggleBtn.addEventListener('click', _openMobileSidebar);
        if (backdrop) backdrop.addEventListener('click', _closeMobileSidebar);
    }

    function _openMobileSidebar() {
        document.getElementById('app-sidebar')?.classList.add('open');
        document.getElementById('sidebar-backdrop')?.classList.remove('hidden');
    }

    function _closeMobileSidebar() {
        document.getElementById('app-sidebar')?.classList.remove('open');
        document.getElementById('sidebar-backdrop')?.classList.add('hidden');
    }

    /* ── WebSocket Lifecycle ─────────────────────────────────── */
    function _onWsOpen() {
        _backendOnline = true;
        _setConnectionPill(true);
        _setText('info-backend-status', 'ONLINE');
        _setClass('info-backend-status', 'info-val text-success font-semibold');
        _setText('info-ws-status', 'Connected (Live Stream)');
        _setClass('info-ws-status', 'info-val text-success font-semibold');
        _setText('info-mode', 'LIVE (Hardware Backend)');
    }

    function _onWsClose() {
        _backendOnline = false;
        _setDisconnectedState();
    }

    function _setConnectionPill(online) {
        const pill = document.getElementById('connection-status-pill');
        const text = document.getElementById('connection-status-text');
        if (pill) {
            pill.className = `status-indicator ${online ? 'status-online' : 'status-offline'}`;
        }
        if (text) {
            text.textContent = online ? 'Backend Online' : 'Backend Offline';
        }
    }

    /* ── Snapshot Rendering ──────────────────────────────────── */
    function _onSnapshot(snap) {
        if (!snap || typeof snap !== 'object') return;
        _lastSnapshot = snap;
        _backendOnline = true;
        _packetCount += 1;

        const nodes = Array.isArray(snap.nodes) && snap.nodes.length ? snap.nodes : DEFAULT_NODES;
        const tel = snap.tel || {};
        const mainNode = nodes.find(n => n.id === 'main');
        const gloveNode = nodes.find(n => n.id === 'glove');
        const mainData = mainNode && mainNode.data ? mainNode.data : {};
        const gloveData = gloveNode && gloveNode.data ? gloveNode.data : {};

        _setConnectionPill(true);
        _renderSidebarNodes(nodes, tel.device_id);
        _renderDbPill(snap.db);
        _renderEStopButton(Boolean(snap.estop));

        const nowLabel = snap.t ? new Date(snap.t * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
        _setText('last-update-label', nowLabel);

        const mainConnected = mainNode && (mainNode.status === 'ONLINE' || mainNode.status === 'SILENT');

        if (mainConnected) {
            _renderHero(tel, mainData, Boolean(snap.estop));
            _renderSensors(tel, mainData);
            _renderSafety(tel, mainData, Boolean(snap.estop));
        } else {
            _renderMainOfflineState(tel, Boolean(snap.estop));
        }

        _renderAlertsFeed(snap.alerts || []);
        _renderTelemetryTable(tel, mainData, gloveData, nodes, Boolean(snap.estop));
        _renderRawJson(snap);
        _renderDeviceInfo(snap, nodes, nowLabel);

        Camera.updateFromSnapshot(snap);

        // Append live chart tick max once per ~1s when Main ESP is ONLINE
        const nowMs = Date.now();
        if (mainNode && mainNode.status === 'ONLINE' && nowMs - _lastChartTickMs >= 950) {
            _lastChartTickMs = nowMs;
            Charts.appendLiveTick(tel, mainData);
        }
    }

    /* ── Sidebar System Nodes (Exactly 3 Nodes: Red -> Green) ── */
    function _renderSidebarNodes(nodes, deviceId) {
        const container = document.getElementById('sidebar-nodes-list');
        if (container) {
            // Render strictly the 3 backend nodes (no duplicate static nodes)
            const html = nodes.map(n => {
                const status = n.status || 'OFFLINE';
                const rttText = status === 'ONLINE' && n.rtt != null ? `${n.rtt}ms` : '--';
                return `
                    <div class="node-item" data-node-id="${_esc(n.id)}">
                        <div class="node-item-left">
                            <span class="node-dot ${_esc(status)}" title="${_esc(status)}"></span>
                            <span class="node-name">${_esc(n.title)}</span>
                        </div>
                        <span class="node-rtt">${_esc(rttText)}</span>
                    </div>
                `;
            }).join('');
            container.innerHTML = html;
        }

        const mainNode = nodes.find(n => n.id === 'main');
        const unitDot = document.getElementById('sidebar-unit-dot');
        if (unitDot) {
            unitDot.classList.toggle('online', Boolean(mainNode && mainNode.status === 'ONLINE'));
        }
        if (deviceId) {
            _setText('sidebar-unit-id', deviceId);
            _setText('hero-unit-tag', `UNIT # ${deviceId}`);
            _setText('info-device-id', deviceId);
            const sel = document.getElementById('device-select');
            if (sel && sel.options[0]) {
                sel.options[0].value = deviceId;
                sel.options[0].textContent = `${deviceId} (${mainNode && mainNode.status === 'ONLINE' ? 'Active' : 'Offline'})`;
            }
        }
    }

    /* ── Hero & Vehicle Animation ────────────────────────────── */
    function _renderHero(tel, mainData, estop) {
        const rawDir = (tel.direction || mainData.dir || '').toString().trim();
        const motion = DIR_ALIASES[rawDir.toUpperCase()] || null;
        const displayDir = motion ? DIR_LABELS[motion] : 'UNKNOWN';

        _updateDirectionHUD(motion, displayDir);

        const blocked = Boolean(mainData.blocked);
        const stopCm = mainData.stop_cm || 20;
        const dist = tel.front_dist_cm;
        const isNear = typeof dist === 'number' && dist < 999 && dist <= stopCm + 25;

        const stage = document.getElementById('vehicle-stage');
        const wrapper = document.getElementById('vehicle-svg-wrapper');
        if (wrapper) {
            wrapper.setAttribute('data-motion', motion || 'stop');
            wrapper.classList.toggle('vehicle-blocked', blocked || estop);
        }
        if (stage) {
            stage.classList.toggle('stage-near', isNear && !blocked && !estop);
        }

        // Rotate nose ultrasonic servo beam using real ESP32 servo angle (0..180, 90=center)
        const servoBeam = document.getElementById('nose-servo-beam');
        if (servoBeam && !_ctrlDragging.servo && mainData.servo != null && !Number.isNaN(Number(mainData.servo))) {
            const servoAngle = Math.max(0, Math.min(180, Math.round(Number(mainData.servo))));
            const deg = Math.max(-90, Math.min(90, servoAngle - 90));
            servoBeam.style.transform = `rotate(${deg}deg)`;
            servoBeam.style.opacity = '0.82';
            _setText('hud-servo-pill', `SERVO: ${servoAngle}°`);
        }
        if (!_ctrlDragging.stopCm) {
            _setText('hud-range-pill', `STOP: ${stopCm}cm`);
        }

        const blockedBadge = document.getElementById('hero-blocked-badge');
        if (blockedBadge) {
            if (estop) {
                blockedBadge.className = 'status-badge badge-danger pulse';
                blockedBadge.textContent = 'E-STOP ACTIVE';
            } else if (blocked) {
                blockedBadge.className = 'status-badge badge-danger pulse';
                blockedBadge.textContent = 'OBSTACLE BLOCKED';
            } else {
                blockedBadge.className = 'status-badge badge-success';
                blockedBadge.textContent = 'PATH CLEAR';
            }
        }

        const statusBadge = document.getElementById('hero-status-badge');
        if (statusBadge) {
            statusBadge.textContent = mainData.glove_link ? 'GLOVE LINK ACTIVE' : 'ESP32 DUAL-MOTOR';
        }

        // Differential Motor Gauges & Speed-Responsive Animations
        const speedAPct = _clampPct(mainData.speedA);
        const speedBPct = _clampPct(mainData.speedB);
        const isMoving = motion && motion !== 'stop' && !(motion === 'forward' && blocked) && !estop;
        const pwmA = speedAPct !== null ? (isMoving ? Math.round((speedAPct / 100) * 255) : 0) : null;
        const pwmB = speedBPct !== null ? (isMoving ? Math.round((speedBPct / 100) * 255) : 0) : null;

        if (stage) {
            const avgSpd = ((speedAPct ?? 50) + (speedBPct ?? 50)) / 2;
            const driveDur = Math.max(0.22, 0.9 - (avgSpd / 100) * 0.65).toFixed(2);
            const wheelDur = Math.max(0.14, 0.55 - (avgSpd / 100) * 0.38).toFixed(2);
            stage.style.setProperty('--drive-dur', `${driveDur}s`);
            stage.style.setProperty('--wheel-dur', `${wheelDur}s`);
        }

        _setText('val-motor-a-pct', speedAPct !== null ? `${speedAPct}%` : '--');
        _setText('val-motor-b-pct', speedBPct !== null ? `${speedBPct}%` : '--');
        _setWidth('bar-motor-a', speedAPct !== null ? speedAPct : 0);
        _setWidth('bar-motor-b', speedBPct !== null ? speedBPct : 0);
        _setText('val-motor-a', pwmA !== null ? pwmA : '--');
        _setText('val-motor-b', pwmB !== null ? pwmB : '--');

        // Summary Motor Cards 5 & 6
        _setText('val-motor-a-card', estop ? 'E-STOP' : (isMoving ? 'ENA ACTIVE' : 'ENA STANDBY'));
        _setText('val-motor-b-card', estop ? 'E-STOP' : (isMoving ? 'ENB ACTIVE' : 'ENB STANDBY'));
        _setText('badge-motor-a-status', speedAPct !== null ? `${speedAPct}% LIMIT` : 'CHANNEL A');
        _setText('badge-motor-b-status', speedBPct !== null ? `${speedBPct}% LIMIT` : 'CHANNEL B');

        _mainOnline = true;
        _dashSceneState.motion = motion || 'stop';
        _dashSceneState.blocked = blocked;
        _dashSceneState.estop = estop;
        _dashSceneState.speedAPct = speedAPct !== null ? speedAPct : 65;
        _dashSceneState.speedBPct = speedBPct !== null ? speedBPct : 65;
        _dashSceneState.speedPct = isMoving ? ((_dashSceneState.speedAPct + _dashSceneState.speedBPct) / 2) : 0;
        _dashSceneState.near = isNear;
        _syncControlsFromTelemetry(mainData, estop, true);
        if (_prevMainOnline === false) {
            _loadSessionHistory();
        }
        _prevMainOnline = true;
    }

    function _updateDirectionHUD(motion, labelText) {
        _setText('hero-direction-badge', labelText);

        const buttons = {
            forward: 'dir-btn-forward',
            backward: 'dir-btn-backward',
            left: 'dir-btn-left',
            right: 'dir-btn-right',
            stop: 'dir-btn-stop',
        };
        Object.entries(buttons).forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', motion === key);
        });
    }

    /* ── 6 Sensor Cards ──────────────────────────────────────── */
    function _renderSensors(tel, mainData) {
        const dhtOk = mainData.dht_ok !== false && tel.temp_c > 0;

        // 1. Temperature
        if (dhtOk && typeof tel.temp_c === 'number') {
            const temp = tel.temp_c;
            _setText('val-temperature', temp.toFixed(1));
            const pct = Math.min(100, Math.max(0, ((temp - 15) / 30) * 100));
            _setWidth('bar-temperature', pct);
            const badge = document.getElementById('status-temperature');
            if (badge) {
                if (temp >= 40) {
                    badge.className = 'status-badge badge-danger';
                    badge.textContent = 'HIGH TEMP';
                } else if (temp >= 34) {
                    badge.className = 'status-badge badge-warning';
                    badge.textContent = 'WARM';
                } else {
                    badge.className = 'status-badge badge-success';
                    badge.textContent = 'NORMAL';
                }
            }
        } else {
            _setText('val-temperature', '--');
            _setWidth('bar-temperature', 0);
            _setBadge('status-temperature', 'badge-warning', 'NO SIGNAL');
        }

        // 2. Humidity (Circular SVG Progress)
        if (dhtOk && typeof tel.humidity_pct === 'number' && tel.humidity_pct > 0) {
            const hum = Math.min(100, Math.max(0, tel.humidity_pct));
            _setText('val-humidity', hum.toFixed(1));
            const circle = document.getElementById('circle-humidity-progress');
            if (circle) {
                circle.style.strokeDashoffset = (HUMIDITY_CIRCUMFERENCE * (1 - hum / 100)).toFixed(2);
            }
            if (hum > 85) _setBadge('status-humidity', 'badge-warning', 'HIGH');
            else if (hum < 25) _setBadge('status-humidity', 'badge-warning', 'DRY');
            else _setBadge('status-humidity', 'badge-success', 'OPTIMAL');
        } else {
            _setText('val-humidity', '--');
            const circle = document.getElementById('circle-humidity-progress');
            if (circle) circle.style.strokeDashoffset = String(HUMIDITY_CIRCUMFERENCE);
            _setBadge('status-humidity', 'badge-warning', 'NO SIGNAL');
        }

        // 3. MQ Gas Sensor (0-4095 ADC)
        if (typeof tel.gas_raw === 'number' && tel.gas_raw >= 0) {
            const gas = tel.gas_raw;
            const gasPct = (gas / 4095) * 100;
            _setText('val-gas', gas);
            _setText('val-gas-pct', `${gasPct.toFixed(1)}%`);
            _setWidth('bar-gas', gasPct);

            const gasState = mainData.gas_state || (gas >= 2500 ? 'DANGER' : gas >= 1500 ? 'Warning' : 'Normal');
            if (gasState === 'DANGER') {
                _setBadge('badge-gas-status', 'badge-danger', 'DANGER');
            } else if (gasState === 'Warning') {
                _setBadge('badge-gas-status', 'badge-warning', 'WARNING');
            } else {
                _setBadge('badge-gas-status', 'badge-success', 'NORMAL');
            }
        } else {
            _setText('val-gas', '--');
            _setText('val-gas-pct', '--');
            _setWidth('bar-gas', 0);
            _setBadge('badge-gas-status', 'badge-warning', 'NO SIGNAL');
        }

        // 4. Ultrasonic Proximity
        const stopCm = mainData.stop_cm || 20;
        _setText('distance-threshold-desc', `Obstacle Alert Threshold: ≤ ${Number(stopCm).toFixed(1)} cm`);

        if (typeof tel.front_dist_cm === 'number' && tel.front_dist_cm < 999) {
            const dist = tel.front_dist_cm;
            const blocked = Boolean(mainData.blocked) || dist <= stopCm;
            _setText('val-distance', dist.toFixed(1));

            const radar = document.getElementById('radar-ultrasonic');
            if (radar) radar.classList.toggle('radar-alert', blocked);

            if (blocked) {
                _setBadge('badge-distance-status', 'badge-danger', 'OBSTACLE');
            } else if (dist <= stopCm + 20) {
                _setBadge('badge-distance-status', 'badge-warning', 'NEAR');
            } else {
                _setBadge('badge-distance-status', 'badge-success', 'CLEAR PATH');
            }
        } else {
            _setText('val-distance', '--');
            document.getElementById('radar-ultrasonic')?.classList.remove('radar-alert');
            _setBadge('badge-distance-status', 'badge-warning', 'OUT OF RANGE');
        }
    }

    /* ── Safety & Alerts View ────────────────────────────────── */
    function _renderSafety(tel, mainData, estop) {
        const stopCm = mainData.stop_cm || 20;
        const dist = tel.front_dist_cm;
        const blocked = Boolean(mainData.blocked) || (dist < 999 && dist <= stopCm);

        // 1. Proximity Interlock
        if (dist >= 999) {
            _setBanner('safety-obstacle-status', 'banner-success', 'PATH CLEAR (No Frontal Obstacle in Range)');
        } else if (blocked) {
            _setBanner('safety-obstacle-status', 'banner-danger', `OBSTACLE DETECTED (${dist} cm ≤ ${stopCm} cm threshold)`);
        } else if (dist <= stopCm + 20) {
            _setBanner('safety-obstacle-status', 'banner-warning', `PROXIMITY CAUTION (${dist} cm — Buzzer Warning Zone)`);
        } else {
            _setBanner('safety-obstacle-status', 'banner-success', `PATH CLEAR (${dist} cm — No Frontal Obstacle)`);
        }

        // 2. Gas
        const gas = tel.gas_raw;
        const gasState = mainData.gas_state || (gas >= 2500 ? 'DANGER' : gas >= 1500 ? 'Warning' : 'Normal');
        if (gasState === 'DANGER') {
            _setBanner('safety-gas-status', 'banner-danger', `DANGER: HIGH GAS CONCENTRATION (${gas} ADC)`);
        } else if (gasState === 'Warning') {
            _setBanner('safety-gas-status', 'banner-warning', `ELEVATED GAS LEVEL (${gas} ADC)`);
        } else {
            _setBanner('safety-gas-status', 'banner-success', `NORMAL AIR QUALITY (${gas} ADC)`);
        }

        // 3. Forward Collision Interlock / E-STOP
        if (estop) {
            _setBanner('safety-movement-status', 'banner-danger', 'HUB E-STOP ENGAGED (Motors Forced to 0%)');
        } else if (blocked) {
            _setBanner('safety-movement-status', 'banner-danger', 'FORWARD DRIVE LOCKED (Ultrasonic Collision Failsafe Active)');
        } else {
            _setBanner('safety-movement-status', 'banner-success', 'SAFETY INTERLOCK NORMAL (Drive authorized)');
        }
    }

    function _renderAlertsFeed(alertsList) {
        const container = document.getElementById('alerts-feed-list');
        if (!container) return;

        if (!alertsList || alertsList.length === 0) {
            container.innerHTML = '<div class="text-xs text-muted" style="padding: 16px; text-align: center;">No safety alerts recorded in this session.</div>';
            _setText('info-active-alerts', '0');
            return;
        }

        const unacked = alertsList.filter(a => !a.acked).length;
        _setText('info-active-alerts', String(unacked));

        container.innerHTML = alertsList.map(a => {
            const sev = (a.severity || 'INFO').toUpperCase();
            const cls = sev === 'CRITICAL' ? 'alert-danger' : sev === 'ELEVATED' ? 'alert-warning' : 'alert-info';
            const badgeCls = sev === 'CRITICAL' ? 'badge-danger' : sev === 'ELEVATED' ? 'badge-warning' : 'badge-info';
            const timeStr = a.t ? new Date(a.t * 1000).toLocaleTimeString() : '--';
            const ackBtn = a.id != null
                ? `<button class="btn-ack ${a.acked ? 'acked' : ''}" data-alert-id="${a.id}" ${a.acked ? 'disabled' : ''}>${a.acked ? 'Acknowledged' : 'Acknowledge'}</button>`
                : '';
            return `
                <div class="alert-item ${cls}">
                    <div class="alert-header">
                        <div class="alert-header-left">
                            <span class="status-badge ${badgeCls}">${_esc(sev)}</span>
                            <span class="font-mono text-xs text-muted">${_esc(a.source || 'SYSTEM')}</span>
                            <span class="font-mono text-xs text-muted">${_esc(timeStr)}</span>
                        </div>
                        ${ackBtn}
                    </div>
                    <div class="text-sm text-primary">${_esc(a.message || '')}</div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.btn-ack:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.alertId;
                try {
                    await API.ackAlert(id);
                    btn.classList.add('acked');
                    btn.textContent = 'Acknowledged';
                    btn.disabled = true;
                } catch (err) {
                    console.warn('[Alerts] Ack failed:', err.message);
                }
            });
        });
    }

    /* ── Live Telemetry Table & JSON Inspector ───────────────── */
    function _renderTelemetryTable(tel, mainData, gloveData, nodes, estop) {
        const tbody = document.getElementById('live-telemetry-tbody');
        if (!tbody) return;

        const mainNode = nodes.find(n => n.id === 'main');
        const mainOnline = mainNode && mainNode.status === 'ONLINE';

        const rows = [
            ['device_id', tel.device_id || '--', 'Unique ESP32 vehicle identifier'],
            ['mode', tel.mode || 'LIVE', 'Live backend ingestion mode'],
            ['direction', mainOnline ? (tel.direction || 'IDLE') : 'NO SIGNAL', 'Active vehicle motion state'],
            ['command', tel.command || 'NO SIGNAL', 'Latest gesture command from Glove ESP'],
            ['control_lock', tel.control_lock || '--', 'Active drive control authority'],
            ['front_dist_cm', mainOnline && tel.front_dist_cm < 999 ? `${tel.front_dist_cm} cm` : '--', 'HC-SR04 front ultrasonic distance'],
            ['temp_c', mainOnline && tel.temp_c > 0 ? `${tel.temp_c.toFixed(1)} °C` : '--', 'DHT11 ambient temperature'],
            ['humidity_pct', mainOnline && tel.humidity_pct > 0 ? `${tel.humidity_pct.toFixed(1)} %` : '--', 'DHT11 relative humidity'],
            ['gas_raw', mainOnline ? `${tel.gas_raw} ADC` : '--', 'MQ gas analog value (12-bit 0–4095)'],
            ['gas_state', mainData.gas_state || '--', 'Gas threshold classification'],
            ['speedA / speedB', mainOnline ? `${mainData.speedA ?? '--'}% / ${mainData.speedB ?? '--'}%` : '--', 'L298N Motor A & Motor B configured speed'],
            ['blocked', mainOnline && mainData.blocked != null ? String(mainData.blocked) : '--', 'Ultrasonic forward collision interlock'],
            ['servo', mainOnline && mainData.servo != null ? `${mainData.servo}° (${mainData.servo_mode || '--'})` : '--', 'Front sonar scanner servo angle'],
            ['glove_pitch_roll', gloveData.pitch_deg != null ? `${gloveData.pitch_deg.toFixed(1)}° / ${gloveData.roll_deg.toFixed(1)}°` : '--', 'MPU6050 glove tilt angles'],
            ['rssi_dbm', tel.rssi_dbm ? `${tel.rssi_dbm} dBm` : '--', 'Main ESP32 Wi-Fi signal strength'],
            ['hazard_score', mainOnline ? `${tel.hazard_score} / 100` : '--', 'Composite gas + proximity hazard index'],
            ['emergency_stop', estop ? 'ENGAGED' : 'CLEAR', 'Hub emergency stop interlock state'],
        ];

        tbody.innerHTML = rows.map(([field, val, desc]) => `
            <tr>
                <td class="font-mono text-cyan">${_esc(field)}</td>
                <td class="font-mono font-semibold text-primary">${_esc(String(val))}</td>
                <td class="text-secondary text-xs">${_esc(desc)}</td>
            </tr>
        `).join('');
    }

    function _renderRawJson(snap) {
        const pre = document.getElementById('raw-json-inspector');
        if (!pre) return;
        pre.textContent = JSON.stringify(snap, null, 2);
    }

    /* ── Device Info View ────────────────────────────────────── */
    function _renderDeviceInfo(snap, nodes, nowLabel) {
        _setText('info-packet-count', String(_packetCount));
        _setText('info-last-time', nowLabel);

        const db = snap.db || {};
        const records = db.records ? db.records : (db.hist_count ?? 0);
        _setText('info-total-records', `${records} (${db.ok ? 'Supabase Synced' : 'In-Memory Buffer'})`);

        const tbody = document.getElementById('nodes-detail-tbody');
        if (tbody) {
            tbody.innerHTML = nodes.map(n => {
                const st = n.status || 'OFFLINE';
                const badgeCls = st === 'ONLINE' ? 'badge-success' : st === 'SILENT' ? 'badge-warning' : 'badge-danger';
                return `
                    <tr>
                        <td class="font-semibold text-primary">${_esc(n.title)}</td>
                        <td><span class="status-badge ${badgeCls}">${_esc(st)}</span></td>
                        <td class="font-mono text-xs">${_esc(n.proto || '--')}</td>
                        <td class="font-mono text-xs">${_esc(n.ip || '--')}</td>
                        <td class="font-mono">${n.rate != null ? `${n.rate}/s` : '--'}</td>
                        <td class="font-mono">${n.rtt != null ? `${n.rtt} ms` : '--'}</td>
                        <td class="font-mono">${n.rssi != null ? `${n.rssi} dBm` : '--'}</td>
                        <td class="font-mono">${n.lost != null ? n.lost : '--'}</td>
                    </tr>
                `;
            }).join('');
        }

        const deviceSec = document.getElementById('view-device');
        const nowMs = Date.now();
        if (deviceSec && deviceSec.classList.contains('active') && nowMs - _lastSessionRefreshMs >= 3000) {
            _loadSessionHistory();
        }
    }

    function _renderDbPill(db) {
        const pill = document.getElementById('db-status-pill');
        const text = document.getElementById('db-status-text');
        if (!pill || !text || !db) return;
        pill.className = `status-indicator ${db.ok ? 'status-online' : 'status-offline'}`;
        text.textContent = db.ok ? 'DB: SYNCED' : `DB: OFFLINE (Q:${db.queue ?? 0})`;
    }

    /* ── Offline / Disconnected States ───────────────────────── */
    function _renderMainOfflineState(tel, estop) {
        _mainOnline = false;
        _updateDirectionHUD(null, 'NO SIGNAL');
        const stage = document.getElementById('vehicle-stage');
        if (stage) stage.classList.remove('stage-near');
        const wrapper = document.getElementById('vehicle-svg-wrapper');
        if (wrapper) {
            wrapper.setAttribute('data-motion', 'stop');
            wrapper.classList.toggle('vehicle-blocked', estop);
        }
        const servoBeam = document.getElementById('nose-servo-beam');
        if (servoBeam && !_ctrlDragging.servo) {
            servoBeam.style.transform = 'rotate(0deg)';
            servoBeam.style.opacity = '0.25';
        }
        _syncControlsFromTelemetry({}, estop, false);
        _dashSceneState.motion = 'stop';
        _dashSceneState.blocked = false;
        _dashSceneState.estop = estop;
        _dashSceneState.speedAPct = 0;
        _dashSceneState.speedBPct = 0;
        _dashSceneState.speedPct = 0;
        _dashSceneState.near = false;
        if (_prevMainOnline === true) {
            _loadSessionHistory();
        }
        _prevMainOnline = false;
        _setBadge('hero-blocked-badge', estop ? 'badge-danger' : 'badge-warning', estop ? 'E-STOP ACTIVE' : 'CAR OFFLINE');

        _setText('val-motor-a-pct', '--');
        _setText('val-motor-b-pct', '--');
        _setWidth('bar-motor-a', 0);
        _setWidth('bar-motor-b', 0);
        _setText('val-motor-a', '--');
        _setText('val-motor-b', '--');
        _setText('val-motor-a-card', 'OFFLINE');
        _setText('val-motor-b-card', 'OFFLINE');
        _setText('badge-motor-a-status', 'CHANNEL A');
        _setText('badge-motor-b-status', 'CHANNEL B');

        _setText('val-temperature', '--');
        _setWidth('bar-temperature', 0);
        _setBadge('status-temperature', 'badge-warning', 'NO SIGNAL');

        _setText('val-humidity', '--');
        const circle = document.getElementById('circle-humidity-progress');
        if (circle) circle.style.strokeDashoffset = String(HUMIDITY_CIRCUMFERENCE);
        _setBadge('status-humidity', 'badge-warning', 'NO SIGNAL');

        _setText('val-gas', '--');
        _setText('val-gas-pct', '--');
        _setWidth('bar-gas', 0);
        _setBadge('badge-gas-status', 'badge-warning', 'NO SIGNAL');

        _setText('val-distance', '--');
        document.getElementById('radar-ultrasonic')?.classList.remove('radar-alert');
        _setBadge('badge-distance-status', 'badge-warning', 'NO SIGNAL');

        _setBanner('safety-obstacle-status', 'banner-warning', 'NO SIGNAL (ESP32 Car Disconnected)');
        _setBanner('safety-gas-status', 'banner-warning', 'NO SIGNAL (ESP32 Car Disconnected)');
        _setBanner('safety-movement-status', estop ? 'banner-danger' : 'banner-warning',
            estop ? 'HUB E-STOP ENGAGED' : 'NO SIGNAL (ESP32 Car Disconnected)');
    }

    function _setDisconnectedState() {
        _setConnectionPill(false);
        _renderSidebarNodes(DEFAULT_NODES, null);
        _renderMainOfflineState({}, false);

        const dbPill = document.getElementById('db-status-pill');
        const dbText = document.getElementById('db-status-text');
        if (dbPill) dbPill.className = 'status-indicator status-offline';
        if (dbText) dbText.textContent = 'DB: OFFLINE';

        _setText('last-update-label', 'OFFLINE');
        _setText('info-mode', 'OFFLINE (Backend Unreachable)');
        _setText('info-backend-status', 'OFFLINE');
        _setClass('info-backend-status', 'info-val text-danger font-semibold');
        _setText('info-ws-status', 'Disconnected');
        _setClass('info-ws-status', 'info-val text-danger');

        Camera.setOffline('STREAM UNAVAILABLE', 'Backend server disconnected');
    }

    /* ── E-Stop ───────────────────────────────────────────────── */
    function _initEStop() {
        const btn = document.getElementById('btn-estop');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const currentlyOn = Boolean(_lastSnapshot && _lastSnapshot.estop);
            try {
                await API.sendCommand({ cmd: 'estop', on: !currentlyOn });
            } catch (err) {
                console.warn('[E-Stop]', err.message);
            }
        });
    }

    function _renderEStopButton(active) {
        const btn = document.getElementById('btn-estop');
        if (!btn) return;
        btn.classList.toggle('active', active);
        btn.textContent = active ? 'RELEASE E-STOP' : 'E-STOP';
    }

    /* ── Hardware Controls (Motor Speed, Servo Angle, Ultrasonic Range) ── */
    function _initControls() {
        const speedA = document.getElementById('ctrl-speed-a');
        const speedB = document.getElementById('ctrl-speed-b');
        const syncChk = document.getElementById('ctrl-speed-sync');
        const speedApply = document.getElementById('ctrl-speed-apply');

        const servoInput = document.getElementById('ctrl-servo-angle');
        const servoSweep = document.getElementById('ctrl-servo-sweep');

        const stopCmInput = document.getElementById('ctrl-stop-cm');
        const rangeApply = document.getElementById('ctrl-range-apply');

        [speedA, speedB, servoInput, stopCmInput].forEach(_setSliderFill);

        function bindDrag(el, key) {
            if (!el) return;
            const start = () => { _ctrlDragging[key] = true; };
            const end = () => { _ctrlDragging[key] = false; };
            el.addEventListener('pointerdown', start);
            el.addEventListener('touchstart', start, { passive: true });
            el.addEventListener('blur', end);
            window.addEventListener('pointerup', end);
            window.addEventListener('touchend', end, { passive: true });
        }

        bindDrag(speedA, 'speedA');
        bindDrag(speedB, 'speedB');
        bindDrag(servoInput, 'servo');
        bindDrag(stopCmInput, 'stopCm');

        // Motor A & B sliders
        const updateSpeedReadouts = () => {
            if (speedA) {
                _setText('ctrl-speed-a-val', `${speedA.value}%`);
                _setSliderFill(speedA);
            }
            if (speedB) {
                _setText('ctrl-speed-b-val', `${speedB.value}%`);
                _setSliderFill(speedB);
            }
        };

        const commitSpeeds = () => {
            if (!speedA || !speedB) return;
            _ctrlDragging.speedA = false;
            _ctrlDragging.speedB = false;
            if (_lastSnapshot && _lastSnapshot.estop) {
                _showControlFeedback('Release E-STOP before setting motor speed', false);
                return;
            }
            const a = Number(speedA.value);
            const b = Number(speedB.value);
            _sendHardwareCommand({ cmd: 'config', speedA: a, speedB: b }, `Speed ${a}% / ${b}%`);
        };

        if (speedA) {
            speedA.addEventListener('input', () => {
                if (syncChk && syncChk.checked && speedB) speedB.value = speedA.value;
                updateSpeedReadouts();
            });
            speedA.addEventListener('change', commitSpeeds);
        }
        if (speedB) {
            speedB.addEventListener('input', () => {
                if (syncChk && syncChk.checked && speedA) speedA.value = speedB.value;
                updateSpeedReadouts();
            });
            speedB.addEventListener('change', commitSpeeds);
        }
        if (speedApply) {
            speedApply.addEventListener('click', commitSpeeds);
        }
        document.querySelectorAll('[data-speed-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const v = Number(btn.dataset.speedPreset);
                if (speedA) speedA.value = String(v);
                if (speedB) speedB.value = String(v);
                updateSpeedReadouts();
                commitSpeeds();
            });
        });

        // Servo Angle slider + Auto Sweep
        const previewServo = (angle) => {
            _setText('ctrl-servo-val', `${angle}°`);
            _setText('hud-servo-pill', `SERVO: ${angle}°`);
            _setText('ctrl-servo-mode', 'MANUAL');
            const beam = document.getElementById('nose-servo-beam');
            if (beam) {
                const deg = Math.max(-90, Math.min(90, angle - 90));
                beam.style.transform = `rotate(${deg}deg)`;
                beam.style.opacity = '0.88';
            }
        };

        const commitServo = (angle) => {
            _ctrlDragging.servo = false;
            _sendHardwareCommand({ cmd: 'servo', angle }, `Servo ${angle}°`);
        };

        if (servoInput) {
            servoInput.addEventListener('input', () => {
                _setSliderFill(servoInput);
                previewServo(Number(servoInput.value));
            });
            servoInput.addEventListener('change', () => commitServo(Number(servoInput.value)));
        }
        document.querySelectorAll('[data-servo-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const angle = Number(btn.dataset.servoPreset);
                if (servoInput) {
                    servoInput.value = String(angle);
                    _setSliderFill(servoInput);
                }
                previewServo(angle);
                commitServo(angle);
            });
        });
        if (servoSweep) {
            servoSweep.addEventListener('click', () => {
                _ctrlDragging.servo = false;
                _setText('ctrl-servo-mode', 'SWEEP');
                _sendHardwareCommand({ cmd: 'servo', mode: 'sweep' }, 'Servo Auto Sweep');
            });
        }

        // Ultrasonic Range (stop_cm) slider
        const previewRange = (cm) => {
            _setText('ctrl-stop-cm-val', `${cm} cm`);
            _setText('ctrl-warn-cm-val', `Warn Zone: ≤ ${cm + 40} cm`);
            _setText('hud-range-pill', `STOP: ${cm}cm`);
            _setText('distance-threshold-desc', `Obstacle Alert Threshold: ≤ ${Number(cm).toFixed(1)} cm`);
        };

        const commitRange = (cm) => {
            _ctrlDragging.stopCm = false;
            _sendHardwareCommand({ cmd: 'config', stop_cm: cm }, `Stop Range ${cm} cm`);
        };

        if (stopCmInput) {
            stopCmInput.addEventListener('input', () => {
                _setSliderFill(stopCmInput);
                previewRange(Number(stopCmInput.value));
            });
            stopCmInput.addEventListener('change', () => commitRange(Number(stopCmInput.value)));
        }
        document.querySelectorAll('[data-range-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const cm = Number(btn.dataset.rangePreset);
                if (stopCmInput) {
                    stopCmInput.value = String(cm);
                    _setSliderFill(stopCmInput);
                }
                previewRange(cm);
                commitRange(cm);
            });
        });
        if (rangeApply && stopCmInput) {
            rangeApply.addEventListener('click', () => commitRange(Number(stopCmInput.value)));
        }
    }

    function _syncControlsFromTelemetry(mainData, estop, online) {
        const badge = document.getElementById('ctrl-sync-badge');
        if (badge) {
            if (estop) {
                badge.className = 'status-badge badge-danger';
                badge.textContent = 'E-STOP LOCKED';
            } else if (online) {
                badge.className = 'status-badge badge-success';
                badge.textContent = 'LIVE SYNCED';
            } else {
                badge.className = 'status-badge badge-warning';
                badge.textContent = 'CAR OFFLINE';
            }
        }

        const speedA = document.getElementById('ctrl-speed-a');
        const speedB = document.getElementById('ctrl-speed-b');
        const speedApply = document.getElementById('ctrl-speed-apply');
        if (speedA) speedA.disabled = Boolean(estop);
        if (speedB) speedB.disabled = Boolean(estop);
        if (speedApply) speedApply.disabled = Boolean(estop);
        document.querySelectorAll('[data-speed-preset]').forEach(btn => {
            btn.disabled = Boolean(estop);
        });

        if (!online) return;

        if (speedA && !_ctrlDragging.speedA && mainData.speedA != null) {
            const a = _clampPct(mainData.speedA);
            if (a !== null) {
                speedA.value = String(a);
                _setText('ctrl-speed-a-val', `${a}%`);
                _setSliderFill(speedA);
            }
        }
        if (speedB && !_ctrlDragging.speedB && mainData.speedB != null) {
            const b = _clampPct(mainData.speedB);
            if (b !== null) {
                speedB.value = String(b);
                _setText('ctrl-speed-b-val', `${b}%`);
                _setSliderFill(speedB);
            }
        }

        const servoInput = document.getElementById('ctrl-servo-angle');
        if (servoInput && !_ctrlDragging.servo && mainData.servo != null) {
            const ang = Math.max(0, Math.min(180, Math.round(Number(mainData.servo))));
            servoInput.value = String(ang);
            _setText('ctrl-servo-val', `${ang}°`);
            _setSliderFill(servoInput);
        }
        if (mainData.servo_mode) {
            _setText('ctrl-servo-mode', String(mainData.servo_mode).toUpperCase());
        }

        const stopCmInput = document.getElementById('ctrl-stop-cm');
        if (stopCmInput && !_ctrlDragging.stopCm && mainData.stop_cm != null) {
            const cm = Math.max(5, Math.min(100, Math.round(Number(mainData.stop_cm))));
            stopCmInput.value = String(cm);
            _setText('ctrl-stop-cm-val', `${cm} cm`);
            _setText('ctrl-warn-cm-val', `Warn Zone: ≤ ${cm + 40} cm`);
            _setSliderFill(stopCmInput);
        }
    }

    async function _sendHardwareCommand(payload, label) {
        if (!_backendOnline) {
            _showControlFeedback('Backend offline', false);
            return;
        }
        if (!_mainOnline) {
            _showControlFeedback('ESP32 Car offline — connect Rover to apply', false);
            return;
        }
        try {
            await API.sendCommand(payload);
            _showControlFeedback(`Sent: ${label}`, true);
        } catch (err) {
            _showControlFeedback(err.message || 'Command failed', false);
        }
    }

    function _showControlFeedback(msg, ok) {
        const el = document.getElementById('ctrl-cmd-feedback');
        if (!el) return;
        el.textContent = msg;
        el.className = `ctrl-feedback ${ok ? 'ok' : 'err'}`;
        clearTimeout(_ctrlFeedbackTimer);
        _ctrlFeedbackTimer = setTimeout(() => {
            el.classList.add('hidden');
        }, 3200);
    }

    function _setSliderFill(el) {
        if (!el) return;
        const min = Number(el.min || 0);
        const max = Number(el.max || 100);
        const val = Number(el.value || 0);
        const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
        el.style.setProperty('--range-pct', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`);
    }

    /* ── Interactive Visual Effects (Stage 3D Parallax + Sonar Ping) ── */
    function _initInteractiveEffects() {
        const stage = document.getElementById('vehicle-stage');
        const pingRing = document.getElementById('sonar-ping-ring');
        if (stage) {
            stage.addEventListener('mousemove', e => {
                const rect = stage.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
                const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
                stage.style.setProperty('--tilt-x', `${(nx * 6).toFixed(2)}deg`);
                stage.style.setProperty('--tilt-y', `${(-ny * 6).toFixed(2)}deg`);
            });
            stage.addEventListener('mouseleave', () => {
                stage.style.setProperty('--tilt-x', '0deg');
                stage.style.setProperty('--tilt-y', '0deg');
            });
            stage.addEventListener('click', () => {
                if (!pingRing) return;
                pingRing.classList.remove('pinging');
                void pingRing.offsetWidth;
                pingRing.classList.add('pinging');
            });
        }

        document.querySelectorAll('.hud-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.remove('hud-pulse');
                void btn.offsetWidth;
                btn.classList.add('hud-pulse');
            });
        });
    }

    /* ── Vehicle Session History & PDF Report (Device Info) ──── */
    function _todayLocalIso() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function _initSessionHistory() {
        const picker = document.getElementById('session-date-picker');
        const refreshBtn = document.getElementById('btn-refresh-sessions');
        const dailyPdfBtn = document.getElementById('btn-download-daily-pdf');

        if (picker && !picker.value) {
            picker.value = _todayLocalIso();
        }
        if (picker) {
            picker.addEventListener('change', () => _loadSessionHistory());
        }
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => _loadSessionHistory());
        }
        if (dailyPdfBtn) {
            dailyPdfBtn.addEventListener('click', () => {
                const dateVal = picker ? picker.value : _todayLocalIso();
                _downloadPdf(
                    API.getDailyReportPdfUrl(dateVal),
                    `aegis_daily_report_${dateVal}.pdf`,
                    dailyPdfBtn
                );
            });
        }
    }

    async function _loadSessionHistory() {
        _lastSessionRefreshMs = Date.now();
        const picker = document.getElementById('session-date-picker');
        const dateVal = picker && picker.value ? picker.value : _todayLocalIso();
        try {
            const data = await API.getSessions(dateVal);
            _renderSessionHistory(data);
        } catch (err) {
            _setText('session-stat-status-msg', `Error loading history: ${err.message}`);
        }
    }

    function _renderSessionHistory(data) {
        if (!data) return;
        _setText('session-stat-cycles', `${data.on_count ?? 0} ON / ${data.off_count ?? 0} OFF`);
        _setText('session-stat-cycles-sub', `Date: ${data.date}`);
        _setText('session-stat-total-dur', data.total_duration_text || '00m 00s');
        _setText('session-stat-total-sub', `${data.total_duration_s ?? 0}s total active`);
        _setText('session-stat-window', `${data.first_on_local || '--'} / ${data.last_off_local || '--'}`);

        const liveEl = document.getElementById('session-stat-live');
        if (liveEl) {
            if (data.active_now) {
                liveEl.textContent = 'ONLINE (ACTIVE)';
                liveEl.className = 'session-kpi-val font-mono text-success';
            } else {
                liveEl.textContent = 'OFFLINE';
                liveEl.className = 'session-kpi-val font-mono text-muted';
            }
        }
        _setText('session-stat-status-msg', `${(data.sessions || []).length} session(s) stored`);

        const tbody = document.getElementById('sessions-history-tbody');
        if (!tbody) return;
        const list = data.sessions || [];
        if (list.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-muted text-xs" style="padding:18px;text-align:center">
                        No Car ON/OFF sessions recorded on ${_esc(data.date)}. Connect ESP32 Car to start automatic tracking.
                    </td>
                </tr>
            `;
            return;
        }

        const avgVal = (st, d = 0) => (st && st.count ? (st.sum / st.count).toFixed(d) : null);
        tbody.innerHTML = list.map((s, idx) => {
            const sm = s.summary || {};
            const stBadge = s.is_active
                ? '<span class="status-badge badge-success pulse">LIVE</span>'
                : '<span class="status-badge badge-info">ENDED</span>';
            const spdA = avgVal(sm.speed_a, 0) ?? '--';
            const spdB = avgVal(sm.speed_b, 0) ?? '--';
            const srv = sm.servo_angle || {};
            const srvText = srv.count ? `${Math.round(srv.min)}°–${Math.round(srv.max)}°` : '--';
            const dst = sm.front_dist_cm || {};
            const stp = sm.stop_cm || {};
            const dstText = dst.count ? `${Math.round(dst.min)}cm` : '--';
            const stpText = stp.last != null ? `${Math.round(stp.last)}cm` : '20cm';

            const tmp = avgVal(sm.temp_c, 1);
            const hum = avgVal(sm.humidity_pct, 0);
            const gasMax = sm.gas_raw && sm.gas_raw.count ? Math.round(sm.gas_raw.max) : null;
            const sensorSummary = `${tmp !== null ? `${tmp}°C` : '--'} • ${hum !== null ? `${hum}%` : '--'} • ${gasMax !== null ? `${gasMax} ADC` : '--'}`;

            return `
                <tr>
                    <td class="font-mono text-muted">${list.length - idx}</td>
                    <td>
                        ${stBadge}
                        <div class="text-xs text-muted" style="margin-top:3px">${_esc(s.off_reason || s.on_reason || '')}</div>
                    </td>
                    <td class="font-mono text-xs text-primary">${_esc(s.started_local)}</td>
                    <td class="font-mono text-xs ${s.is_active ? 'text-success font-semibold' : 'text-secondary'}">${_esc(s.ended_local)}</td>
                    <td class="font-mono font-semibold text-cyan">${_esc(s.duration_text)}</td>
                    <td class="font-mono text-xs">Spd ${spdA}/${spdB}% • Srv ${srvText} • Min ${dstText} (Stop ${stpText})</td>
                    <td class="font-mono text-xs">${_esc(sensorSummary)}</td>
                    <td>
                        <button type="button" class="btn-session-pdf" data-session-uid="${_esc(s.session_uid)}" data-session-date="${_esc((s.started_local || '').slice(0, 10))}">
                            PDF
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.btn-session-pdf').forEach(btn => {
            btn.addEventListener('click', () => {
                const uid = btn.dataset.sessionUid;
                const dt = btn.dataset.sessionDate || 'report';
                _downloadPdf(
                    API.getSessionPdfUrl(uid),
                    `aegis_session_${uid}_${dt}.pdf`,
                    btn
                );
            });
        });
    }

    async function _downloadPdf(url, filename, btn) {
        const origHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating…';
        }
        try {
            const resp = await fetch(url, {
                headers: API.authHeaders(),
                credentials: 'same-origin',
            });
            if (resp.status === 401) {
                API.clearSession();
                _exitToAuth('Session expired. Please sign in again.');
                return;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
            _setText('session-stat-status-msg', `Downloaded ${filename}`);
        } catch (err) {
            _setText('session-stat-status-msg', `PDF export failed: ${err.message}`);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        }
    }

    /* ── Authentication, Resend OTP, Google OAuth & Session Lifecycle ── */
    function _initAuth() {
        const tabLogin = document.getElementById('tab-login');
        const tabSignup = document.getElementById('tab-signup');
        const formLogin = document.getElementById('form-login');
        const formSignup = document.getElementById('form-signup');
        const formOtp = document.getElementById('form-otp');
        const btnLogout = document.getElementById('btn-logout');

        if (tabLogin) tabLogin.addEventListener('click', () => _setAuthMode('login'));
        if (tabSignup) tabSignup.addEventListener('click', () => _setAuthMode('signup'));

        document.querySelectorAll('[data-toggle-pw]').forEach(btn => {
            btn.addEventListener('click', () => {
                const inp = document.getElementById(btn.dataset.togglePw);
                if (!inp) return;
                const isPw = inp.type === 'password';
                inp.type = isPw ? 'text' : 'password';
                btn.textContent = isPw ? 'Hide' : 'Show';
            });
        });

        // OTP 6-digit boxes auto-advance & paste
        const otpInputs = Array.from(document.querySelectorAll('#otp-inputs-group .otp-digit'));
        otpInputs.forEach((inp, idx) => {
            inp.addEventListener('input', () => {
                inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
                if (inp.value && idx < otpInputs.length - 1) {
                    otpInputs[idx + 1].focus();
                }
            });
            inp.addEventListener('keydown', e => {
                if (e.key === 'Backspace' && !inp.value && idx > 0) {
                    otpInputs[idx - 1].focus();
                }
            });
            inp.addEventListener('paste', e => {
                const pasted = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
                if (!pasted) return;
                e.preventDefault();
                otpInputs.forEach((box, i) => { box.value = pasted[i] || ''; });
                const nextIdx = Math.min(pasted.length, otpInputs.length - 1);
                otpInputs[nextIdx].focus();
            });
        });

        // Login form submit
        if (formLogin) {
            formLogin.addEventListener('submit', async e => {
                e.preventDefault();
                const email = (document.getElementById('login-email')?.value || '').trim();
                const password = document.getElementById('login-password')?.value || '';
                const btn = document.getElementById('btn-login-submit');
                _showAuthFeedback('', null);
                _setAuthBtnBusy(btn, true, 'Signing in…');
                try {
                    const res = await API.login(email, password);
                    _completeAuthSession(res);
                } catch (err) {
                    if (err.data && err.data.requires_otp) {
                        _enterOtpStep(err.data.email || email, err.message, true);
                    } else {
                        _showAuthFeedback(err.message || 'Sign in failed', 'err');
                    }
                } finally {
                    _setAuthBtnBusy(btn, false, 'Sign In to Dashboard');
                }
            });
        }

        // Signup form submit
        if (formSignup) {
            formSignup.addEventListener('submit', async e => {
                e.preventDefault();
                const name = (document.getElementById('signup-name')?.value || '').trim();
                const email = (document.getElementById('signup-email')?.value || '').trim();
                const pw = document.getElementById('signup-password')?.value || '';
                const confirm = document.getElementById('signup-confirm')?.value || '';
                const btn = document.getElementById('btn-signup-submit');
                _showAuthFeedback('', null);

                if (name.length < 2) {
                    _showAuthFeedback('Please enter your full name.', 'err');
                    return;
                }
                if (pw.length < 6) {
                    _showAuthFeedback('Password must be at least 6 characters.', 'err');
                    return;
                }
                if (pw !== confirm) {
                    _showAuthFeedback('Passwords do not match.', 'err');
                    return;
                }

                _setAuthBtnBusy(btn, true, 'Sending OTP…');
                try {
                    const res = await API.signup(name, email, pw);
                    _enterOtpStep(res.email || email, res.message || 'Verification code sent to your email.', false);
                } catch (err) {
                    _showAuthFeedback(err.message || 'Could not create account', 'err');
                } finally {
                    _setAuthBtnBusy(btn, false, 'Create Account & Send OTP');
                }
            });
        }

        // OTP Verify submit
        if (formOtp) {
            formOtp.addEventListener('submit', async e => {
                e.preventDefault();
                const code = otpInputs.map(i => i.value.trim()).join('');
                const btn = document.getElementById('btn-otp-submit');
                if (code.length !== 6) {
                    _showAuthFeedback('Please enter all 6 digits of the verification code.', 'err');
                    return;
                }
                _setAuthBtnBusy(btn, true, 'Verifying…');
                try {
                    const res = await API.verifyOtp(_pendingOtpEmail, code);
                    _completeAuthSession(res);
                } catch (err) {
                    _showAuthFeedback(err.message || 'Invalid verification code', 'err');
                } finally {
                    _setAuthBtnBusy(btn, false, 'Verify Code & Launch Dashboard');
                }
            });
        }

        // Resend & Back OTP buttons
        const btnResend = document.getElementById('btn-otp-resend');
        if (btnResend) {
            btnResend.addEventListener('click', async () => {
                if (!_pendingOtpEmail) return;
                btnResend.disabled = true;
                try {
                    const res = await API.resendOtp(_pendingOtpEmail);
                    _showAuthFeedback(res.message || 'New code sent.', 'ok');
                    _startOtpResendCooldown(30);
                } catch (err) {
                    _showAuthFeedback(err.message || 'Failed to resend code', 'err');
                    btnResend.disabled = false;
                }
            });
        }
        const btnBack = document.getElementById('btn-otp-back');
        if (btnBack) {
            btnBack.addEventListener('click', () => _setAuthMode('login'));
        }

        if (btnLogout) {
            btnLogout.addEventListener('click', async () => {
                await API.logout();
                _exitToAuth('Signed out securely.');
            });
        }

        _initGoogleAuthButtons();
    }

    async function _checkAuthOnStartup() {
        try {
            const me = await API.getAuthMe();
            if (me && me.authenticated && me.user) {
                const existing = API.getSession() || {};
                if (existing.token) {
                    API.setSession({ ...existing, user: me.user, expires_at: me.expires_at });
                }
                _enterDashboard(me.user, me.expires_at);
                return;
            }
        } catch (_) {
            API.clearSession();
        }
        _showAuthScreen();
    }

    async function _initGoogleAuthButtons() {
        let cfg = null;
        try {
            cfg = await API.getAuthConfig();
        } catch (_) {
            return;
        }
        if (!cfg || !cfg.google_enabled || !cfg.google_client_id) return;

        let attempts = 0;
        const tryRender = () => {
            if (window.google && window.google.accounts && window.google.accounts.id) {
                window.google.accounts.id.initialize({
                    client_id: cfg.google_client_id,
                    callback: async resp => {
                        if (!resp || !resp.credential) return;
                        _showAuthFeedback('Verifying Google sign-in…', 'info');
                        try {
                            const sessionRes = await API.googleAuth(resp.credential);
                            _completeAuthSession(sessionRes);
                        } catch (err) {
                            _showAuthFeedback(err.message || 'Google Sign-In failed', 'err');
                        }
                    },
                });
                ['google-btn-login', 'google-btn-signup'].forEach(slotId => {
                    const el = document.getElementById(slotId);
                    if (el && !el.hasChildNodes()) {
                        window.google.accounts.id.renderButton(el, {
                            theme: 'filled_black',
                            size: 'large',
                            shape: 'rectangular',
                            text: 'continue_with',
                            width: 340,
                        });
                    }
                });
                return;
            }
            attempts += 1;
            if (attempts < 25) {
                setTimeout(tryRender, 250);
            } else {
                const note = document.getElementById('google-fallback-note');
                if (note) {
                    note.textContent = 'Google Sign-In unavailable offline — use verified email & password.';
                    note.classList.remove('hidden');
                }
            }
        };
        tryRender();
    }

    function _setAuthMode(mode) {
        const tabLogin = document.getElementById('tab-login');
        const tabSignup = document.getElementById('tab-signup');
        const tabsBar = document.getElementById('auth-tabs');
        const formLogin = document.getElementById('form-login');
        const formSignup = document.getElementById('form-signup');
        const formOtp = document.getElementById('form-otp');

        _showAuthFeedback('', null);
        if (formLogin) formLogin.classList.toggle('hidden', mode !== 'login');
        if (formSignup) formSignup.classList.toggle('hidden', mode !== 'signup');
        if (formOtp) formOtp.classList.toggle('hidden', mode !== 'otp');
        if (tabsBar) tabsBar.classList.toggle('hidden', mode === 'otp');

        if (tabLogin) tabLogin.classList.toggle('active', mode === 'login');
        if (tabSignup) tabSignup.classList.toggle('active', mode === 'signup');

        if (mode === 'login') {
            _setText('auth-heading', 'Welcome Back');
            _setText('auth-subheading', 'Sign in to access your rover telemetry & controls');
        } else if (mode === 'signup') {
            _setText('auth-heading', 'Create Operator Account');
            _setText('auth-subheading', 'Verify your email via OTP or continue with Google');
        } else {
            _setText('auth-heading', 'Verify Your Email');
            _setText('auth-subheading', 'Enter the 6-digit code sent to your inbox');
        }
    }

    function _enterOtpStep(email, msg, isInfo) {
        _pendingOtpEmail = email;
        _setText('otp-email-label', email);
        document.querySelectorAll('#otp-inputs-group .otp-digit').forEach(i => { i.value = ''; });
        _setAuthMode('otp');
        _showAuthFeedback(msg, isInfo ? 'info' : 'ok');
        _startOtpResendCooldown(30);
        const firstBox = document.querySelector('#otp-inputs-group .otp-digit');
        if (firstBox) setTimeout(() => firstBox.focus(), 60);
    }

    function _startOtpResendCooldown(seconds) {
        const btn = document.getElementById('btn-otp-resend');
        if (!btn) return;
        clearInterval(_otpResendCooldownTimer);
        let rem = seconds;
        btn.disabled = true;
        btn.textContent = `Resend (${rem}s)`;
        _otpResendCooldownTimer = setInterval(() => {
            rem -= 1;
            if (rem <= 0) {
                clearInterval(_otpResendCooldownTimer);
                btn.disabled = false;
                btn.textContent = 'Resend Code';
            } else {
                btn.textContent = `Resend (${rem}s)`;
            }
        }, 1000);
    }

    function _showAuthFeedback(msg, type) {
        const el = document.getElementById('auth-feedback');
        if (!el) return;
        if (!msg || !type) {
            el.textContent = '';
            el.className = 'auth-feedback hidden';
            return;
        }
        el.textContent = msg;
        el.className = `auth-feedback ${type}`;
    }

    function _setAuthBtnBusy(btn, busy, label) {
        if (!btn) return;
        btn.disabled = busy;
        const sp = btn.querySelector('span');
        if (sp) sp.textContent = label;
    }

    function _completeAuthSession(res) {
        if (res && res.token) {
            API.setSession(res);
        }
        _enterDashboard(res.user, res.expires_at);
    }

    function _enterDashboard(user, expiresAt) {
        _stopAuthSceneAnimation();
        const authEl = document.getElementById('auth-screen');
        const appEl = document.getElementById('app-shell');
        if (authEl) authEl.classList.add('hidden');
        if (appEl) appEl.classList.remove('hidden');

        if (user) {
            const name = user.name || user.email || 'Operator';
            _setText('nav-user-name', name);
            const av = document.getElementById('nav-user-avatar');
            if (av) {
                if (user.avatar_url) {
                    av.innerHTML = `<img src="${_esc(user.avatar_url)}" alt="">`;
                } else {
                    av.textContent = name.trim().charAt(0).toUpperCase() || 'U';
                }
            }
        }

        clearTimeout(_expiryTimer);
        if (expiresAt) {
            const msLeft = Math.max(0, expiresAt * 1000 - Date.now());
            // Schedule automatic logout when token expires (cap at 24d setTimeout limit)
            const delay = Math.min(msLeft, 2000000000);
            _expiryTimer = setTimeout(() => {
                API.clearSession();
                _exitToAuth('Session expired. Please sign in again.');
            }, delay);
        }

        if (!_dashboardStarted) {
            _dashboardStarted = true;
            _bootstrapBackend();
            _loadSessionHistory();
        } else {
            _bootstrapBackend();
            _loadSessionHistory();
        }
        Charts.refresh();
        _startDashSceneAnimation();
    }

    function _showAuthScreen(noticeMsg) {
        _stopDashSceneAnimation();
        const authEl = document.getElementById('auth-screen');
        const appEl = document.getElementById('app-shell');
        if (appEl) appEl.classList.add('hidden');
        if (authEl) authEl.classList.remove('hidden');
        _setAuthMode('login');
        if (noticeMsg) {
            _showAuthFeedback(noticeMsg, 'info');
        }
        _startAuthSceneAnimation();
    }

    /* ── 60fps Left-Side Login Rover Physics & Canvas Scene ──── */
    function _startAuthSceneAnimation() {
        if (_authAnimRaf !== null) return;
        const showcase = document.getElementById('auth-car-showcase');
        const canvas = document.getElementById('auth-scene-canvas');
        const camRig = document.getElementById('auth-cam-rig');
        const carMover = document.getElementById('auth-car-mover');
        if (!showcase || !canvas || !carMover) return;

        const ctx = canvas.getContext('2d');
        const steerFL = document.getElementById('auth-steer-fl');
        const steerFR = document.getElementById('auth-steer-fr');
        const turret = document.getElementById('auth-servo-turret');
        const turnL = document.getElementById('auth-turn-l');
        const turnR = document.getElementById('auth-turn-r');
        const arcL = document.getElementById('auth-arc-l');
        const arcR = document.getElementById('auth-arc-r');
        const thrL = document.getElementById('auth-thruster-l');
        const thrR = document.getElementById('auth-thruster-r');
        const beamL = document.getElementById('auth-beam-l');
        const beamR = document.getElementById('auth-beam-r');
        const w1 = document.getElementById('auth-wave-1');
        const w2 = document.getElementById('auth-wave-2');
        const w3 = document.getElementById('auth-wave-3');
        const treads = Array.from(document.querySelectorAll('.auth-wheel-tread'));
        const trails = Array.from(document.querySelectorAll('.auth-aero-trail'));

        const particles = Array.from({ length: 28 }, () => ({
            x: Math.random(),
            y: Math.random(),
            speed: 0.45 + Math.random() * 0.9,
            len: 10 + Math.random() * 22,
            color: Math.random() > 0.72 ? 'rgba(139, 92, 246, 0.75)' : 'rgba(0, 240, 255, 0.72)',
        }));

        const radarBlips = [
            { lane: -0.65, y: -0.2 },
            { lane: 0.65, y: 0.35 },
        ];
        const trailHistory = [];
        let roadScroll = 0;
        let treadOffset = 0;
        let lastTs = performance.now();
        let startTs = lastTs;
        let hudTick = 0;

        function resizeCanvas() {
            const rect = showcase.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.max(200, Math.round(rect.width));
            const h = Math.max(160, Math.round(rect.height));
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            return { w, h, dpr };
        }

        function frame(now) {
            const authScreen = document.getElementById('auth-screen');
            if (!authScreen || authScreen.classList.contains('hidden')) {
                _authAnimRaf = null;
                return;
            }

            const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
            lastTs = now;
            const t = (now - startTs) / 1000;

            const { w, h, dpr } = resizeCanvas();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            // Dynamic multi-harmonic driving path: rover weaves across lanes + surges forward!
            const phase = t * 1.15;
            const xAmp = Math.min(115, w * 0.25);
            const yAmp = Math.min(46, h * 0.14);
            const carX = Math.sin(phase) * xAmp + Math.sin(phase * 2.0) * (xAmp * 0.18);
            const carY = -Math.sin(phase * 2.0) * yAmp - Math.cos(phase) * 10;

            // True velocity derivatives for realistic steering angle & body tilt
            const vx = Math.cos(phase) * xAmp * 1.15 + Math.cos(phase * 2.0) * (xAmp * 0.18) * 2.3;
            const headingDeg = Math.max(-18, Math.min(18, vx * 0.11));
            const steerDeg = Math.max(-26, Math.min(26, vx * 0.17));
            const speedFactor = 1.0 + Math.max(0, -carY / Math.max(1, yAmp)) * 0.45;
            const speedPct = Math.round(68 + speedFactor * 18);

            // Scroll road & wheel treads continuously
            roadScroll = (roadScroll + dt * 240 * speedFactor) % 52;
            treadOffset = (treadOffset - dt * 110 * speedFactor) % 24;

            // Chase-camera parallax offset
            const camX = -carX * 0.18;
            const camY = -carY * 0.12;
            const camScale = 1.0 + (speedFactor - 1.0) * 0.04;
            if (camRig) {
                camRig.style.transform = `translate3d(${camX.toFixed(1)}px, ${camY.toFixed(1)}px, 0) scale(${camScale.toFixed(3)})`;
            }

            // 1. Draw moving perspective cyber grid + highway lanes on canvas
            const centerX = w * 0.5 + camX * 1.15;
            const roadHalfW = Math.min(160, w * 0.36);

            // Background cyber grid lines
            ctx.strokeStyle = 'rgba(0, 240, 255, 0.06)';
            ctx.lineWidth = 1;
            const gridSize = 38;
            const gxOff = (camX * 0.5) % gridSize;
            const gyOff = (roadScroll * 0.72) % gridSize;
            ctx.beginPath();
            for (let gx = gxOff; gx < w; gx += gridSize) {
                ctx.moveTo(gx, 0);
                ctx.lineTo(gx, h);
            }
            for (let gy = gyOff - gridSize; gy < h; gy += gridSize) {
                ctx.moveTo(0, gy);
                ctx.lineTo(w, gy);
            }
            ctx.stroke();

            // Glowing highway edges (slight perspective convergence)
            const topHalfW = roadHalfW * 0.78;
            const botHalfW = roadHalfW * 1.12;
            const drawEdge = (sign) => {
                const grad = ctx.createLinearGradient(0, 0, 0, h);
                grad.addColorStop(0, 'rgba(0, 240, 255, 0.05)');
                grad.addColorStop(0.5, 'rgba(0, 240, 255, 0.75)');
                grad.addColorStop(1, 'rgba(0, 240, 255, 0.15)');
                ctx.strokeStyle = grad;
                ctx.lineWidth = 2.2;
                ctx.beginPath();
                ctx.moveTo(centerX + sign * topHalfW, 0);
                ctx.lineTo(centerX + sign * botHalfW, h);
                ctx.stroke();
            };
            drawEdge(-1);
            drawEdge(1);

            // Moving dashed highway lane dividers
            [-0.48, 0, 0.48].forEach(laneFrac => {
                ctx.strokeStyle = laneFrac === 0 ? 'rgba(0, 240, 255, 0.58)' : 'rgba(56, 189, 248, 0.35)';
                ctx.lineWidth = laneFrac === 0 ? 2.4 : 1.6;
                ctx.setLineDash([22, 30]);
                ctx.lineDashOffset = -roadScroll * 1.4;
                ctx.beginPath();
                ctx.moveTo(centerX + laneFrac * topHalfW, 0);
                ctx.lineTo(centerX + laneFrac * botHalfW, h);
                ctx.stroke();
            });
            ctx.setLineDash([]);

            // 2. Dynamic sonar radar blips moving down road
            radarBlips.forEach(b => {
                b.y = (b.y + dt * 0.34 * speedFactor) % 1.25;
                const by = b.y * h - 20;
                const tY = Math.max(0, Math.min(1, by / h));
                const curHalfW = topHalfW + (botHalfW - topHalfW) * tY;
                const bx = centerX + b.lane * curHalfW;
                const pulse = 0.55 + 0.45 * Math.sin(t * 7 + b.lane * 4);
                ctx.beginPath();
                ctx.arc(bx, by, 4 + pulse * 4, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(245, 158, 11, ${(0.75 - pulse * 0.4).toFixed(2)})`;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
                ctx.fillStyle = '#f59e0b';
                ctx.fill();
            });

            // 3. Speed particles flying past
            particles.forEach(p => {
                p.y += dt * p.speed * speedFactor;
                if (p.y > 1.1) {
                    p.y = -0.1;
                    p.x = Math.random();
                }
                const px = p.x * w;
                const py = p.y * h;
                ctx.strokeStyle = p.color;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(px, py);
                ctx.lineTo(px, py + p.len);
                ctx.stroke();
            });

            // 4. Curved glowing tire motion trails behind the moving car
            const absCarX = w * 0.5 + camX + carX;
            const absCarY = h * 0.5 + camY + carY;
            const rad = (headingDeg * Math.PI) / 180;
            const rearOffset = 52;
            const trackHalf = 30;
            const rearCx = absCarX - Math.sin(rad) * rearOffset;
            const rearCy = absCarY + Math.cos(rad) * rearOffset;
            trailHistory.push({
                lx: rearCx - Math.cos(rad) * trackHalf,
                ly: rearCy - Math.sin(rad) * trackHalf,
                rx: rearCx + Math.cos(rad) * trackHalf,
                ry: rearCy + Math.sin(rad) * trackHalf,
            });
            if (trailHistory.length > 26) trailHistory.shift();
            // Shift previous trail points backward with road speed so trails stream behind the rover
            for (let i = 0; i < trailHistory.length - 1; i++) {
                trailHistory[i].ly += dt * 210 * speedFactor;
                trailHistory[i].ry += dt * 210 * speedFactor;
            }
            for (let i = 1; i < trailHistory.length; i++) {
                const alpha = (i / trailHistory.length) * 0.52;
                ctx.strokeStyle = `rgba(0, 240, 255, ${alpha.toFixed(2)})`;
                ctx.lineWidth = 3.2;
                ctx.beginPath();
                ctx.moveTo(trailHistory[i - 1].lx, trailHistory[i - 1].ly);
                ctx.lineTo(trailHistory[i].lx, trailHistory[i].ly);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(trailHistory[i - 1].rx, trailHistory[i - 1].ry);
                ctx.lineTo(trailHistory[i].rx, trailHistory[i].ry);
                ctx.stroke();
            }

            // 5. Expanding floor radar pulse ring centered under rover
            const ringProg = (t * 0.6) % 1;
            ctx.beginPath();
            ctx.arc(absCarX, absCarY - 26, 24 + ringProg * 115, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(0, 240, 255, ${(0.45 * (1 - ringProg)).toFixed(2)})`;
            ctx.lineWidth = 1.4;
            ctx.stroke();

            // 6. Apply real motion transform to the rover SVG + steering + wheels + servo + lights
            carMover.style.transform = `translate3d(${carX.toFixed(1)}px, ${carY.toFixed(1)}px, 0) rotate(${headingDeg.toFixed(2)}deg)`;
            if (steerFL) steerFL.style.transform = `rotate(${steerDeg.toFixed(1)}deg)`;
            if (steerFR) steerFR.style.transform = `rotate(${steerDeg.toFixed(1)}deg)`;

            const servoDeg = Math.sin(t * 2.1) * 42;
            if (turret) turret.style.transform = `rotate(${servoDeg.toFixed(1)}deg)`;

            treads.forEach(tr => { tr.style.strokeDashoffset = treadOffset.toFixed(1); });
            trails.forEach(tr => { tr.style.strokeDashoffset = (treadOffset * 1.8).toFixed(1); });

            // Turn signals + corner arcs illuminate smoothly when turning
            const leftOp = steerDeg < -5 ? Math.min(1, (-steerDeg - 5) / 10) : 0;
            const rightOp = steerDeg > 5 ? Math.min(1, (steerDeg - 5) / 10) : 0;
            const blink = Math.sin(t * 14) > 0 ? 1 : 0.25;
            if (turnL) turnL.setAttribute('opacity', (leftOp * blink).toFixed(2));
            if (arcL) arcL.setAttribute('opacity', leftOp.toFixed(2));
            if (turnR) turnR.setAttribute('opacity', (rightOp * blink).toFixed(2));
            if (arcR) arcR.setAttribute('opacity', rightOp.toFixed(2));

            // Headlight shimmer, thruster flicker, and cascading sonar waves
            const beamOp = 0.78 + 0.22 * Math.sin(t * 4.5);
            if (beamL) beamL.setAttribute('opacity', beamOp.toFixed(2));
            if (beamR) beamR.setAttribute('opacity', beamOp.toFixed(2));
            const thrLen = 320 + Math.sin(t * 28) * 14;
            if (thrL) thrL.setAttribute('y2', thrLen.toFixed(1));
            if (thrR) thrR.setAttribute('y2', (thrLen - Math.cos(t * 28) * 5).toFixed(1));

            [w1, w2, w3].forEach((wv, idx) => {
                if (!wv) return;
                const p = (t * 1.4 + idx * 0.33) % 1;
                wv.setAttribute('opacity', (Math.sin(p * Math.PI) * 0.9).toFixed(2));
                wv.setAttribute('transform', `translate(0, ${(-p * 10).toFixed(1)})`);
            });

            // Update floating HUD telemetry badges ~6 times/sec
            hudTick += dt;
            if (hudTick >= 0.16) {
                hudTick = 0;
                _setText('auth-hud-speed', `DRV ${speedPct}%`);
                _setText('auth-hud-sonar', `SONAR ${Math.round(90 + servoDeg)}°`);
                _setText('auth-hud-steer', `HDG ${headingDeg >= 0 ? '+' : ''}${Math.round(headingDeg)}°`);
            }

            _authAnimRaf = requestAnimationFrame(frame);
        }

        _authAnimRaf = requestAnimationFrame(frame);
    }

    function _stopAuthSceneAnimation() {
        if (_authAnimRaf !== null) {
            cancelAnimationFrame(_authAnimRaf);
            _authAnimRaf = null;
        }
    }

    /* ── 60fps Dashboard Rover Physics & Telemetry-Driven Scene ─ */
    function _startDashSceneAnimation() {
        if (_dashAnimRaf !== null) return;
        const stage = document.getElementById('vehicle-stage');
        const canvas = document.getElementById('dash-scene-canvas');
        const camRig = document.getElementById('dash-cam-rig');
        const carMover = document.getElementById('dash-car-mover');
        if (!stage || !canvas || !carMover) return;

        const ctx = canvas.getContext('2d');
        const steerFL = stage.querySelector('.wheel-steer-fl');
        const steerFR = stage.querySelector('.wheel-steer-fr');
        const wheelsLeft = [
            stage.querySelector('.wheel-fl'),
            stage.querySelector('.wheel-rl'),
        ].filter(Boolean);
        const wheelsRight = [
            stage.querySelector('.wheel-fr'),
            stage.querySelector('.wheel-rr'),
        ].filter(Boolean);
        const aeroStreaks = Array.from(stage.querySelectorAll('.aero-streak'));

        const particles = Array.from({ length: 24 }, () => ({
            x: Math.random(),
            y: Math.random(),
            speed: 0.45 + Math.random() * 0.85,
            len: 9 + Math.random() * 18,
            color: Math.random() > 0.7 ? 'rgba(139, 92, 246, 0.7)' : 'rgba(0, 240, 255, 0.7)',
        }));

        const trailHistory = [];
        let curX = 0;
        let curY = 0;
        let curHeading = 0;
        let curSteer = 0;
        let curRoadSpeed = 0;
        let roadScroll = 0;
        let treadL = 0;
        let treadR = 0;
        let aeroOff = 0;
        let lastTs = performance.now();
        let startTs = lastTs;

        function resizeCanvas() {
            const rect = stage.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.max(200, Math.round(rect.width));
            const h = Math.max(180, Math.round(rect.height));
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            return { w, h, dpr };
        }

        function frame(now) {
            const appEl = document.getElementById('app-shell');
            if (!appEl || appEl.classList.contains('hidden')) {
                _dashAnimRaf = null;
                return;
            }

            const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
            lastTs = now;
            const t = (now - startTs) / 1000;

            // Skip drawing while switching to a non-overview tab
            if (stage.offsetParent === null) {
                _dashAnimRaf = requestAnimationFrame(frame);
                return;
            }

            const { w, h, dpr } = resizeCanvas();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const st = _dashSceneState;
            const isForwardBlocked = st.motion === 'forward' && st.blocked;
            const effMotion = (st.estop || isForwardBlocked) ? 'stop' : (st.motion || 'stop');
            const speedNorm = Math.max(0.38, Math.min(1.35, (st.speedPct || 65) / 72));
            const maxX = Math.min(84, w * 0.2);
            const maxY = Math.min(48, h * 0.14);

            // Compute target rover pose & velocity based strictly on telemetry command
            let targetX = 0;
            let targetY = 0;
            let targetHeading = 0;
            let targetSteer = 0;
            let targetRoadSpeed = 0;
            let treadRateL = 0;
            let treadRateR = 0;

            if (effMotion === 'forward') {
                targetRoadSpeed = 240 * speedNorm;
                targetX = Math.sin(t * 2.1) * Math.min(26, maxX * 0.32);
                targetY = -maxY * 0.72 - Math.cos(t * 2.1) * 5;
                targetHeading = Math.cos(t * 2.1) * 4.2;
                targetSteer = targetHeading * 1.4;
                treadRateL = -125 * speedNorm;
                treadRateR = -125 * speedNorm;
            } else if (effMotion === 'backward') {
                targetRoadSpeed = -205 * speedNorm;
                targetX = Math.sin(t * 1.8) * Math.min(20, maxX * 0.25);
                targetY = maxY * 0.76 + Math.cos(t * 1.8) * 4;
                targetHeading = Math.cos(t * 1.8) * 3.5;
                targetSteer = -targetHeading * 1.4;
                treadRateL = 110 * speedNorm;
                treadRateR = 110 * speedNorm;
            } else if (effMotion === 'left') {
                targetRoadSpeed = 145 * speedNorm;
                targetX = -maxX * 0.74;
                targetY = -maxY * 0.28;
                targetHeading = -18;
                targetSteer = -26;
                treadRateL = 68 * speedNorm;
                treadRateR = -125 * speedNorm;
            } else if (effMotion === 'right') {
                targetRoadSpeed = 145 * speedNorm;
                targetX = maxX * 0.74;
                targetY = -maxY * 0.28;
                targetHeading = 18;
                targetSteer = 26;
                treadRateL = -125 * speedNorm;
                treadRateR = 68 * speedNorm;
            }

            // Smooth spring/exponential interpolation (snaps cleanly to 0 when stopped)
            const lerp = 1 - Math.exp(-dt * 8.5);
            const speedLerp = 1 - Math.exp(-dt * 7.0);
            curX += (targetX - curX) * lerp;
            curY += (targetY - curY) * lerp;
            curHeading += (targetHeading - curHeading) * lerp;
            curSteer += (targetSteer - curSteer) * (1 - Math.exp(-dt * 12));
            curRoadSpeed += (targetRoadSpeed - curRoadSpeed) * speedLerp;

            if (effMotion === 'stop') {
                if (Math.abs(curX) < 0.08) curX = 0;
                if (Math.abs(curY) < 0.08) curY = 0;
                if (Math.abs(curHeading) < 0.08) curHeading = 0;
                if (Math.abs(curSteer) < 0.08) curSteer = 0;
                if (Math.abs(curRoadSpeed) < 0.6) curRoadSpeed = 0;
            }

            roadScroll = ((roadScroll + dt * curRoadSpeed) % 52 + 52) % 52;
            treadL = ((treadL + dt * treadRateL) % 24 + 24) % 24;
            treadR = ((treadR + dt * treadRateR) % 24 + 24) % 24;
            aeroOff = ((aeroOff - dt * curRoadSpeed * 0.55) % 40 + 40) % 40;

            const isMovingNow = Math.abs(curRoadSpeed) > 4;
            const speedFactor = curRoadSpeed / 240;

            // Chase-camera parallax (follows car smoothly when driving, parked at center when stopped)
            const camX = -curX * 0.16;
            const camY = -curY * 0.12;
            const camScale = 1 + Math.min(0.035, Math.abs(speedFactor) * 0.025);
            if (camRig) {
                camRig.style.transform = `translate3d(${camX.toFixed(1)}px, ${camY.toFixed(1)}px, 0) scale(${camScale.toFixed(3)})`;
            }

            // 1. Cyber grid & highway lanes (still when stopped, flows forward/backward with motion)
            const centerX = w * 0.5 + camX * 1.1;
            const roadHalfW = Math.min(148, w * 0.34);
            const gridSize = 36;
            const gxOff = ((camX * 0.5) % gridSize + gridSize) % gridSize;
            const gyOff = (roadScroll * 0.7) % gridSize;

            ctx.strokeStyle = (st.blocked || st.estop) ? 'rgba(239, 68, 68, 0.08)' : 'rgba(0, 240, 255, 0.06)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let gx = gxOff; gx < w; gx += gridSize) {
                ctx.moveTo(gx, 0);
                ctx.lineTo(gx, h);
            }
            for (let gy = gyOff - gridSize; gy < h; gy += gridSize) {
                ctx.moveTo(0, gy);
                ctx.lineTo(w, gy);
            }
            ctx.stroke();

            const topHalfW = roadHalfW * 0.8;
            const botHalfW = roadHalfW * 1.1;
            const edgeRgb = effMotion === 'backward' || st.blocked || st.estop ? '239, 68, 68' : '0, 240, 255';
            [-1, 1].forEach(sign => {
                const grad = ctx.createLinearGradient(0, 0, 0, h);
                grad.addColorStop(0, `rgba(${edgeRgb}, 0.05)`);
                grad.addColorStop(0.5, `rgba(${edgeRgb}, ${isMovingNow ? 0.72 : 0.32})`);
                grad.addColorStop(1, `rgba(${edgeRgb}, 0.12)`);
                ctx.strokeStyle = grad;
                ctx.lineWidth = isMovingNow ? 2.2 : 1.5;
                ctx.beginPath();
                ctx.moveTo(centerX + sign * topHalfW, 0);
                ctx.lineTo(centerX + sign * botHalfW, h);
                ctx.stroke();
            });

            [-0.48, 0, 0.48].forEach(laneFrac => {
                ctx.strokeStyle = laneFrac === 0
                    ? `rgba(${edgeRgb}, ${isMovingNow ? 0.56 : 0.24})`
                    : `rgba(56, 189, 248, ${isMovingNow ? 0.34 : 0.16})`;
                ctx.lineWidth = laneFrac === 0 ? 2.2 : 1.5;
                ctx.setLineDash([20, 28]);
                ctx.lineDashOffset = -roadScroll * 1.35;
                ctx.beginPath();
                ctx.moveTo(centerX + laneFrac * topHalfW, 0);
                ctx.lineTo(centerX + laneFrac * botHalfW, h);
                ctx.stroke();
            });
            ctx.setLineDash([]);

            // 2. Speed particles (only drift when vehicle is moving; reverse flows upward!)
            if (isMovingNow) {
                particles.forEach(p => {
                    p.y += dt * p.speed * speedFactor * 1.25;
                    if (p.y > 1.1) {
                        p.y = -0.1;
                        p.x = Math.random();
                    } else if (p.y < -0.1) {
                        p.y = 1.1;
                        p.x = Math.random();
                    }
                    const px = p.x * w;
                    const py = p.y * h;
                    const streakLen = p.len * Math.min(1.2, Math.abs(speedFactor) + 0.2);
                    ctx.strokeStyle = effMotion === 'backward' ? 'rgba(239, 68, 68, 0.58)' : p.color;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(px, py);
                    ctx.lineTo(px, py + (speedFactor >= 0 ? streakLen : -streakLen));
                    ctx.stroke();
                });
            }

            // 3. Curved tire motion trails (forward: cyan behind rear wheels; backward: red ahead; stopped: fade out cleanly)
            const absCarX = w * 0.5 + camX + curX;
            const absCarY = h * 0.5 + camY + curY;
            const rad = (curHeading * Math.PI) / 180;
            const trackHalf = 50;
            const anchorY = effMotion === 'backward' ? -56 : 58;
            const anchorCx = absCarX - Math.sin(rad) * anchorY;
            const anchorCy = absCarY + Math.cos(rad) * anchorY;

            if (isMovingNow) {
                trailHistory.push({
                    lx: anchorCx - Math.cos(rad) * trackHalf,
                    ly: anchorCy - Math.sin(rad) * trackHalf,
                    rx: anchorCx + Math.cos(rad) * trackHalf,
                    ry: anchorCy + Math.sin(rad) * trackHalf,
                    rev: curRoadSpeed < 0,
                });
                if (trailHistory.length > 22) trailHistory.shift();
                for (let i = 0; i < trailHistory.length - 1; i++) {
                    trailHistory[i].ly += dt * curRoadSpeed * 0.9;
                    trailHistory[i].ry += dt * curRoadSpeed * 0.9;
                }
            } else if (trailHistory.length > 0) {
                trailHistory.shift();
            }

            for (let i = 1; i < trailHistory.length; i++) {
                const pt = trailHistory[i];
                const prev = trailHistory[i - 1];
                const alpha = (i / trailHistory.length) * 0.5;
                ctx.strokeStyle = pt.rev ? `rgba(239, 68, 68, ${alpha.toFixed(2)})` : `rgba(0, 240, 255, ${alpha.toFixed(2)})`;
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(prev.lx, prev.ly);
                ctx.lineTo(pt.lx, pt.ly);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(prev.rx, prev.ry);
                ctx.lineTo(pt.rx, pt.ry);
                ctx.stroke();
            }

            // 4. Obstacle warning barrier arc ahead if blocked or estop, else gentle sonar floor ring while active
            if (st.blocked || st.estop) {
                const warnPulse = 0.55 + 0.45 * Math.sin(t * 9);
                ctx.strokeStyle = `rgba(239, 68, 68, ${(0.35 + warnPulse * 0.55).toFixed(2)})`;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(absCarX, absCarY - 34, 62 + warnPulse * 8, Math.PI * 1.18, Math.PI * 1.82);
                ctx.stroke();
            } else if (isMovingNow) {
                const ringProg = (t * 0.75) % 1;
                ctx.beginPath();
                ctx.arc(absCarX, absCarY - 26, 22 + ringProg * 95, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${edgeRgb}, ${(0.4 * (1 - ringProg)).toFixed(2)})`;
                ctx.lineWidth = 1.3;
                ctx.stroke();
            }

            // 5. Apply smooth physics transform to car mover & steering/wheels
            carMover.style.transform = `translate3d(${curX.toFixed(1)}px, ${curY.toFixed(1)}px, 0) rotate(${curHeading.toFixed(2)}deg)`;
            if (steerFL) steerFL.style.transform = `rotate(${curSteer.toFixed(1)}deg)`;
            if (steerFR) steerFR.style.transform = `rotate(${curSteer.toFixed(1)}deg)`;

            wheelsLeft.forEach(el => { el.style.strokeDashoffset = treadL.toFixed(1); });
            wheelsRight.forEach(el => { el.style.strokeDashoffset = treadR.toFixed(1); });
            aeroStreaks.forEach(el => { el.style.strokeDashoffset = aeroOff.toFixed(1); });

            _dashAnimRaf = requestAnimationFrame(frame);
        }

        _dashAnimRaf = requestAnimationFrame(frame);
    }

    function _stopDashSceneAnimation() {
        if (_dashAnimRaf !== null) {
            cancelAnimationFrame(_dashAnimRaf);
            _dashAnimRaf = null;
        }
    }

    function _exitToAuth(noticeMsg) {
        clearTimeout(_expiryTimer);
        API.disconnect();
        Camera.setOffline('STREAM UNAVAILABLE', 'Authentication required');
        _setDisconnectedState();
        _showAuthScreen(noticeMsg);
    }

    /* ── Helpers ─────────────────────────────────────────────── */
    function _clampPct(v) {
        if (v == null || Number.isNaN(Number(v))) return null;
        return Math.min(100, Math.max(0, Math.round(Number(v))));
    }

    function _setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function _setClass(id, cls) {
        const el = document.getElementById(id);
        if (el) el.className = cls;
    }

    function _setWidth(id, pct) {
        const el = document.getElementById(id);
        if (el) el.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }

    function _setBadge(id, cls, text) {
        const el = document.getElementById(id);
        if (el) {
            el.className = `status-badge ${cls}`;
            el.textContent = text;
        }
    }

    function _setBanner(id, cls, text) {
        const el = document.getElementById(id);
        if (el) {
            el.className = `status-banner ${cls}`;
            el.textContent = text;
        }
    }

    function _esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
})();
