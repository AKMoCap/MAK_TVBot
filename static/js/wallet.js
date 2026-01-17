/**
 * Wallet Manager - Web3 Wallet Connection and Hyperliquid Agent Approval
 * Handles MetaMask/Rabby connection and creates Hyperliquid API wallets
 */

class WalletManager {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        this.isConnected = false;
        this.agentKey = null;

        // Hyperliquid uses chainId 1337 for EIP-712 signing (L1)
        // Users can be connected to any network - signing is off-chain
        this.HYPERLIQUID_SIGNING_CHAIN_ID = 1337;

        // Check for existing session on load
        this.checkExistingSession();

        // Listen for account/chain changes
        if (window.ethereum) {
            window.ethereum.on('accountsChanged', (accounts) => this.handleAccountsChanged(accounts));
            window.ethereum.on('chainChanged', (chainId) => this.handleChainChanged(chainId));
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
                this.address = data.address;
                this.isConnected = true;
                this.agentKey = data.has_agent_key;
                this.updateUI();

                // Try to reconnect Web3 provider silently
                if (window.ethereum) {
                    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                    if (accounts.length > 0 && accounts[0].toLowerCase() === this.address.toLowerCase()) {
                        this.provider = new ethers.BrowserProvider(window.ethereum);
                        this.signer = await this.provider.getSigner();
                    }
                }
            }
        } catch (error) {
            console.log('No existing session');
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

            if (accounts.length === 0) {
                throw new Error('No accounts found');
            }

            this.signer = await this.provider.getSigner();
            this.address = await this.signer.getAddress();
            const network = await this.provider.getNetwork();
            this.chainId = Number(network.chainId);

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

                if (!data.has_agent_key) {
                    // Need to create agent wallet
                    this.showToast('Wallet connected! Now authorize trading to continue.', 'info');
                    await this.promptAgentApproval();
                } else {
                    this.showToast('Wallet connected and ready to trade!', 'success');
                }

                this.updateUI();

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
     * Signs EIP-712 typed data to authorize the agent
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

            statusDiv.innerHTML = '<div class="text-muted">Please sign the message in your wallet...</div>';
            approveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sign in Wallet...';

            // Sign the EIP-712 typed data
            const signature = await this.signAgentApproval(prepData.sign_data);

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
     * Sign EIP-712 typed data for agent approval
     */
    async signAgentApproval(signData) {
        // Hyperliquid uses EIP-712 typed data signing
        const domain = signData.domain;
        const types = signData.types;
        const message = signData.message;

        // Remove EIP712Domain from types if present (ethers handles it automatically)
        const typesWithoutDomain = { ...types };
        delete typesWithoutDomain.EIP712Domain;

        // Sign using ethers.js
        const signature = await this.signer.signTypedData(domain, typesWithoutDomain, message);

        return signature;
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
        this.isConnected = false;
        this.agentKey = null;

        this.updateUI();
        this.showToast('Wallet disconnected', 'info');
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
                btn.onclick = () => this.showWalletMenu();
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
        // Create dropdown menu for wallet options
        const existingMenu = document.getElementById('wallet-menu');
        if (existingMenu) {
            existingMenu.remove();
            return;
        }

        const btn = document.getElementById('wallet-connect-btn');
        const rect = btn.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.id = 'wallet-menu';
        menu.className = 'dropdown-menu show bg-dark border-secondary';
        menu.style.cssText = `position: fixed; top: ${rect.bottom + 5}px; right: ${window.innerWidth - rect.right}px; z-index: 9999;`;
        menu.innerHTML = `
            <div class="px-3 py-2 text-muted small border-bottom border-secondary">
                ${this.address}
            </div>
            <button class="dropdown-item text-light" onclick="walletManager.disconnect(); document.getElementById('wallet-menu')?.remove();">
                <i class="bi bi-box-arrow-right me-2"></i>Disconnect
            </button>
        `;

        document.body.appendChild(menu);

        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== btn) {
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
