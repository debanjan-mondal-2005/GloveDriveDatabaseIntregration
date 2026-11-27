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

    document.addEventListener('DOMContentLoaded', () => {
        _initNavigation();
        _initMobileSidebar();
        _initUrlConfig();
        _initEStop();

        Charts.init();
        Camera.init();

        // Render initial offline state (including 3 red node dots)
        _setDisconnectedState();

        // Wire API listeners and connect immediately to real backend
        API.on('wsOpen', _onWsOpen);
        API.on('wsClose', _onWsClose);
        API.on('snapshot', _onSnapshot);
        API.on('error', err => console.warn('[Dashboard]', err.message));

        _bootstrapBackend();
    });

    async function _bootstrapBackend() {
        _updateEndpointLabels();
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
        const wrapper = document.getElementById('vehicle-svg-wrapper');
        if (wrapper) {
            wrapper.setAttribute('data-motion', motion || 'stop');
            wrapper.classList.toggle('vehicle-blocked', blocked || estop);
        }

        // Rotate nose ultrasonic servo beam using real ESP32 servo angle (0..180, 90=center)
        const servoBeam = document.getElementById('nose-servo-beam');
        if (servoBeam && mainData.servo != null && !Number.isNaN(Number(mainData.servo))) {
            const deg = Math.max(-90, Math.min(90, Number(mainData.servo) - 90));
            servoBeam.style.transform = `rotate(${deg}deg)`;
            servoBeam.style.opacity = '0.75';
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

        // Differential Motor Gauges
        const speedAPct = _clampPct(mainData.speedA);
        const speedBPct = _clampPct(mainData.speedB);
        const isMoving = motion && motion !== 'stop' && !(motion === 'forward' && blocked) && !estop;
        const pwmA = speedAPct !== null ? (isMoving ? Math.round((speedAPct / 100) * 255) : 0) : null;
        const pwmB = speedBPct !== null ? (isMoving ? Math.round((speedBPct / 100) * 255) : 0) : null;

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
        _updateDirectionHUD(null, 'NO SIGNAL');
        const wrapper = document.getElementById('vehicle-svg-wrapper');
        if (wrapper) {
            wrapper.setAttribute('data-motion', 'stop');
            wrapper.classList.toggle('vehicle-blocked', estop);
        }
        const servoBeam = document.getElementById('nose-servo-beam');
        if (servoBeam) {
            servoBeam.style.transform = 'rotate(0deg)';
            servoBeam.style.opacity = '0.2';
        }
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

    /* ── E-Stop & Backend URL Config ─────────────────────────── */
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

    function _initUrlConfig() {
        const input = document.getElementById('input-backend-url');
        const saveBtn = document.getElementById('btn-save-backend-url');
        _updateEndpointLabels();

        if (saveBtn && input) {
            saveBtn.addEventListener('click', () => {
                const raw = input.value.trim();
                if (!raw) return;
                try {
                    API.disconnect();
                    API.setBaseUrl(raw);
                    _updateEndpointLabels();
                    _historyLoaded = false;
                    Charts.clear();
                    _setDisconnectedState();
                    _setText('connection-status-text', 'Reconnecting...');
                    _bootstrapBackend();
                } catch (err) {
                    alert(err.message);
                }
            });
        }
    }

    function _updateEndpointLabels() {
        const url = API.getBaseUrl();
        const input = document.getElementById('input-backend-url');
        if (input) input.value = url;
        _setText('info-gateway-url', url);
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
