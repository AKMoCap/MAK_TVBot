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
        this.onPositionUpdate = null;
        this.onAccountUpdate = null;
        this.onOrderUpdate = null;
        this.onFillUpdate = null;
    }

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

        this.userAddress = userAddress.toLowerCase();

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

            // Handle subscription confirmation
            if (msg.channel === 'subscriptionResponse') {
                console.log('[HL-WS] Subscription response:', msg.data);
                return;
            }

            // Handle webData2 updates
            if (msg.channel === 'webData2') {
                this.processWebData2(msg.data);
                return;
            }

            // Handle pong
            if (msg.channel === 'pong') {
                return;
            }

            // Log other messages for debugging
            console.log('[HL-WS] Message:', msg);

        } catch (error) {
            console.error('[HL-WS] Error parsing message:', error, data);
        }
    }

    /**
     * Process webData2 updates - contains positions, account info, orders
     */
    processWebData2(data) {
        if (!data) return;

        // Extract clearinghouse state (positions, margin, account value)
        const clearinghouse = data.clearinghouseState;
        if (clearinghouse) {
            // Account summary
            const marginSummary = clearinghouse.marginSummary || {};
            const accountValue = parseFloat(marginSummary.accountValue || 0);
            const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || 0);
            const withdrawable = parseFloat(marginSummary.withdrawable || 0);

            // Positions
            const assetPositions = clearinghouse.assetPositions || [];
            const positions = assetPositions
                .map(pos => {
                    const position = pos.position || pos;
                    const size = parseFloat(position.szi || 0);
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

            // Call position update callback
            if (this.onPositionUpdate) {
                this.onPositionUpdate(positions);
            }

            // Call account update callback
            if (this.onAccountUpdate) {
                this.onAccountUpdate({
                    account_value: accountValue,
                    total_margin_used: totalMarginUsed,
                    withdrawable: withdrawable,
                    positions: positions
                });
            }
        }

        // Extract open orders
        if (data.openOrders && this.onOrderUpdate) {
            this.onOrderUpdate(data.openOrders);
        }

        // Extract fills (recent trades)
        if (data.fills && this.onFillUpdate) {
            this.onFillUpdate(data.fills);
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
