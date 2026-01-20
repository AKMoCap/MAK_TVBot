/**
 * MAK Trading Bot - Frontend JavaScript
 */

// Global state
let botState = {
    enabled: true,
    network: 'testnet',
    connected: false
};

// Global price cache for live prices from WebSocket
let livePrices = {};

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

    // Use longer delay for errors so users have time to read them
    const delay = type === 'error' ? 10000 : (type === 'warning' ? 7000 : 5000);

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
    const toast = new bootstrap.Toast(toastEl, { autohide: true, delay: delay });
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

/**
 * Update tab count badge
 * @param {string} tabName - Tab name: 'perps', 'orders', or 'twaps'
 * @param {number} count - Number of items
 */
function updateTabCount(tabName, count) {
    const countEl = document.getElementById(`tab-count-${tabName}`);
    if (countEl) {
        countEl.textContent = count > 0 ? `(${count})` : '';
    }
}

/**
 * Make an API call with optional loading state management
 * @param {string} endpoint - API endpoint (without /api prefix)
 * @param {string} method - HTTP method
 * @param {object} data - Request body data
 * @param {object} options - Additional options
 * @param {HTMLElement} options.loadingButton - Button to show loading state on
 * @param {string} options.loadingText - Text to show while loading
 * @param {boolean} options.silent - Don't show error toast on failure
 */
