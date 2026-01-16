"""
TradingView to Hyperliquid Trading Bot
======================================
This bot receives webhook alerts from TradingView and executes trades on Hyperliquid.

How it works:
1. TradingView sends a webhook (HTTP POST) when your indicator triggers
2. This Flask server receives the webhook
3. The bot validates the request and executes the trade on Hyperliquid

Author: Built with Claude for learning purposes
"""

import os
import json
import logging
from flask import Flask, request, jsonify
from eth_account import Account
from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

# ============================================================================
# CONFIGURATION
# ============================================================================

# Your wallet addresses (loaded from environment variables for security)
MAIN_WALLET_ADDRESS = os.environ.get("HL_MAIN_WALLET")
API_WALLET_SECRET = os.environ.get("HL_API_SECRET")

# Webhook secret - TradingView must include this in requests
# This prevents random people from triggering your bot
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "your-secret-key-change-me")

# Use MAINNET for real trading, TESTNET for testing
# IMPORTANT: Start with TESTNET to test your setup!
USE_TESTNET = os.environ.get("USE_TESTNET", "true").lower() == "true"
API_URL = constants.TESTNET_API_URL if USE_TESTNET else constants.MAINNET_API_URL

# ============================================================================
# SETUP LOGGING
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# INITIALIZE FLASK APP
# ============================================================================

app = Flask(__name__)

# ============================================================================
# HYPERLIQUID CONNECTION
# ============================================================================

def get_exchange():
    """
    Creates a connection to Hyperliquid exchange.
    Returns both the info client (for reading data) and exchange client (for trading).
    """
    if not MAIN_WALLET_ADDRESS or not API_WALLET_SECRET:
        raise ValueError("Missing wallet configuration. Set HL_MAIN_WALLET and HL_API_SECRET environment variables.")
    
    # Create wallet from your API secret key
    wallet = Account.from_key(API_WALLET_SECRET)
    
    # Info client - for reading market data
    info = Info(API_URL, skip_ws=True)
    
    # Exchange client - for placing trades
    # Note: account_address is your MAIN wallet, but we sign with the API wallet
    exchange = Exchange(wallet, API_URL, account_address=MAIN_WALLET_ADDRESS)
    
    return info, exchange


def calculate_position_size(info, coin, collateral_usd, leverage):
    """
    Calculate the position size based on collateral and leverage.
    
    For example:
    - If you want $100 collateral at 10x leverage
    - Your position size = $100 * 10 = $1000 notional
    - If BTC is $100,000, that's 0.01 BTC
    """
    # Get current price
    all_mids = info.all_mids()
    current_price = float(all_mids[coin])
    
    # Calculate notional value (collateral * leverage)
    notional_value = collateral_usd * leverage
    
    # Calculate size in coin terms
    size = notional_value / current_price
    
    # Round to appropriate decimal places (Hyperliquid has size constraints)
    # For BTC, typically 3-4 decimal places; for others, may vary
    size = round(size, 4)
    
    logger.info(f"Price: ${current_price:,.2f} | Collateral: ${collateral_usd} | "
                f"Leverage: {leverage}x | Notional: ${notional_value:,.2f} | Size: {size} {coin}")
    
    return size, current_price


# ============================================================================
# WEBHOOK ENDPOINT
# ============================================================================

