/**
 * MAK Trading Bot - Frontend JavaScript
 */

// Global state
let botState = {
    enabled: true,
    network: 'testnet',
    connected: false
};

// ============================================================================
// Utility Functions
// ============================================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toastId = 'toast-' + Date.now();

    const bgClass = {
        'success': 'bg-success',
        'error': 'bg-danger',
        'warning': 'bg-warning',
        'info': 'bg-info'
    }[type] || 'bg-info';

    const iconClass = {
        'success': 'bi-check-circle',
        'error': 'bi-x-circle',
        'warning': 'bi-exclamation-triangle',
        'info': 'bi-info-circle'
    }[type] || 'bi-info-circle';

    const html = `
        <div id="${toastId}" class="toast" role="alert">
            <div class="toast-header bg-dark text-light">
                <i class="bi ${iconClass} me-2 ${type === 'error' ? 'text-danger' : ''}"></i>
                <strong class="me-auto">${type.charAt(0).toUpperCase() + type.slice(1)}</strong>
                <small class="text-muted">just now</small>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast"></button>
            </div>
            <div class="toast-body">
                ${message}
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    const toastEl = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastEl, { autohide: true, delay: 5000 });
    toast.show();

    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}

function formatCurrency(value, decimals = 2) {
    if (value === null || value === undefined) return '$--.--';
    const num = parseFloat(value);
    const prefix = num >= 0 ? '' : '-';
    return prefix + '$' + Math.abs(num).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function formatPercent(value) {
    if (value === null || value === undefined) return '--.--';
    const num = parseFloat(value);
    const prefix = num >= 0 ? '+' : '';
    return prefix + num.toFixed(2) + '%';
}

function formatPrice(value) {
    if (!value) return '$--.--';
    const num = parseFloat(value);
    if (num >= 1000) return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (num >= 1) return '$' + num.toFixed(2);
    return '$' + num.toFixed(4);
}

function formatDate(dateStr) {
    if (!dateStr) return '--';
    const date = new Date(dateStr);
    return date.toLocaleString();
}

async function apiCall(endpoint, method = 'GET', data = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (data) options.body = JSON.stringify(data);

    try {
        const response = await fetch('/api' + endpoint, options);
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        showToast('API request failed: ' + error.message, 'error');
        throw error;
    }
}

// ============================================================================
// Dashboard Functions
// ============================================================================

async function initDashboard() {
    // First fetch settings to get network and bot status
    await fetchBotStatus();
    await refreshDashboard();
    setupDashboardEvents();
}

async function fetchBotStatus() {
    try {
        const settings = await apiCall('/settings');

        // Update network badge
        const networkBadge = document.getElementById('network-badge');
        if (networkBadge) {
            if (settings.use_testnet === 'false') {
                networkBadge.className = 'status-badge status-badge-primary';
                networkBadge.innerHTML = '<i class="bi bi-hdd-network me-1"></i>MAINNET';
            } else {
                networkBadge.className = 'status-badge status-badge-testnet';
                networkBadge.innerHTML = '<i class="bi bi-hdd-network me-1"></i>TESTNET';
            }
        }

        // Update bot status button
        const botToggle = document.getElementById('bot-toggle');
        if (botToggle) {
            const isEnabled = settings.bot_enabled === 'true';
            updateBotToggleButton(isEnabled);
        }
    } catch (error) {
        console.error('Failed to fetch bot status:', error);
    }
}

async function refreshDashboard() {
    try {
        // Fetch account info
        const accountData = await apiCall('/account');
        if (!accountData.error) {
            updateAccountCards(accountData);
            updatePositionsTable(accountData.positions || []);
        }

        // Fetch daily stats
        const statsData = await apiCall('/stats/daily');
        if (!statsData.error) {
            updateDailyStats(statsData);
        }

        // Fetch market prices
        const pricesData = await apiCall('/prices');
        if (!pricesData.error) {
            updatePrices(pricesData);
        }

        // Fetch recent activity
        const activityData = await apiCall('/activity?limit=10');
        if (!activityData.error) {
            updateActivityList(activityData.logs || []);
        }

        // Update connection status
        updateConnectionStatus(true);

    } catch (error) {
        updateConnectionStatus(false);
    }
}

function updateAccountCards(data) {
    document.getElementById('account-value').textContent = formatCurrency(data.account_value);
    document.getElementById('open-positions').textContent = (data.positions || []).length;

    // Update network badge
    const networkBadge = document.getElementById('network-badge');
    if (data.network === 'mainnet') {
        networkBadge.className = 'badge bg-danger';
        networkBadge.innerHTML = '<i class="bi bi-hdd-network me-1"></i>MAINNET';
    } else {
        networkBadge.className = 'badge bg-warning text-dark';
        networkBadge.innerHTML = '<i class="bi bi-hdd-network me-1"></i>TESTNET';
    }
}

function updateDailyStats(data) {
    const dailyPnl = document.getElementById('daily-pnl');
    const pnlIcon = document.getElementById('pnl-icon');
    const pnlIconContainer = document.getElementById('pnl-icon-container');

    dailyPnl.textContent = formatCurrency(data.total_pnl);
    if (data.total_pnl >= 0) {
        dailyPnl.className = 'mb-0 text-success';
        pnlIcon.className = 'bi bi-graph-up text-success fs-4';
        pnlIconContainer.className = 'bg-success bg-opacity-25 p-3 rounded';
    } else {
        dailyPnl.className = 'mb-0 text-danger';
        pnlIcon.className = 'bi bi-graph-down text-danger fs-4';
        pnlIconContainer.className = 'bg-danger bg-opacity-25 p-3 rounded';
    }

    document.getElementById('trades-today').textContent = data.total_trades || 0;

    // Update risk status bars
    updateRiskBars(data);
}

function updateRiskBars(data) {
    // These would need actual limits from settings
    const dailyLossLimit = 500;
    const positionLimit = 5;
    const dailyTradesLimit = 20;

    const dailyLoss = Math.abs(data.total_pnl < 0 ? data.total_pnl : 0);
    const dailyLossPct = (dailyLoss / dailyLossLimit) * 100;
    document.getElementById('daily-loss-status').textContent = formatCurrency(dailyLoss) + ' / ' + formatCurrency(dailyLossLimit);
    document.getElementById('daily-loss-bar').style.width = Math.min(dailyLossPct, 100) + '%';
    document.getElementById('daily-loss-bar').className = 'progress-bar ' + (dailyLossPct > 80 ? 'bg-danger' : 'bg-success');

    const openPositions = data.open_trades || 0;
    const positionPct = (openPositions / positionLimit) * 100;
    document.getElementById('position-limit-status').textContent = openPositions + ' / ' + positionLimit;
    document.getElementById('position-limit-bar').style.width = Math.min(positionPct, 100) + '%';

    const dailyTradesPct = (data.total_trades / dailyTradesLimit) * 100;
    document.getElementById('daily-trades-status').textContent = data.total_trades + ' / ' + dailyTradesLimit;
    document.getElementById('daily-trades-bar').style.width = Math.min(dailyTradesPct, 100) + '%';
}

function updatePositionsTable(positions) {
    const tbody = document.getElementById('positions-table');

    if (!positions || positions.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="text-center text-muted py-4">
                    <i class="bi bi-inbox fs-3 d-block mb-2"></i>
                    No open positions
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = positions.map(pos => {
        const pnlClass = pos.unrealized_pnl >= 0 ? 'text-success' : 'text-danger';
        const sideClass = pos.side === 'long' ? 'badge-long' : 'badge-short';

        return `
            <tr>
                <td><strong>${pos.coin}</strong></td>
                <td><span class="badge ${sideClass}">${pos.side.toUpperCase()}</span></td>
                <td>${Math.abs(pos.size).toFixed(4)}</td>
                <td>${formatPrice(pos.entry_price)}</td>
                <td>${formatPrice(pos.mark_price)}</td>
                <td>${pos.liquidation_price ? formatPrice(pos.liquidation_price) : '--'}</td>
                <td class="${pnlClass}">${formatCurrency(pos.unrealized_pnl)}</td>
                <td>${pos.leverage}x</td>
                <td>
                    <button class="btn btn-outline-danger btn-sm" onclick="closePosition('${pos.coin}')">
                        <i class="bi bi-x-circle"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function updatePrices(prices) {
    for (const [coin, price] of Object.entries(prices)) {
        const el = document.getElementById('price-' + coin);
        if (el) el.textContent = formatPrice(price);
    }
}

