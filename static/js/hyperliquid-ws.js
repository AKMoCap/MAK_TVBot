/**
 * Hyperliquid WebSocket Manager
 * Connects directly to Hyperliquid's WebSocket for real-time position updates
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
 */

class HyperliquidWebSocket {
    constructor() {
        this.ws = null;
        this.userAddress = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.pingInterval = null;
        this.subscriptionId = null;

        // Callbacks
        this._onPositionUpdate = null;
        this._onAccountUpdate = null;
        this._onOrderUpdate = null;
        this._onFillUpdate = null;
        this._onPriceUpdate = null;  // New: callback for price updates
        this._onConnectionStatusChange = null;  // New: callback for connection status changes
        this._onReconnectFailed = null;  // New: callback when max reconnect attempts reached

        // Buffer for data received before callbacks are set
        this._lastAccountData = null;
        this._lastPositions = null;
        this._lastPrices = {};  // New: cache for latest prices

        // Cache for HIP-3 positions (from REST API, not available via WebSocket)
        this._hip3PositionsCache = [];

        // Cache for funding rates (from REST API, not available via WebSocket)
        this._fundingRatesCache = {};

        // Lookup map for HIP-3 coins: unprefixed name -> full "dex:COIN" name
        this._hip3CoinLookup = {};
    }

    /**
     * Update the HIP-3 positions cache from REST API data
     * Call this when REST API returns positions to preserve HIP-3 data
     */
    updateHip3Cache(positions) {
        if (!positions || !Array.isArray(positions)) return;
        // Extract only HIP-3 positions
        this._hip3PositionsCache = positions.filter(p => p.is_hip3 === true);
        if (this._hip3PositionsCache.length > 0) {
            console.log('[HL-WS] Updated HIP-3 cache:', this._hip3PositionsCache.length, 'positions');
        }

        // Also cache funding rates from all positions
        positions.forEach(p => {
            if (p.coin && p.funding_rate !== undefined) {
                this._fundingRatesCache[p.coin] = p.funding_rate;
            }
        });
    }

    /**
     * Clear the HIP-3 cache (e.g., on disconnect)
     */
    clearHip3Cache() {
        this._hip3PositionsCache = [];
    }

    /**
     * Get cached prices
     */
    get prices() {
        return this._lastPrices;
    }

    // Callback setters that also replay buffered data
    set onAccountUpdate(callback) {
        this._onAccountUpdate = callback;
        // Replay buffered data if available
        if (callback && this._lastAccountData) {
            console.log('[HL-WS] Replaying buffered account data');
            callback(this._lastAccountData);
        }
    }
    get onAccountUpdate() { return this._onAccountUpdate; }

    set onPositionUpdate(callback) {
        this._onPositionUpdate = callback;
        // Replay buffered data if available
        if (callback && this._lastPositions) {
            console.log('[HL-WS] Replaying buffered position data');
            callback(this._lastPositions);
        }
    }
    get onPositionUpdate() { return this._onPositionUpdate; }

    set onOrderUpdate(callback) { this._onOrderUpdate = callback; }
    get onOrderUpdate() { return this._onOrderUpdate; }

    set onFillUpdate(callback) { this._onFillUpdate = callback; }
    get onFillUpdate() { return this._onFillUpdate; }

    set onPriceUpdate(callback) { this._onPriceUpdate = callback; }
    get onPriceUpdate() { return this._onPriceUpdate; }

    set onConnectionStatusChange(callback) { this._onConnectionStatusChange = callback; }
    get onConnectionStatusChange() { return this._onConnectionStatusChange; }

    set onReconnectFailed(callback) { this._onReconnectFailed = callback; }
    get onReconnectFailed() { return this._onReconnectFailed; }

    /**
     * Get WebSocket URL based on network
     */
    async getWsUrl() {
        try {
            const response = await fetch('/api/settings', { credentials: 'same-origin' });
            const settings = await response.json();
            const isTestnet = settings.use_testnet === 'true' || settings.use_testnet === true;
            return isTestnet
                ? 'wss://api.hyperliquid-testnet.xyz/ws'
                : 'wss://api.hyperliquid.xyz/ws';
        } catch (error) {
            console.error('Failed to get settings, defaulting to mainnet:', error);
            return 'wss://api.hyperliquid.xyz/ws';
        }
    }

