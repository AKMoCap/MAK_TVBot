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
    // Setup real-time WebSocket callbacks FIRST (before any connections)
    setupHyperliquidWebSocket();

    // Then fetch settings to get network and bot status
    await fetchBotStatus();
    await refreshDashboard();
    setupDashboardEvents();
}

/**
 * Setup Hyperliquid WebSocket for real-time position updates
 * This should be called early, before wallet connects
 */
function setupHyperliquidWebSocket() {
    if (typeof hlWebSocket === 'undefined') {
        console.warn('[Dashboard] HyperliquidWebSocket not available');
        return;
    }

    console.log('[Dashboard] Setting up Hyperliquid WebSocket callbacks');

    // Set up callbacks for real-time updates
    hlWebSocket.onAccountUpdate = (data) => {
        console.log('[WS] Account update received, positions:', data.positions?.length || 0);
        updateAccountCards(data);
        updatePositionsTable(data.positions || []);
        updateConnectionStatus(true);
    };

    hlWebSocket.onPositionUpdate = (positions) => {
        console.log('[WS] Position update:', positions.length, 'positions');
        updatePositionsTable(positions);
    };

    hlWebSocket.onFillUpdate = (fills) => {
        console.log('[WS] Fill update:', fills.length, 'fills');
        // Could update activity list here if needed
    };

    // If wallet is already connected (session restored), connect WebSocket now
    if (typeof walletManager !== 'undefined' && walletManager.isConnected && walletManager.address) {
        console.log('[Dashboard] Wallet already connected, connecting WebSocket for:', walletManager.address);
        hlWebSocket.connect(walletManager.address);
    }
}

// Setup WebSocket callbacks immediately when script loads
// This ensures callbacks are ready before wallet.js tries to connect
if (typeof hlWebSocket !== 'undefined') {
    console.log('[app.js] Setting up WebSocket callbacks on load');
    setupHyperliquidWebSocket();
}