async function apiCall(endpoint, method = 'GET', data = null, options = {}) {
    const { loadingButton, loadingText, silent } = options;
    let originalButtonContent = null;

    // Set loading state on button if provided
    if (loadingButton) {
        originalButtonContent = loadingButton.innerHTML;
        loadingButton.disabled = true;
        loadingButton.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${loadingText || 'Loading...'}`;
    }

    const fetchOptions = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (data) fetchOptions.body = JSON.stringify(data);

    try {
        const response = await fetch('/api' + endpoint, fetchOptions);
        const result = await response.json();

        // Restore button state on success
        if (loadingButton) {
            loadingButton.disabled = false;
            loadingButton.innerHTML = originalButtonContent;
        }

        return result;
    } catch (error) {
        console.error('API Error:', error);

        // Restore button state on error
        if (loadingButton) {
            loadingButton.disabled = false;
            loadingButton.innerHTML = originalButtonContent;
        }

        if (!silent) {
            showToast('API request failed: ' + error.message, 'error');
        }
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

    // Set up price update callback for real-time prices via allMids
    hlWebSocket.onPriceUpdate = (prices) => {
        // Update price displays with WebSocket data
        updatePricesFromWebSocket(prices);
    };

    // Set up connection status change callback for user notifications
    hlWebSocket.onConnectionStatusChange = (connected, status, attempt, maxAttempts) => {
        console.log('[WS] Connection status changed:', status);
        if (status === 'connected') {
            updateConnectionStatus(true);
            // Only show reconnection success if we were previously trying to reconnect
            if (attempt > 0) {
                showToast('Real-time connection restored', 'success');
            }
        } else if (status === 'reconnecting') {
            updateConnectionStatus(false);
            // Show reconnection attempt on first retry
            if (attempt === 1) {
                showToast('Real-time connection lost. Attempting to reconnect...', 'warning');
            }
        } else if (status === 'disconnected') {
            updateConnectionStatus(false);
        }
    };

    // Set up callback for when max reconnection attempts are reached
    hlWebSocket.onReconnectFailed = () => {
        showToast('Real-time updates unavailable. Please refresh the page to reconnect.', 'error');
        updateConnectionStatus(false);
    };

    // If wallet is already connected (session restored), connect WebSocket now
    if (typeof walletManager !== 'undefined' && walletManager.isConnected && walletManager.address) {
        console.log('[Dashboard] Wallet already connected, connecting WebSocket for:', walletManager.address);
        hlWebSocket.connect(walletManager.address);
    }
}

/**
 * Update price displays from WebSocket allMids data
 * This is called in real-time and doesn't use REST API
 */
function updatePricesFromWebSocket(prices) {
    if (!prices) return;

    // Store prices in global cache
    Object.assign(livePrices, prices);

    for (const [coin, price] of Object.entries(prices)) {
        const el = document.getElementById('price-' + coin);
        if (el) {
            el.textContent = formatPrice(price);
        }
    }

    // Update Quick Trade dropdown with live prices
    updateDropdownPrices();
}

/**
 * Update Quick Trade custom dropdown with live prices
 */
function updateDropdownPrices() {
    const dropdownMenu = document.getElementById('coin-dropdown-menu');
    if (!dropdownMenu) return;

    // Update each dropdown item with its live price
    const items = dropdownMenu.querySelectorAll('.coin-dropdown-item');
    items.forEach(item => {
        const coin = item.dataset.coin;
        if (coin && livePrices[coin]) {
            const price = livePrices[coin];
            const formattedPrice = formatPrice(price);
            const priceSpan = item.querySelector('.item-price');
            if (priceSpan) {
                priceSpan.textContent = formattedPrice;
            }
        }
    });

    // Also update the selected coin's price in the trigger
    const selectedCoin = document.getElementById('trade-coin')?.value;
    if (selectedCoin && livePrices[selectedCoin]) {
        const selectedPriceEl = document.getElementById('selected-coin-price');
        if (selectedPriceEl) {
            selectedPriceEl.textContent = formatPrice(livePrices[selectedCoin]);
        }
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
    // Use Promise.allSettled for parallel API calls - one failure won't block others
    const wsConnected = typeof hlWebSocket !== 'undefined' && hlWebSocket.isConnected;

    // Build list of promises for parallel execution
    const promises = [
        apiCall('/account', 'GET', null, { silent: true }).catch(e => ({ error: e.message })),
        apiCall('/stats/daily', 'GET', null, { silent: true }).catch(e => ({ error: e.message })),
        apiCall('/activity?limit=10', 'GET', null, { silent: true }).catch(e => ({ error: e.message })),
        loadAndCacheSpotBalances().catch(e => null)
    ];

    // Only fetch prices via REST if WebSocket is not connected
    if (!wsConnected) {
        promises.push(
            apiCall('/prices', 'GET', null, { silent: true }).catch(e => ({ error: e.message }))
        );
    }

    // Execute all promises in parallel
    const results = await Promise.allSettled(promises);
    let connected = false;

    // Process account data (index 0)
    const accountResult = results[0];
    if (accountResult.status === 'fulfilled' && accountResult.value) {
        const accountData = accountResult.value;
        if (accountData.error) {
            console.log('[Dashboard] Account error:', accountData.error);
            connected = true; // We reached the server
        } else {
            updateAccountCards(accountData);
            updatePositionsTable(accountData.positions || []);
            connected = true;

            // Update WebSocket HIP-3 cache with positions from REST API
            if (typeof hlWebSocket !== 'undefined' && hlWebSocket.updateHip3Cache) {
                hlWebSocket.updateHip3Cache(accountData.positions || []);
            }
        }
    }

    // Process stats data (index 1)
    const statsResult = results[1];
    if (statsResult.status === 'fulfilled' && statsResult.value && !statsResult.value.error) {
        updateDailyStats(statsResult.value);
        connected = true;
    }

    // Process activity data (index 2)
    const activityResult = results[2];
    if (activityResult.status === 'fulfilled' && activityResult.value && !activityResult.value.error) {
        updateActivityList(activityResult.value.logs || []);
        connected = true;
    }

    // Spot balances (index 3) - handled by loadAndCacheSpotBalances

    // Process prices data (index 4, only if WebSocket not connected)
    if (!wsConnected && results.length > 4) {
        const pricesResult = results[4];
        if (pricesResult.status === 'fulfilled' && pricesResult.value && !pricesResult.value.error) {
            updatePrices(pricesResult.value);
            connected = true;
        }
    }

    // Update connection status based on whether any call succeeded
    updateConnectionStatus(connected);
}

// Global cache for stablecoin balances (for transfer modal and display)
let stablecoinBalances = {
    usdcPerps: 0,        // Total perps account value (marginSummary.accountValue)
    usdcPerpsAvail: 0,   // Available/withdrawable perps balance
    usdcSpot: 0,
    usdh: 0,
    totalSpotValue: 0    // Total spot value in USD (for account value calculation)
};

// Track last known values to prevent flashing
let lastKnownAccountValue = null;
let spotBalancesLoaded = false;

// Cache for spot balances (for Spot tab display)
let spotBalancesCache = [];

function updateAccountCards(data) {
    // Store perps account value and available balance
    const perpsAccountValue = parseFloat(data.account_value) || 0;
    const perpsAvailable = parseFloat(data.withdrawable) || 0;

    stablecoinBalances.usdcPerps = perpsAccountValue;
    stablecoinBalances.usdcPerpsAvail = perpsAvailable;

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

    // Calculate and display total account value using cached spot values
    const totalValue = perpsAccountValue + stablecoinBalances.totalSpotValue;

    // Only update display if we have valid data (prevent flashing to $0)
    if (totalValue > 0 || lastKnownAccountValue === null) {
        lastKnownAccountValue = totalValue;
        document.getElementById('account-value').textContent = formatCurrency(totalValue);
    }

    // Update perps breakdown (always have this data)
    document.getElementById('usdc-perps').textContent = formatCurrency(perpsAccountValue);
    document.getElementById('usdc-perps-avail').textContent = formatCurrency(perpsAvailable);

    // Update spot values from cache
    document.getElementById('usdc-spot').textContent = formatCurrency(stablecoinBalances.usdcSpot);
    document.getElementById('usdh-balance').textContent = formatCurrency(stablecoinBalances.usdh);

    // Update Collateral at Risk
    const collateralEl = document.getElementById('collateral-at-risk');
    if (collateralEl) {
        collateralEl.textContent = formatCurrency(totalCollateral);
    }

    // Update Account Leverage (total position value / account value)
    const acctLeverageEl = document.getElementById('account-leverage');
    if (acctLeverageEl) {
        const acctLeverage = perpsAccountValue > 0 ? totalPositionValue / perpsAccountValue : 0;
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

/**
 * Load and cache spot balances (called on init and periodically)
 * This is the single source of truth for spot data
 */
async function loadAndCacheSpotBalances() {
    const walletAddress = typeof walletManager !== 'undefined' && walletManager.address;
    if (!walletAddress) return null;

    try {
        const data = await apiCall(`/spot-balances?address=${walletAddress}`);
        const balances = data.balances || [];

        // Calculate totals and cache individual balances
        let usdcSpot = 0;
        let usdh = 0;
        let totalSpotValue = 0;

        balances.forEach(bal => {
            const value = parseFloat(bal.value_usd) || 0;
            totalSpotValue += value;

            if (bal.token === 'USDC') {
                usdcSpot = parseFloat(bal.total) || 0;
            } else if (bal.token === 'USDH') {
                usdh = parseFloat(bal.total) || 0;
            }
        });

        // Update the global cache
        stablecoinBalances.usdcSpot = usdcSpot;
        stablecoinBalances.usdh = usdh;
        stablecoinBalances.totalSpotValue = totalSpotValue;
        spotBalancesLoaded = true;

        // Update the display elements
        document.getElementById('usdc-spot').textContent = formatCurrency(usdcSpot);
        document.getElementById('usdh-balance').textContent = formatCurrency(usdh);

        // Recalculate total account value if we have perps data
        if (stablecoinBalances.usdcPerps > 0 || spotBalancesLoaded) {
            const totalValue = stablecoinBalances.usdcPerps + totalSpotValue;
            lastKnownAccountValue = totalValue;
            document.getElementById('account-value').textContent = formatCurrency(totalValue);
        }

        // Cache the full balances array for the Spot tab (filtered > $5)
        spotBalancesCache = balances.filter(bal => (parseFloat(bal.value_usd) || 0) > 5);

        return balances;
    } catch (error) {
        console.error('Failed to load spot balances:', error);
        return null;
    }
}

/**
 * Force refresh stablecoin balances (for transfer modal)
 */
async function refreshStablecoinBalances() {
    const walletAddress = typeof walletManager !== 'undefined' && walletManager.address;
    if (!walletAddress) return stablecoinBalances;

    try {
        // Load spot balances
        await loadAndCacheSpotBalances();

        // Also get perps balance from account API
        const accountData = await apiCall('/account');
        if (!accountData.error) {
            stablecoinBalances.usdcPerps = parseFloat(accountData.account_value) || 0;
            stablecoinBalances.usdcPerpsAvail = parseFloat(accountData.withdrawable) || 0;
        }

        return stablecoinBalances;
    } catch (error) {
        console.error('Failed to refresh stablecoin balances:', error);
        return stablecoinBalances;
    }
}

/**
 * Setup transfer modal functionality
 */
function setupTransferModal() {
    const directionSelect = document.getElementById('transfer-direction');
    const amountInput = document.getElementById('transfer-amount');
    const maxBtn = document.getElementById('transfer-max-btn');
    const confirmBtn = document.getElementById('confirm-transfer-btn');
    const availableEl = document.getElementById('transfer-available');

    // Update available balance when direction changes
    // For perps->spot, use the available/withdrawable balance (usdcPerpsAvail)
    const updateAvailable = () => {
        const direction = directionSelect.value;
        const available = direction === 'spotToPerp' ? stablecoinBalances.usdcSpot : stablecoinBalances.usdcPerpsAvail;
        availableEl.textContent = formatCurrency(available);
    };

    if (directionSelect) {
        directionSelect.addEventListener('change', updateAvailable);
    }

    // Fetch fresh balances and update available when modal opens
    const transferModal = document.getElementById('transferModal');
    if (transferModal) {
        transferModal.addEventListener('show.bs.modal', async () => {
            // Show loading state
            availableEl.textContent = 'Loading...';

            // Fetch fresh balances
            await refreshStablecoinBalances();

            // Update the display
            updateAvailable();
        });
    }

    // Max button
    if (maxBtn) {
        maxBtn.addEventListener('click', () => {
            const direction = directionSelect.value;
            const available = direction === 'spotToPerp' ? stablecoinBalances.usdcSpot : stablecoinBalances.usdcPerpsAvail;
            amountInput.value = available.toFixed(2);
        });
    }

    // Confirm transfer
    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            const direction = directionSelect.value;
            const amount = parseFloat(amountInput.value);

            if (!amount || amount <= 0) {
                showToast('Please enter a valid amount', 'warning');
                return;
            }

            const available = direction === 'spotToPerp' ? stablecoinBalances.usdcSpot : stablecoinBalances.usdcPerpsAvail;
            if (amount > available) {
                showToast('Amount exceeds available balance', 'error');
                return;
            }

            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Transferring...';

            try {
                const result = await apiCall('/transfer-usdc', 'POST', {
                    direction,
                    amount
                });

                if (result.success) {
                    showToast(`Successfully transferred ${formatCurrency(amount)} USDC`, 'success');
                    bootstrap.Modal.getInstance(transferModal).hide();
                    amountInput.value = '';
                    // Refresh dashboard to update balances
                    refreshDashboard();
                } else {
                    showToast('Transfer failed: ' + (result.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                showToast('Transfer failed: ' + error.message, 'error');
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = '<i class="bi bi-arrow-left-right me-1"></i>Transfer';
            }
        });
    }
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

// Global positions cache for sorting/filtering
let positionsCache = [];
let currentSortColumn = 'posValue';
let currentSortDirection = 'desc';
let positionsLastUpdate = 0;  // Track last update time for efficient diffing

/**
 * Generate a unique key for a position (used for efficient DOM diffing)
 */
function getPositionKey(pos) {
    return `${pos.coin}-${pos.side}`;
}

/**
 * Create HTML for a single position row
 */
function createPositionRowHtml(pos) {
    const pnlClass = pos.unrealized_pnl >= 0 ? 'text-success' : 'text-danger';
    const sideClass = pos.side === 'long' ? 'badge-long' : 'badge-short';
    const hip3Badge = pos.is_hip3 ? '<span class="badge bg-info ms-1" style="font-size:0.65rem;padding:2px 4px;" title="HIP-3 Builder Perp">HIP-3</span>' : '';
    const positionValue = Math.abs(pos.size) * (pos.mark_price || pos.entry_price || 0);
    const margin = pos.margin_used || 0;

    let fundingDisplay = '--';
    if (pos.funding_rate !== undefined && pos.funding_rate !== null) {
        const annualPct = (pos.funding_rate * 100 * 24 * 365).toFixed(1);
        const rateClass = pos.funding_rate >= 0 ? 'text-success' : 'text-danger';
        fundingDisplay = `<span class="${rateClass}">${annualPct}%</span>`;
    }

    return `
        <tr data-coin="${pos.coin}" data-side="${pos.side}" data-pos-value="${positionValue}" data-pos-key="${getPositionKey(pos)}">
            <td><strong>${pos.coin}</strong>${hip3Badge}</td>
            <td><span class="badge ${sideClass}" style="font-size:0.7rem;">${pos.side.toUpperCase()}</span></td>
            <td>${pos.leverage}x</td>
            <td>${formatCurrency(margin)}</td>
            <td>${formatCurrency(positionValue)}</td>
            <td>${Math.abs(pos.size).toFixed(4)}</td>
            <td>${formatPrice(pos.entry_price)}</td>
            <td>${formatPrice(pos.mark_price)}</td>
            <td>${pos.liquidation_price ? formatPrice(pos.liquidation_price) : '--'}</td>
            <td>${fundingDisplay}</td>
            <td class="${pnlClass}">${formatCurrency(pos.unrealized_pnl)}</td>
            <td>
                <button class="btn btn-outline-danger btn-sm py-0 px-1" onclick="closePosition('${pos.coin}')">
                    <i class="bi bi-x-circle"></i>
                </button>
            </td>
        </tr>
    `;
}

/**
 * Update a single row with new position data (in-place update)
 */
function updatePositionRow(row, pos) {
    const cells = row.cells;
    const pnlClass = pos.unrealized_pnl >= 0 ? 'text-success' : 'text-danger';
    const positionValue = Math.abs(pos.size) * (pos.mark_price || pos.entry_price || 0);
    const margin = pos.margin_used || 0;

    // Update data attributes
    row.dataset.posValue = positionValue;

    // Update only the cells that change frequently (mark price, P&L, margin, position value)
    cells[3].textContent = formatCurrency(margin);  // Margin
    cells[4].textContent = formatCurrency(positionValue);  // Position value
    cells[5].textContent = Math.abs(pos.size).toFixed(4);  // Size
    cells[7].textContent = formatPrice(pos.mark_price);  // Mark price

    // P&L cell with color
    const pnlCell = cells[10];
    pnlCell.textContent = formatCurrency(pos.unrealized_pnl);
    pnlCell.className = pnlClass;

    // Funding rate
    let fundingDisplay = '--';
    if (pos.funding_rate !== undefined && pos.funding_rate !== null) {
        const annualPct = (pos.funding_rate * 100 * 24 * 365).toFixed(1);
        const rateClass = pos.funding_rate >= 0 ? 'text-success' : 'text-danger';
        fundingDisplay = `<span class="${rateClass}">${annualPct}%</span>`;
    }
    cells[9].innerHTML = fundingDisplay;
}

function updatePositionsTable(positions) {
    console.log('[updatePositionsTable] Called with', positions?.length || 0, 'positions');

    // Cache positions for sorting/filtering
    // positions === null means use cached data (for sorting/filtering)
    // positions === [] (empty array) means clear the cache (positions were closed)
    if (positions !== null) {
        positionsCache = positions || [];
        // Update tab count with total positions (not filtered)
        updateTabCount('perps', positionsCache.length);
    }

    const tbody = document.getElementById('positions-table');
    if (!tbody) {
        console.error('[updatePositionsTable] positions-table element not found!');
        return;
    }

    // Apply filter
    const sideFilter = document.getElementById('side-filter');
    let filteredPositions = positionsCache;
    if (sideFilter && sideFilter.value) {
        filteredPositions = positionsCache.filter(pos => pos.side === sideFilter.value);
    }

    if (!filteredPositions || filteredPositions.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="12" class="text-center text-muted py-3">
                    <i class="bi bi-inbox fs-4 d-block mb-1"></i>
                    No open positions
                </td>
            </tr>
        `;
        positionsLastUpdate = Date.now();
        return;
    }

    // Apply sorting
    const sortedPositions = sortPositions(filteredPositions, currentSortColumn, currentSortDirection);

    // Check if we can do an efficient in-place update
    const existingRows = tbody.querySelectorAll('tr[data-pos-key]');
    const existingKeys = new Set([...existingRows].map(r => r.dataset.posKey));
    const newKeys = new Set(sortedPositions.map(getPositionKey));

    // If the set of positions hasn't changed and order is same, do in-place update
    const canUpdateInPlace = existingRows.length === sortedPositions.length &&
        sortedPositions.every((pos, idx) => existingRows[idx]?.dataset.posKey === getPositionKey(pos));

    if (canUpdateInPlace) {
        // Efficient path: update existing rows in place
        console.log('[updatePositionsTable] In-place update for', sortedPositions.length, 'positions');
        sortedPositions.forEach((pos, idx) => {
            updatePositionRow(existingRows[idx], pos);
        });
    } else {
        // Full rebuild needed (positions added/removed/reordered)
        console.log('[updatePositionsTable] Full rebuild for', sortedPositions.length, 'positions');
        tbody.innerHTML = sortedPositions.map(createPositionRowHtml).join('');
    }

    positionsLastUpdate = Date.now();
}

