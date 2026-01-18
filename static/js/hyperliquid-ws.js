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

        // Buffer for data received before callbacks are set
        this._lastAccountData = null;
        this._lastPositions = null;
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

    /**
     * Get WebSocket URL based on network
     */
    async getWsUrl() {
        try {
            const response = await fetch('/api/settings');
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

                // Attempt reconnection if not intentionally closed
                if (this.userAddress && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = this.reconnectDelay * this.reconnectAttempts;
                    console.log(`[HL-WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
                    setTimeout(() => this.connect(this.userAddress), delay);
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
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(data) {
        try {
            const msg = JSON.parse(data);

            // Debug: log all messages
            console.log('[HL-WS] Raw message channel:', msg.channel);

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

            // Handle pong
            if (msg.channel === 'pong') {
                return;
            }

            // Handle error messages
            if (msg.channel === 'error' || msg.error) {
                console.error('[HL-WS] Error from server:', msg);
                return;
            }

            // Log other messages for debugging
            console.log('[HL-WS] Unhandled message:', msg);

        } catch (error) {
            console.error('[HL-WS] Error parsing message:', error, data);
        }
    }

    /**
     * Process webData2 updates - contains positions, account info, orders
     */
    processWebData2(data) {
        if (!data) {
            console.log('[HL-WS] processWebData2: no data');
            return;
        }

        console.log('[HL-WS] processWebData2 keys:', Object.keys(data));

        // Extract clearinghouse state (positions, margin, account value)
        const clearinghouse = data.clearinghouseState;
        if (clearinghouse) {
            // Account summary
            const marginSummary = clearinghouse.marginSummary || {};
            const accountValue = parseFloat(marginSummary.accountValue || 0);
            const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || 0);
            const withdrawable = parseFloat(marginSummary.withdrawable || 0);

            console.log('[HL-WS] Account value:', accountValue, 'Margin used:', totalMarginUsed);

            // Positions
            const assetPositions = clearinghouse.assetPositions || [];
            console.log('[HL-WS] Raw assetPositions count:', assetPositions.length);

            // Debug: log first position structure
            if (assetPositions.length > 0) {
                console.log('[HL-WS] First position structure:', JSON.stringify(assetPositions[0], null, 2));
            }

            const positions = assetPositions
                .map(pos => {
                    const position = pos.position || pos;
                    const size = parseFloat(position.szi || 0);

                    // Debug: log each position parsing
                    console.log('[HL-WS] Parsing position:', position.coin, 'size:', size);

                    if (size === 0) return null;

                    const entryPx = parseFloat(position.entryPx || 0);
                    const positionValue = parseFloat(position.positionValue || 0);
                    const markPx = size !== 0 ? Math.abs(positionValue / size) : entryPx;

                    return {
                        coin: position.coin,
                        size: size,
                        entry_price: entryPx,
                        mark_price: markPx,
                        unrealized_pnl: parseFloat(position.unrealizedPnl || 0),
                        leverage: parseInt(position.leverage?.value || position.leverage || 1),
                        liquidation_price: position.liquidationPx ? parseFloat(position.liquidationPx) : null,
                        margin_used: parseFloat(position.marginUsed || 0),
                        side: size > 0 ? 'long' : 'short'
                    };
                })
                .filter(p => p !== null);

            console.log('[HL-WS] Filtered positions count:', positions.length);

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
        } else {
            console.log('[HL-WS] No clearinghouseState in data');
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