function updateActivityList(logs) {
    const container = document.getElementById('activity-list');

    if (!logs || logs.length === 0) {
        container.innerHTML = `
            <div class="text-center text-muted py-4">
                <i class="bi bi-inbox fs-3 d-block mb-2"></i>
                No recent activity
            </div>
        `;
        return;
    }

    container.innerHTML = logs.map(log => {
        const iconClass = {
            'trade': 'trade',
            'risk': 'warning',
            'error': 'error',
            'system': 'trade'
        }[log.category] || 'trade';

        const icon = {
            'trade': 'bi-arrow-left-right',
            'risk': 'bi-shield-exclamation',
            'error': 'bi-x-circle',
            'system': 'bi-gear'
        }[log.category] || 'bi-info-circle';

        return `
            <div class="activity-item">
                <div class="activity-icon ${iconClass}">
                    <i class="bi ${icon}"></i>
                </div>
                <div class="activity-content">
                    <div>${log.message}</div>
                    <div class="activity-time">${formatDate(log.timestamp)}</div>
                </div>
            </div>
        `;
    }).join('');
}

function updateConnectionStatus(connected) {
    const badge = document.getElementById('connection-status');
    if (connected) {
        badge.className = 'status-badge status-badge-primary';
        badge.innerHTML = '<i class="bi bi-wifi me-1"></i>Connected';
    } else {
        badge.className = 'status-badge status-badge-disconnected';
        badge.innerHTML = '<i class="bi bi-wifi-off me-1"></i>Disconnected';
    }
}