/**
 * Sort positions by column
 */
function sortPositions(positions, column, direction) {
    return [...positions].sort((a, b) => {
        let valA, valB;

        switch (column) {
            case 'coin':
                valA = a.coin || '';
                valB = b.coin || '';
                break;
            case 'side':
                valA = a.side || '';
                valB = b.side || '';
                break;
            case 'leverage':
                valA = a.leverage || 0;
                valB = b.leverage || 0;
                break;
            case 'margin':
                valA = a.margin_used || 0;
                valB = b.margin_used || 0;
                break;
            case 'posValue':
                valA = Math.abs(a.size) * (a.mark_price || a.entry_price || 0);
                valB = Math.abs(b.size) * (b.mark_price || b.entry_price || 0);
                break;
            case 'size':
                valA = Math.abs(a.size) || 0;
                valB = Math.abs(b.size) || 0;
                break;
            case 'entry':
                valA = a.entry_price || 0;
                valB = b.entry_price || 0;
                break;
            case 'mark':
                valA = a.mark_price || 0;
                valB = b.mark_price || 0;
                break;
            case 'liq':
                valA = a.liquidation_price || 0;
                valB = b.liquidation_price || 0;
                break;
            case 'funding':
                valA = a.funding_rate || 0;
                valB = b.funding_rate || 0;
                break;
            case 'pnl':
                valA = a.unrealized_pnl || 0;
                valB = b.unrealized_pnl || 0;
                break;
            default:
                return 0;
        }

        // Handle string vs number comparison
        if (typeof valA === 'string' && typeof valB === 'string') {
            const cmp = valA.localeCompare(valB);
            return direction === 'asc' ? cmp : -cmp;
        } else {
            const cmp = valA - valB;
            return direction === 'asc' ? cmp : -cmp;
        }
    });
}

/**
 * Setup sortable table headers for Perps table
 */
function setupPerpsTableSorting() {
    const headers = document.querySelectorAll('#perps-table-sortable th.sortable');

    headers.forEach(header => {
        header.addEventListener('click', function() {
            const column = this.dataset.sort;
            const type = this.dataset.type;

            // Toggle direction if same column, otherwise default based on type
            if (currentSortColumn === column) {
                currentSortDirection = currentSortDirection === 'desc' ? 'asc' : 'desc';
            } else {
                // Numbers default to desc, text defaults to asc
                currentSortDirection = type === 'number' ? 'desc' : 'asc';
            }
            currentSortColumn = column;

            // Update header classes
            headers.forEach(h => {
                h.classList.remove('active', 'asc', 'desc');
                const icon = h.querySelector('.sort-icon');
                if (icon) icon.className = 'bi bi-arrow-down-up sort-icon';
            });

            this.classList.add('active', currentSortDirection);
            const icon = this.querySelector('.sort-icon');
            if (icon) {
                icon.className = `bi bi-arrow-${currentSortDirection === 'desc' ? 'down' : 'up'} sort-icon`;
            }

            // Re-render table with new sort
            updatePositionsTable(null);  // Use cached positions
        });
    });

    // Setup side filter
    const sideFilter = document.getElementById('side-filter');
    if (sideFilter) {
        sideFilter.addEventListener('change', function() {
            updatePositionsTable(null);  // Use cached positions with filter
        });
    }
}

function updatePrices(prices) {
    // Store prices in global cache
    Object.assign(livePrices, prices);

    for (const [coin, price] of Object.entries(prices)) {
        const el = document.getElementById('price-' + coin);
        if (el) el.textContent = formatPrice(price);
    }

    // Update Quick Trade dropdown with prices
    updateDropdownPrices();
}

