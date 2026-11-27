/**
 * charts.js — Chart.js 4 initialization, historical loading, and live updates.
 *
 * Canvas IDs (matching index.html):
 *   - chart-temperature
 *   - chart-humidity
 *   - chart-gas
 *   - chart-distance
 *
 * Uses only real telemetry from GET /api/history and live WebSocket updates.
 */

const Charts = (() => {
    const MAX_POINTS = 120;
    const _instances = {};

    function _baseOptions(unit, minY = 0, maxY = 2000) {
        const opts = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 180, easing: 'easeOutQuart' },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 15, 29, 0.95)',
                    borderColor: 'rgba(0, 240, 255, 0.3)',
                    borderWidth: 1,
                    titleColor: '#94a3b8',
                    bodyColor: '#f8fafc',
                    padding: 10,
                    titleFont: { family: 'JetBrains Mono, monospace', size: 11 },
                    bodyFont: { family: 'JetBrains Mono, monospace', size: 12 },
                    callbacks: {
                        label: ctx => {
                            const val = ctx.parsed.y;
                            return val == null ? '--' : `${val.toFixed(1)} ${unit}`.trim();
                        },
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.04)' },
                    ticks: {
                        color: '#64748b',
                        font: { family: 'JetBrains Mono, monospace', size: 10 },
                        maxTicksLimit: 6,
                    },
                },
                y: {
                    min: minY,
                    max: maxY,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#64748b',
                        font: { family: 'JetBrains Mono, monospace', size: 10 },
                        stepSize: 500,
                        callback: v => `${v}${unit ? ' ' + unit : ''}`,
                    },
                },
            },
        };
        return opts;
    }

    function _createChart(canvasId, label, rgbColor, unit, minY, maxY) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || typeof Chart === 'undefined') return null;

        if (_instances[canvasId]) {
            _instances[canvasId].destroy();
        }

        const chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label,
                    data: [],
                    borderColor: `rgb(${rgbColor})`,
                    backgroundColor: `rgba(${rgbColor}, 0.1)`,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    fill: true,
                    tension: 0.35,
                    spanGaps: true,
                }],
            },
            options: _baseOptions(unit, minY, maxY),
        });

        _instances[canvasId] = chart;
        return chart;
    }

    function init() {
        _createChart('chart-temperature', 'Temperature', '0, 240, 255', '°C', 0, 2000);
        _createChart('chart-humidity', 'Humidity', '16, 185, 129', '%', 0, 2000);
        _createChart('chart-gas', 'Gas ADC', '245, 158, 11', 'ADC', 0, 2000);
        _createChart('chart-distance', 'Distance', '139, 92, 246', 'cm', 0, 2000);
    }

    function _push(canvasId, label, value) {
        const chart = _instances[canvasId];
        if (!chart) return;
        chart.data.labels.push(label);
        chart.data.datasets[0].data.push(
            value !== null && value !== undefined && Number.isFinite(Number(value))
                ? Number(value)
                : null
        );
        if (chart.data.labels.length > MAX_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }
    }

    function clear() {
        Object.values(_instances).forEach(chart => {
            if (!chart) return;
            chart.data.labels = [];
            chart.data.datasets[0].data = [];
            chart.update('none');
        });
    }

    async function loadHistory() {
        let history;
        try {
            history = await API.getHistory();
        } catch (err) {
            console.warn('[Charts] Failed to load history:', err.message);
            return;
        }
        if (!Array.isArray(history)) return;

        clear();
        const slice = history.slice(-MAX_POINTS);
        slice.forEach(pt => {
            const label = pt.t ? new Date(pt.t * 1000).toLocaleTimeString() : '';
            const dist = pt.dist != null && pt.dist < 400 ? pt.dist : null;
            _push('chart-temperature', label, pt.temp);
            _push('chart-humidity', label, pt.hum);
            _push('chart-gas', label, pt.gas);
            _push('chart-distance', label, dist);
        });

        Object.values(_instances).forEach(c => c && c.update('none'));
    }

    function appendLiveTick(tel, mainData) {
        if (!tel) return;
        const label = new Date().toLocaleTimeString();
        const dhtOk = mainData && mainData.dht_ok !== false;
        const temp = dhtOk && tel.temp_c > 0 ? tel.temp_c : null;
        const hum = dhtOk && tel.humidity_pct > 0 ? tel.humidity_pct : null;
        const gas = tel.gas_raw >= 0 ? tel.gas_raw : null;
        const dist = tel.front_dist_cm != null && tel.front_dist_cm < 400 ? tel.front_dist_cm : null;

        _push('chart-temperature', label, temp);
        _push('chart-humidity', label, hum);
        _push('chart-gas', label, gas);
        _push('chart-distance', label, dist);

        const analyticsView = document.getElementById('view-analytics');
        if (analyticsView && !analyticsView.classList.contains('hidden')) {
            Object.values(_instances).forEach(c => c && c.update('none'));
        }
    }

    function refresh() {
        Object.values(_instances).forEach(c => {
            if (c) {
                c.resize();
                c.update('none');
            }
        });
    }

    return { init, loadHistory, appendLiveTick, refresh, clear };
})();