function setupDashboardEvents() {
    // Leverage slider
    const leverageRange = document.getElementById('trade-leverage-range');
    const leverageDisplay = document.getElementById('leverage-display');
    if (leverageRange) {
        leverageRange.addEventListener('input', function() {
            leverageDisplay.textContent = this.value + 'x';
        });
    }

    // Buy button
    const buyBtn = document.getElementById('buy-btn');
    if (buyBtn) {
        buyBtn.addEventListener('click', () => executeTrade('buy'));
    }

    // Sell button
    const sellBtn = document.getElementById('sell-btn');
    if (sellBtn) {
        sellBtn.addEventListener('click', () => executeTrade('sell'));
    }

    // Bot toggle
    const botToggle = document.getElementById('bot-toggle');
    if (botToggle) {
        botToggle.addEventListener('click', toggleBot);
    }

    // Close all button
    const closeAllBtn = document.getElementById('close-all-btn');
    if (closeAllBtn) {
        closeAllBtn.addEventListener('click', closeAllPositions);
    }
}

async function executeTrade(action) {
    const coin = document.getElementById('trade-coin').value;
    const collateral = parseFloat(document.getElementById('trade-collateral').value);
    const leverage = parseInt(document.getElementById('trade-leverage-range').value);
    const stopLoss = parseFloat(document.getElementById('trade-sl').value) || null;
    const takeProfit = parseFloat(document.getElementById('trade-tp').value) || null;

    if (!coin || !collateral || !leverage) {
        showToast('Please fill in all required fields', 'warning');
        return;
    }

    try {
        const result = await apiCall('/trade', 'POST', {
            coin,
            action,
            leverage,
            collateral_usd: collateral,
            stop_loss_pct: stopLoss,
            take_profit_pct: takeProfit
        });

        if (result.success) {
            showToast(`${action.toUpperCase()} order executed for ${coin}`, 'success');
            refreshDashboard();
        } else {
            showToast('Trade failed: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Trade execution failed', 'error');
    }
}

async function closePosition(coin) {
    document.getElementById('close-position-coin').textContent = coin;
    const modal = new bootstrap.Modal(document.getElementById('closePositionModal'));
    modal.show();

    document.getElementById('confirm-close-btn').onclick = async () => {
        try {
            const result = await apiCall('/close', 'POST', { coin });
            if (result.success) {
                showToast(`Position closed for ${coin}`, 'success');
                modal.hide();
                refreshDashboard();
            } else {
                showToast('Failed to close position: ' + result.error, 'error');
            }
        } catch (error) {
            showToast('Failed to close position', 'error');
        }
    };
}

async function closeAllPositions() {
    if (!confirm('Are you sure you want to close ALL open positions?')) return;

    try {
        const result = await apiCall('/close-all', 'POST');
        if (result.success) {
            showToast('All positions closed', 'success');
            refreshDashboard();
        } else {
            showToast('Failed to close positions: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Failed to close positions', 'error');
    }
}

async function toggleBot() {
    const btn = document.getElementById('bot-toggle');
    const isEnabled = !btn.classList.contains('status-badge-paused');

    try {
        const result = await apiCall('/bot/toggle', 'POST', { enabled: !isEnabled });
        if (result.success) {
            updateBotToggleButton(result.enabled);
            showToast(`Bot ${result.enabled ? 'enabled' : 'paused'}`, 'info');
        }
    } catch (error) {
        showToast('Failed to toggle bot', 'error');
    }
}

function updateBotToggleButton(enabled) {
    const btn = document.getElementById('bot-toggle');
    if (!btn) return;

    if (enabled) {
        btn.className = 'status-badge status-badge-primary';
        btn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Running';
    } else {
        btn.className = 'status-badge status-badge-paused';
        btn.innerHTML = '<i class="bi bi-pause-fill me-1"></i>Paused';
    }
}

// ============================================================================
// Trade History Functions
// ============================================================================

let tradesPage = 1;
let pnlChart = null;
let winlossChart = null;

async function loadTradeHistory() {
    const coin = document.getElementById('filter-coin').value;
    const side = document.getElementById('filter-side').value;
    const status = document.getElementById('filter-status').value;
    const result = document.getElementById('filter-result').value;
    const dateRange = document.getElementById('filter-date').value;

    const params = new URLSearchParams();
    if (coin) params.set('coin', coin);
    if (side) params.set('side', side);
    if (status) params.set('status', status);
    if (result) params.set('result', result);
    if (dateRange) params.set('date_range', dateRange);
    params.set('page', tradesPage);

    try {
        const data = await apiCall('/trades?' + params.toString());

        // Update stats
        if (data.stats) {
            document.getElementById('total-trades').textContent = data.stats.total_trades || 0;
            document.getElementById('win-rate').textContent = (data.stats.win_rate || 0).toFixed(1) + '%';

            const totalPnl = document.getElementById('total-pnl');
            totalPnl.textContent = formatCurrency(data.stats.total_pnl);
            totalPnl.className = data.stats.total_pnl >= 0 ? 'mb-0 text-success' : 'mb-0 text-danger';

            document.getElementById('avg-win').textContent = formatCurrency(data.stats.avg_win);
            document.getElementById('avg-loss').textContent = formatCurrency(data.stats.avg_loss);
            document.getElementById('best-trade').textContent = formatCurrency(data.stats.best_trade);
        }

        // Update table
        updateTradesTable(data.trades || []);

        // Update charts
        updateCharts(data.trades || []);

    } catch (error) {
        console.error('Failed to load trades:', error);
    }
}

function updateTradesTable(trades) {
    const tbody = document.getElementById('trades-table');

    if (!trades || trades.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="11" class="text-center text-muted py-4">
                    <i class="bi bi-inbox fs-3 d-block mb-2"></i>
                    No trades found
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = trades.map(trade => {
        const pnlClass = (trade.pnl || 0) >= 0 ? 'text-success' : 'text-danger';
        const sideClass = trade.side === 'long' ? 'badge-long' : 'badge-short';

        return `
            <tr>
                <td>${formatDate(trade.timestamp)}</td>
                <td><strong>${trade.coin}</strong></td>
                <td><span class="badge ${sideClass}">${trade.side.toUpperCase()}</span></td>
                <td>${formatPrice(trade.entry_price)}</td>
                <td>${trade.exit_price ? formatPrice(trade.exit_price) : '--'}</td>
                <td>${trade.size.toFixed(4)}</td>
                <td>${trade.leverage}x</td>
                <td class="${pnlClass}">${formatCurrency(trade.pnl)}</td>
                <td class="${pnlClass}">${formatPercent(trade.pnl_percent)}</td>
                <td>${trade.close_reason || '--'}</td>
                <td>${trade.indicator_name || '--'}</td>
            </tr>
        `;
    }).join('');
}

function initCharts() {
    // P&L Chart
    const pnlCtx = document.getElementById('pnl-chart');
    if (pnlCtx) {
        pnlChart = new Chart(pnlCtx.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Cumulative P&L',
                    data: [],
                    borderColor: '#238636',
                    backgroundColor: 'rgba(35, 134, 54, 0.1)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        grid: { color: 'rgba(255,255,255,0.1)' },
                        ticks: { color: '#8b949e' }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#8b949e' }
                    }
                }
            }
        });
    }

    // Win/Loss Chart
    const wlCtx = document.getElementById('winloss-chart');
    if (wlCtx) {
        winlossChart = new Chart(wlCtx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: ['Wins', 'Losses'],
                datasets: [{
                    data: [0, 0],
                    backgroundColor: ['#238636', '#da3633']
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    }
}

function updateCharts(trades) {
    if (!trades || trades.length === 0) return;

    // Calculate cumulative P&L
    let cumulative = 0;
    const pnlData = trades.filter(t => t.status === 'closed').map(t => {
        cumulative += (t.pnl || 0);
        return { date: t.timestamp?.split('T')[0], pnl: cumulative };
    });

    if (pnlChart && pnlData.length > 0) {
        pnlChart.data.labels = pnlData.map(d => d.date);
        pnlChart.data.datasets[0].data = pnlData.map(d => d.pnl);
        pnlChart.update();
    }

    // Win/Loss distribution
    const wins = trades.filter(t => t.status === 'closed' && (t.pnl || 0) > 0).length;
    const losses = trades.filter(t => t.status === 'closed' && (t.pnl || 0) < 0).length;

    if (winlossChart) {
        winlossChart.data.datasets[0].data = [wins, losses];
        winlossChart.update();
    }
}

function exportTrades() {
    window.location.href = '/api/trades/export';
}

// ============================================================================
// Indicators Functions
// ============================================================================

async function loadIndicators() {
    try {
        const data = await apiCall('/indicators');
        updateIndicatorsTable(data.indicators || []);
    } catch (error) {
        console.error('Failed to load indicators:', error);
    }
}

function updateIndicatorsTable(indicators) {
    const tbody = document.getElementById('indicators-table');

    if (!indicators || indicators.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="text-center text-muted py-4">
                    <i class="bi bi-inbox fs-3 d-block mb-2"></i>
                    No indicators configured
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = indicators.map(ind => `
        <tr>
            <td>
                <div class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" ${ind.enabled ? 'checked' : ''}
                           onchange="toggleIndicator(${ind.id}, this.checked)">
                </div>
            </td>
            <td><strong>${ind.name}</strong></td>
            <td><span class="badge bg-secondary">${ind.indicator_type}</span></td>
            <td>${ind.timeframe}</td>
            <td>${ind.coins || 'All'}</td>
            <td>${ind.total_trades}</td>
            <td>${ind.win_rate.toFixed(1)}%</td>
            <td class="${ind.total_pnl >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(ind.total_pnl)}</td>
            <td>
                <button class="btn btn-outline-secondary btn-sm me-1" onclick="editIndicator(${ind.id})">
                    <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-outline-danger btn-sm" onclick="deleteIndicator(${ind.id})">
                    <i class="bi bi-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

async function saveIndicator(e) {
    e.preventDefault();

    const data = {
        name: document.getElementById('indicator-name').value,
        indicator_type: document.getElementById('indicator-type').value,
        webhook_key: document.getElementById('indicator-webhook-key').value,
        timeframe: document.getElementById('indicator-timeframe').value,
        coins: Array.from(document.getElementById('indicator-coins').selectedOptions).map(o => o.value),
        description: document.getElementById('indicator-description').value
    };

    try {
        const result = await apiCall('/indicators', 'POST', data);
        if (result.success) {
            showToast('Indicator saved successfully', 'success');
            loadIndicators();
            document.getElementById('new-indicator-form').reset();
            bootstrap.Collapse.getInstance(document.getElementById('add-indicator-form')).hide();
        } else {
            showToast('Failed to save indicator: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Failed to save indicator', 'error');
    }
}

async function toggleIndicator(id, enabled) {
    try {
        await apiCall(`/indicators/${id}`, 'PUT', { enabled });
        showToast(`Indicator ${enabled ? 'enabled' : 'disabled'}`, 'info');
    } catch (error) {
        showToast('Failed to toggle indicator', 'error');
        loadIndicators();
    }
}

async function deleteIndicator(id) {
    if (!confirm('Are you sure you want to delete this indicator?')) return;

    try {
        const result = await apiCall(`/indicators/${id}`, 'DELETE');
        if (result.success) {
            showToast('Indicator deleted', 'success');
            loadIndicators();
        }
    } catch (error) {
        showToast('Failed to delete indicator', 'error');
    }
}

function setupWebhookInfo() {
    const webhookUrl = window.location.origin + '/webhook';
    document.getElementById('webhook-url').value = webhookUrl;
}

function copyWebhookUrl() {
    navigator.clipboard.writeText(document.getElementById('webhook-url').value);
    showToast('Webhook URL copied to clipboard', 'success');
}

function copyTemplate() {
    navigator.clipboard.writeText(document.getElementById('webhook-template').textContent);
    showToast('Template copied to clipboard', 'success');
}

// ============================================================================
// Settings Functions
// ============================================================================

async function loadSettings() {
    try {
        const data = await apiCall('/settings');

        // General settings
        const botEnabled = data.bot_enabled !== 'false';
        document.getElementById('bot-enabled').checked = botEnabled;
        document.getElementById('default-leverage').value = data.default_leverage || 3;
        document.getElementById('default-collateral').value = data.default_collateral || 100;
        document.getElementById('slippage-tolerance').value = (parseFloat(data.slippage_tolerance) * 100) || 0.3;

        // Update navbar bot toggle to match
        updateBotToggleButton(botEnabled);

        // Update network badge
        const networkBadge = document.getElementById('network-badge');
        if (networkBadge) {
            if (data.use_testnet === 'false') {
                networkBadge.className = 'status-badge status-badge-primary';
                networkBadge.innerHTML = '<i class="bi bi-hdd-network me-1"></i>MAINNET';
            } else {
                networkBadge.className = 'status-badge status-badge-testnet';
                networkBadge.innerHTML = '<i class="bi bi-hdd-network me-1"></i>TESTNET';
            }
        }

        // Risk settings
        if (data.risk) {
            document.getElementById('max-position-value').value = data.risk.max_position_value_usd || 1000;
            document.getElementById('max-exposure-pct').value = data.risk.max_total_exposure_pct || 75;
            document.getElementById('max-leverage').value = data.risk.max_leverage || 10;
        }

        // Wallet info
        document.getElementById('main-wallet').value = data.main_wallet || 'Not configured';
        document.getElementById('webhook-secret').value = data.webhook_secret ? '••••••••••••' : 'Not configured';

        if (!data.api_secret_configured) {
            document.getElementById('api-wallet-status').innerHTML =
                '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>Not Configured</span>';
        }

    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

async function loadCoinConfigs() {
    try {
        const data = await apiCall('/coins');
        updateCoinConfigTable(data.coins || []);
    } catch (error) {
        console.error('Failed to load coin configs:', error);
    }
}

function updateCoinConfigTable(coins) {
    const tbody = document.getElementById('coin-config-table');

    // Define coin groups
    const groups = {
        'MAJORS': ['BTC', 'ETH', 'SOL', 'HYPE'],
        'DEFI': ['AAVE', 'ENA', 'PENDLE', 'AERO'],
        'HIGH BETA / MEMES': ['DOGE', 'PUMP', 'FARTCOIN', 'kBONK', 'kPEPE', 'PENGU']
    };

    // Create a map for quick coin lookup
    const coinMap = {};
    coins.forEach(c => { coinMap[c.coin] = c; });

    let html = '';

    for (const [groupName, groupCoins] of Object.entries(groups)) {
        // Add group header
        html += `
            <tr class="table-active">
                <td colspan="8" class="py-2" style="background-color: rgba(58, 180, 239, 0.15); color: #3AB4EF; font-weight: 600;">
                    <i class="bi bi-collection me-2"></i>${groupName}
                </td>
            </tr>
        `;

        // Add coins in this group
        for (const coinName of groupCoins) {
            const coin = coinMap[coinName];
            if (coin) {
                html += `
                    <tr>
                        <td><strong>${coin.coin}</strong></td>
                        <td>
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" ${coin.enabled ? 'checked' : ''}
                                       onchange="toggleCoin('${coin.coin}', this.checked)">
                            </div>
                        </td>
                        <td>${coin.default_leverage}x</td>
                        <td>${formatCurrency(coin.default_collateral)}</td>
                        <td>${coin.max_position_size ? formatCurrency(coin.max_position_size) : '--'}</td>
                        <td>${coin.default_stop_loss_pct ? coin.default_stop_loss_pct + '%' : '--'}</td>
                        <td>${coin.default_take_profit_pct ? coin.default_take_profit_pct + '%' : '--'}</td>
                        <td>
                            <button class="btn btn-outline-secondary btn-sm" onclick="editCoin('${coin.coin}')">
                                <i class="bi bi-pencil"></i>
                            </button>
                        </td>
                    </tr>
                `;
            }
        }
    }

    tbody.innerHTML = html;
}

async function saveGeneralSettings(e) {
    e.preventDefault();

    const botEnabled = document.getElementById('bot-enabled').checked;
    const data = {
        bot_enabled: botEnabled,
        default_leverage: parseInt(document.getElementById('default-leverage').value),
        default_collateral: parseFloat(document.getElementById('default-collateral').value),
        slippage_tolerance: parseFloat(document.getElementById('slippage-tolerance').value) / 100
    };

    try {
        const result = await apiCall('/settings', 'POST', data);
        if (result.success) {
            // Update navbar bot toggle to match
            updateBotToggleButton(botEnabled);
            showToast('Settings saved successfully', 'success');
        }
    } catch (error) {
        showToast('Failed to save settings', 'error');
    }
}

async function saveRiskSettings(e) {
    e.preventDefault();

    const data = {
        max_position_value_usd: parseFloat(document.getElementById('max-position-value').value),
        max_total_exposure_pct: parseFloat(document.getElementById('max-exposure-pct').value),
        max_leverage: parseInt(document.getElementById('max-leverage').value)
    };

    try {
        const result = await apiCall('/settings/risk', 'POST', data);
        if (result.success) {
            showToast('Risk settings saved successfully', 'success');
        }
    } catch (error) {
        showToast('Failed to save risk settings', 'error');
    }
}

async function testConnection() {
    try {
        const result = await apiCall('/test-connection');
        if (result.success) {
            showToast('Connection successful! Account value: ' + formatCurrency(result.account_value), 'success');
        } else {
            showToast('Connection failed: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Connection test failed', 'error');
    }
}

function toggleSecretVisibility() {
    const input = document.getElementById('webhook-secret');
    const btn = document.getElementById('toggle-secret');

    if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = '<i class="bi bi-eye-slash"></i>';
    } else {
        input.type = 'password';
        btn.innerHTML = '<i class="bi bi-eye"></i>';
    }
}

async function toggleCoin(coin, enabled) {
    try {
        await apiCall(`/coins/${coin}`, 'PUT', { enabled });
        showToast(`${coin} trading ${enabled ? 'enabled' : 'disabled'}`, 'info');
    } catch (error) {
        showToast('Failed to update coin', 'error');
        loadCoinConfigs();
    }
}

function editCoin(coin) {
    apiCall(`/coins/${coin}`).then(data => {
        document.getElementById('edit-coin-name').value = coin;
        document.getElementById('edit-coin-enabled').checked = data.enabled;
        document.getElementById('edit-coin-leverage').value = data.default_leverage;
        document.getElementById('edit-coin-collateral').value = data.default_collateral;
        document.getElementById('edit-coin-max-size').value = data.max_position_size || '';
        document.getElementById('edit-coin-sl').value = data.default_stop_loss_pct || '';
        document.getElementById('edit-coin-tp').value = data.default_take_profit_pct || '';

        const modal = new bootstrap.Modal(document.getElementById('editCoinModal'));
        modal.show();
    });
}

async function saveCoinConfig() {
    const coin = document.getElementById('edit-coin-name').value;
    const data = {
        enabled: document.getElementById('edit-coin-enabled').checked,
        default_leverage: parseInt(document.getElementById('edit-coin-leverage').value),
        default_collateral: parseFloat(document.getElementById('edit-coin-collateral').value),
        max_position_size: parseFloat(document.getElementById('edit-coin-max-size').value) || null,
        default_stop_loss_pct: parseFloat(document.getElementById('edit-coin-sl').value) || null,
        default_take_profit_pct: parseFloat(document.getElementById('edit-coin-tp').value) || null
    };

    try {
        const result = await apiCall(`/coins/${coin}`, 'PUT', data);
        if (result.success) {
            showToast('Coin configuration saved', 'success');
            bootstrap.Modal.getInstance(document.getElementById('editCoinModal')).hide();
            loadCoinConfigs();
        }
    } catch (error) {
        showToast('Failed to save coin configuration', 'error');
    }
}