function updateActivityList(logs) {
    const container = document.getElementById('activity-list');
    if (!container) return;  // Activity list not present on this page

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

// Category definitions for batch trading (dynamically populated from coin configs)
let categoryCoins = {
    'CAT:L1s': [],
    'CAT:APPS': [],
    'CAT:MEMES': []
};

// Category display names
const categoryDisplayNames = {
    'L1s': 'L1s',
    'APPS': 'APPS',
    'MEMES': 'MEMES',
    'HIP-3 Perps': 'HIP-3 Perps'
};

// localStorage cache key for Quick Trade coins (STATIC - only updates on explicit refresh)
const QUICK_TRADE_CACHE_KEY = 'mak_quick_trade_coins';

/**
 * Save coins to Quick Trade cache (ONLY called from Refresh Leverage Tables)
 */
function saveQuickTradeCache(coins) {
    try {
        localStorage.setItem(QUICK_TRADE_CACHE_KEY, JSON.stringify(coins));
        console.log('[QuickTrade] Saved', coins.length, 'coins to static cache');
    } catch (e) {
        console.warn('[QuickTrade] Failed to save cache:', e);
    }
}

/**
 * Load coins from Quick Trade cache
 * Returns null if no cache exists
 */
function loadQuickTradeCache() {
    try {
        const cached = localStorage.getItem(QUICK_TRADE_CACHE_KEY);
        if (cached) {
            const coins = JSON.parse(cached);
            console.log('[QuickTrade] Loaded', coins.length, 'coins from static cache');
            return coins;
        }
    } catch (e) {
        console.warn('[QuickTrade] Failed to load cache:', e);
    }
    return null;
}

/**
 * Force refresh Quick Trade cache from database
 * ONLY called when user clicks "Refresh Leverage Tables"
 */
async function refreshQuickTradeCache() {
    try {
        const data = await apiCall('/coins');
        if (data.coins && data.coins.length > 0) {
            saveQuickTradeCache(data.coins);
            processCoinData(data.coins);
            console.log('[QuickTrade] Cache refreshed with', data.coins.length, 'coins');
            return true;
        }
    } catch (error) {
        console.error('[QuickTrade] Failed to refresh cache:', error);
    }
    return false;
}

function isCategory(value) {
    return value && value.startsWith('CAT:');
}

function getMaxLeverage(coin) {
    // Get max leverage from coin config (stored in database)
    if (coinConfigsCache[coin] && coinConfigsCache[coin].hl_max_leverage) {
        return coinConfigsCache[coin].hl_max_leverage;
    }
    return 50;  // Default max leverage
}

/**
 * Process coins data and populate caches/dropdown
 */
function processCoinData(coins) {
    // Clear and rebuild caches
    coinConfigsCache = {};
    categoryCoins = {
        'CAT:L1s': [],
        'CAT:APPS': [],
        'CAT:MEMES': [],
        'CAT:HIP-3 Perps': []
    };

    // Populate caches
    coins.forEach(coin => {
        coinConfigsCache[coin.coin] = coin;
        // Build category lists for batch trading
        const category = coin.category || 'L1s';
        const catKey = 'CAT:' + category;
        if (categoryCoins[catKey]) {
            categoryCoins[catKey].push(coin.coin);
        } else {
            // Handle any new categories dynamically
            categoryCoins[catKey] = [coin.coin];
        }
    });

    // Store full coin list for filtering
    window.allCoinsData = coins;

    // Dynamically populate the Quick Trade dropdown
    populateQuickTradeDropdown(coins);

    // Setup category filter buttons
    setupCategoryFilters();

    // Populate form with default coin (first one selected)
    const coinSelect = document.getElementById('trade-coin');
    if (coinSelect && coinSelect.value && !isCategory(coinSelect.value)) {
        populateQuickTradeForm(coinSelect.value);
    }
}

/**
 * Load coin configs for Quick Trade dropdown
 * Uses STATIC localStorage cache - ONLY updates when user clicks "Refresh Leverage Tables"
 * Note: Dropdown is pre-populated by inline script in dashboard.html for INSTANT display
 */
async function loadCoinConfigsForQuickTrade() {
    // Try to load from static cache first
    const cachedCoins = loadQuickTradeCache();
    if (cachedCoins && cachedCoins.length > 0) {
        // Cache exists - the dropdown was already populated by inline script
        // Just setup the internal data structures and event handlers
        processCoinDataWithoutRepopulate(cachedCoins);
        setupCategoryFilterHandlers();
        return;
    }

    // No cache exists yet - fetch once and cache permanently
    // This only happens on first visit or after clearing browser data
    console.log('[QuickTrade] No cache found, fetching initial coin list...');
    try {
        const data = await apiCall('/coins');
        if (data.coins && data.coins.length > 0) {
            saveQuickTradeCache(data.coins);
            processCoinData(data.coins);  // This will populate dropdown since cache was empty
        }
    } catch (error) {
        console.error('[QuickTrade] Failed to load initial coin configs:', error);
    }
}

/**
 * Process coin data WITHOUT re-populating dropdown (for when inline script already did it)
 */
function processCoinDataWithoutRepopulate(coins) {
    // Clear and rebuild caches
    coinConfigsCache = {};
    categoryCoins = {
        'CAT:L1s': [],
        'CAT:APPS': [],
        'CAT:MEMES': [],
        'CAT:HIP-3 Perps': []
    };

    // Populate caches
    coins.forEach(coin => {
        coinConfigsCache[coin.coin] = coin;
        const category = coin.category || 'L1s';
        const catKey = 'CAT:' + category;
        if (categoryCoins[catKey]) {
            categoryCoins[catKey].push(coin.coin);
        } else {
            categoryCoins[catKey] = [coin.coin];
        }
    });

    // Store full coin list for filtering
    window.allCoinsData = coins;

    // DON'T repopulate dropdown - inline script already did it
    // Just populate form with first selected coin
    const coinSelect = document.getElementById('trade-coin');
    if (coinSelect && coinSelect.value && !isCategory(coinSelect.value)) {
        populateQuickTradeForm(coinSelect.value);
    }
}

/**
 * Setup click handlers for category filter buttons (pre-rendered by inline script)
 */
function setupCategoryFilterHandlers() {
    const filterContainer = document.getElementById('coin-category-filters');
    if (!filterContainer) return;

    filterContainer.querySelectorAll('.category-filter-btn').forEach(btn => {
        // Remove existing handlers to avoid duplicates
        btn.replaceWith(btn.cloneNode(true));
    });

    // Re-query and add handlers
    filterContainer.querySelectorAll('.category-filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            // Update active state
            filterContainer.querySelectorAll('.category-filter-btn').forEach(b => {
                b.classList.remove('active', 'btn-primary');
                b.classList.add('btn-outline-secondary');
            });
            this.classList.add('active', 'btn-primary');
            this.classList.remove('btn-outline-secondary');

            // Filter dropdown
            const category = this.dataset.category || null;
            if (window.allCoinsData) {
                populateQuickTradeDropdown(window.allCoinsData, category);
            }
        });
    });
}

/**
 * Dynamically populate the Quick Trade custom dropdown from coin configs
 * @param {Array} coins - Array of coin objects to display
 * @param {string} filterCategory - Optional category to filter by (null = show all)
 */
function populateQuickTradeDropdown(coins, filterCategory = null) {
    const dropdownMenu = document.getElementById('coin-dropdown-menu');
    const hiddenInput = document.getElementById('trade-coin');
    if (!dropdownMenu) return;

    // Category order for display
    const categoryOrder = ['L1s', 'APPS', 'MEMES', 'HIP-3 Perps'];

    // Group coins by category
    const groups = {};
    categoryOrder.forEach(cat => groups[cat] = []);

    coins.forEach(coin => {
        const category = coin.category || 'L1s';
        // If filtering, only include coins from the selected category
        if (filterCategory && category !== filterCategory) return;

        if (groups[category]) {
            groups[category].push(coin.coin);
        } else {
            groups[category] = [coin.coin];
        }
    });

    // Build custom dropdown HTML with two columns
    let html = '';
    let firstCoin = null;

    // Add coin groups in order
    for (const category of categoryOrder) {
        const coinList = groups[category];
        if (coinList && coinList.length > 0) {
            html += `<div class="coin-dropdown-category" data-category="${category}">${categoryDisplayNames[category] || category}</div>`;
            coinList.forEach(coinName => {
                if (!firstCoin) firstCoin = coinName;
                const price = livePrices[coinName] ? formatPrice(livePrices[coinName]) : '--';
                const selectedClass = (hiddenInput && hiddenInput.value === coinName) ? ' selected' : '';
                html += `<div class="coin-dropdown-item${selectedClass}" data-coin="${coinName}" data-category="${category}">`;
                html += `<span class="item-coin">${coinName}</span>`;
                html += `<span class="item-price">${price}</span>`;
                html += '</div>';
            });
        }
    }

    dropdownMenu.innerHTML = html;

    // If no coin is selected yet, select the first one
    if (hiddenInput && !hiddenInput.value && firstCoin) {
        hiddenInput.value = firstCoin;
        document.getElementById('selected-coin-name').textContent = firstCoin;
        if (livePrices[firstCoin]) {
            document.getElementById('selected-coin-price').textContent = formatPrice(livePrices[firstCoin]);
        }
        const firstItem = dropdownMenu.querySelector('.coin-dropdown-item');
        if (firstItem) firstItem.classList.add('selected');
        populateQuickTradeForm(firstCoin);
    }
}

/**
 * Setup category filter buttons for Quick Trade dropdown
 * Only creates buttons if they don't exist (inline script may have already created them)
 */
function setupCategoryFilters() {
    const filterContainer = document.getElementById('coin-category-filters');
    if (!filterContainer) return;

    // Only create buttons if they don't exist yet
    if (!filterContainer.querySelector('.category-filter-btn')) {
        const categories = ['All', 'L1s', 'APPS', 'MEMES', 'HIP-3 Perps'];

        let html = '';
        categories.forEach((cat, idx) => {
            const isActive = idx === 0 ? 'active' : '';
            const btnClass = idx === 0 ? 'btn-primary' : 'btn-outline-secondary';
            html += `<button type="button" class="btn ${btnClass} btn-sm me-1 mb-1 category-filter-btn ${isActive}"
                             data-category="${cat === 'All' ? '' : cat}">${cat}</button>`;
        });

        filterContainer.innerHTML = html;
    }

    // Attach click handlers (works for both pre-rendered and newly created buttons)
    setupCategoryFilterHandlers();
}

/**
 * Filter Quick Trade dropdown by category
 */
function filterCoinsByCategory(category) {
    if (window.allCoinsData) {
        populateQuickTradeDropdown(window.allCoinsData, category || null);
    }
}

/**
 * Handle order type change - show/hide appropriate fields
 */