@app.route('/webhook', methods=['POST'])
def webhook():
    """
    Receives webhooks from TradingView.
    
    Expected JSON payload from TradingView:
    {
        "secret": "your-webhook-secret",
        "action": "buy" or "sell",
        "coin": "BTC",
        "leverage": 10,
        "collateral_usd": 100,
        "close_position": false  (optional - if true, closes existing position)
    }
    """
    try:
        # Parse the incoming JSON
        data = request.get_json()
        
        if not data:
            logger.warning("Received empty request")
            return jsonify({"error": "No data received"}), 400
        
        logger.info(f"Received webhook: {json.dumps(data, indent=2)}")
        
        # ====================================================================
        # SECURITY CHECK - Verify the secret
        # ====================================================================
        if data.get("secret") != WEBHOOK_SECRET:
            logger.warning("Invalid webhook secret!")
            return jsonify({"error": "Invalid secret"}), 401
        
        # ====================================================================
        # PARSE THE ALERT DATA
        # ====================================================================
        action = data.get("action", "").lower()  # "buy" or "sell"
        coin = data.get("coin", "BTC").upper()   # e.g., "BTC", "ETH"
        leverage = int(data.get("leverage", 10))
        collateral_usd = float(data.get("collateral_usd", 100))
        close_position = data.get("close_position", False)
        
        # Validate action
        if action not in ["buy", "sell"] and not close_position:
            return jsonify({"error": "Invalid action. Must be 'buy' or 'sell'"}), 400
        
        # ====================================================================
        # CONNECT TO HYPERLIQUID
        # ====================================================================
        info, exchange = get_exchange()
        
        # ====================================================================
        # HANDLE CLOSE POSITION REQUEST
        # ====================================================================
        if close_position:
            logger.info(f"Closing position for {coin}")
            result = exchange.market_close(coin)
            logger.info(f"Close result: {result}")
            return jsonify({
                "status": "success",
                "action": "close",
                "coin": coin,
                "result": result
            })
        
        # ====================================================================
        # SET LEVERAGE (do this before opening position)
        # ====================================================================
        # is_cross=False means isolated margin (recommended for defined risk)
        logger.info(f"Setting leverage to {leverage}x for {coin}")
        leverage_result = exchange.update_leverage(leverage, coin, is_cross=False)
        logger.info(f"Leverage result: {leverage_result}")
        
        # ====================================================================
        # CALCULATE POSITION SIZE
        # ====================================================================
        size, current_price = calculate_position_size(info, coin, collateral_usd, leverage)
        
        # ====================================================================
        # EXECUTE THE TRADE
        # ====================================================================
        is_buy = (action == "buy")
        
        logger.info(f"Executing market {'BUY' if is_buy else 'SELL'} for {size} {coin}")
        
        # market_open places a market order with slippage protection
        # The 0.01 = 1% slippage tolerance (adjust as needed)
        order_result = exchange.market_open(
            coin,           # The asset to trade
            is_buy,         # True for long, False for short
            size,           # Position size in coin terms
            None,           # px - None means use market price
            0.01            # 1% slippage tolerance
        )
        
        logger.info(f"Order result: {json.dumps(order_result, indent=2)}")
        
        # ====================================================================
        # PROCESS THE RESPONSE
        # ====================================================================
        if order_result.get("status") == "ok":
            statuses = order_result.get("response", {}).get("data", {}).get("statuses", [])
            fills = []
            for status in statuses:
                if "filled" in status:
                    filled = status["filled"]
                    fills.append({
                        "oid": filled.get("oid"),
                        "size": filled.get("totalSz"),
                        "avg_price": filled.get("avgPx")
                    })
                elif "error" in status:
                    logger.error(f"Order error: {status['error']}")
            
            return jsonify({
                "status": "success",
                "action": action,
                "coin": coin,
                "leverage": leverage,
                "size": size,
                "fills": fills,
                "network": "testnet" if USE_TESTNET else "mainnet"
            })
        else:
            error_msg = order_result.get("response", "Unknown error")
            logger.error(f"Order failed: {error_msg}")
            return jsonify({"status": "error", "message": str(error_msg)}), 500
            
    except Exception as e:
        logger.exception(f"Error processing webhook: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ============================================================================
# HEALTH CHECK ENDPOINT
# ============================================================================

@app.route('/', methods=['GET'])
def root():
    """Root endpoint for health checks (required for Autoscale deployment)."""
    return jsonify({"status": "healthy"})


@app.route('/health', methods=['GET'])
def health():
    """Simple health check endpoint to verify the bot is running."""
    return jsonify({
        "status": "healthy",
        "network": "testnet" if USE_TESTNET else "mainnet",
        "wallet_configured": bool(MAIN_WALLET_ADDRESS and API_WALLET_SECRET)
    })


# ============================================================================
# STATUS ENDPOINT - Check your account
# ============================================================================

@app.route('/status', methods=['GET'])
def status():
    """Check your account status and open positions."""
    try:
        info, _ = get_exchange()
        user_state = info.user_state(MAIN_WALLET_ADDRESS)
        
        return jsonify({
            "status": "success",
            "network": "testnet" if USE_TESTNET else "mainnet",
            "account": {
                "margin_summary": user_state.get("marginSummary", {}),
                "positions": user_state.get("assetPositions", [])
            }
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ============================================================================
# RUN THE SERVER
# ============================================================================

if __name__ == '__main__':
    logger.info("=" * 60)
    logger.info("TradingView to Hyperliquid Bot Starting...")
    logger.info(f"Network: {'TESTNET' if USE_TESTNET else 'MAINNET'}")
    logger.info(f"Wallet configured: {bool(MAIN_WALLET_ADDRESS and API_WALLET_SECRET)}")
    logger.info("=" * 60)
    
    # Run on port 5000 (or use PORT env variable for Replit)
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