    /**
     * Connect to Hyperliquid WebSocket and subscribe to user data
     */
    async connect(userAddress) {
        if (!userAddress) {
            console.error('[HL-WS] No user address provided');
            return false;
        }

        // IMPORTANT: Use the address as-is, Hyperliquid may need checksum format
        // Convert to checksum if it's all lowercase
        this.userAddress = userAddress;

        // If address is all lowercase, try to get checksum from ethers
        if (userAddress === userAddress.toLowerCase() && typeof ethers !== 'undefined') {
            try {
                this.userAddress = ethers.getAddress(userAddress);
                console.log('[HL-WS] Converted to checksum address:', this.userAddress);
            } catch (e) {
                console.log('[HL-WS] Using address as-is:', userAddress);
            }
        }

        // Disconnect existing connection if any
        this.disconnect();

        try {
            const wsUrl = await this.getWsUrl();
            console.log('[HL-WS] Connecting to:', wsUrl);

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[HL-WS] Connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;

                // Notify listeners of successful connection
                if (this._onConnectionStatusChange) {
                    this._onConnectionStatusChange(true, 'connected');
                }

                // Subscribe to webData2 for user positions/account data
                this.subscribeToUserData();

                // Start ping to keep connection alive
                this.startPing();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onerror = (error) => {
                console.error('[HL-WS] WebSocket error:', error);
            };

            this.ws.onclose = (event) => {
                console.log('[HL-WS] Disconnected:', event.code, event.reason);
                this.isConnected = false;
                this.stopPing();

                // Notify listeners of disconnection
                if (this._onConnectionStatusChange) {
                    this._onConnectionStatusChange(false, 'disconnected');
                }

                // Attempt reconnection if not intentionally closed
                if (this.userAddress && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = this.reconnectDelay * this.reconnectAttempts;
                    console.log(`[HL-WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

                    // Notify listeners of reconnection attempt
                    if (this._onConnectionStatusChange) {
                        this._onConnectionStatusChange(false, 'reconnecting', this.reconnectAttempts, this.maxReconnectAttempts);
                    }

                    setTimeout(() => this.connect(this.userAddress), delay);
                } else if (this.userAddress && this.reconnectAttempts >= this.maxReconnectAttempts) {
                    // Max reconnection attempts reached - notify user
                    console.error('[HL-WS] Max reconnection attempts reached');
                    if (this._onReconnectFailed) {
                        this._onReconnectFailed();
                    }
                    if (this._onConnectionStatusChange) {
                        this._onConnectionStatusChange(false, 'failed');
                    }
                }
            };

            return true;
        } catch (error) {
            console.error('[HL-WS] Connection error:', error);
            return false;
        }
    }

    /**
     * Subscribe to webData2 for real-time user data
     */
    subscribeToUserData() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('[HL-WS] Cannot subscribe - not connected');
            return;
        }

        // webData2 provides positions, account value, margin info, orders, etc.
        const subscription = {
            method: 'subscribe',
            subscription: {
                type: 'webData2',
                user: this.userAddress
            }
        };

        console.log('[HL-WS] Subscribing to webData2 for:', this.userAddress);
        this.ws.send(JSON.stringify(subscription));

        // Also subscribe to allMids for real-time price updates (no rate limit impact)
        this.subscribeToAllMids();
    }

    /**
     * Subscribe to allMids for real-time price updates
     * This provides mid prices for ALL assets without counting against rate limits
     * Also subscribes to HIP-3 dexes if configured
     */
    subscribeToAllMids() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('[HL-WS] Cannot subscribe to allMids - not connected');
            return;
        }

        // Subscribe to main perp dex (default)
        const mainSubscription = {
            method: 'subscribe',
            subscription: {
                type: 'allMids'
            }
        };
        console.log('[HL-WS] Subscribing to allMids for main perps');
        this.ws.send(JSON.stringify(mainSubscription));

        // Subscribe to HIP-3 dexes for builder-deployed perps
        this.subscribeToHip3Dexes();
    }

    /**
     * Subscribe to HIP-3 dex allMids for builder-deployed perp prices
     * Extracts dex names from coin configs in localStorage cache
     */
    subscribeToHip3Dexes() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Get HIP-3 dexes from localStorage cache
        const hip3Dexes = this.getHip3DexesFromCache();
        if (hip3Dexes.length === 0) {
            console.log('[HL-WS] No HIP-3 dexes found in cache');
            return;
        }

        console.log('[HL-WS] Found HIP-3 dexes:', hip3Dexes);

        // Subscribe to each HIP-3 dex
        for (const dexName of hip3Dexes) {
            const subscription = {
                method: 'subscribe',
                subscription: {
                    type: 'allMids',
                    dex: dexName
                }
            };
            console.log(`[HL-WS] Subscribing to allMids for HIP-3 dex: ${dexName}`);
            this.ws.send(JSON.stringify(subscription));
        }
    }

    /**
     * Extract HIP-3 dex names from coin configs in localStorage
     * Coin names are stored as "dex:COIN" format (e.g., "xyz:BTC")
     * Also builds a lookup map for matching websocket responses
     */
    getHip3DexesFromCache() {
        try {
            const cached = localStorage.getItem('mak_quick_trade_coins');
            if (!cached) return [];

            const coins = JSON.parse(cached);
            const dexes = new Set();

            // Clear and rebuild lookup map
            this._hip3CoinLookup = {};

            for (const coin of coins) {
                if (coin.coin && coin.coin.includes(':')) {
                    const [dexName, coinName] = coin.coin.split(':');
                    dexes.add(dexName);
                    // Build lookup: unprefixed name -> full "dex:COIN" name
                    // e.g., "XYZ100" -> "xyz:XYZ100"
                    this._hip3CoinLookup[coinName] = coin.coin;
                }
            }

            console.log('[HL-WS] Built HIP-3 coin lookup:', this._hip3CoinLookup);
            return Array.from(dexes);
        } catch (e) {
            console.warn('[HL-WS] Failed to parse coin cache for HIP-3 dexes:', e);
            return [];
        }
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(data) {
        try {
            const msg = JSON.parse(data);

            // Handle subscription confirmation
            if (msg.channel === 'subscriptionResponse') {
                console.log('[HL-WS] Subscription response:', msg.data);
                return;
            }

            // Handle webData2 updates - check both possible channel names
            if (msg.channel === 'webData2' || msg.channel === 'user') {
                console.log('[HL-WS] User data received, has clearinghouseState:', !!msg.data?.clearinghouseState);
                this.processWebData2(msg.data);
                return;
            }

            // Handle allMids updates (real-time prices)
            if (msg.channel === 'allMids') {
                this.processAllMids(msg.data);
                return;
            }

            // Handle pong
            if (msg.channel === 'pong') {
                return;
            }

            // Handle error messages
            if (msg.channel === 'error' || msg.error) {
                console.error('[HL-WS] Error from server:', msg);
                return;
            }

        } catch (error) {
            console.error('[HL-WS] Error parsing message:', error, data);
        }
    }

    /**
     * Process allMids updates - real-time price data for all assets
     * Data format: { mids: { "BTC": "12345.67", "ETH": "2345.67", ... } }
     * Uses lookup map to match HIP-3 coins (websocket returns unprefixed names)
     * @param {Object} data - The allMids data containing mids object
     */
    processAllMids(data) {
        if (!data || !data.mids) return;

        const mids = data.mids;
        let hip3Count = 0;

        // Update our price cache
        for (const [coin, price] of Object.entries(mids)) {
            // Check if this coin matches a known HIP-3 coin via lookup
            // Websocket returns "XYZ100" but we store as "xyz:XYZ100"
            if (this._hip3CoinLookup[coin]) {
                const fullCoinName = this._hip3CoinLookup[coin];
                this._lastPrices[fullCoinName] = parseFloat(price);
                hip3Count++;
            } else {
                // Regular perp or spot coin
                this._lastPrices[coin] = parseFloat(price);
            }
        }

        if (hip3Count > 0) {
            console.log(`[HL-WS] Updated ${hip3Count} HIP-3 prices`);
        }

        // Call the price update callback if set
        if (this._onPriceUpdate) {
            this._onPriceUpdate(this._lastPrices);
        }
    }

    /**
     * Process webData2 updates - contains positions, account info, orders
     * Also handles HIP-3 (builder-deployed perp) positions
     */
    processWebData2(data) {
        if (!data) {
            console.log('[HL-WS] processWebData2: no data');
            return;
        }

        console.log('[HL-WS] processWebData2 keys:', Object.keys(data));
        console.log('[HL-WS] Subscribed address:', this.userAddress);
        console.log('[HL-WS] Data user field:', data.user);

        // Check if there's a spot position
        if (data.spotState) {
            console.log('[HL-WS] spotState:', JSON.stringify(data.spotState, null, 2));
        }

        // Check for HIP-3 perp DEX state
        if (data.perpDexStates) {
            console.log('[HL-WS] perpDexStates found:', JSON.stringify(data.perpDexStates, null, 2).slice(0, 500));
        }

        // Extract clearinghouse state (positions, margin, account value)
        const clearinghouse = data.clearinghouseState;
        let positions = [];
        let accountValue = 0;
        let totalMarginUsed = 0;
        let withdrawable = undefined;  // Use undefined to indicate "not provided"

        if (clearinghouse) {
            // Debug: log the full clearinghouse structure
            console.log('[HL-WS] clearinghouseState keys:', Object.keys(clearinghouse));

            // Account summary
            const marginSummary = clearinghouse.marginSummary || {};
            accountValue = parseFloat(marginSummary.accountValue || 0);
            totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || 0);
            // Only set withdrawable if explicitly provided in the data
            if (marginSummary.withdrawable !== undefined && marginSummary.withdrawable !== null) {
                withdrawable = parseFloat(marginSummary.withdrawable);
            }

            console.log('[HL-WS] Account value:', accountValue, 'Margin used:', totalMarginUsed);

            // Positions - native perps
            let assetPositions = clearinghouse.assetPositions || [];
            console.log('[HL-WS] Raw assetPositions count:', assetPositions.length);

            // Debug: log first position structure if any
            if (assetPositions.length > 0) {
                console.log('[HL-WS] First position structure:', JSON.stringify(assetPositions[0], null, 2));
            } else {
                // Check if positions might be elsewhere in the data
                console.log('[HL-WS] No assetPositions, checking other fields...');
                console.log('[HL-WS] marginSummary:', JSON.stringify(marginSummary, null, 2));
                if (clearinghouse.crossMarginSummary) {
                    console.log('[HL-WS] crossMarginSummary:', JSON.stringify(clearinghouse.crossMarginSummary, null, 2));
                }
            }

            // Parse native perp positions
            positions = assetPositions
                .map(pos => {
                    const position = pos.position || pos;
                    const size = parseFloat(position.szi || 0);
                    const coin = position.coin;

                    console.log('[HL-WS] Parsing position:', coin, 'size:', size);

                    if (size === 0) return null;

                    const entryPx = parseFloat(position.entryPx || 0);
                    const positionValue = parseFloat(position.positionValue || 0);
                    const markPx = size !== 0 ? Math.abs(positionValue / size) : entryPx;

                    // Get cached funding rate if available
                    const fundingRate = this._fundingRatesCache[coin];

                    return {
                        coin: coin,
                        size: size,
                        entry_price: entryPx,
                        mark_price: markPx,
                        unrealized_pnl: parseFloat(position.unrealizedPnl || 0),
                        leverage: parseInt(position.leverage?.value || position.leverage || 1),
                        liquidation_price: position.liquidationPx ? parseFloat(position.liquidationPx) : null,
                        margin_used: parseFloat(position.marginUsed || 0),
                        side: size > 0 ? 'long' : 'short',
                        is_hip3: false,
                        funding_rate: fundingRate
                    };
                })
                .filter(p => p !== null);

            console.log('[HL-WS] Native perp positions count:', positions.length);
        } else {
            console.log('[HL-WS] No clearinghouseState in data');
        }

        // Process HIP-3 (builder-deployed perp) positions
        // These may be in perpDexStates or perpDexClearinghouseStates
        const hip3States = data.perpDexStates || data.perpDexClearinghouseStates || [];
        if (hip3States.length > 0) {
            console.log('[HL-WS] Processing HIP-3 states:', hip3States.length);

            for (const dexState of hip3States) {
                const dexPositions = dexState.assetPositions || dexState.positions || [];
                const dexName = dexState.dexName || dexState.name || 'HIP-3';

                for (const pos of dexPositions) {
                    const position = pos.position || pos;
                    const size = parseFloat(position.szi || 0);

                    if (size === 0) continue;

                    const entryPx = parseFloat(position.entryPx || 0);
                    const positionValue = parseFloat(position.positionValue || 0);
                    const markPx = size !== 0 ? Math.abs(positionValue / size) : entryPx;

                    positions.push({
                        coin: position.coin,
                        size: size,
                        entry_price: entryPx,
                        mark_price: markPx,
                        unrealized_pnl: parseFloat(position.unrealizedPnl || 0),
                        leverage: parseInt(position.leverage?.value || position.leverage || 1),
                        liquidation_price: position.liquidationPx ? parseFloat(position.liquidationPx) : null,
                        margin_used: parseFloat(position.marginUsed || 0),
                        side: size > 0 ? 'long' : 'short',
                        is_hip3: true,
                        dex_name: dexName
                    });
                }
            }

            console.log('[HL-WS] Total positions after HIP-3:', positions.length);
        }

        // Merge cached HIP-3 positions with native positions from WebSocket
        // WebSocket doesn't provide HIP-3 positions, so we preserve them from REST API
        if (this._hip3PositionsCache && this._hip3PositionsCache.length > 0) {
            // Get coins from native positions to avoid duplicates
            const nativeCoins = new Set(positions.map(p => p.coin));
            // Add cached HIP-3 positions that aren't already in the list
            for (const hip3Pos of this._hip3PositionsCache) {
                if (!nativeCoins.has(hip3Pos.coin)) {
                    positions.push(hip3Pos);
                }
            }
            console.log('[HL-WS] Merged with HIP-3 cache, total positions:', positions.length);
        }

        // Buffer the data for late callback setup
        this._lastPositions = positions;
        const accountData = {
            account_value: accountValue,
            total_margin_used: totalMarginUsed,
            withdrawable: withdrawable,
            positions: positions
        };
        this._lastAccountData = accountData;

        // Call position update callback
        if (this._onPositionUpdate) {
            this._onPositionUpdate(positions);
        } else {
            console.log('[HL-WS] No position callback set, data buffered');
        }

        // Call account update callback
        if (this._onAccountUpdate) {
            this._onAccountUpdate(accountData);
        } else {
            console.log('[HL-WS] No account callback set, data buffered');
        }

        // Extract open orders
        if (data.openOrders && this._onOrderUpdate) {
            this._onOrderUpdate(data.openOrders);
        }

        // Extract fills (recent trades)
        if (data.fills && this._onFillUpdate) {
            this._onFillUpdate(data.fills);
        }
    }

    /**
     * Start ping interval to keep connection alive
     */
    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ method: 'ping' }));
            }
        }, 30000); // Ping every 30 seconds
    }

    /**
     * Stop ping interval
     */
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect() {
        this.stopPing();

        if (this.ws) {
            // Prevent reconnection
            const address = this.userAddress;
            this.userAddress = null;

            try {
                this.ws.close();
            } catch (e) {
                console.log('[HL-WS] Error closing:', e);
            }
            this.ws = null;
        }

        this.isConnected = false;
        console.log('[HL-WS] Disconnected');
    }
}

// Global instance
const hlWebSocket = new HyperliquidWebSocket();
