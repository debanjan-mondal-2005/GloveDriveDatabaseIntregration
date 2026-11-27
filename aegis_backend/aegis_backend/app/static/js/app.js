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
    const _ctrlDragging = { speedA: false, speedB: false, servo: false, stopCm: false };

    document.addEventListener('DOMContentLoaded', () => {
        _initNavigation();
        _initMobileSidebar();
        _initEStop();
        _initControls();
        _initSessionHistory();
        _initInteractiveEffects();

        Charts.init();
        Camera.init();

        // Render initial offline state (including 3 red node dots)
        _setDisconnectedState();

        // Wire API listeners and connect immediately to real backend
        API.on('wsOpen', _onWsOpen);
        API.on('wsClose', _onWsClose);
        API.on('snapshot', _onSnapshot);
        API.on('error', err => {
            console.warn('[Dashboard]', err.message);
            _showControlFeedback(err.message, false);
        });

        _bootstrapBackend();
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
        _loadSessionHistory();
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
            const resp = await fetch(url);
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