function handleOrderTypeChange(orderType) {
    // Hide all order type specific fields
    const fieldContainers = ['market-order-fields', 'limit-order-fields', 'twap-order-fields', 'scale-order-fields'];
    fieldContainers.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    // Show the selected order type fields
    const selectedFields = document.getElementById(orderType + '-order-fields');
    if (selectedFields) {
        selectedFields.style.display = 'block';
    }

    // Update mid price display for limit orders
    if (orderType === 'limit') {
        updateLimitMidPrice();
    }

    // Update button text based on order type
    const buyBtn = document.getElementById('buy-btn');
    const sellBtn = document.getElementById('sell-btn');

    if (buyBtn && sellBtn) {
        switch (orderType) {
            case 'limit':
                buyBtn.innerHTML = '<i class="bi bi-arrow-up-circle me-1"></i>Limit Long';
                sellBtn.innerHTML = '<i class="bi bi-arrow-down-circle me-1"></i>Limit Short';
                break;
            case 'twap':
                buyBtn.innerHTML = '<i class="bi bi-arrow-up-circle me-1"></i>TWAP Long';
                sellBtn.innerHTML = '<i class="bi bi-arrow-down-circle me-1"></i>TWAP Short';
                break;
            case 'scale':
                buyBtn.innerHTML = '<i class="bi bi-arrow-up-circle me-1"></i>Scale Long';
                sellBtn.innerHTML = '<i class="bi bi-arrow-down-circle me-1"></i>Scale Short';
                break;
            default: // market
                buyBtn.innerHTML = '<i class="bi bi-arrow-up-circle me-1"></i>Long / Buy';
                sellBtn.innerHTML = '<i class="bi bi-arrow-down-circle me-1"></i>Short / Sell';
        }
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

    // Update mid price display for limit orders
    updateLimitMidPrice();
}

/**
 * Update the mid price display for limit order field
 */
function updateLimitMidPrice() {
    const midPriceEl = document.getElementById('limit-mid-price');
    if (!midPriceEl) return;

    const selectedCoin = document.getElementById('trade-coin')?.value;
    if (!selectedCoin || isCategory(selectedCoin)) {
        midPriceEl.textContent = 'Mid: --';
        return;
    }

    const price = livePrices[selectedCoin];
    if (price) {
        midPriceEl.textContent = `Mid: ${formatPrice(price)}`;
    } else {
        midPriceEl.textContent = 'Mid: --';
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

// Cache for open orders (for Orders tab display)
let openOrdersCache = [];

/**
 * Setup tab switching for Perps/Spot/Open Orders
 */
function setupPositionTabs() {
    const tabs = document.querySelectorAll('.positions-tab');
    const perpsControls = document.getElementById('perps-controls');

    tabs.forEach(tab => {
        tab.addEventListener('click', function() {
            // Remove active class from all tabs
            tabs.forEach(t => t.classList.remove('active'));
            // Add active class to clicked tab
            this.classList.add('active');

            // Hide all tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.style.display = 'none';
            });

            // Show selected tab content
            const tabName = this.dataset.tab;
            const tabContent = document.getElementById('tab-' + tabName);
            if (tabContent) {
                tabContent.style.display = 'block';
            }

            // Show/hide perps controls (filter and Close All button)
            if (perpsControls) {
                perpsControls.style.display = tabName === 'perps' ? 'block' : 'none';
            }

            // Load/refresh data for the selected tab
            if (tabName === 'perps') {
                // Re-render positions from cache
                updatePositionsTable(null);
            } else if (tabName === 'spot') {
                loadSpotBalances();
            } else if (tabName === 'orders') {
                loadOpenOrders();
            } else if (tabName === 'twaps') {
                loadTwapOrders();
            }
        });
    });
}

/**
 * Render spot balances to the Spot tab table
 * Uses cached data for instant display, refreshes if cache is empty
 */
async function loadSpotBalances() {
    const tbody = document.getElementById('spot-table');
    if (!tbody) return;

    // Get wallet address from walletManager
    const walletAddress = typeof walletManager !== 'undefined' && walletManager.address;
    if (!walletAddress) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="text-center text-muted py-3">
                    <i class="bi bi-wallet2 fs-4 d-block mb-1"></i>
                    Connect wallet to view spot balances
                </td>
            </tr>
        `;
        return;
    }

    // If cache is empty, load from API first
    if (!spotBalancesLoaded || spotBalancesCache.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="text-center text-muted py-3">
                    <i class="bi bi-hourglass-split fs-4 d-block mb-1"></i>
                    Loading...
                </td>
            </tr>
        `;
        await loadAndCacheSpotBalances();
    }

    // Use cached data (already filtered to > $5)
    const balances = spotBalancesCache;

    if (!balances || balances.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="text-center text-muted py-3">
                    <i class="bi bi-inbox fs-4 d-block mb-1"></i>
                    No spot balances (> $5)
                </td>
            </tr>
        `;
        return;
    }

    // Sort by value descending
    const sortedBalances = [...balances].sort((a, b) =>
        (parseFloat(b.value_usd) || 0) - (parseFloat(a.value_usd) || 0)
    );

    tbody.innerHTML = sortedBalances.map(bal => `
        <tr>
            <td><strong>${bal.token}</strong></td>
            <td>${parseFloat(bal.total).toFixed(4)}</td>
            <td>${formatCurrency(bal.value_usd)}</td>
        </tr>
    `).join('');
}

/**
 * Load open orders from API
 */
async function loadOpenOrders() {
    const tbody = document.getElementById('orders-table');
    if (!tbody) return;

    // Get wallet address from walletManager
    const walletAddress = typeof walletManager !== 'undefined' && walletManager.address;
    if (!walletAddress) {
        updateTabCount('orders', 0);
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="text-center text-muted py-3">
                    <i class="bi bi-wallet2 fs-4 d-block mb-1"></i>
                    Connect wallet to view open orders
                </td>
            </tr>
        `;
        return;
    }

    try {
        const data = await apiCall(`/open-orders?address=${walletAddress}`);
        if (data.error) {
            updateTabCount('orders', 0);
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-center text-muted py-3">
                        <i class="bi bi-exclamation-circle fs-4 d-block mb-1"></i>
                        ${data.error}
                    </td>
                </tr>
            `;
            return;
        }

        const orders = data.orders || [];
        updateTabCount('orders', orders.length);

        if (orders.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-center text-muted py-3">
                        <i class="bi bi-inbox fs-4 d-block mb-1"></i>
                        No open orders
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = orders.map(order => {
            // Hyperliquid returns 'B' for buy, 'A' for sell (ask)
            const sideClass = order.side === 'B' ? 'badge-long' : 'badge-short';
            const sideText = order.side === 'B' ? 'BUY' : 'SELL';
            // Field names from Hyperliquid: sz (size), limitPx (price), orderType
            const size = parseFloat(order.sz || order.size || 0);
            const price = parseFloat(order.limitPx || order.price || 0);
            const orderValue = size * price;
            const origSz = parseFloat(order.origSz || order.sz || size);
            const filledPct = origSz > 0 ? (((origSz - size) / origSz) * 100).toFixed(0) : '0';

            return `
                <tr>
                    <td><strong>${order.coin}</strong></td>
                    <td><span class="badge ${sideClass}" style="font-size:0.7rem;">${sideText}</span></td>
                    <td>${order.orderType || 'Limit'}</td>
                    <td>${size.toFixed(4)}</td>
                    <td>${formatPrice(price)}</td>
                    <td>${formatCurrency(orderValue)}</td>
                    <td>${filledPct}%</td>
                    <td>
                        <button class="btn btn-outline-secondary btn-sm py-0 px-2 me-1" onclick="openModifyOrderModal(${order.oid}, '${order.coin}', ${size}, ${price}, '${order.side}')" title="Modify Order">
                            <i class="bi bi-pencil"></i>
                        </button>
                        <button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="cancelOrder(${order.oid}, '${order.coin}')" title="Cancel Order">
                            <i class="bi bi-x"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load open orders:', error);
        updateTabCount('orders', 0);
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="text-center text-muted py-3">
                    <i class="bi bi-exclamation-circle fs-4 d-block mb-1"></i>
                    Failed to load orders
                </td>
            </tr>
        `;
    }
}

/**
 * Cancel an open order
 */
async function cancelOrder(oid, coin) {
    if (!confirm(`Cancel order for ${coin}?`)) return;

    try {
        const result = await apiCall('/cancel-order', 'POST', { oid, coin });
        if (result.success) {
            showToast(`Order cancelled for ${coin}`, 'success');
            loadOpenOrders();
        } else {
            showToast('Failed to cancel order: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to cancel order', 'error');
    }
}

/**
 * Open the modify order modal with order details
 */
function openModifyOrderModal(oid, coin, size, price, side) {
    // Populate modal fields
    document.getElementById('modify-order-oid').value = oid;
    document.getElementById('modify-order-coin-value').value = coin;
    document.getElementById('modify-order-coin').textContent = coin;
    document.getElementById('modify-order-side').textContent = side === 'B' ? 'BUY (Long)' : 'SELL (Short)';
    document.getElementById('modify-order-side').className = side === 'B' ? 'text-success' : 'text-danger';
    document.getElementById('modify-order-current-size').textContent = size.toFixed(4);
    document.getElementById('modify-order-current-price').textContent = formatPrice(price);

    // Pre-fill new price with current price
    document.getElementById('modify-order-new-price').value = price;
    document.getElementById('modify-order-new-size').value = '';

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('modifyOrderModal'));
    modal.show();
}

/**
 * Submit the modify order request
 */
async function submitModifyOrder() {
    const oid = parseInt(document.getElementById('modify-order-oid').value);
    const coin = document.getElementById('modify-order-coin-value').value;
    const newPrice = parseFloat(document.getElementById('modify-order-new-price').value);
    const newSizeInput = document.getElementById('modify-order-new-size').value;
    const newSize = newSizeInput ? parseFloat(newSizeInput) : null;

    if (!oid || !coin || !newPrice || newPrice <= 0) {
        showToast('Please enter a valid new price', 'warning');
        return;
    }

    if (newSize !== null && newSize <= 0) {
        showToast('New size must be greater than 0', 'warning');
        return;
    }

    try {
        const payload = { oid, coin, new_price: newPrice };
        if (newSize !== null) {
            payload.new_size = newSize;
        }

        const result = await apiCall('/modify-order', 'POST', payload);

        if (result.success) {
            showToast(`Order modified successfully for ${coin}`, 'success');
            // Close modal
            const modal = bootstrap.Modal.getInstance(document.getElementById('modifyOrderModal'));
            if (modal) modal.hide();
            // Refresh orders
            loadOpenOrders();
        } else {
            showToast('Failed to modify order: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to modify order', 'error');
    }
}

/**
 * Load TWAP orders for the TWAPs tab
 */
async function loadTwapOrders() {
    const tbody = document.getElementById('twaps-table');
    if (!tbody) return;

    // Get wallet address from walletManager
    const walletAddress = typeof walletManager !== 'undefined' && walletManager.address;
    if (!walletAddress) {
        updateTabCount('twaps', 0);
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center text-muted py-3">
                    <i class="bi bi-wallet2 fs-4 d-block mb-1"></i>
                    Connect wallet to view TWAP orders
                </td>
            </tr>
        `;
        return;
    }

    try {
        const data = await apiCall(`/twap-history?address=${walletAddress}`);
        if (!data.success) {
            updateTabCount('twaps', 0);
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-muted py-3">
                        <i class="bi bi-exclamation-circle fs-4 d-block mb-1"></i>
                        ${data.error || 'Failed to load TWAP orders'}
                    </td>
                </tr>
            `;
            return;
        }

        const twaps = data.twaps || [];

        // Debug: Log raw TWAP data to understand API response structure
        console.log('[loadTwapOrders] Raw TWAP data:', JSON.stringify(twaps, null, 2));

        // Filter to only show active/running TWAPs
        // Note: Hyperliquid API uses Rust-style enum encoding where status is an object
        // e.g., { status: { running: { twapId: 123 } } } not { status: "running" }
        const activeTwaps = twaps.filter(twap => {
            const state = twap.state || {};
            const status = state.status || {};
            console.log('[loadTwapOrders] TWAP state:', twap.state, 'status:', status);
            // Check if status object has 'running' or 'activated' key (Rust enum style)
            return typeof status === 'object' && ('running' in status || 'activated' in status);
        });

        updateTabCount('twaps', activeTwaps.length);

        if (activeTwaps.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-muted py-3">
                        <i class="bi bi-inbox fs-4 d-block mb-1"></i>
                        No active TWAP orders
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = activeTwaps.map(twap => {
            const state = twap.state || {};
            const status = state.status || {};
            // Get the active status data (running or activated)
            const statusData = status.running || status.activated || {};

            const coin = twap.coin || state.coin || 'Unknown';
            const isBuy = twap.is_buy !== undefined ? twap.is_buy : state.isBuy;
            const sideClass = isBuy ? 'badge-long' : 'badge-short';
            const sideText = isBuy ? 'BUY' : 'SELL';

            // Size and executed size
            const totalSize = parseFloat(twap.sz || state.sz || 0);
            const executedSize = parseFloat(twap.executed_sz || state.executedSz || 0);

            // Average price
            const avgPrice = parseFloat(twap.avg_px || state.avgPx || 0);

            // Running time - calculate from timestamps if available
            const durationMinutes = parseInt(twap.minutes || state.minutes || 0);
            let runningTime = '--';
            let totalTime = `${durationMinutes}m`;

            if (twap.start_time || state.startTime) {
                const startTime = new Date(twap.start_time || state.startTime);
                const now = new Date();
                const elapsedMs = now - startTime;
                const elapsedMinutes = Math.floor(elapsedMs / 60000);
                runningTime = `${elapsedMinutes}m`;
            }

            // twapId can be at multiple locations depending on API response
            const twapId = twap.twap_id || state.twapId || statusData.twapId || twap.oid;

            return `
                <tr>
                    <td><strong>${coin}</strong></td>
                    <td><span class="badge ${sideClass}" style="font-size:0.7rem;">${sideText}</span></td>
                    <td>${totalSize.toFixed(4)}</td>
                    <td>${executedSize.toFixed(4)}</td>
                    <td>${avgPrice > 0 ? formatPrice(avgPrice) : '--'}</td>
                    <td>${runningTime} / ${totalTime}</td>
                    <td>
                        <button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="cancelTwapOrder(${twapId}, '${coin}')" title="Cancel TWAP">
                            <i class="bi bi-x"></i> Cancel
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load TWAP orders:', error);
        updateTabCount('twaps', 0);
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center text-muted py-3">
                    <i class="bi bi-exclamation-circle fs-4 d-block mb-1"></i>
                    Failed to load TWAP orders
                </td>
            </tr>
        `;
    }
}

/**
 * Cancel a TWAP order
 */
async function cancelTwapOrder(twapId, coin) {
    if (!confirm(`Cancel TWAP order for ${coin}?`)) return;

    try {
        const result = await apiCall('/twap-cancel', 'POST', { twap_id: twapId, coin });
        if (result.success) {
            showToast(`TWAP order cancelled for ${coin}`, 'success');
            loadTwapOrders();
        } else {
            showToast('Failed to cancel TWAP: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to cancel TWAP order', 'error');
    }
}

/**
 * Setup custom coin dropdown with two columns (Coin | Price)
 */
function setupCustomCoinDropdown() {
    const trigger = document.getElementById('coin-dropdown-trigger');
    const menu = document.getElementById('coin-dropdown-menu');
    const hiddenInput = document.getElementById('trade-coin');

    if (!trigger || !menu) return;

    // Toggle dropdown on trigger click
    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        const isOpen = menu.classList.contains('show');
        if (isOpen) {
            closeDropdown();
        } else {
            openDropdown();
        }
    });

    // Handle keyboard navigation
    trigger.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger.click();
        } else if (e.key === 'Escape') {
            closeDropdown();
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (!trigger.contains(e.target) && !menu.contains(e.target)) {
            closeDropdown();
        }
    });

    // Setup item click handlers (using event delegation)
    menu.addEventListener('click', function(e) {
        const item = e.target.closest('.coin-dropdown-item');
        if (item) {
            selectCoin(item.dataset.coin);
            closeDropdown();
        }
    });

    function openDropdown() {
        menu.classList.add('show');
        trigger.classList.add('open');
    }

    function closeDropdown() {
        menu.classList.remove('show');
        trigger.classList.remove('open');
    }

    function selectCoin(coin) {
        if (!coin) return;

        // Update hidden input
        if (hiddenInput) {
            hiddenInput.value = coin;
        }

        // Update trigger display
        const nameEl = document.getElementById('selected-coin-name');
        const priceEl = document.getElementById('selected-coin-price');
        if (nameEl) nameEl.textContent = coin;
        if (priceEl && livePrices[coin]) {
            priceEl.textContent = formatPrice(livePrices[coin]);
        } else if (priceEl) {
            priceEl.textContent = '';
        }

        // Update selected state in menu
        menu.querySelectorAll('.coin-dropdown-item').forEach(item => {
            item.classList.remove('selected');
            if (item.dataset.coin === coin) {
                item.classList.add('selected');
            }
        });

        // Populate form with coin defaults
        populateQuickTradeForm(coin);
    }
}

function setupDashboardEvents() {
    // Setup positions/spot/orders tab switching
    setupPositionTabs();

    // Setup sortable table headers for Perps
    setupPerpsTableSorting();

    // Setup transfer modal
    setupTransferModal();

    // Leverage slider
    const leverageRange = document.getElementById('trade-leverage-range');
    const leverageDisplay = document.getElementById('leverage-display');
    if (leverageRange) {
        leverageRange.addEventListener('input', function() {
            leverageDisplay.textContent = this.value + 'x';
        });
    }

    // Custom coin dropdown - setup open/close and selection
    setupCustomCoinDropdown();

    // Order type dropdown - show/hide appropriate fields
    const orderTypeSelect = document.getElementById('order-type');
    if (orderTypeSelect) {
        orderTypeSelect.addEventListener('change', function() {
            handleOrderTypeChange(this.value);
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

/**
 * Validate trade form inputs with detailed feedback
 * @returns {object|null} - Validated data or null if validation failed
 */
function validateTradeForm() {
    const selection = document.getElementById('trade-coin').value;
    const collateralInput = document.getElementById('trade-collateral');
    const leverageInput = document.getElementById('trade-leverage-range');
    const orderType = document.getElementById('order-type')?.value || 'market';

    // Clear previous validation states
    collateralInput.classList.remove('is-invalid');

    // Validate coin selection
    if (!selection) {
        showToast('Please select a coin to trade', 'warning');
        return null;
    }

    // Validate collateral
    const collateral = parseFloat(collateralInput.value);
    if (!collateral || isNaN(collateral)) {
        showToast('Please enter a valid collateral amount', 'warning');
        collateralInput.classList.add('is-invalid');
        collateralInput.focus();
        return null;
    }

    if (collateral <= 0) {
        showToast('Collateral must be a positive amount', 'warning');
        collateralInput.classList.add('is-invalid');
        collateralInput.focus();
        return null;
    }

    if (collateral < 1) {
        showToast('Minimum collateral is $1', 'warning');
        collateralInput.classList.add('is-invalid');
        collateralInput.focus();
        return null;
    }

    if (collateral > 100000) {
        showToast('Maximum collateral is $100,000 per trade', 'warning');
        collateralInput.classList.add('is-invalid');
        collateralInput.focus();
        return null;
    }

    // Validate leverage
    const leverage = parseInt(leverageInput.value);
    if (!leverage || isNaN(leverage) || leverage < 1) {
        showToast('Please select a valid leverage', 'warning');
        return null;
    }

    // Check leverage against coin's max leverage
    const maxLeverage = getMaxLeverage(selection);
    if (leverage > maxLeverage) {
        showToast(`Leverage ${leverage}x exceeds maximum ${maxLeverage}x for ${selection}`, 'error');
        return null;
    }

    return { selection, collateral, leverage, orderType };
}

async function executeTrade(action) {
    // Validate action parameter
    if (!['buy', 'sell'].includes(action.toLowerCase())) {
        showToast('Invalid trade action', 'error');
        return;
    }

    // Validate form inputs
    const validated = validateTradeForm();
    if (!validated) return;

    const { selection, collateral, leverage, orderType } = validated;

    // Check if this is a category trade (only for market orders)
    if (isCategory(selection)) {
        if (orderType !== 'market') {
            showToast('Category trades only support market orders', 'warning');
            return;
        }
        const stopLoss = parseFloat(document.getElementById('trade-sl').value) || null;
        const tp1Pct = parseFloat(document.getElementById('trade-tp1').value) || null;
        const tp1SizePct = parseFloat(document.getElementById('trade-tp1-size').value) || null;
        const tp2Pct = parseFloat(document.getElementById('trade-tp2').value) || null;
        const tp2SizePct = parseFloat(document.getElementById('trade-tp2-size').value) || null;
        await executeCategoryTrade(selection, action, collateral, leverage, stopLoss, tp1Pct, tp1SizePct, tp2Pct, tp2SizePct);
        return;
    }

    // Handle based on order type
    if (orderType === 'limit') {
        await executeLimitOrder(selection, action, collateral, leverage);
    } else if (orderType === 'twap') {
        await executeTwapOrder(selection, action, collateral, leverage);
    } else if (orderType === 'scale') {
        await executeScaleOrder(selection, action, collateral, leverage);
    } else {
        // Market order
        await executeMarketOrder(selection, action, collateral, leverage);
    }
}

/**
 * Execute a market order
 */
async function executeMarketOrder(coin, action, collateral, leverage) {
    const stopLoss = parseFloat(document.getElementById('trade-sl').value) || null;
    const tp1Pct = parseFloat(document.getElementById('trade-tp1').value) || null;
    const tp1SizePct = parseFloat(document.getElementById('trade-tp1-size').value) || null;
    const tp2Pct = parseFloat(document.getElementById('trade-tp2').value) || null;
    const tp2SizePct = parseFloat(document.getElementById('trade-tp2-size').value) || null;

    // Get the button for loading state
    const button = document.getElementById(action === 'buy' ? 'buy-btn' : 'sell-btn');

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
        }, {
            loadingButton: button,
            loadingText: 'Executing...'
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

/**
 * Execute a limit order with price validation
 */
async function executeLimitOrder(coin, action, collateral, leverage) {
    const limitPrice = parseFloat(document.getElementById('trade-limit-price').value);

    if (!limitPrice || limitPrice <= 0) {
        showToast('Please enter a valid limit price', 'warning');
        return;
    }

    // Get current mid price for validation
    const midPrice = livePrices[coin];
    if (!midPrice) {
        showToast('Could not get current price. Please try again.', 'warning');
        return;
    }

    // Validate limit price against mid price
    // Long: limit price must be BELOW mid (buying at a discount)
    // Short: limit price must be ABOVE mid (selling at a premium)
    const isLong = action === 'buy';

    if (isLong && limitPrice >= midPrice) {
        showToast(`Long limit price must be below mid price (${formatPrice(midPrice)}). Your order would execute immediately at market.`, 'error');
        return;
    }

    if (!isLong && limitPrice <= midPrice) {
        showToast(`Short limit price must be above mid price (${formatPrice(midPrice)}). Your order would execute immediately at market.`, 'error');
        return;
    }

    // Get the button for loading state
    const button = document.getElementById(action === 'buy' ? 'buy-btn' : 'sell-btn');

    try {
        const result = await apiCall('/limit-order', 'POST', {
            coin,
            action,
            leverage,
            collateral_usd: collateral,
            limit_price: limitPrice
        }, {
            loadingButton: button,
            loadingText: 'Placing...'
        });

        if (result.success) {
            if (result.filled) {
                showToast(`Limit order filled immediately for ${coin}`, 'success');
            } else {
                showToast(`Limit order placed for ${coin} at ${formatPrice(limitPrice)}`, 'success');
            }
            refreshDashboard();
            loadOpenOrders();
        } else {
            showToast('Limit order failed: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Limit order execution failed', 'error');
    }
}

/**
 * Execute a TWAP order
 */
async function executeTwapOrder(coin, action, collateral, leverage) {
    const hours = parseInt(document.getElementById('trade-twap-hours')?.value) || 0;
    const minutes = parseInt(document.getElementById('trade-twap-minutes')?.value) || 30;
    const randomize = document.getElementById('trade-twap-randomize')?.checked || false;

    // Calculate total duration
    const totalMinutes = (hours * 60) + minutes;
    if (totalMinutes < 5) {
        showToast('TWAP duration must be at least 5 minutes', 'warning');
        return;
    }

    // Get the button for loading state
    const button = document.getElementById(action === 'buy' ? 'buy-btn' : 'sell-btn');

    try {
        const result = await apiCall('/twap-order', 'POST', {
            coin,
            action,
            leverage,
            collateral_usd: collateral,
            hours,
            minutes,
            randomize
        }, {
            loadingButton: button,
            loadingText: 'Starting TWAP...'
        });

        if (result.success) {
            const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            showToast(`TWAP order started for ${coin} over ${durationStr}`, 'success');
            refreshDashboard();
            loadTwapOrders();
        } else {
            showToast('TWAP order failed: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('TWAP order execution failed', 'error');
    }
}

/**
 * Execute a Scale order (multiple limit orders with optional skew)
 */
async function executeScaleOrder(coin, action, collateral, leverage) {
    const priceFrom = parseFloat(document.getElementById('trade-scale-from')?.value);
    const priceTo = parseFloat(document.getElementById('trade-scale-to')?.value);
    const numOrders = parseInt(document.getElementById('trade-scale-count')?.value) || 5;
    const skew = parseFloat(document.getElementById('trade-scale-skew')?.value) || 1.0;
    const reduceOnly = document.getElementById('trade-reduce-only')?.checked || false;

    // Validation
    if (!priceFrom || priceFrom <= 0) {
        showToast('Please enter a valid "Price From"', 'warning');
        return;
    }
    if (!priceTo || priceTo <= 0) {
        showToast('Please enter a valid "Price To"', 'warning');
        return;
    }
    if (priceFrom === priceTo) {
        showToast('Price From and Price To must be different', 'warning');
        return;
    }
    if (numOrders < 2 || numOrders > 50) {
        showToast('Number of orders must be between 2 and 50', 'warning');
        return;
    }
    if (skew < 0.1 || skew > 10) {
        showToast('Skew must be between 0.1 and 10', 'warning');
        return;
    }

    // For Long orders: Price From should be higher than Price To (buying at lower prices)
    // For Short orders: Price From should be lower than Price To (selling at higher prices)
    const isLong = action === 'buy';

    // Get the button for loading state
    const button = document.getElementById(action === 'buy' ? 'buy-btn' : 'sell-btn');

    try {
        const result = await apiCall('/scale-order', 'POST', {
            coin,
            action,
            leverage,
            collateral_usd: collateral,
            price_from: priceFrom,
            price_to: priceTo,
            num_orders: numOrders,
            skew,
            reduce_only: reduceOnly
        }, {
            loadingButton: button,
            loadingText: 'Placing orders...'
        });

        if (result.success) {
            const ordersPlaced = result.orders_placed || numOrders;
            showToast(`Scale order: ${ordersPlaced} limit orders placed for ${coin}`, 'success');
            refreshDashboard();
            loadOpenOrders();
        } else {
            showToast('Scale order failed: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Scale order execution failed', 'error');
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

    // Group coins by their category from the API
    const groups = {};
    const categoryOrder = ['L1s', 'APPS', 'MEMES', 'HIP-3 Perps'];

    coins.forEach(coin => {
        const category = coin.category || 'L1s';
        if (!groups[category]) {
            groups[category] = [];
        }
        groups[category].push(coin);
    });

    let html = '';

    // Render categories in order
    for (const categoryName of categoryOrder) {
        const groupCoins = groups[categoryName];
        if (groupCoins && groupCoins.length > 0) {
            // Add group header
            html += `
                <tr class="table-active">
                    <td colspan="12" class="py-1" style="background-color: rgba(58, 180, 239, 0.15); color: #3AB4EF; font-weight: 600;">
                        <i class="bi bi-collection me-2"></i>${categoryDisplayNames[categoryName] || categoryName}
                    </td>
                </tr>
            `;

            // Add coins in this group
            for (const coin of groupCoins) {
                // TP display: "size% @ target%" (e.g., "25% @ 50%" = close 25% at 50% gain)
                const tp1Display = coin.tp1_pct ? `${coin.tp1_size_pct}% @ ${coin.tp1_pct}%` : '--';
                const tp2Display = coin.tp2_pct ? `${coin.tp2_size_pct}% @ ${coin.tp2_pct}%` : '--';
                const maxSizeDisplay = coin.max_position_size ? formatCurrency(coin.max_position_size) : formatCurrency(coin.default_collateral * 10);
                const slDisplay = coin.default_stop_loss_pct ? `-${coin.default_stop_loss_pct}%` : '-15%';
                // Max leverage and margin mode from Hyperliquid metadata
                const maxLevDisplay = coin.hl_max_leverage ? `${coin.hl_max_leverage}x` : '--';
                const marginMode = (coin.hl_margin_mode === 'strictIsolated' || coin.hl_margin_mode === 'noCross' || coin.hl_only_isolated) ? 'Isolated' : 'Cross';
                const quoteAsset = coin.quote_asset || 'USDC';
                html += `
                    <tr>
                        <td><strong>${coin.coin}</strong></td>
                        <td><small>${quoteAsset}</small></td>
                        <td>
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" ${coin.enabled ? 'checked' : ''}
                                       onchange="toggleCoin('${coin.coin}', this.checked)">
                            </div>
                        </td>
                        <td>${maxLevDisplay}</td>
                        <td>${marginMode}</td>
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
        max_total_exposure_pct: parseFloat(document.getElementById('max-exposure-pct').value)
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
            // Refresh Quick Trade cache so changes flow through
            await refreshQuickTradeCache();
            bootstrap.Modal.getInstance(document.getElementById('editCoinModal')).hide();
            loadCoinConfigs();
        }
    } catch (error) {
        showToast('Failed to save coin configuration', 'error');
    }
}

/**
 * Save default settings for ALL coins at once
 */
async function saveAllCoinDefaults() {
    const data = {
        default_leverage: parseInt(document.getElementById('all-coin-leverage').value),
        default_collateral: parseFloat(document.getElementById('all-coin-collateral').value),
        max_position_size: parseFloat(document.getElementById('all-coin-max-size').value) || null,
        default_stop_loss_pct: parseFloat(document.getElementById('all-coin-sl').value) || null,
        tp1_pct: parseFloat(document.getElementById('all-coin-tp1').value) || null,
        tp1_size_pct: parseFloat(document.getElementById('all-coin-tp1-size').value) || null,
        tp2_pct: parseFloat(document.getElementById('all-coin-tp2').value) || null,
        tp2_size_pct: parseFloat(document.getElementById('all-coin-tp2-size').value) || null
    };

    const btn = document.getElementById('save-all-coin-defaults');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Applying...';

    try {
        const result = await apiCall('/coins/bulk-update', 'PUT', data);
        if (result.success) {
            showToast(`Updated ${result.updated} coin configurations`, 'success');
            // Refresh Quick Trade cache so changes flow through
            await refreshQuickTradeCache();
            bootstrap.Modal.getInstance(document.getElementById('setDefaultsAllModal')).hide();
            loadCoinConfigs();
        } else {
            showToast('Failed to update coins: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to update coin configurations', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Apply to All Coins';
    }
}

/**
 * Refresh leverage and margin mode data from Hyperliquid API
 * This is the ONLY action that updates the Quick Trade dropdown cache
 */
async function refreshLeverageTables() {
    const btn = document.getElementById('refresh-leverage-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Refreshing...';

    try {
        const result = await apiCall('/coins/refresh-leverage', 'POST');
        if (result.success) {
            let message = `Updated ${result.updated} coins with Hyperliquid metadata`;
            if (result.not_found && result.not_found.length > 0) {
                message += `. Not found on Hyperliquid: ${result.not_found.join(', ')}`;
            }
            showToast(message, 'success');

            // Refresh the Quick Trade static cache (this is the ONLY place it gets updated)
            await refreshQuickTradeCache();

            loadCoinConfigs();  // Refresh the Settings table
        } else {
            showToast('Failed to refresh: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to refresh leverage tables', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Refresh Leverage Tables';
    }
}

/**
 * Cleanup duplicate coin entries (e.g., KBONK vs kBONK)
 */
async function cleanupDuplicates() {
    const btn = document.getElementById('cleanup-duplicates-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Cleaning...';

    try {
        const result = await apiCall('/coins/cleanup-duplicates', 'POST');
        if (result.success) {
            showToast(result.message, 'success');
            // Also refresh Quick Trade cache after cleanup
            await refreshQuickTradeCache();
            loadCoinConfigs();  // Refresh the table
        } else {
            showToast('Failed to cleanup: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to cleanup duplicates', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-trash me-1"></i>Cleanup Duplicates';
    }
}

/**
 * Add a new perpetual coin to the configuration
 */
async function addNewPerp() {
    const ticker = document.getElementById('new-perp-ticker').value.trim();
    const isHip3 = document.getElementById('new-perp-hip3').checked;
    const dexName = document.getElementById('new-perp-dex').value.trim();
    const category = document.getElementById('new-perp-category').value;
    const resultDiv = document.getElementById('add-perp-result');

    if (!ticker) {
        resultDiv.innerHTML = '<div class="alert alert-danger py-2">Please enter a ticker symbol</div>';
        resultDiv.style.display = 'block';
        return;
    }

    if (isHip3 && !dexName) {
        resultDiv.innerHTML = '<div class="alert alert-danger py-2">Please enter the DEX name for HIP-3 perpetuals</div>';
        resultDiv.style.display = 'block';
        return;
    }

    const btn = document.getElementById('add-perp-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Adding...';
    resultDiv.style.display = 'none';

    try {
        const result = await apiCall('/coins/add', 'POST', {
            ticker: ticker,
            is_hip3: isHip3,
            dex_name: dexName,
            category: category
        });

        if (result.success) {
            resultDiv.innerHTML = `<div class="alert alert-success py-2">
                <i class="bi bi-check-circle me-1"></i>${result.message}
                <br><small>Max Leverage: ${result.coin.hl_max_leverage}x</small>
            </div>`;
            resultDiv.style.display = 'block';

            // Clear form
            document.getElementById('new-perp-ticker').value = '';
            document.getElementById('new-perp-hip3').checked = false;
            document.getElementById('new-perp-dex').value = '';
            document.getElementById('hip3-dex-container').style.display = 'none';
            document.getElementById('new-perp-category').value = 'HIP-3 Perps';

            // Refresh Quick Trade cache so new coin appears in dropdown
            await refreshQuickTradeCache();

            // Refresh the coin config table
            loadCoinConfigs();

            // Close modal after 1.5 seconds
            setTimeout(() => {
                bootstrap.Modal.getInstance(document.getElementById('addNewPerpModal')).hide();
                resultDiv.style.display = 'none';
            }, 1500);
        } else {
            resultDiv.innerHTML = `<div class="alert alert-danger py-2">
                <i class="bi bi-x-circle me-1"></i>${result.error}
            </div>`;
            resultDiv.style.display = 'block';
        }
    } catch (error) {
        resultDiv.innerHTML = '<div class="alert alert-danger py-2">Failed to add perpetual</div>';
        resultDiv.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-plus-circle me-1"></i>Add Perp';
    }
}

/**
 * Setup HIP-3 checkbox toggle
 */
function setupHip3Toggle() {
    const checkbox = document.getElementById('new-perp-hip3');
    const dexContainer = document.getElementById('hip3-dex-container');

    if (checkbox && dexContainer) {
        checkbox.addEventListener('change', function() {
            dexContainer.style.display = this.checked ? 'block' : 'none';
        });
    }
}

// Initialize HIP-3 toggle when DOM is ready
document.addEventListener('DOMContentLoaded', setupHip3Toggle);

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