async function fetchBotStatus() {
    try {
        const settings = await apiCall('/settings');

        // Debug: log what we received
        console.log('[fetchBotStatus] Settings received:', {
            use_testnet: settings.use_testnet,
            network: settings.network,
            type: typeof settings.use_testnet
        });

        // Update network badge - use explicit network field if available
        const networkBadge = document.getElementById('network-badge');
        if (networkBadge) {
            const isMainnet = settings.network === 'mainnet' || settings.use_testnet === 'false' || settings.use_testnet === false;
            if (isMainnet) {
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
    let connected = false;

    try {
        // Fetch account info - handle errors gracefully
        const accountData = await apiCall('/account');
        if (accountData.error) {
            // Show error but still consider connected if we got a response
            console.log('[Dashboard] Account error:', accountData.error);
            document.getElementById('account-value').textContent = '$0.00';
            connected = true;  // We reached the server
        } else {
            updateAccountCards(accountData);
            updatePositionsTable(accountData.positions || []);
            connected = true;
        }
    } catch (error) {
        console.error('[Dashboard] Account fetch failed:', error);
    }

    try {
        // Fetch daily stats
        const statsData = await apiCall('/stats/daily');
        if (!statsData.error) {
            updateDailyStats(statsData);
        }
        connected = true;
    } catch (error) {
        console.error('[Dashboard] Stats fetch failed:', error);
    }

    try {
        // Fetch market prices
        const pricesData = await apiCall('/prices');
        if (!pricesData.error) {
            updatePrices(pricesData);
        }
        connected = true;
    } catch (error) {
        console.error('[Dashboard] Prices fetch failed:', error);
    }

    try {
        // Fetch recent activity
        const activityData = await apiCall('/activity?limit=10');
        if (!activityData.error) {
            updateActivityList(activityData.logs || []);
        }
        connected = true;
    } catch (error) {
        console.error('[Dashboard] Activity fetch failed:', error);
    }

    // Update connection status based on whether any call succeeded
    updateConnectionStatus(connected);
}

function updateAccountCards(data) {
    document.getElementById('account-value').textContent = formatCurrency(data.account_value);

    // Calculate totals from positions
    const positions = data.positions || [];
    let totalCollateral = 0;
    let totalPnl = 0;
    let totalPositionValue = 0;

    positions.forEach(pos => {
        totalCollateral += Math.abs(pos.margin_used || pos.collateral || 0);
        totalPnl += pos.unrealized_pnl || 0;
        // Calculate position value (notional): size * mark_price
        const posValue = Math.abs(pos.size || 0) * (pos.mark_price || pos.entry_price || 0);
        totalPositionValue += posValue;
    });

    // Update Collateral at Risk
    const collateralEl = document.getElementById('collateral-at-risk');
    if (collateralEl) {
        collateralEl.textContent = formatCurrency(totalCollateral);
    }

    // Update Account Leverage (total position value / account value)
    const acctLeverageEl = document.getElementById('account-leverage');
    if (acctLeverageEl) {
        const accountValue = parseFloat(data.account_value) || 0;
        const acctLeverage = accountValue > 0 ? totalPositionValue / accountValue : 0;
        acctLeverageEl.textContent = acctLeverage.toFixed(1) + 'x';
    }

    // Update Current P&L with color coding
    const currentPnlEl = document.getElementById('current-pnl');
    const pnlIcon = document.getElementById('current-pnl-icon');
    const pnlIconContainer = document.getElementById('current-pnl-icon-container');
    if (currentPnlEl) {
        currentPnlEl.textContent = formatCurrency(totalPnl);
        if (totalPnl >= 0) {
            currentPnlEl.className = 'mb-0 text-success';
            if (pnlIcon) pnlIcon.className = 'bi bi-graph-up text-success fs-5';
            if (pnlIconContainer) pnlIconContainer.className = 'bg-success bg-opacity-25 p-2 rounded';
        } else {
            currentPnlEl.className = 'mb-0 text-danger';
            if (pnlIcon) pnlIcon.className = 'bi bi-graph-down text-danger fs-5';
            if (pnlIconContainer) pnlIconContainer.className = 'bg-danger bg-opacity-25 p-2 rounded';
        }
    }
    // Note: Network badge is updated by fetchBotStatus() from /api/settings only
}

function updateDailyStats(data) {
    // Update Effective Leverage (Cross Margin Used)
    const effectiveLeverageEl = document.getElementById('effective-leverage');
    if (effectiveLeverageEl) {
        const crossMarginUsed = data.cross_margin_used || 0;
        effectiveLeverageEl.textContent = crossMarginUsed.toFixed(1) + 'x';
    }
}

function updateRiskBars(data) {
    // Get values from data or use defaults
    const maxExposurePct = data.max_exposure_pct || 75;
    const maxLeverage = data.max_leverage || 10;
    const collateralAtRisk = data.collateral_at_risk_pct || 0;
    const crossMarginUsed = data.cross_margin_used || 0;

    // Collateral at Risk (% of account used as collateral)
    const collateralPct = (collateralAtRisk / maxExposurePct) * 100;
    const collateralStatus = document.getElementById('collateral-risk-status');
    const collateralBar = document.getElementById('collateral-risk-bar');
    if (collateralStatus) {
        collateralStatus.textContent = collateralAtRisk.toFixed(1) + '% / ' + maxExposurePct + '%';
    }
    if (collateralBar) {
        collateralBar.style.width = Math.min(collateralPct, 100) + '%';
        collateralBar.className = 'progress-bar ' + (collateralPct > 80 ? 'bg-danger' : collateralPct > 50 ? 'bg-warning' : 'bg-info');
    }

    // Cross Margin Used (effective leverage vs max allowed)
    const marginPct = (crossMarginUsed / maxLeverage) * 100;
    const marginStatus = document.getElementById('cross-margin-status');
    const marginBar = document.getElementById('cross-margin-bar');
    if (marginStatus) {
        marginStatus.textContent = crossMarginUsed.toFixed(1) + 'x / ' + maxLeverage + 'x';
    }
    if (marginBar) {
        marginBar.style.width = Math.min(marginPct, 100) + '%';
        marginBar.className = 'progress-bar ' + (marginPct > 80 ? 'bg-danger' : marginPct > 50 ? 'bg-warning' : 'bg-success');
    }
}

function updatePositionsTable(positions) {
    console.log('[updatePositionsTable] Called with', positions?.length || 0, 'positions');

    const tbody = document.getElementById('positions-table');
    if (!tbody) {
        console.error('[updatePositionsTable] positions-table element not found!');
        return;
    }

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

    console.log('[updatePositionsTable] Rendering positions:', positions);

    tbody.innerHTML = positions.map(pos => {
        const pnlClass = pos.unrealized_pnl >= 0 ? 'text-success' : 'text-danger';
        const sideClass = pos.side === 'long' ? 'badge-long' : 'badge-short';
        // HIP-3 badge for builder-deployed perps
        const hip3Badge = pos.is_hip3 ? '<span class="badge bg-info ms-1" title="HIP-3 Builder Perp">HIP-3</span>' : '';
        const dexInfo = pos.dex_name ? ` (${pos.dex_name})` : '';

        return `
            <tr>
                <td><strong>${pos.coin}</strong>${hip3Badge}</td>
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

// Store coin configs globally for quick trade form
let coinConfigsCache = {};

// Store asset metadata (szDecimals, maxLeverage) from Hyperliquid API
let assetMetaCache = {};

// Category definitions for batch trading
const categoryCoins = {
    'CAT:MAJORS': ['BTC', 'ETH', 'SOL', 'HYPE'],
    'CAT:DEFI': ['AAVE', 'ENA', 'PENDLE', 'AERO'],
    'CAT:MEMES': ['DOGE', 'PUMP', 'FARTCOIN', 'kBONK', 'kPEPE', 'PENGU', 'VIRTUAL']
};

function isCategory(value) {
    return value && value.startsWith('CAT:');
}

async function loadAssetMetadata() {
    try {
        const data = await apiCall('/asset-meta');
        if (data && !data.error) {
            assetMetaCache = data;
            console.log('Loaded asset metadata for', Object.keys(assetMetaCache).length, 'assets');
        }
    } catch (error) {
        console.error('Failed to load asset metadata:', error);
    }
}

function getMaxLeverage(coin) {
    // Get max leverage from asset metadata (stored in database, refreshed daily)
    if (assetMetaCache[coin]) {
        return assetMetaCache[coin].maxLeverage || 10;
    }
    // Fallback to coin config if available
    if (coinConfigsCache[coin] && coinConfigsCache[coin].hl_max_leverage) {
        return coinConfigsCache[coin].hl_max_leverage;
    }
    return 10;
}

async function loadCoinConfigsForQuickTrade() {
    try {
        // Load asset metadata first
        await loadAssetMetadata();

        const data = await apiCall('/coins');
        if (data.coins) {
            data.coins.forEach(coin => {
                coinConfigsCache[coin.coin] = coin;
            });
            // Populate form with default coin (first one selected)
            const coinSelect = document.getElementById('trade-coin');
            if (coinSelect && coinSelect.value && !isCategory(coinSelect.value)) {
                populateQuickTradeForm(coinSelect.value);
            }
        }
    } catch (error) {
        console.error('Failed to load coin configs for quick trade:', error);
    }
}

function populateQuickTradeForm(selection) {
    // If a category is selected, clear the form for manual entry
    if (isCategory(selection)) {
        clearQuickTradeForm();
        return;
    }

    const config = coinConfigsCache[selection];
    if (!config) return;

    // Get max leverage for this coin from Hyperliquid API metadata
    const maxLeverage = getMaxLeverage(selection);

    // Update leverage slider max value and current value
    const leverageRange = document.getElementById('trade-leverage-range');
    const leverageDisplay = document.getElementById('leverage-display');
    if (leverageRange) {
        // Update the max attribute
        leverageRange.max = maxLeverage;

        // Set default leverage (capped at max)
        const defaultLev = Math.min(config.default_leverage || 3, maxLeverage);
        leverageRange.value = defaultLev;

        if (leverageDisplay) {
            leverageDisplay.textContent = defaultLev + 'x';
            // Show max leverage info
            leverageDisplay.title = `Max leverage for ${selection}: ${maxLeverage}x`;
        }
    }

    // Update collateral
    const collateralInput = document.getElementById('trade-collateral');
    if (collateralInput && config.default_collateral) {
        collateralInput.value = config.default_collateral;
    }

    // Update stop loss
    const slInput = document.getElementById('trade-sl');
    if (slInput && config.default_stop_loss_pct) {
        slInput.value = config.default_stop_loss_pct;
    }

    // Update TP1
    const tp1Input = document.getElementById('trade-tp1');
    const tp1SizeInput = document.getElementById('trade-tp1-size');
    if (tp1Input && config.tp1_pct) {
        tp1Input.value = config.tp1_pct;
    }
    if (tp1SizeInput && config.tp1_size_pct) {
        tp1SizeInput.value = config.tp1_size_pct;
    }

    // Update TP2
    const tp2Input = document.getElementById('trade-tp2');
    const tp2SizeInput = document.getElementById('trade-tp2-size');
    if (tp2Input && config.tp2_pct) {
        tp2Input.value = config.tp2_pct;
    }
    if (tp2SizeInput && config.tp2_size_pct) {
        tp2SizeInput.value = config.tp2_size_pct;
    }
}

function clearQuickTradeForm() {
    // Clear all fields for category trading (user must fill in)
    const leverageRange = document.getElementById('trade-leverage-range');
    const leverageDisplay = document.getElementById('leverage-display');
    if (leverageRange) {
        // Reset max to lowest common denominator for category trading
        leverageRange.max = 3;  // Most restrictive (AERO is 3x max)
        leverageRange.value = 3;
        if (leverageDisplay) {
            leverageDisplay.textContent = '3x';
            leverageDisplay.title = 'Max leverage varies by coin (using lowest: 3x)';
        }
    }

    const collateralInput = document.getElementById('trade-collateral');
    if (collateralInput) collateralInput.value = '';

    const slInput = document.getElementById('trade-sl');
    if (slInput) slInput.value = '';

    const tp1Input = document.getElementById('trade-tp1');
    const tp1SizeInput = document.getElementById('trade-tp1-size');
    if (tp1Input) tp1Input.value = '';
    if (tp1SizeInput) tp1SizeInput.value = '';

    const tp2Input = document.getElementById('trade-tp2');
    const tp2SizeInput = document.getElementById('trade-tp2-size');
    if (tp2Input) tp2Input.value = '';
    if (tp2SizeInput) tp2SizeInput.value = '';
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

    // Coin dropdown - auto-populate form with coin defaults
    const coinSelect = document.getElementById('trade-coin');
    if (coinSelect) {
        coinSelect.addEventListener('change', function() {
            populateQuickTradeForm(this.value);
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

    // Load coin configs for quick trade
    loadCoinConfigsForQuickTrade();
}

async function executeTrade(action) {
    const selection = document.getElementById('trade-coin').value;
    const collateral = parseFloat(document.getElementById('trade-collateral').value);
    const leverage = parseInt(document.getElementById('trade-leverage-range').value);
    const stopLoss = parseFloat(document.getElementById('trade-sl').value) || null;

    // Get TP1 and TP2 values
    const tp1Pct = parseFloat(document.getElementById('trade-tp1').value) || null;
    const tp1SizePct = parseFloat(document.getElementById('trade-tp1-size').value) || null;
    const tp2Pct = parseFloat(document.getElementById('trade-tp2').value) || null;
    const tp2SizePct = parseFloat(document.getElementById('trade-tp2-size').value) || null;

    if (!selection || !collateral || !leverage) {
        showToast('Please fill in all required fields', 'warning');
        return;
    }

    // Check if this is a category trade
    if (isCategory(selection)) {
        await executeCategoryTrade(selection, action, collateral, leverage, stopLoss, tp1Pct, tp1SizePct, tp2Pct, tp2SizePct);
        return;
    }

    // Single coin trade
    try {
        const result = await apiCall('/trade', 'POST', {
            coin: selection,
            action,
            leverage,
            collateral_usd: collateral,
            stop_loss_pct: stopLoss,
            tp1_pct: tp1Pct,
            tp1_size_pct: tp1SizePct,
            tp2_pct: tp2Pct,
            tp2_size_pct: tp2SizePct
        });

        if (result.success) {
            showToast(`${action.toUpperCase()} order executed for ${selection}`, 'success');
            refreshDashboard();
        } else {
            showToast('Trade failed: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Trade execution failed', 'error');
    }
}

async function executeCategoryTrade(category, action, collateral, leverage, stopLoss, tp1Pct, tp1SizePct, tp2Pct, tp2SizePct) {
    const coins = categoryCoins[category];
    if (!coins || coins.length === 0) {
        showToast('Invalid category selected', 'error');
        return;
    }

    const categoryName = category.replace('CAT:', '');

    showToast(`Opening ${coins.length} ${action.toUpperCase()} positions for ${categoryName}...`, 'info');

    let successCount = 0;
    let failedCoins = [];

    // Helper function to execute trade with retry logic
    async function executeWithRetry(coin, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await apiCall('/trade', 'POST', {
                    coin,
                    action,
                    leverage,
                    collateral_usd: collateral,
                    stop_loss_pct: stopLoss,
                    tp1_pct: tp1Pct,
                    tp1_size_pct: tp1SizePct,
                    tp2_pct: tp2Pct,
                    tp2_size_pct: tp2SizePct
                });

                if (result.success) {
                    return { success: true, result };
                } else if (result.error && result.error.includes('429')) {
                    // Rate limited - wait and retry
                    if (attempt < maxRetries) {
                        const waitTime = attempt * 3000; // 3s, 6s, 9s
                        showToast(`${coin} rate limited, retrying in ${waitTime/1000}s...`, 'warning');
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                }
                return { success: false, error: result.error || 'Unknown error' };
            } catch (error) {
                if (attempt < maxRetries && error.message && error.message.includes('429')) {
                    const waitTime = attempt * 3000;
                    showToast(`${coin} rate limited, retrying in ${waitTime/1000}s...`, 'warning');
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                return { success: false, error: error.message || 'Request failed' };
            }
        }
        return { success: false, error: 'Max retries exceeded' };
    }

    // Execute trades sequentially with longer delay to avoid rate limiting
    for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];

        // Add a pre-trade delay (except for first trade)
        if (i > 0) {
            // Longer delay between trades to avoid rate limiting (4 seconds)
            // Hyperliquid has rate limits that require spacing out requests
            await new Promise(resolve => setTimeout(resolve, 4000));
        }

        showToast(`Opening ${coin} (${i + 1}/${coins.length})...`, 'info');
        const result = await executeWithRetry(coin);

        if (result.success) {
            successCount++;
            showToast(`${coin} ${action.toUpperCase()} opened (${successCount}/${coins.length})`, 'success');
        } else {
            failedCoins.push(`${coin}: ${result.error}`);
            showToast(`${coin} failed: ${result.error}`, 'error');
        }
    }

    // Show final summary
    if (successCount === coins.length) {
        showToast(`All ${successCount} ${action.toUpperCase()} positions opened for ${categoryName}!`, 'success');
    } else if (successCount > 0) {
        showToast(`Opened ${successCount}/${coins.length} positions. ${failedCoins.length} failed.`, 'warning');
        console.error('Failed trades:', failedCoins);
    } else {
        showToast(`Failed to open any positions for ${categoryName}`, 'error');
        console.error('All trades failed:', failedCoins);
    }

    refreshDashboard();
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
        // Note: Network badge is updated by fetchBotStatus() only

        // Risk settings
        if (data.risk) {
            document.getElementById('max-position-value').value = data.risk.max_position_value_usd || 1000;
            document.getElementById('max-exposure-pct').value = data.risk.max_total_exposure_pct || 75;
            document.getElementById('max-leverage').value = data.risk.max_leverage || 10;
        }

        // Wallet info
        document.getElementById('main-wallet').value = data.main_wallet || 'Not configured';

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
        'HIGH BETA / MEMES': ['DOGE', 'PUMP', 'FARTCOIN', 'kBONK', 'kPEPE', 'PENGU', 'VIRTUAL']
    };

    // Create a map for quick coin lookup
    const coinMap = {};
    coins.forEach(c => { coinMap[c.coin] = c; });

    let html = '';

    for (const [groupName, groupCoins] of Object.entries(groups)) {
        // Add group header
        html += `
            <tr class="table-active">
                <td colspan="9" class="py-2" style="background-color: rgba(58, 180, 239, 0.15); color: #3AB4EF; font-weight: 600;">
                    <i class="bi bi-collection me-2"></i>${groupName}
                </td>
            </tr>
        `;

        // Add coins in this group
        for (const coinName of groupCoins) {
            const coin = coinMap[coinName];
            if (coin) {
                // TP display: "size% @ target%" (e.g., "25% @ 50%" = close 25% at 50% gain)
                const tp1Display = coin.tp1_pct ? `${coin.tp1_size_pct}% @ ${coin.tp1_pct}%` : '--';
                const tp2Display = coin.tp2_pct ? `${coin.tp2_size_pct}% @ ${coin.tp2_pct}%` : '--';
                const maxSizeDisplay = coin.max_position_size ? formatCurrency(coin.max_position_size) : formatCurrency(coin.default_collateral * 10);
                const slDisplay = coin.default_stop_loss_pct ? `-${coin.default_stop_loss_pct}%` : '-15%';
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
                        <td>${maxSizeDisplay}</td>
                        <td>${slDisplay}</td>
                        <td><small>${tp1Display}</small></td>
                        <td><small>${tp2Display}</small></td>
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
        document.getElementById('edit-coin-leverage').value = data.default_leverage || 3;
        document.getElementById('edit-coin-collateral').value = data.default_collateral || 100;
        document.getElementById('edit-coin-max-size').value = data.max_position_size || 1000;
        document.getElementById('edit-coin-sl').value = data.default_stop_loss_pct || 15;
        document.getElementById('edit-coin-tp1').value = data.tp1_pct || 50;
        document.getElementById('edit-coin-tp1-size').value = data.tp1_size_pct || 25;
        document.getElementById('edit-coin-tp2').value = data.tp2_pct || 100;
        document.getElementById('edit-coin-tp2-size').value = data.tp2_size_pct || 50;

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
        tp1_pct: parseFloat(document.getElementById('edit-coin-tp1').value) || null,
        tp1_size_pct: parseFloat(document.getElementById('edit-coin-tp1-size').value) || null,
        tp2_pct: parseFloat(document.getElementById('edit-coin-tp2').value) || null,
        tp2_size_pct: parseFloat(document.getElementById('edit-coin-tp2-size').value) || null
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

async function clearTradeHistory() {
    if (!confirm('Are you sure you want to clear ALL trade history? This action cannot be undone.')) {
        return;
    }

    // Double confirmation for safety
    if (!confirm('This will permanently delete all trades. Are you ABSOLUTELY sure?')) {
        return;
    }

    try {
        const result = await apiCall('/trades/clear', 'DELETE');
        if (result.success) {
            showToast(`Cleared ${result.deleted} trades from history`, 'success');
            // Refresh the page if on trades page, or refresh dashboard
            if (typeof loadTradeHistory === 'function') {
                loadTradeHistory();
            }
            if (typeof refreshDashboard === 'function') {
                refreshDashboard();
            }
        } else {
            showToast('Failed to clear trades: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Failed to clear trade history', 'error');
    }
}

async function clearActivityLogs() {
    if (!confirm('Are you sure you want to clear all activity logs?')) {
        return;
    }

    try {
        const result = await apiCall('/logs/clear', 'DELETE');
        if (result.success) {
            showToast(`Cleared ${result.deleted} log entries`, 'success');
        } else {
            showToast('Failed to clear logs: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Failed to clear activity logs', 'error');
    }
}

// Setup event listeners for settings page buttons
function setupSettingsEvents() {
    const clearTradesBtn = document.getElementById('clear-trades');
    if (clearTradesBtn) {
        clearTradesBtn.addEventListener('click', clearTradeHistory);
    }

    const clearLogsBtn = document.getElementById('clear-logs');
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', clearActivityLogs);
    }

    const exportDataBtn = document.getElementById('export-data');
    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', () => {
            window.location.href = '/api/trades/export';
        });
    }

    // Check HIP-3 DEX abstraction status
    checkHip3Status();
}

/**
 * Check and display HIP-3 DEX abstraction status on Settings page
 */
async function checkHip3Status() {
    const hip3StatusEl = document.getElementById('hip3-status');
    if (!hip3StatusEl) return;

    try {
        const result = await apiCall('/wallet/dex-abstraction-status');

        if (result.error && result.error !== 'Not connected' && result.error !== 'Not authorized') {
            hip3StatusEl.innerHTML = `<span class="badge bg-warning"><i class="bi bi-exclamation-triangle me-1"></i>Unknown</span>`;
            return;
        }

        if (result.error === 'Not connected') {
            hip3StatusEl.innerHTML = `<span class="badge bg-secondary"><i class="bi bi-wallet2 me-1"></i>Connect Wallet</span>`;
            return;
        }

        if (result.error === 'Not authorized') {
            hip3StatusEl.innerHTML = `<span class="badge bg-secondary"><i class="bi bi-key me-1"></i>Authorize First</span>`;
            return;
        }

        if (result.enabled) {
            hip3StatusEl.innerHTML = `<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Enabled</span>`;
        } else {
            hip3StatusEl.innerHTML = `
                <span class="badge bg-warning me-2"><i class="bi bi-x-circle me-1"></i>Disabled</span>
                <button class="btn btn-sm btn-outline-info" onclick="enableHip3Dex()">
                    <i class="bi bi-lightning me-1"></i>Enable
                </button>
            `;
        }
    } catch (error) {
        console.error('Failed to check HIP-3 status:', error);
        hip3StatusEl.innerHTML = `<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>Error</span>`;
    }
}

/**
 * Enable HIP-3 DEX abstraction from Settings page
 */
async function enableHip3Dex() {
    const hip3StatusEl = document.getElementById('hip3-status');
    if (hip3StatusEl) {
        hip3StatusEl.innerHTML = `<span class="badge bg-info"><i class="bi bi-hourglass-split me-1"></i>Enabling...</span>`;
    }

    try {
        const result = await apiCall('/wallet/enable-dex-abstraction', 'POST');
        if (result.success) {
            showToast('HIP-3 DEX abstraction enabled successfully!', 'success');
            if (hip3StatusEl) {
                hip3StatusEl.innerHTML = `<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Enabled</span>`;
            }
        } else {
            showToast('Failed to enable HIP-3: ' + (result.error || 'Unknown error'), 'error');
            checkHip3Status();  // Refresh status
        }
    } catch (error) {
        showToast('Failed to enable HIP-3 DEX abstraction', 'error');
        checkHip3Status();  // Refresh status
    }
}
