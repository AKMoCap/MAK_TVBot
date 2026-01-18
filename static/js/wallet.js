/**
 * Wallet Manager - Web3 Wallet Connection and Hyperliquid Agent Approval
 * Handles MetaMask/Rabby connection and creates Hyperliquid API wallets
 */

class WalletManager {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.address = null;  // lowercase for comparisons
        this.checksumAddress = null;  // original case for signing
        this.chainId = null;
        this.isConnected = false;
        this.agentKey = null;

        // Hyperliquid chain IDs for EIP-712 signing
        // Must match the network for signature validation
        this.ARBITRUM_ONE_CHAIN_ID = 42161;
        this.ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

        // Network configurations for adding/switching
        this.NETWORKS = {
            42161: {
                chainId: '0xa4b1',
                chainName: 'Arbitrum One',
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://arb1.arbitrum.io/rpc'],
                blockExplorerUrls: ['https://arbiscan.io']
            },
            421614: {
                chainId: '0x66eee',
                chainName: 'Arbitrum Sepolia',
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
                blockExplorerUrls: ['https://sepolia.arbiscan.io']
            }
        };

        // Check for existing session on load
        this.checkExistingSession();

        // Listen for account/chain changes
        if (window.ethereum) {
            window.ethereum.on('accountsChanged', (accounts) => this.handleAccountsChanged(accounts));
            window.ethereum.on('chainChanged', (chainId) => this.handleChainChanged(chainId));
        }
    }

    /**
     * Switch to the required network for Hyperliquid signing
     */
    async switchToRequiredNetwork(requiredChainId) {
        const currentChainId = this.chainId;

        if (currentChainId === requiredChainId) {
            console.log('Already on correct network:', requiredChainId);
            return true;
        }

        const networkConfig = this.NETWORKS[requiredChainId];
        if (!networkConfig) {
            throw new Error(`Unknown network: ${requiredChainId}`);
        }

        console.log(`Switching from chain ${currentChainId} to ${requiredChainId} (${networkConfig.chainName})`);

        try {
            // Try to switch to the network
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: networkConfig.chainId }]
            });

            // Update our stored chain ID
            this.chainId = requiredChainId;
            console.log('Successfully switched to', networkConfig.chainName);
            return true;

        } catch (switchError) {
            // Error code 4902 means the network hasn't been added yet
            if (switchError.code === 4902) {
                console.log('Network not found, adding it...');
                try {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [networkConfig]
                    });
                    this.chainId = requiredChainId;
                    console.log('Successfully added and switched to', networkConfig.chainName);
                    return true;
                } catch (addError) {
                    console.error('Failed to add network:', addError);
                    throw new Error(`Please add ${networkConfig.chainName} network to your wallet manually`);
                }
            } else {
                console.error('Failed to switch network:', switchError);
                throw new Error(`Please switch to ${networkConfig.chainName} in your wallet`);
            }
        }
    }

    /**
     * Check if user has an existing session
     */
    async checkExistingSession() {
        try {
            const response = await fetch('/api/wallet/session');
            const data = await response.json();

            if (data.connected && data.address) {
                this.address = data.address.toLowerCase();
                this.isConnected = true;
                this.agentKey = data.has_agent_key;
                this.updateUI();

                // Try to reconnect Web3 provider silently
                if (window.ethereum) {
                    try {
                        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                        if (accounts.length > 0 && accounts[0].toLowerCase() === this.address) {
                            this.checksumAddress = accounts[0];
                            this.provider = new ethers.BrowserProvider(window.ethereum);
                            this.signer = await this.provider.getSigner();

                            // Get current chain and switch to correct network if needed
                            const network = await this.provider.getNetwork();
                            this.chainId = Number(network.chainId);

                            const requiredChainId = await this.getRequiredChainId();
                            console.log('Session reconnect - Current chain:', this.chainId, 'Required:', requiredChainId);

                            if (this.chainId !== requiredChainId) {
                                try {
                                    await this.switchToRequiredNetwork(requiredChainId);
                                    this.chainId = requiredChainId;
                                    console.log('Switched to required network:', requiredChainId);
                                } catch (switchError) {
                                    console.warn('Could not auto-switch network on reconnect:', switchError.message);
                                }
                            }

                            console.log('Reconnected Web3 provider for:', this.checksumAddress);
                        }
                    } catch (e) {
                        console.log('Could not reconnect Web3 provider:', e);
                    }
                }

                // Connect Hyperliquid WebSocket for real-time updates
                if (typeof hlWebSocket !== 'undefined' && this.address) {
                    console.log('[Wallet] Connecting Hyperliquid WebSocket on session restore:', this.address);
                    hlWebSocket.connect(this.address);
                }
            }
        } catch (error) {
            console.log('No existing session:', error);
        }
    }

    /**
     * Get required chain ID from app settings
     */
    async getRequiredChainId() {
        try {
            const response = await fetch('/api/settings');
            const settings = await response.json();
            const isTestnet = settings.use_testnet === 'true' || settings.use_testnet === true;
            return isTestnet ? this.ARBITRUM_SEPOLIA_CHAIN_ID : this.ARBITRUM_ONE_CHAIN_ID;
        } catch (error) {
            console.error('Failed to get settings, defaulting to mainnet:', error);
            return this.ARBITRUM_ONE_CHAIN_ID;
        }
    }

    /**
     * Connect wallet (MetaMask, Rabby, etc.)
     */
    async connect() {
        if (!window.ethereum) {
            this.showToast('No Web3 wallet detected. Please install MetaMask or Rabby.', 'error');
            return false;
        }

        try {
            this.updateButton('Connecting...', 'status-badge-primary');

            // Request account access
            this.provider = new ethers.BrowserProvider(window.ethereum);
            const accounts = await this.provider.send('eth_requestAccounts', []);

            if (!accounts || accounts.length === 0) {
                throw new Error('No accounts found');
            }

            this.signer = await this.provider.getSigner();
            this.checksumAddress = await this.signer.getAddress();
            this.address = this.checksumAddress.toLowerCase();
            const network = await this.provider.getNetwork();
            this.chainId = Number(network.chainId);

            console.log('Wallet connected:', this.checksumAddress, 'Chain:', this.chainId);

            // Get the required chain ID from app settings and switch if needed
            const requiredChainId = await this.getRequiredChainId();
            console.log('Required chain ID from settings:', requiredChainId);

            if (this.chainId !== requiredChainId) {
                this.updateButton('Switching Network...', 'status-badge-primary');
                try {
                    await this.switchToRequiredNetwork(requiredChainId);
                    this.chainId = requiredChainId;
                } catch (switchError) {
                    console.warn('Could not auto-switch network:', switchError.message);
                    // Continue anyway - the network switch will happen during agent approval
                }
            }

            // Register wallet with backend
            const response = await fetch('/api/wallet/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: this.address, chain_id: this.chainId })
            });

            const data = await response.json();

            if (data.success) {
                this.isConnected = true;
                this.agentKey = data.has_agent_key;

                // Handle network change notification
                if (data.network_changed) {
                    this.showToast(`Network changed to ${data.network}. Please re-authorize trading.`, 'warning');
                }

                if (!data.has_agent_key) {
                    // Need to create agent wallet
                    const networkName = data.network === 'mainnet' ? 'Mainnet' : 'Testnet';
                    this.showToast(`Wallet connected to ${networkName}! Authorize trading to continue.`, 'info');
                    await this.promptAgentApproval();
                } else {
                    const networkName = data.network === 'mainnet' ? 'Mainnet' : 'Testnet';
                    this.showToast(`Wallet connected to ${networkName} and ready to trade!`, 'success');
                }

                this.updateUI();

                // Connect Hyperliquid WebSocket for real-time updates
                if (typeof hlWebSocket !== 'undefined') {
                    console.log('[Wallet] Connecting Hyperliquid WebSocket for:', this.address);
                    hlWebSocket.connect(this.address);
                }

                // Refresh dashboard data
                if (typeof refreshDashboard === 'function') {
                    refreshDashboard();
                }

                return true;
            } else {
                throw new Error(data.error || 'Failed to connect wallet');
            }

        } catch (error) {
            console.error('Wallet connection error:', error);
            this.showToast('Failed to connect wallet: ' + error.message, 'error');
            this.updateButton('Connect Wallet', 'status-badge-disconnected');
            return false;
        }
    }

    /**
     * Prompt user to approve agent wallet for Hyperliquid trading
     */
    async promptAgentApproval() {
        // Show modal asking user to approve agent
        const modal = this.createApprovalModal();
        document.body.appendChild(modal);

        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
    }

    /**
     * Create the agent approval modal
     */
    createApprovalModal() {
        const modal = document.createElement('div');
        modal.className = 'modal fade';
        modal.id = 'agentApprovalModal';
        modal.innerHTML = `
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content bg-dark text-light">
                    <div class="modal-header border-secondary">
                        <h5 class="modal-title">
                            <i class="bi bi-shield-check me-2 text-primary"></i>Authorize Trading
                        </h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p>To enable trading, you need to authorize this app to trade on your behalf.</p>
                        <div class="alert alert-info">
                            <i class="bi bi-info-circle me-2"></i>
                            <strong>How it works:</strong>
                            <ul class="mb-0 mt-2">
                                <li>A secure "agent wallet" will be created</li>
                                <li>It can only trade, not withdraw funds</li>
                                <li>You'll sign a message to approve it</li>
                                <li>Your main wallet keys stay safe</li>
                            </ul>
                        </div>
                        <div id="approval-status" class="mt-3"></div>
                    </div>
                    <div class="modal-footer border-secondary">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                        <button type="button" class="btn btn-primary" id="approve-agent-btn" onclick="walletManager.approveAgent()">
                            <i class="bi bi-check-circle me-1"></i>Authorize Trading
                        </button>
                    </div>
                </div>
            </div>
        `;
        return modal;
    }

    /**
     * Approve agent wallet for Hyperliquid trading
     * Uses EIP-712 typed data signing matching Hyperliquid's requirements
     */
    async approveAgent() {
        const statusDiv = document.getElementById('approval-status');
        const approveBtn = document.getElementById('approve-agent-btn');

        try {
            approveBtn.disabled = true;
            approveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Preparing...';
            statusDiv.innerHTML = '<div class="text-muted">Generating agent wallet...</div>';

            // Request agent approval data from backend
            const prepResponse = await fetch('/api/wallet/prepare-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: this.address })
            });

            const prepData = await prepResponse.json();

            if (!prepData.success) {
                throw new Error(prepData.error || 'Failed to prepare agent');
            }

            // Get the typed data from backend
            const typedData = prepData.typed_data;
            const requiredChainId = typedData.domain.chainId;

            // Switch to the required network for signing
            statusDiv.innerHTML = '<div class="text-muted">Switching to required network...</div>';
            approveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Switch Network...';

            try {
                await this.switchToRequiredNetwork(requiredChainId);
            } catch (networkError) {
                throw new Error(`Network switch failed: ${networkError.message}`);
            }

            statusDiv.innerHTML = '<div class="text-muted">Please sign the message in your wallet...</div>';
            approveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sign in Wallet...';

            // Use checksummed address for signing (MetaMask requires it)
            // If we don't have checksumAddress, get it from wallet
            let signingAddress = this.checksumAddress;
            if (!signingAddress && window.ethereum) {
                const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                signingAddress = accounts[0];
            }

            console.log('Signing with address:', signingAddress);
            console.log('Required chain:', requiredChainId);
            console.log('Typed data:', JSON.stringify(typedData, null, 2));

            const signature = await window.ethereum.request({
                method: 'eth_signTypedData_v4',
                params: [signingAddress, JSON.stringify(typedData)]
            });

            statusDiv.innerHTML = '<div class="text-muted">Submitting approval to Hyperliquid...</div>';
            approveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Submitting...';

            // Submit the signed approval to backend
            const approveResponse = await fetch('/api/wallet/approve-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    address: this.address,
                    signature: signature,
                    agent_address: prepData.agent_address,
                    agent_key: prepData.agent_key,
                    nonce: prepData.nonce
                })
            });

            const approveData = await approveResponse.json();

            if (approveData.success) {
                this.agentKey = true;
                statusDiv.innerHTML = '<div class="text-success"><i class="bi bi-check-circle me-1"></i>Trading authorized successfully!</div>';
                this.showToast('Trading authorized! You can now trade on Hyperliquid.', 'success');

                // Close modal after delay
                setTimeout(() => {
                    const modal = bootstrap.Modal.getInstance(document.getElementById('agentApprovalModal'));
                    if (modal) modal.hide();
                    document.getElementById('agentApprovalModal')?.remove();
                }, 1500);

                this.updateUI();

                // Refresh dashboard
                if (typeof refreshDashboard === 'function') {
                    refreshDashboard();
                }
            } else {
                throw new Error(approveData.error || 'Failed to approve agent');
            }

        } catch (error) {
            console.error('Agent approval error:', error);
            statusDiv.innerHTML = `<div class="text-danger"><i class="bi bi-x-circle me-1"></i>${error.message}</div>`;
            approveBtn.disabled = false;
            approveBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Try Again';
        }
    }

    /**
     * Disconnect wallet
     */
    async disconnect() {
        try {
            await fetch('/api/wallet/disconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Disconnect error:', error);
        }

        this.provider = null;
        this.signer = null;
        this.address = null;
        this.checksumAddress = null;
        this.isConnected = false;
        this.agentKey = null;

        console.log('Wallet disconnected');

        // Disconnect Hyperliquid WebSocket
        if (typeof hlWebSocket !== 'undefined') {
            hlWebSocket.disconnect();
        }

        // Close any open wallet menu
        const menu = document.getElementById('wallet-menu');
        if (menu) menu.remove();

        this.updateUI();
        this.showToast('Wallet disconnected', 'info');

        // Refresh dashboard to clear data
        if (typeof refreshDashboard === 'function') {
            refreshDashboard();
        }
    }

    /**
     * Handle account changes in wallet
     */
    handleAccountsChanged(accounts) {
        if (accounts.length === 0) {
            this.disconnect();
        } else if (accounts[0].toLowerCase() !== this.address?.toLowerCase()) {
            // Account changed, reconnect
            this.disconnect();
            this.connect();
        }
    }

    /**
     * Handle chain changes in wallet
     */
    handleChainChanged(chainId) {
        this.chainId = parseInt(chainId, 16);
        // Could add chain validation here if needed
    }

    /**
     * Update UI based on connection state
     */
    updateUI() {
        const btn = document.getElementById('wallet-connect-btn');
        const statusText = document.getElementById('wallet-status-text');

        if (!btn || !statusText) return;

        if (this.isConnected && this.address) {
            const shortAddress = this.address.slice(0, 6) + '...' + this.address.slice(-4);

            if (this.agentKey) {
                // Fully connected and authorized
                btn.className = 'status-badge status-badge-primary';
                statusText.textContent = shortAddress;
                btn.onclick = (e) => { e.stopPropagation(); this.showWalletMenu(); };
            } else {
                // Connected but needs agent approval
                btn.className = 'status-badge status-badge-testnet';
                statusText.textContent = shortAddress + ' (Authorize)';
                btn.onclick = () => this.promptAgentApproval();
            }
        } else {
            btn.className = 'status-badge status-badge-disconnected';
            statusText.textContent = 'Connect Wallet';
            btn.onclick = () => this.connect();
        }
    }

    /**
     * Update button state
     */
    updateButton(text, className) {
        const btn = document.getElementById('wallet-connect-btn');
        const statusText = document.getElementById('wallet-status-text');

        if (btn) btn.className = 'status-badge ' + className;
        if (statusText) statusText.textContent = text;
    }

    /**
     * Show wallet menu (connected state)
     */
    showWalletMenu() {
        // Remove existing menu if open
        const existingMenu = document.getElementById('wallet-menu');
        if (existingMenu) {
            existingMenu.remove();
            return;
        }

        const btn = document.getElementById('wallet-connect-btn');
        const rect = btn.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.id = 'wallet-menu';
        menu.className = 'dropdown-menu show';
        menu.style.cssText = `
            position: fixed;
            top: ${rect.bottom + 5}px;
            right: ${window.innerWidth - rect.right}px;
            z-index: 9999;
            background: #1a1d29;
            border: 1px solid #2d3748;
            border-radius: 8px;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        menu.innerHTML = `
            <div class="px-3 py-2 text-muted small border-bottom" style="border-color: #2d3748 !important;">
                <i class="bi bi-wallet2 me-1"></i>Connected Wallet
            </div>
            <div class="px-3 py-2 text-light small" style="word-break: break-all;">
                ${this.address}
            </div>
            <div class="dropdown-divider" style="border-color: #2d3748;"></div>
            <button class="dropdown-item text-warning d-flex align-items-center" id="reauthorize-wallet-btn" style="background: transparent;">
                <i class="bi bi-shield-check me-2"></i>Re-authorize Trading
            </button>
            <button class="dropdown-item text-danger d-flex align-items-center" id="disconnect-wallet-btn" style="background: transparent;">
                <i class="bi bi-box-arrow-right me-2"></i>Disconnect Wallet
            </button>
        `;

        document.body.appendChild(menu);

        // Add click handler for re-authorize button
        document.getElementById('reauthorize-wallet-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            menu.remove();
            this.promptAgentApproval();
        };

        // Add click handler for disconnect button
        document.getElementById('disconnect-wallet-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.disconnect();
        };

        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 100);
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }
}

// Initialize wallet manager
const walletManager = new WalletManager();
