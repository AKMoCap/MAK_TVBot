"""
MAK TradingView to Hyperliquid Trading Bot
============================================
Full-featured trading bot with:
- Web-based UI dashboard
- Multi-coin trading support
- Risk management (SL/TP, position limits, circuit breakers)
- Trade history and analytics
- TradingView webhook integration

Author: Built with Claude
"""

import os
import json
import logging
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, render_template, send_from_directory

# Initialize Flask app
app = Flask(__name__)
SECRET_KEY = os.environ.get('SECRET_KEY')
if not SECRET_KEY:
    import secrets
    SECRET_KEY = secrets.token_hex(32)
    import logging
    logging.warning("No SECRET_KEY set - generated random key (sessions will reset on restart)")
app.config['SECRET_KEY'] = SECRET_KEY
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///trading_bot.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize database
from models import db, migrate, init_db, Trade, BotConfig, CoinConfig, RiskSettings, Indicator, ActivityLog, UserWallet
init_db(app)

# Initialize managers
from risk_manager import risk_manager
from bot_manager import bot_manager

# ============================================================================
# CONFIGURATION
# ============================================================================

MAIN_WALLET_ADDRESS = os.environ.get("HL_MAIN_WALLET")

# Read USE_TESTNET - defaults to true for safety
# IMPORTANT: After changing this secret, you must RESTART the deployment
_use_testnet_raw = os.environ.get("USE_TESTNET", "true")
USE_TESTNET = _use_testnet_raw.lower().strip() == "true"

# Log the actual value for debugging
print(f"[CONFIG] USE_TESTNET raw value: '{_use_testnet_raw}' -> parsed: {USE_TESTNET}")

# Select API secret based on network
if USE_TESTNET:
    API_WALLET_SECRET = os.environ.get("HL_TESTNET_API_SECRET")
    print(f"[CONFIG] Using TESTNET API")
else:
    API_WALLET_SECRET = os.environ.get("HL_API_SECRET")
    print(f"[CONFIG] Using MAINNET API")

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "your-secret-key-change-me")

# ============================================================================
# LOGGING
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def log_activity(level, category, message, details=None):
    """Log activity to database"""
    try:
        log = ActivityLog(
            level=level,
            category=category,
            message=message,
            details=json.dumps(details) if details else None
        )
        db.session.add(log)
        db.session.commit()
    except Exception as e:
        logger.error(f"Failed to log activity: {e}")


# ============================================================================
# WEB UI ROUTES
# ============================================================================

@app.route('/')
def dashboard():
    """Main dashboard page"""
    return render_template('dashboard.html')


@app.route('/trades')
def trades():
    """Trade history page"""
    return render_template('trades.html')


@app.route('/indicators')
def indicators():
    """Indicators configuration page"""
    try:
        return render_template('indicators.html')
    except Exception as e:
        logger.exception(f"Error rendering indicators page: {e}")
        return f"Error: {str(e)}", 500


@app.route('/settings')
def settings():
    """Settings page"""
    return render_template('settings.html')


# ============================================================================
# API ROUTES - Account & Positions
# ============================================================================

@app.route('/api/account', methods=['GET'])
def api_account():
    """Get account info and positions"""
    try:
        # Try to get user-specific account info if connected
        user = get_current_user()
        logger.info(f"[ACCOUNT] User: {user.address[:10] if user else 'None'}... has_agent: {user.has_agent_key() if user else False}")

        if user and user.has_agent_key():
            try:
                agent_key = user.get_agent_key()
                logger.info(f"[ACCOUNT] Agent key retrieved, length: {len(agent_key) if agent_key else 0}")
                data = bot_manager.get_account_info(
                    user_wallet=user.address,
                    user_agent_key=agent_key
                )
            except Exception as agent_error:
                logger.exception(f"[ACCOUNT] Error with agent key: {agent_error}")
                # Return error but don't crash
                data = {
                    'error': f'Agent key error: {str(agent_error)}',
                    'account_value': 0,
                    'total_margin_used': 0,
                    'total_ntl_pos': 0,
                    'withdrawable': 0,
                    'positions': [],
                    'network': 'testnet' if USE_TESTNET else 'mainnet'
                }
        else:
            # Return empty data if no user connected
            data = {
                'error': 'Please connect your wallet and authorize trading',
                'account_value': 0,
                'total_margin_used': 0,
                'total_ntl_pos': 0,
                'withdrawable': 0,
                'positions': [],
                'network': 'testnet' if USE_TESTNET else 'mainnet'
            }
        return jsonify(data)
    except Exception as e:
        logger.exception(f"Error getting account info: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/prices', methods=['GET'])
def api_prices():
    """Get current market prices"""
    try:
        coins = request.args.get('coins', 'BTC,ETH,SOL,HYPE,AAVE,ENA,PENDLE,VIRTUAL,AERO,DOGE,PUMP,FARTCOIN,kBONK,kPEPE,PENGU').split(',')
        prices = bot_manager.get_market_prices(coins)
        return jsonify(prices)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/spot-balances', methods=['GET'])
def api_spot_balances():
    """Get spot balances for the connected wallet"""
    try:
        # Get wallet address from query param or session
        wallet_address = request.args.get('address') or session.get('wallet_address')
        logger.info(f"[spot-balances] wallet_address: {wallet_address}")
        if not wallet_address:
            return jsonify({'error': 'Wallet not connected', 'balances': []})

        # Fetch spot balances from Hyperliquid
        balances = bot_manager.get_spot_balances(wallet_address)
        logger.info(f"[spot-balances] Returning {len(balances)} balances")
        return jsonify({'balances': balances})
    except Exception as e:
        logger.exception(f"Error getting spot balances: {e}")
        return jsonify({'error': str(e), 'balances': []}), 500


@app.route('/api/open-orders', methods=['GET'])
def api_open_orders():
    """Get open orders for the connected wallet"""
    try:
        # Get wallet address from query param or session
        wallet_address = request.args.get('address') or session.get('wallet_address')
        logger.info(f"[open-orders] wallet_address: {wallet_address}")
        if not wallet_address:
            return jsonify({'error': 'Wallet not connected', 'orders': []})

        # Fetch open orders from Hyperliquid
        orders = bot_manager.get_open_orders(wallet_address)
        logger.info(f"[open-orders] Returning {len(orders)} orders")
        return jsonify({'orders': orders})
    except Exception as e:
        logger.exception(f"Error getting open orders: {e}")
        return jsonify({'error': str(e), 'orders': []}), 500


@app.route('/api/cancel-order', methods=['POST'])
def api_cancel_order():
    """Cancel an open order"""
    try:
        # Get current user from session (same pattern as /api/trade)
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        wallet_address = user.address
        agent_key = user.get_agent_key()

        data = request.json
        oid = data.get('oid')
        coin = data.get('coin')

        if not oid or not coin:
            return jsonify({'success': False, 'error': 'Missing oid or coin'})

        result = bot_manager.cancel_order(wallet_address, agent_key, oid, coin)
        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error cancelling order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/limit-order', methods=['POST'])
def api_limit_order():
    """Place a limit order"""
    try:
        # Get current user from session (same pattern as /api/trade)
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        wallet_address = user.address
        agent_key = user.get_agent_key()

        data = request.json
        coin = data.get('coin')
        action = data.get('action')  # 'buy' or 'sell'
        limit_price = data.get('limit_price')
        collateral_usd = data.get('collateral_usd')
        leverage = data.get('leverage')
        reduce_only = data.get('reduce_only', False)

        if not all([coin, action, limit_price, collateral_usd, leverage]):
            return jsonify({'success': False, 'error': 'Missing required fields'})

        limit_price = float(limit_price)
        collateral_usd = float(collateral_usd)
        leverage = int(leverage)
        is_buy = action.lower() == 'buy'

        # Get asset metadata to calculate position size
        asset_meta = bot_manager.get_asset_metadata()
        coin_meta = asset_meta.get(coin, {})

        if not coin_meta:
            return jsonify({'success': False, 'error': f"Coin '{coin}' not found in Hyperliquid"})

        # Check and set leverage
        max_leverage = coin_meta.get('maxLeverage', 10)
        if leverage > max_leverage:
            return jsonify({'success': False, 'error': f"Leverage {leverage}x exceeds max allowed for {coin} ({max_leverage}x)"})

        # Set leverage using exchange
        _, exchange = bot_manager.get_exchange(wallet_address, agent_key)
        try:
            exchange.update_leverage(leverage, coin, is_cross=False)
        except Exception as lev_error:
            return jsonify({'success': False, 'error': f"Failed to set leverage: {str(lev_error)}"})

        # Calculate position size
        notional_value = collateral_usd * leverage
        size = notional_value / limit_price

        # Round size according to asset decimals
        sz_decimals = coin_meta.get('szDecimals', 2)
        size = round(size, sz_decimals)

        # Place limit order
        result = bot_manager.place_limit_order(
            coin, is_buy, size, limit_price,
            reduce_only=reduce_only,
            user_wallet=wallet_address,
            user_agent_key=agent_key
        )

        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error placing limit order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/modify-order', methods=['POST'])
def api_modify_order():
    """Modify an existing order"""
    try:
        # Get current user from session (same pattern as /api/trade)
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        wallet_address = user.address
        agent_key = user.get_agent_key()

        data = request.json
        coin = data.get('coin')
        oid = data.get('oid')
        new_price = data.get('new_price')
        new_size = data.get('new_size')  # Optional

        if not all([coin, oid, new_price]):
            return jsonify({'success': False, 'error': 'Missing required fields (coin, oid, new_price)'})

        new_price = float(new_price)
        new_size = float(new_size) if new_size else None

        result = bot_manager.modify_order(
            coin, oid, new_price, new_size,
            user_wallet=wallet_address,
            user_agent_key=agent_key
        )

        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error modifying order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/scale-order', methods=['POST'])
def api_scale_order():
    """Place a scale order (multiple limit orders with optional skew)"""
    try:
        # Get current user from session
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        wallet_address = user.address
        agent_key = user.get_agent_key()

        data = request.json
        coin = data.get('coin')
        action = data.get('action')  # 'buy' or 'sell'
        collateral_usd = data.get('collateral_usd')
        leverage = data.get('leverage')
        price_from = data.get('price_from')
        price_to = data.get('price_to')
        num_orders = data.get('num_orders', 5)
        skew = data.get('skew', 1.0)
        reduce_only = data.get('reduce_only', False)

        if not all([coin, action, collateral_usd, leverage, price_from, price_to]):
            return jsonify({'success': False, 'error': 'Missing required fields'})

        collateral_usd = float(collateral_usd)
        leverage = int(leverage)
        price_from = float(price_from)
        price_to = float(price_to)
        num_orders = int(num_orders)
        skew = float(skew)
        is_buy = action.lower() == 'buy'

        # Validation
        if num_orders < 2 or num_orders > 50:
            return jsonify({'success': False, 'error': 'Number of orders must be between 2 and 50'})
        if skew < 0.1 or skew > 10:
            return jsonify({'success': False, 'error': 'Skew must be between 0.1 and 10'})

        # Get asset metadata
        asset_meta = bot_manager.get_asset_metadata()
        coin_meta = asset_meta.get(coin, {})

        if not coin_meta:
            return jsonify({'success': False, 'error': f"Coin '{coin}' not found in Hyperliquid"})

        # Check and set leverage
        max_leverage = coin_meta.get('maxLeverage', 10)
        if leverage > max_leverage:
            return jsonify({'success': False, 'error': f"Leverage {leverage}x exceeds max allowed for {coin} ({max_leverage}x)"})

        # Set leverage
        _, exchange = bot_manager.get_exchange(wallet_address, agent_key)
        try:
            exchange.update_leverage(leverage, coin, is_cross=False)
        except Exception as lev_error:
            return jsonify({'success': False, 'error': f"Failed to set leverage: {str(lev_error)}"})

        # Calculate total size based on average price
        avg_price = (price_from + price_to) / 2
        notional_value = collateral_usd * leverage
        total_size = notional_value / avg_price

        # Get size decimals
        sz_decimals = coin_meta.get('szDecimals', 2)

        # Calculate price levels (evenly spaced, inclusive)
        prices = []
        for i in range(num_orders):
            price = price_from + (price_to - price_from) * i / (num_orders - 1)
            prices.append(float(f"{price:.5g}"))

        # Calculate size distribution with skew
        # If skew = 1.0, all orders have equal size
        # If skew > 1.0, later orders (towards price_to) are larger
        # If skew < 1.0, later orders are smaller
        # Formula: size_i = base_size * (1 + (skew - 1) * i / (n - 1))
        # We need to solve for base_size such that sum of all sizes = total_size

        if abs(skew - 1.0) < 0.001:
            # Equal distribution
            sizes = [total_size / num_orders] * num_orders
        else:
            # Calculate the sum of multipliers
            multipliers = []
            for i in range(num_orders):
                mult = 1 + (skew - 1) * i / (num_orders - 1)
                multipliers.append(mult)
            mult_sum = sum(multipliers)
            base_size = total_size / mult_sum
            sizes = [base_size * m for m in multipliers]

        # Round sizes
        sizes = [round(s, sz_decimals) for s in sizes]

        # Place limit orders with small delay to avoid rate limiting
        import time
        orders_placed = 0
        errors = []

        for i, (price, size) in enumerate(zip(prices, sizes)):
            if size <= 0:
                continue

            # Add delay between orders to avoid rate limiting (except first)
            if i > 0:
                time.sleep(0.15)  # 150ms delay between orders

            result = bot_manager.place_limit_order(
                coin, is_buy, size, price,
                reduce_only=reduce_only,
                user_wallet=wallet_address,
                user_agent_key=agent_key
            )

            if result.get('success'):
                orders_placed += 1
            else:
                errors.append(f"Order {i+1}: {result.get('error', 'Unknown error')}")

        if orders_placed == 0:
            return jsonify({'success': False, 'error': f"No orders placed. Errors: {'; '.join(errors)}"})

        return jsonify({
            'success': True,
            'orders_placed': orders_placed,
            'total_orders': num_orders,
            'errors': errors if errors else None
        })
    except Exception as e:
        logger.exception(f"Error placing scale order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/twap-order', methods=['POST'])
def api_twap_order():
    """Place a TWAP order"""
    try:
        # Get current user from session
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        wallet_address = user.address
        agent_key = user.get_agent_key()

        data = request.json
        coin = data.get('coin')
        action = data.get('action')  # 'buy' or 'sell'
        collateral_usd = data.get('collateral_usd')
        leverage = data.get('leverage')
        hours = data.get('hours', 0)
        minutes = data.get('minutes', 30)
        randomize = data.get('randomize', False)

        if not all([coin, action, collateral_usd, leverage]):
            return jsonify({'success': False, 'error': 'Missing required fields'})

        collateral_usd = float(collateral_usd)
        leverage = int(leverage)
        hours = int(hours)
        minutes = int(minutes)

        # Calculate total duration in minutes
        duration_minutes = (hours * 60) + minutes
        if duration_minutes < 5:
            return jsonify({'success': False, 'error': 'TWAP duration must be at least 5 minutes'})

        is_buy = action.lower() == 'buy'

        # Get asset metadata
        asset_meta = bot_manager.get_asset_metadata()
        coin_meta = asset_meta.get(coin, {})

        if not coin_meta:
            return jsonify({'success': False, 'error': f"Coin '{coin}' not found in Hyperliquid"})

        # Check and set leverage
        max_leverage = coin_meta.get('maxLeverage', 10)
        if leverage > max_leverage:
            return jsonify({'success': False, 'error': f"Leverage {leverage}x exceeds max allowed for {coin} ({max_leverage}x)"})

        # Set leverage
        _, exchange = bot_manager.get_exchange(wallet_address, agent_key)
        try:
            exchange.update_leverage(leverage, coin, is_cross=False)
        except Exception as lev_error:
            return jsonify({'success': False, 'error': f"Failed to set leverage: {str(lev_error)}"})

        # Get current price to calculate size
        prices = bot_manager.get_market_prices([coin])
        current_price = prices.get(coin, 0)
        if not current_price:
            return jsonify({'success': False, 'error': f"Could not get price for {coin}"})

        # Calculate position size
        notional_value = collateral_usd * leverage
        size = notional_value / current_price

        # Round size
        sz_decimals = coin_meta.get('szDecimals', 2)
        size = round(size, sz_decimals)

        # Place TWAP order
        result = bot_manager.place_twap_order(
            coin, is_buy, size, duration_minutes, randomize,
            reduce_only=False,
            user_wallet=wallet_address,
            user_agent_key=agent_key
        )

        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error placing TWAP order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/twap-cancel', methods=['POST'])
def api_twap_cancel():
    """Cancel a TWAP order"""
    try:
        # Get current user from session
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        wallet_address = user.address
        agent_key = user.get_agent_key()

        data = request.json
        coin = data.get('coin')
        twap_id = data.get('twap_id')

        if not coin or not twap_id:
            return jsonify({'success': False, 'error': 'Missing coin or twap_id'})

        result = bot_manager.cancel_twap_order(
            coin, int(twap_id),
            user_wallet=wallet_address,
            user_agent_key=agent_key
        )

        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error canceling TWAP order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/twap-history', methods=['GET'])
def api_twap_history():
    """Get TWAP order history"""
    try:
        wallet_address = request.args.get('address')
        if not wallet_address:
            return jsonify({'success': False, 'error': 'Missing address parameter'})

        result = bot_manager.get_twap_history(wallet_address)
        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error getting TWAP history: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/transfer-usdc', methods=['POST'])
def api_transfer_usdc():
    """Transfer USDC between Spot and Perps accounts"""
    try:
        # Check if wallet is connected and authorized
        wallet_address = session.get('wallet_address')
        agent_key = session.get('agent_private_key')

        if not wallet_address or not agent_key:
            return jsonify({'success': False, 'error': 'Not authorized. Please connect and authorize your wallet.'})

        data = request.json
        direction = data.get('direction')  # 'spotToPerp' or 'perpToSpot'
        amount = data.get('amount')

        if not direction or not amount:
            return jsonify({'success': False, 'error': 'Missing direction or amount'})

        amount = float(amount)
        if amount <= 0:
            return jsonify({'success': False, 'error': 'Amount must be greater than 0'})

        # Convert direction to toPerp boolean
        to_perp = direction == 'spotToPerp'

        result = bot_manager.transfer_usdc(wallet_address, agent_key, amount, to_perp)
        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error transferring USDC: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/asset-meta', methods=['GET'])
def api_asset_metadata():
    """Get asset metadata from database (no API call - use /api/asset-meta/refresh to update)"""
    try:
        # Return metadata from database - no API call needed
        configs = CoinConfig.query.all()
        meta = {}
        for config in configs:
            meta[config.coin] = {
                'szDecimals': config.hl_sz_decimals,
                'maxLeverage': config.hl_max_leverage,
                'onlyIsolated': config.hl_only_isolated
            }
        return jsonify(meta)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/asset-meta/refresh', methods=['POST'])
def api_refresh_asset_metadata():
    """Refresh asset metadata from Hyperliquid API and store in database"""
    try:
        # Fetch fresh metadata from Hyperliquid API
        meta = bot_manager.get_asset_metadata(force_refresh=True)

        if not meta:
            return jsonify({'success': False, 'error': 'Failed to fetch metadata from API'}), 500

        updated_count = 0
        now = datetime.utcnow()

        for coin, data in meta.items():
            config = CoinConfig.query.filter_by(coin=coin).first()
            if config:
                # Update existing config
                config.hl_max_leverage = data.get('maxLeverage', 10)
                config.hl_sz_decimals = data.get('szDecimals', 2)
                config.hl_only_isolated = data.get('onlyIsolated', False)
                config.hl_metadata_updated = now
                updated_count += 1

        db.session.commit()

        log_activity('info', 'system', f'Refreshed Hyperliquid metadata for {updated_count} coins')
        return jsonify({
            'success': True,
            'updated': updated_count,
            'total_coins': len(meta)
        })

    except Exception as e:
        logger.exception(f"Error refreshing metadata: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stats/daily', methods=['GET'])
def api_daily_stats():
    """Get daily trading statistics"""
    try:
        # Get account info for risk calculations
        account_value = None
        total_margin_used = None
        has_positions = False
        try:
            # Try to get user-specific account info if connected
            user = get_current_user()
            if user and user.has_agent_key():
                account_info = bot_manager.get_account_info(
                    user_wallet=user.address,
                    user_agent_key=user.get_agent_key()
                )
            else:
                account_info = {}
            if account_info and 'account_value' in account_info:
                account_value = account_info['account_value']
            if account_info and 'total_margin_used' in account_info:
                total_margin_used = account_info['total_margin_used']
            # Check if there are actual positions on the exchange
            if account_info and account_info.get('positions'):
                has_positions = len(account_info['positions']) > 0
        except:
            pass

        stats = risk_manager.get_daily_stats(account_value, total_margin_used, has_positions)
        return jsonify(stats)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/activity', methods=['GET'])
def api_activity():
    """Get recent activity logs"""
    try:
        limit = int(request.args.get('limit', 20))
        logs = ActivityLog.query.order_by(ActivityLog.timestamp.desc()).limit(limit).all()
        return jsonify({'logs': [log.to_dict() for log in logs]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================================
# API ROUTES - Trading
# ============================================================================

@app.route('/api/trade', methods=['POST'])
def api_trade():
    """Execute a manual trade"""
    try:
        # Get current user from session
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No trade data provided'}), 400

        coin = data.get('coin', '').strip()  # Preserve case - Hyperliquid uses case-sensitive names like kBONK
        action = data.get('action', '').lower().strip()

        # Input validation
        if not coin:
            return jsonify({'success': False, 'error': 'Coin is required'}), 400

        if action not in ('buy', 'sell'):
            return jsonify({'success': False, 'error': 'Invalid action. Must be "buy" or "sell"'}), 400

        try:
            leverage = int(data.get('leverage', 10))
        except (TypeError, ValueError):
            return jsonify({'success': False, 'error': 'Invalid leverage value'}), 400

        try:
            collateral_usd = float(data.get('collateral_usd', 100))
        except (TypeError, ValueError):
            return jsonify({'success': False, 'error': 'Invalid collateral value'}), 400

        # Validate ranges
        if leverage < 1 or leverage > 100:
            return jsonify({'success': False, 'error': 'Leverage must be between 1 and 100'}), 400

        if collateral_usd <= 0:
            return jsonify({'success': False, 'error': 'Collateral must be a positive amount'}), 400

        if collateral_usd < 1:
            return jsonify({'success': False, 'error': 'Minimum collateral is $1'}), 400

        if collateral_usd > 100000:
            return jsonify({'success': False, 'error': 'Maximum collateral is $100,000 per trade'}), 400

        stop_loss_pct = data.get('stop_loss_pct')
        take_profit_pct = data.get('take_profit_pct')
        tp1_pct = data.get('tp1_pct')
        tp1_size_pct = data.get('tp1_size_pct')
        tp2_pct = data.get('tp2_pct')
        tp2_size_pct = data.get('tp2_size_pct')

        # Check if bot is enabled
        if not bot_manager.is_enabled:
            return jsonify({'success': False, 'error': 'Bot is disabled'})

        # Risk check
        allowed, reason = risk_manager.check_trading_allowed(coin, collateral_usd, leverage)
        if not allowed:
            log_activity('warning', 'risk', f"Trade blocked: {reason}", {'coin': coin})
            return jsonify({'success': False, 'error': reason})

        # Get coin config for defaults
        coin_config = risk_manager.get_coin_config(coin)
        if stop_loss_pct is None and coin_config.default_stop_loss_pct:
            stop_loss_pct = coin_config.default_stop_loss_pct
        if take_profit_pct is None and coin_config.default_take_profit_pct:
            take_profit_pct = coin_config.default_take_profit_pct
        # Use coin config defaults for TP1/TP2 if not provided
        if tp1_pct is None and coin_config.tp1_pct:
            tp1_pct = coin_config.tp1_pct
        if tp1_size_pct is None and coin_config.tp1_size_pct:
            tp1_size_pct = coin_config.tp1_size_pct
        if tp2_pct is None and coin_config.tp2_pct:
            tp2_pct = coin_config.tp2_pct
        if tp2_size_pct is None and coin_config.tp2_size_pct:
            tp2_size_pct = coin_config.tp2_size_pct

        # Execute trade with user credentials
        result = bot_manager.execute_trade(
            coin=coin,
            action=action,
            leverage=leverage,
            collateral_usd=collateral_usd,
            stop_loss_pct=stop_loss_pct,
            take_profit_pct=take_profit_pct,
            tp1_pct=tp1_pct,
            tp1_size_pct=tp1_size_pct,
            tp2_pct=tp2_pct,
            tp2_size_pct=tp2_size_pct,
            user_wallet=user.address,
            user_agent_key=user.get_agent_key()
        )

        if result.get('success'):
            # Record trade in database
            trade = Trade(
                coin=coin,
                action=action,
                side='long' if action == 'buy' else 'short',
                size=result['size'],
                entry_price=result['entry_price'],
                leverage=leverage,
                collateral_usd=collateral_usd,
                stop_loss=result.get('stop_loss'),
                take_profit=result.get('take_profit'),
                order_id=result.get('order_id'),
                status='open'
            )
            db.session.add(trade)
            db.session.commit()

            log_activity('info', 'trade',
                        f"Opened {action.upper()} {coin} @ ${result['entry_price']:.2f}",
                        result)

        return jsonify(result)

    except ValueError as e:
        logger.warning(f"Trade validation error: {e}")
        db.session.rollback()
        return jsonify({'success': False, 'error': f'Invalid input: {str(e)}'}), 400
    except Exception as e:
        logger.exception(f"Trade error: {e}")
        db.session.rollback()
        # Provide user-friendly error message
        error_msg = str(e)
        if 'insufficient' in error_msg.lower():
            error_msg = 'Insufficient balance to execute this trade'
        elif 'rate limit' in error_msg.lower() or '429' in error_msg:
            error_msg = 'Too many requests. Please wait a moment and try again.'
        elif 'timeout' in error_msg.lower():
            error_msg = 'Request timed out. Please try again.'
        return jsonify({'success': False, 'error': error_msg}), 500


@app.route('/api/close', methods=['POST'])
def api_close_position():
    """Close a position"""
    try:
        # Get current user from session
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        data = request.get_json()
        coin = data.get('coin', '')  # Preserve case - Hyperliquid uses case-sensitive names

        if not coin:
            return jsonify({'success': False, 'error': 'Coin is required'})

        result = bot_manager.close_position(
            coin,
            user_wallet=user.address,
            user_agent_key=user.get_agent_key()
        )

        if result.get('success'):
            # Update trade in database
            trade = Trade.query.filter_by(coin=coin, status='open').first()
            if trade:
                # Get current price for P&L calculation
                prices = bot_manager.get_market_prices([coin])
                exit_price = prices.get(coin, trade.entry_price)

                pnl, pnl_pct = risk_manager.calculate_pnl(trade, exit_price)

                trade.exit_price = exit_price
                trade.pnl = pnl
                trade.pnl_percent = pnl_pct
                trade.status = 'closed'
                trade.close_reason = 'manual'
                db.session.commit()

                risk_manager.record_trade_result(pnl)

                log_activity('info', 'trade',
                            f"Closed {coin} position with P&L: ${pnl:.2f}",
                            {'coin': coin, 'pnl': pnl})

        return jsonify(result)

    except Exception as e:
        logger.exception(f"Close position error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/close-all', methods=['POST'])
def api_close_all():
    """Close all open positions"""
    try:
        # Get current user from session
        user = get_current_user()
        if not user or not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please connect and authorize your wallet first'}), 401

        account = bot_manager.get_account_info(
            user_wallet=user.address,
            user_agent_key=user.get_agent_key()
        )
        positions = account.get('positions', [])

        # Get current prices for all positions to calculate P&L
        coins = [pos['coin'] for pos in positions]
        prices = bot_manager.get_market_prices(coins) if coins else {}

        results = []
        total_pnl = 0
        for pos in positions:
            coin = pos['coin']
            result = bot_manager.close_position(
                coin,
                user_wallet=user.address,
                user_agent_key=user.get_agent_key()
            )

            # Update trade record with exit price and P&L
            if result.get('success'):
                trade = Trade.query.filter_by(coin=coin, status='open').first()
                if trade:
                    exit_price = prices.get(coin, trade.entry_price)
                    pnl, pnl_pct = risk_manager.calculate_pnl(trade, exit_price)

                    trade.exit_price = exit_price
                    trade.pnl = pnl
                    trade.pnl_percent = pnl_pct
                    trade.status = 'closed'
                    trade.close_reason = 'manual'
                    db.session.commit()

                    risk_manager.record_trade_result(pnl)
                    total_pnl += pnl

                    result['exit_price'] = exit_price
                    result['pnl'] = pnl
                    result['pnl_percent'] = pnl_pct

            results.append({'coin': coin, 'result': result})

        log_activity('info', 'trade', f"Closed all positions ({len(positions)} total) with P&L: ${total_pnl:.2f}")

        return jsonify({'success': True, 'results': results, 'total_pnl': total_pnl})

    except Exception as e:
        logger.exception(f"Close all error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/bot/toggle', methods=['POST'])
def api_bot_toggle():
    """Toggle bot enabled/disabled"""
    try:
        data = request.get_json()
        enabled = data.get('enabled', True)

        if enabled:
            bot_manager.enable()
        else:
            bot_manager.disable()

        BotConfig.set('bot_enabled', str(enabled).lower())
        log_activity('info', 'system', f"Bot {'enabled' if enabled else 'disabled'}")

        return jsonify({'success': True, 'enabled': enabled})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ============================================================================
# API ROUTES - Trade History
# ============================================================================

@app.route('/api/trades', methods=['GET'])
def api_trades():
    """Get trade history"""
    try:
        coin = request.args.get('coin')
        side = request.args.get('side')
        status = request.args.get('status')
        result = request.args.get('result')
        date_range = request.args.get('date_range', 'all')
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 50))

        query = Trade.query

        if coin:
            query = query.filter_by(coin=coin)
        if side:
            query = query.filter_by(side=side)
        if status:
            query = query.filter_by(status=status)
        if result == 'win':
            query = query.filter(Trade.pnl > 0)
        elif result == 'loss':
            query = query.filter(Trade.pnl < 0)

        if date_range == 'today':
            today = datetime.utcnow().replace(hour=0, minute=0, second=0)
            query = query.filter(Trade.timestamp >= today)
        elif date_range == 'week':
            week_ago = datetime.utcnow() - timedelta(days=7)
            query = query.filter(Trade.timestamp >= week_ago)
        elif date_range == 'month':
            month_ago = datetime.utcnow() - timedelta(days=30)
            query = query.filter(Trade.timestamp >= month_ago)

        trades = query.order_by(Trade.timestamp.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )

        # Calculate stats using SQL aggregates for better performance
        from sqlalchemy import func, case

        # Get aggregate stats in a single query
        stats_query = db.session.query(
            func.count(Trade.id).label('total_trades'),
            func.sum(Trade.pnl).label('total_pnl'),
            func.max(Trade.pnl).label('best_trade'),
            func.count(case((Trade.pnl > 0, 1))).label('win_count'),
            func.count(case((Trade.pnl < 0, 1))).label('loss_count'),
            func.sum(case((Trade.pnl > 0, Trade.pnl), else_=0)).label('total_wins'),
            func.sum(case((Trade.pnl < 0, Trade.pnl), else_=0)).label('total_losses')
        ).filter(Trade.status == 'closed').first()

        total_trades = stats_query.total_trades or 0
        win_count = stats_query.win_count or 0
        loss_count = stats_query.loss_count or 0

        stats = {
            'total_trades': total_trades,
            'win_rate': (win_count / total_trades * 100) if total_trades > 0 else 0,
            'total_pnl': float(stats_query.total_pnl or 0),
            'avg_win': float(stats_query.total_wins or 0) / win_count if win_count > 0 else 0,
            'avg_loss': float(stats_query.total_losses or 0) / loss_count if loss_count > 0 else 0,
            'best_trade': float(stats_query.best_trade or 0)
        }

        return jsonify({
            'trades': [t.to_dict() for t in trades.items],
            'stats': stats,
            'page': page,
            'total_pages': trades.pages,
            'total': trades.total
        })

    except Exception as e:
        logger.exception(f"Error getting trades: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trades/export', methods=['GET'])
def api_export_trades():
    """Export trades as CSV"""
    try:
        trades = Trade.query.order_by(Trade.timestamp.desc()).all()

        csv_lines = ['timestamp,coin,side,entry_price,exit_price,size,leverage,pnl,pnl_percent,status,close_reason']
        for t in trades:
            csv_lines.append(f"{t.timestamp},{t.coin},{t.side},{t.entry_price},{t.exit_price or ''},{t.size},{t.leverage},{t.pnl or ''},{t.pnl_percent or ''},{t.status},{t.close_reason or ''}")

        from flask import Response
        return Response(
            '\n'.join(csv_lines),
            mimetype='text/csv',
            headers={'Content-Disposition': 'attachment;filename=trades.csv'}
        )

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================================
# API ROUTES - Indicators
# ============================================================================

@app.route('/api/indicators', methods=['GET'])
def api_get_indicators():
    """Get all indicators"""
    try:
        indicators = Indicator.query.all()
        return jsonify({'indicators': [ind.to_dict() for ind in indicators]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/indicators', methods=['POST'])
def api_create_indicator():
    """Create a new indicator"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No data provided'}), 400

        name = data.get('name', '').strip()
        if not name:
            return jsonify({'success': False, 'error': 'Indicator name is required'}), 400

        indicator = Indicator(
            name=name,
            indicator_type=data.get('indicator_type'),
            description=data.get('description'),
            webhook_key=data.get('webhook_key'),
            timeframe=data.get('timeframe', '1h'),
            coins=json.dumps(data.get('coins', []))
        )
        db.session.add(indicator)
        db.session.commit()

        log_activity('info', 'system', f"Created indicator: {indicator.name}")

        return jsonify({'success': True, 'indicator': indicator.to_dict()})

    except Exception as e:
        db.session.rollback()
        logger.exception(f"Error creating indicator: {e}")
        return jsonify({'success': False, 'error': 'Failed to create indicator. Please try again.'}), 500


@app.route('/api/indicators/<int:id>', methods=['PUT'])
def api_update_indicator(id):
    """Update an indicator"""
    try:
        data = request.get_json()
        indicator = Indicator.query.get_or_404(id)

        if 'enabled' in data:
            indicator.enabled = data['enabled']
        if 'name' in data:
            indicator.name = data['name']
        if 'timeframe' in data:
            indicator.timeframe = data['timeframe']
        if 'coins' in data:
            indicator.coins = json.dumps(data['coins'])

        db.session.commit()

        return jsonify({'success': True})

    except Exception as e:
        db.session.rollback()
        logger.exception(f"Error updating indicator: {e}")
        return jsonify({'success': False, 'error': 'Failed to update indicator. Please try again.'}), 500


@app.route('/api/indicators/<int:id>', methods=['DELETE'])
def api_delete_indicator(id):
    """Delete an indicator"""
    try:
        indicator = Indicator.query.get_or_404(id)
        name = indicator.name
        db.session.delete(indicator)
        db.session.commit()

        log_activity('info', 'system', f"Deleted indicator: {name}")

        return jsonify({'success': True})

    except Exception as e:
        db.session.rollback()
        logger.exception(f"Error deleting indicator: {e}")
        return jsonify({'success': False, 'error': 'Failed to delete indicator. Please try again.'}), 500


# ============================================================================
# API ROUTES - Settings
# ============================================================================

@app.route('/api/settings', methods=['GET'])
def api_get_settings():
    """Get all settings"""
    try:
        risk = RiskSettings.query.first()

        # Debug: log the actual value
        logger.info(f"[SETTINGS] USE_TESTNET={USE_TESTNET}, returning use_testnet='{str(USE_TESTNET).lower()}'")

        return jsonify({
            'bot_enabled': BotConfig.get('bot_enabled', 'true'),
            'use_testnet': str(USE_TESTNET).lower(),  # Use actual environment variable
            'network': 'testnet' if USE_TESTNET else 'mainnet',  # Add explicit network field
            'default_leverage': BotConfig.get('default_leverage', '3'),
            'default_collateral': BotConfig.get('default_collateral', '100'),
            'slippage_tolerance': BotConfig.get('slippage_tolerance', '0.003'),
            'risk': risk.to_dict() if risk else {},
            'main_wallet': MAIN_WALLET_ADDRESS[:10] + '...' + MAIN_WALLET_ADDRESS[-6:] if MAIN_WALLET_ADDRESS else None,
            'api_secret_configured': bool(API_WALLET_SECRET),
            'webhook_secret': bool(WEBHOOK_SECRET and WEBHOOK_SECRET != 'your-secret-key-change-me')
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/settings', methods=['POST'])
def api_save_settings():
    """Save general settings"""
    try:
        data = request.get_json()

        for key in ['bot_enabled', 'use_testnet', 'default_leverage', 'default_collateral', 'slippage_tolerance']:
            if key in data:
                BotConfig.set(key, str(data[key]))

        log_activity('info', 'system', 'Settings updated')

        return jsonify({'success': True})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/settings/risk', methods=['POST'])
def api_save_risk_settings():
    """Save risk management settings"""
    try:
        data = request.get_json()
        risk = RiskSettings.query.first()

        if not risk:
            risk = RiskSettings()
            db.session.add(risk)

        for key in ['max_position_value_usd', 'max_total_exposure_pct', 'max_leverage']:
            if key in data:
                setattr(risk, key, data[key])

        db.session.commit()

        log_activity('info', 'system', 'Risk settings updated')

        return jsonify({'success': True})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/coins', methods=['GET'])
def api_get_coins():
    """Get coin configurations"""
    try:
        coins = CoinConfig.query.all()
        return jsonify({'coins': [c.to_dict() for c in coins]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/coins/list', methods=['GET'])
def api_get_coins_list():
    """
    Lightweight endpoint for Quick Trade dropdown.
    Returns only essential fields: coin name, category, max leverage.
    Much faster than /api/coins for dropdown population.
    """
    try:
        # Use a targeted query selecting only needed columns
        coins = db.session.query(
            CoinConfig.coin,
            CoinConfig.category,
            CoinConfig.hl_max_leverage,
            CoinConfig.enabled
        ).filter(CoinConfig.enabled == True).all()

        return jsonify({
            'coins': [
                {
                    'coin': c.coin,
                    'category': c.category or 'L1s',
                    'hl_max_leverage': c.hl_max_leverage or 50
                }
                for c in coins
            ]
        })
    except Exception as e:
        logger.exception(f"Error getting coins list: {e}")
        return jsonify({'error': 'Failed to load coins'}), 500


@app.route('/api/coins/cleanup-duplicates', methods=['POST'])
def api_cleanup_duplicates():
    """Remove duplicate coin entries (case variations like KBONK vs kBONK)"""
    try:
        coins = CoinConfig.query.all()

        # Find duplicates by lowercase name
        seen = {}
        duplicates = []

        for coin in coins:
            lower_name = coin.coin.lower()
            if lower_name in seen:
                # This is a duplicate - decide which to keep
                existing = seen[lower_name]
                # Prefer the one with metadata (hl_max_leverage set) or the one that matches Hyperliquid casing
                # Hyperliquid uses kBONK, kPEPE (lowercase k prefix)
                if coin.coin.startswith('k') and not existing.coin.startswith('k'):
                    # New one has correct casing, remove old one
                    duplicates.append(existing)
                    seen[lower_name] = coin
                elif existing.coin.startswith('k') and not coin.coin.startswith('k'):
                    # Old one has correct casing, remove new one
                    duplicates.append(coin)
                elif coin.hl_max_leverage and not existing.hl_max_leverage:
                    # New one has metadata, remove old one
                    duplicates.append(existing)
                    seen[lower_name] = coin
                else:
                    # Default: keep existing, remove new
                    duplicates.append(coin)
            else:
                seen[lower_name] = coin

        # Remove duplicates
        removed = []
        for dup in duplicates:
            removed.append(dup.coin)
            db.session.delete(dup)

        # Also ensure kBONK and kPEPE are in MEMES category (not L1s)
        fixed_categories = []
        for coin_name, coin in seen.items():
            if coin_name in ['kbonk', 'kpepe'] and coin.category != 'MEMES':
                coin.category = 'MEMES'
                fixed_categories.append(coin.coin)

        db.session.commit()

        message = f'Removed {len(removed)} duplicate coins'
        if removed:
            message += f': {", ".join(removed)}'
        if fixed_categories:
            message += f'. Fixed category for: {", ".join(fixed_categories)}'

        return jsonify({
            'success': True,
            'removed': removed,
            'fixed_categories': fixed_categories,
            'message': message
        })

    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/coins/<coin>', methods=['GET'])
def api_get_coin(coin):
    """Get single coin configuration"""
    try:
        # Preserve case - Hyperliquid uses case-sensitive names like kBONK
        config = CoinConfig.query.filter_by(coin=coin).first()
        if config:
            return jsonify(config.to_dict())
        return jsonify({'error': 'Coin not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/coins/<coin>', methods=['PUT'])
def api_update_coin(coin):
    """Update coin configuration"""
    try:
        data = request.get_json()
        # Preserve case - Hyperliquid uses case-sensitive names like kBONK
        config = CoinConfig.query.filter_by(coin=coin).first()

        if not config:
            config = CoinConfig(coin=coin)
            db.session.add(config)

        for key in ['enabled', 'category', 'default_leverage', 'default_collateral', 'max_position_size',
                    'max_open_positions', 'default_stop_loss_pct',
                    'tp1_pct', 'tp1_size_pct', 'tp2_pct', 'tp2_size_pct',
                    'use_trailing_stop', 'trailing_stop_pct']:
            if key in data:
                setattr(config, key, data[key])

        db.session.commit()

        return jsonify({'success': True})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/coins/bulk-update', methods=['PUT'])
def api_bulk_update_coins():
    """Update all coin configurations with the same settings"""
    try:
        data = request.get_json()
        coins = CoinConfig.query.all()
        updated = 0

        for config in coins:
            for key in ['default_leverage', 'default_collateral', 'max_position_size',
                        'default_stop_loss_pct', 'tp1_pct', 'tp1_size_pct',
                        'tp2_pct', 'tp2_size_pct']:
                if key in data and data[key] is not None:
                    setattr(config, key, data[key])
            updated += 1

        db.session.commit()

        return jsonify({'success': True, 'updated': updated})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/coins/refresh-leverage', methods=['POST'])
def api_refresh_leverage():
    """Refresh max leverage, margin mode, and quote asset data from Hyperliquid API"""
    import requests
    from datetime import datetime

    try:
        # Step 1: Fetch spotMeta for token list (to map collateralToken indices to names)
        spot_response = requests.post(
            'https://api.hyperliquid.xyz/info',
            json={'type': 'spotMeta'},
            headers={'Content-Type': 'application/json'},
            timeout=10
        )

        token_map = {0: 'USDC'}  # Default: index 0 is USDC
        if spot_response.status_code == 200:
            spot_data = spot_response.json()
            tokens = spot_data.get('tokens', [])
            for token in tokens:
                token_index = token.get('index')
                token_name = token.get('name')
                if token_index is not None and token_name:
                    token_map[token_index] = token_name

        # Step 2: Fetch standard perpetuals metadata from Hyperliquid
        response = requests.post(
            'https://api.hyperliquid.xyz/info',
            json={'type': 'meta'},
            headers={'Content-Type': 'application/json'},
            timeout=10
        )

        if response.status_code != 200:
            return jsonify({'success': False, 'error': f'Hyperliquid API error: {response.status_code}'}), 500

        data = response.json()
        universe = data.get('universe', [])

        if not universe:
            return jsonify({'success': False, 'error': 'No perpetuals data returned from Hyperliquid'}), 500

        # Build maps of coin name -> metadata (exact match and lowercase for fallback)
        hl_metadata = {}
        hl_metadata_lower = {}
        for asset in universe:
            name = asset.get('name')
            if name:
                collateral_token = asset.get('collateralToken', 0)
                meta = {
                    'maxLeverage': asset.get('maxLeverage', 50),
                    'szDecimals': asset.get('szDecimals', 2),
                    'onlyIsolated': asset.get('onlyIsolated', False),
                    'marginMode': asset.get('marginMode'),  # strictIsolated, noCross, or None
                    'quoteAsset': token_map.get(collateral_token, 'USDC')
                }
                hl_metadata[name] = meta
                hl_metadata_lower[name.lower()] = meta

        # Step 3: Get all coins and identify HIP-3 perps (format: dex:TICKER)
        coins = CoinConfig.query.all()
        hip3_dexes = set()

        for config in coins:
            if ':' in config.coin:
                dex_name = config.coin.split(':')[0].lower()
                hip3_dexes.add(dex_name)

        # Step 4: Fetch metadata for each HIP-3 DEX
        for dex_name in hip3_dexes:
            try:
                dex_response = requests.post(
                    'https://api.hyperliquid.xyz/info',
                    json={'type': 'meta', 'dex': dex_name},
                    headers={'Content-Type': 'application/json'},
                    timeout=10
                )

                if dex_response.status_code == 200:
                    dex_data = dex_response.json()
                    dex_universe = dex_data.get('universe', [])
                    # collateralToken is at the TOP LEVEL of the response for HIP-3 DEXes
                    # All perps in this DEX share the same collateral token
                    dex_collateral_token = dex_data.get('collateralToken', 0)
                    dex_quote_asset = token_map.get(dex_collateral_token, 'USDC')

                    for asset in dex_universe:
                        name = asset.get('name')
                        if name:
                            meta = {
                                'maxLeverage': asset.get('maxLeverage', 50),
                                'szDecimals': asset.get('szDecimals', 2),
                                'onlyIsolated': asset.get('onlyIsolated', False),
                                'marginMode': asset.get('marginMode'),
                                'quoteAsset': dex_quote_asset  # Use DEX-level collateral token
                            }
                            hl_metadata[name] = meta
                            hl_metadata_lower[name.lower()] = meta
            except Exception as e:
                # Continue with other DEXes if one fails
                pass

        # Step 5: Update all coin configs with the metadata
        updated = 0
        not_found = []

        for config in coins:
            # Try exact match first, then case-insensitive match
            meta = hl_metadata.get(config.coin) or hl_metadata_lower.get(config.coin.lower())
            if meta:
                config.hl_max_leverage = meta['maxLeverage']
                config.hl_sz_decimals = meta['szDecimals']
                config.hl_only_isolated = meta['onlyIsolated']
                config.hl_margin_mode = meta['marginMode']
                config.quote_asset = meta['quoteAsset']
                config.hl_metadata_updated = datetime.utcnow()
                updated += 1
            else:
                not_found.append(config.coin)

        db.session.commit()

        return jsonify({
            'success': True,
            'updated': updated,
            'not_found': not_found,
            'message': f'Updated {updated} coins with Hyperliquid metadata'
        })

    except requests.exceptions.Timeout:
        return jsonify({'success': False, 'error': 'Hyperliquid API timeout'}), 500
    except requests.exceptions.RequestException as e:
        return jsonify({'success': False, 'error': f'Network error: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/coins/add', methods=['POST'])
def api_add_coin():
    """Add a new perpetual coin by fetching its metadata from Hyperliquid"""
    import requests
    from datetime import datetime

    try:
        data = request.get_json()
        ticker = data.get('ticker', '').strip().upper()
        is_hip3 = data.get('is_hip3', False)
        dex_name = data.get('dex_name', '').strip().lower()
        category = data.get('category', 'L1s')

        if not ticker:
            return jsonify({'success': False, 'error': 'Ticker is required'}), 400

        # Build the coin name based on HIP-3 status
        if is_hip3:
            if not dex_name:
                return jsonify({'success': False, 'error': 'DEX name is required for HIP-3 perpetuals'}), 400
            coin_name = f"{dex_name}:{ticker}"
        else:
            coin_name = ticker

        # Check if coin already exists (case-insensitive check)
        existing = CoinConfig.query.filter(
            db.func.lower(CoinConfig.coin) == coin_name.lower()
        ).first()
        if existing:
            return jsonify({'success': False, 'error': f'Coin {existing.coin} already exists'}), 400

        # Fetch spotMeta for token list (to map collateralToken indices to names)
        token_map = {0: 'USDC'}  # Default: index 0 is USDC
        try:
            spot_response = requests.post(
                'https://api.hyperliquid.xyz/info',
                json={'type': 'spotMeta'},
                headers={'Content-Type': 'application/json'},
                timeout=10
            )
            if spot_response.status_code == 200:
                spot_data = spot_response.json()
                tokens = spot_data.get('tokens', [])
                for token in tokens:
                    token_index = token.get('index')
                    token_name = token.get('name')
                    if token_index is not None and token_name:
                        token_map[token_index] = token_name
        except Exception:
            pass  # Continue with default token map

        # Fetch metadata from Hyperliquid to verify the coin exists
        if is_hip3:
            # For HIP-3 perps, use meta endpoint with dex parameter
            response = requests.post(
                'https://api.hyperliquid.xyz/info',
                json={'type': 'meta', 'dex': dex_name},
                headers={'Content-Type': 'application/json'},
                timeout=10
            )
        else:
            # For regular perps, fetch from meta endpoint (empty dex = first perp dex)
            response = requests.post(
                'https://api.hyperliquid.xyz/info',
                json={'type': 'meta'},
                headers={'Content-Type': 'application/json'},
                timeout=10
            )

        if response.status_code != 200:
            return jsonify({'success': False, 'error': f'Hyperliquid API error: {response.status_code}'}), 500

        api_data = response.json()

        # Find the coin in the API response (universe array)
        coin_meta = None
        universe = api_data.get('universe', [])

        for asset in universe:
            name = asset.get('name', '')
            if is_hip3:
                # For HIP-3, match {dex}:{TICKER} format or just TICKER within the dex
                if name.lower() == coin_name.lower() or name.lower() == ticker.lower():
                    coin_meta = asset
                    coin_name = name  # Use exact casing from API
                    break
            else:
                # Regular perps - match ticker
                if name.lower() == ticker.lower():
                    coin_meta = asset
                    coin_name = name  # Use exact casing from API
                    break

        if not coin_meta:
            error_msg = f'Coin {ticker} not found'
            if is_hip3:
                error_msg += f' in DEX "{dex_name}". Make sure the DEX name is correct (e.g., "xyz" not "xyz:").'
            else:
                error_msg += ' on Hyperliquid. Check the ticker spelling.'
            return jsonify({'success': False, 'error': error_msg}), 404

        # Get quote asset from collateralToken
        # For HIP-3 perps, collateralToken is at the TOP LEVEL of the response (DEX-wide)
        # For regular perps, it's 0 (USDC) by default
        if is_hip3:
            collateral_token = api_data.get('collateralToken', 0)
        else:
            collateral_token = 0  # Regular perps use USDC
        quote_asset = token_map.get(collateral_token, 'USDC')

        # Create new coin config with metadata from API
        new_coin = CoinConfig(
            coin=coin_name,
            quote_asset=quote_asset,
            category=category,
            enabled=True,
            default_leverage=3,
            default_collateral=100.0,
            max_position_size=1000.0,
            default_stop_loss_pct=15.0,
            tp1_pct=50.0,
            tp1_size_pct=25.0,
            tp2_pct=100.0,
            tp2_size_pct=50.0,
            hl_max_leverage=coin_meta.get('maxLeverage', 50),
            hl_sz_decimals=coin_meta.get('szDecimals', 2),
            hl_only_isolated=coin_meta.get('onlyIsolated', False),
            hl_margin_mode=coin_meta.get('marginMode'),
            hl_metadata_updated=datetime.utcnow()
        )

        db.session.add(new_coin)
        db.session.commit()

        return jsonify({
            'success': True,
            'coin': new_coin.to_dict(),
            'message': f'Successfully added {coin_name} (Quote: {quote_asset})'
        })

    except requests.exceptions.Timeout:
        return jsonify({'success': False, 'error': 'Hyperliquid API timeout'}), 500
    except requests.exceptions.RequestException as e:
        return jsonify({'success': False, 'error': f'Network error: {str(e)}'}), 500
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/test-connection', methods=['GET'])
def api_test_connection():
    """Test Hyperliquid connection"""
    try:
        # Try to get user-specific account info if connected
        user = get_current_user()
        if user and user.has_agent_key():
            data = bot_manager.get_account_info(
                user_wallet=user.address,
                user_agent_key=user.get_agent_key()
            )
        else:
            return jsonify({'success': False, 'error': 'Please connect your wallet first'})

        if 'error' in data:
            return jsonify({'success': False, 'error': data['error']})

        return jsonify({
            'success': True,
            'account_value': data.get('account_value'),
            'network': data.get('network')
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/logs', methods=['GET'])
def api_logs():
    """Get activity logs"""
    try:
        limit = int(request.args.get('limit', 100))
        logs = ActivityLog.query.order_by(ActivityLog.timestamp.desc()).limit(limit).all()
        return jsonify({'logs': [log.to_dict() for log in logs]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/trades/clear', methods=['DELETE'])
def api_clear_trades():
    """Clear all trade history. Requires confirm=true parameter for safety."""
    try:
        # Require explicit confirmation
        confirm = request.args.get('confirm', '').lower() == 'true'
        if not confirm:
            count = Trade.query.count()
            return jsonify({
                'success': False,
                'error': 'Confirmation required',
                'message': f'This will permanently delete {count} trades. Add ?confirm=true to confirm.',
                'count': count
            }), 400

        count = Trade.query.count()
        if count == 0:
            return jsonify({'success': True, 'deleted': 0, 'message': 'No trades to delete'})

        Trade.query.delete()
        db.session.commit()
        log_activity('info', 'system', f'Cleared {count} trades from history')
        return jsonify({'success': True, 'deleted': count})
    except Exception as e:
        db.session.rollback()
        logger.exception(f"Error clearing trades: {e}")
        return jsonify({'success': False, 'error': 'Failed to clear trades. Please try again.'}), 500


@app.route('/api/logs/clear', methods=['DELETE'])
def api_clear_logs():
    """Clear all activity logs. Requires confirm=true parameter for safety."""
    try:
        # Require explicit confirmation
        confirm = request.args.get('confirm', '').lower() == 'true'
        if not confirm:
            count = ActivityLog.query.count()
            return jsonify({
                'success': False,
                'error': 'Confirmation required',
                'message': f'This will permanently delete {count} log entries. Add ?confirm=true to confirm.',
                'count': count
            }), 400

        count = ActivityLog.query.count()
        if count == 0:
            return jsonify({'success': True, 'deleted': 0, 'message': 'No logs to delete'})

        ActivityLog.query.delete()
        db.session.commit()
        return jsonify({'success': True, 'deleted': count})
    except Exception as e:
        db.session.rollback()
        logger.exception(f"Error clearing logs: {e}")
        return jsonify({'success': False, 'error': 'Failed to clear logs. Please try again.'}), 500


# ============================================================================
# WALLET CONNECTION API
# ============================================================================

import secrets
from eth_account import Account
from flask import session

@app.route('/api/wallet/session', methods=['GET'])
def api_wallet_session():
    """Check if user has an existing wallet session"""
    try:
        session_token = request.cookies.get('wallet_session') or session.get('wallet_session')
        if session_token:
            user = UserWallet.query.filter_by(session_token=session_token).first()
            if user:
                # Check if agent was authorized on a different network
                # If user has an agent but it was for a different network, they need to re-authorize
                has_valid_agent = user.has_agent_key() and user.use_testnet == USE_TESTNET

                # If network changed, clear the old agent key (it won't work)
                if user.has_agent_key() and user.use_testnet != USE_TESTNET:
                    logger.info(f"Network changed for {user.address[:10]}... clearing old agent key")
                    user.agent_key_encrypted = None
                    user.agent_address = None
                    user.use_testnet = USE_TESTNET
                    db.session.commit()
                    has_valid_agent = False

                return jsonify({
                    'connected': True,
                    'address': user.address,
                    'has_agent_key': has_valid_agent,
                    'use_testnet': USE_TESTNET,
                    'network': 'testnet' if USE_TESTNET else 'mainnet'
                })
        return jsonify({'connected': False, 'use_testnet': USE_TESTNET, 'network': 'testnet' if USE_TESTNET else 'mainnet'})
    except Exception as e:
        logger.error(f"Session check error: {e}")
        return jsonify({'connected': False, 'use_testnet': USE_TESTNET})


@app.route('/api/wallet/connect', methods=['POST'])
def api_wallet_connect():
    """Connect a wallet address"""
    try:
        data = request.get_json() or {}
        address = (data.get('address') or '').lower().strip()
        chain_id = data.get('chain_id')

        if not address or len(address) != 42 or not address.startswith('0x'):
            return jsonify({'success': False, 'error': 'Invalid wallet address'}), 400

        # Find or create user wallet
        user = UserWallet.query.filter_by(address=address).first()
        network_changed = False

        if not user:
            # Use app's USE_TESTNET setting for new users
            user = UserWallet(address=address, use_testnet=USE_TESTNET)
            db.session.add(user)
        else:
            # Check if network changed - if so, clear old agent (it won't work on new network)
            if user.has_agent_key() and user.use_testnet != USE_TESTNET:
                logger.info(f"Network changed for {address[:10]}... from {'testnet' if user.use_testnet else 'mainnet'} to {'testnet' if USE_TESTNET else 'mainnet'}")
                user.agent_key_encrypted = None
                user.agent_address = None
                network_changed = True

            # Update to match app config
            user.use_testnet = USE_TESTNET

        # Generate session token
        session_token = user.generate_session_token()
        user.last_connected = datetime.utcnow()
        db.session.commit()

        # Set session
        session['wallet_session'] = session_token
        session['wallet_address'] = address

        logger.info(f"Wallet connected: {address[:10]}... session: {session_token[:10]}... network: {'testnet' if USE_TESTNET else 'mainnet'}")

        response = jsonify({
            'success': True,
            'address': address,
            'has_agent_key': user.has_agent_key(),  # Will be False if we cleared it above
            'use_testnet': USE_TESTNET,
            'network': 'testnet' if USE_TESTNET else 'mainnet',
            'network_changed': network_changed
        })
        response.set_cookie('wallet_session', session_token, httponly=True, samesite='Lax', max_age=86400*30)
        return response

    except Exception as e:
        logger.exception(f"Wallet connect error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/wallet/prepare-agent', methods=['POST'])
def api_wallet_prepare_agent():
    """Prepare agent wallet approval - generate agent key and EIP-712 data"""
    try:
        data = request.get_json() or {}
        address = (data.get('address') or '').lower().strip()

        if not address:
            return jsonify({'success': False, 'error': 'No address provided'}), 400

        # Verify session using cookie (more reliable than Flask session)
        session_token = request.cookies.get('wallet_session') or session.get('wallet_session')
        logger.info(f"Prepare agent - address: {address[:10]}..., session_token: {session_token[:10] if session_token else 'None'}...")

        if not session_token:
            return jsonify({'success': False, 'error': 'No session found. Please reconnect wallet.'}), 401

        user = UserWallet.query.filter_by(session_token=session_token).first()
        if not user:
            return jsonify({'success': False, 'error': 'Session expired. Please reconnect wallet.'}), 401

        if not user.address or user.address.lower() != address:
            return jsonify({'success': False, 'error': 'Address mismatch. Please reconnect wallet.'}), 401

        # Generate new agent key
        agent_key = '0x' + secrets.token_hex(32)
        agent_account = Account.from_key(agent_key)
        agent_address = agent_account.address

        # Get timestamp for nonce
        nonce = int(datetime.utcnow().timestamp() * 1000)

        # Use app's USE_TESTNET setting (not user's stored value)
        use_testnet = USE_TESTNET

        # Build EIP-712 typed data for Hyperliquid agent approval
        # Must use Arbitrum chain IDs (matching ShuttheBox implementation)
        if use_testnet:
            chain_id = 421614  # Arbitrum Sepolia
            signature_chain_id = '0x66eee'  # Hex format for API
            hyperliquid_chain = 'Testnet'
        else:
            chain_id = 42161  # Arbitrum One
            signature_chain_id = '0xa4b1'  # Hex format for API
            hyperliquid_chain = 'Mainnet'

        # Full EIP-712 typed data structure
        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"}
                ],
                "HyperliquidTransaction:ApproveAgent": [
                    {"name": "hyperliquidChain", "type": "string"},
                    {"name": "agentAddress", "type": "address"},
                    {"name": "agentName", "type": "string"},
                    {"name": "nonce", "type": "uint64"}
                ]
            },
            "primaryType": "HyperliquidTransaction:ApproveAgent",
            "domain": {
                "name": "HyperliquidSignTransaction",
                "version": "1",
                "chainId": chain_id,
                "verifyingContract": "0x0000000000000000000000000000000000000000"
            },
            "message": {
                "hyperliquidChain": hyperliquid_chain,
                "agentAddress": agent_address,
                "agentName": "MAKTVBot",
                "nonce": nonce
            }
        }

        return jsonify({
            'success': True,
            'agent_address': agent_address,
            'agent_key': agent_key,
            'nonce': nonce,
            'typed_data': typed_data,
            'signature_chain_id': signature_chain_id,
            'hyperliquid_chain': hyperliquid_chain
        })

    except Exception as e:
        logger.exception(f"Prepare agent error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/wallet/approve-agent', methods=['POST'])
def api_wallet_approve_agent():
    """Submit agent approval to Hyperliquid and store agent key"""
    try:
        data = request.get_json() or {}
        address = (data.get('address') or '').lower().strip()
        signature = data.get('signature')
        agent_address = data.get('agent_address')
        agent_key = data.get('agent_key')
        nonce = data.get('nonce')

        if not address or not signature or not agent_address:
            return jsonify({'success': False, 'error': 'Missing required fields'}), 400

        # Verify session using cookie (more reliable than Flask session)
        session_token = request.cookies.get('wallet_session') or session.get('wallet_session')
        logger.info(f"Approve agent - address: {address[:10]}..., session_token: {session_token[:10] if session_token else 'None'}...")

        if not session_token:
            return jsonify({'success': False, 'error': 'No session found. Please reconnect wallet.'}), 401

        user = UserWallet.query.filter_by(session_token=session_token).first()
        if not user:
            return jsonify({'success': False, 'error': 'Session expired. Please reconnect wallet.'}), 401

        if not user.address or user.address.lower() != address:
            return jsonify({'success': False, 'error': 'Address mismatch. Please reconnect wallet.'}), 401

        # Submit approval to Hyperliquid
        from hyperliquid.info import Info
        from hyperliquid.utils import constants
        import requests

        # Use app's USE_TESTNET setting (not user's stored value)
        if USE_TESTNET:
            api_url = constants.TESTNET_API_URL
            signature_chain_id = '0x66eee'  # Arbitrum Sepolia
            hyperliquid_chain = 'Testnet'
        else:
            api_url = constants.MAINNET_API_URL
            signature_chain_id = '0xa4b1'  # Arbitrum One
            hyperliquid_chain = 'Mainnet'

        # Build the action payload - must match ShuttheBox format
        action = {
            "type": "approveAgent",
            "hyperliquidChain": hyperliquid_chain,
            "signatureChainId": signature_chain_id,
            "agentAddress": agent_address,
            "agentName": "MAKTVBot",
            "nonce": nonce
        }

        # Parse signature components (ethers returns full signature)
        # Hyperliquid expects {r, s, v} format
        sig_bytes = bytes.fromhex(signature[2:] if signature.startswith('0x') else signature)
        r = '0x' + sig_bytes[:32].hex()
        s = '0x' + sig_bytes[32:64].hex()
        v = sig_bytes[64]

        payload = {
            "action": action,
            "nonce": nonce,
            "signature": {"r": r, "s": s, "v": v},
            "vaultAddress": None
        }

        logger.info(f"Submitting agent approval to Hyperliquid: {api_url}/exchange")
        logger.info(f"Payload: {json.dumps(payload, indent=2)}")

        # Submit to Hyperliquid exchange endpoint
        response = requests.post(
            f"{api_url}/exchange",
            json=payload,
            headers={"Content-Type": "application/json"}
        )

        result = response.json()
        logger.info(f"Hyperliquid agent approval response: {result}")

        # Check if approval was successful
        if result.get('status') == 'ok' or 'response' in result:
            # Store agent key (encrypted)
            user.agent_address = agent_address
            user.set_agent_key(agent_key)
            db.session.commit()

            log_activity('info', 'wallet', f"Agent wallet approved for {address[:10]}...", {
                'agent_address': agent_address
            })

            # Auto-enable HIP-3 DEX abstraction for HIP-3 perps support
            try:
                dex_result = bot_manager.enable_dex_abstraction(
                    user_wallet=user.address,
                    user_agent_key=agent_key
                )
                if dex_result.get('success'):
                    logger.info(f"HIP-3 DEX abstraction auto-enabled for {address[:10]}...")
                else:
                    logger.warning(f"Could not auto-enable DEX abstraction: {dex_result.get('error')}")
            except Exception as dex_err:
                logger.warning(f"Error auto-enabling DEX abstraction: {dex_err}")
                # Don't fail the whole approval if DEX abstraction fails

            return jsonify({'success': True, 'message': 'Agent approved successfully'})
        else:
            error_msg = result.get('error', result.get('response', 'Unknown error'))
            return jsonify({'success': False, 'error': str(error_msg)}), 400

    except Exception as e:
        logger.exception(f"Approve agent error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/wallet/enable-dex-abstraction', methods=['POST'])
def api_wallet_enable_dex_abstraction():
    """
    Enable HIP-3 DEX abstraction for the current user.
    This allows seeing and trading HIP-3 perps (builder-deployed perpetuals).
    """
    try:
        user = get_current_user()
        if not user:
            return jsonify({'success': False, 'error': 'Please connect your wallet'}), 401

        if not user.has_agent_key():
            return jsonify({'success': False, 'error': 'Please authorize trading first'}), 400

        result = bot_manager.enable_dex_abstraction(
            user_wallet=user.address,
            user_agent_key=user.get_agent_key()
        )

        if result.get('success'):
            log_activity('info', 'wallet', f"HIP-3 DEX abstraction enabled for {user.address[:10]}...")
            return jsonify({'success': True, 'message': 'HIP-3 DEX abstraction enabled'})
        else:
            return jsonify({'success': False, 'error': result.get('error', 'Unknown error')}), 400

    except Exception as e:
        logger.exception(f"Enable DEX abstraction error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/wallet/dex-abstraction-status', methods=['GET'])
def api_wallet_dex_abstraction_status():
    """
    Check if HIP-3 DEX abstraction is enabled for the current user.
    Uses the Hyperliquid info endpoint to query the status.
    """
    try:
        user = get_current_user()
        if not user:
            return jsonify({'enabled': False, 'error': 'Not connected'})

        if not user.has_agent_key():
            return jsonify({'enabled': False, 'error': 'Not authorized'})

        # Query Hyperliquid info endpoint for DEX abstraction status
        from hyperliquid.info import Info
        from hyperliquid.utils import constants
        import requests

        api_url = constants.TESTNET_API_URL if USE_TESTNET else constants.MAINNET_API_URL

        # Query userDexAbstraction status
        response = requests.post(
            f"{api_url}/info",
            json={
                "type": "userDexAbstraction",
                "user": user.address
            },
            headers={"Content-Type": "application/json"}
        )

        result = response.json()
        logger.info(f"DEX abstraction status for {user.address[:10]}...: {result}")

        # The response should be a boolean or object indicating enabled status
        if isinstance(result, bool):
            return jsonify({'enabled': result})
        elif isinstance(result, dict):
            return jsonify({'enabled': result.get('enabled', False), 'details': result})
        else:
            return jsonify({'enabled': bool(result), 'raw': result})

    except Exception as e:
        logger.exception(f"DEX abstraction status error: {e}")
        return jsonify({'enabled': False, 'error': str(e)})


@app.route('/api/hip3/dexs', methods=['GET'])
def api_hip3_dexs():
    """
    Get list of available HIP-3 DEXs.
    This is useful for debugging and understanding which DEXs are available.
    """
    try:
        from hyperliquid.utils import constants
        import requests

        api_url = constants.TESTNET_API_URL if USE_TESTNET else constants.MAINNET_API_URL

        response = requests.post(
            f"{api_url}/info",
            json={"type": "perpDexs"},
            headers={"Content-Type": "application/json"}
        )

        result = response.json()
        logger.info(f"HIP-3 DEXs: {result}")

        return jsonify({
            'success': True,
            'dexs': result,
            'network': 'testnet' if USE_TESTNET else 'mainnet'
        })

    except Exception as e:
        logger.exception(f"Error fetching HIP-3 DEXs: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/wallet/disconnect', methods=['POST'])
def api_wallet_disconnect():
    """Disconnect wallet session"""
    try:
        session_token = request.cookies.get('wallet_session') or session.get('wallet_session')
        if session_token:
            user = UserWallet.query.filter_by(session_token=session_token).first()
            if user:
                user.session_token = None
                db.session.commit()

        session.pop('wallet_session', None)
        session.pop('wallet_address', None)

        response = jsonify({'success': True})
        response.delete_cookie('wallet_session')
        return response
    except Exception as e:
        logger.error(f"Disconnect error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


def get_current_user():
    """Get the current user from session"""
    session_token = request.cookies.get('wallet_session') or session.get('wallet_session')
    if session_token:
        return UserWallet.query.filter_by(session_token=session_token).first()
    return None


# ============================================================================
# WEBHOOK ENDPOINT (TradingView)
# ============================================================================

@app.route('/webhook', methods=['POST'])
def webhook():
    """
    Receives webhooks from TradingView.

    Expected JSON payload:
    {
        "secret": "your-webhook-secret",
        "action": "buy" or "sell",
        "coin": "BTC",
        "leverage": 10,
        "collateral_usd": 100,
        "indicator": "indicator-key",
        "stop_loss_pct": 2,
        "take_profit_pct": 5,
        "close_position": false
    }
    """
    try:
        data = request.get_json()

        if not data:
            logger.warning("Received empty webhook request")
            return jsonify({"error": "No data received"}), 400

        logger.info(f"Received webhook: {json.dumps(data, indent=2)}")

        # Validate secret
        if data.get("secret") != WEBHOOK_SECRET:
            logger.warning("Invalid webhook secret!")
            log_activity('warning', 'webhook', 'Invalid webhook secret received')
            return jsonify({"error": "Invalid secret"}), 401

        # Parse data
        action = data.get("action", "").lower()
        coin = data.get("coin", "BTC")  # Preserve case - Hyperliquid uses case-sensitive names
        leverage = int(data.get("leverage", 10))
        collateral_usd = float(data.get("collateral_usd", 100))
        close_position = data.get("close_position", False)
        stop_loss_pct = data.get("stop_loss_pct")
        take_profit_pct = data.get("take_profit_pct")
        indicator_key = data.get("indicator")

        # Check if bot is enabled
        if not bot_manager.is_enabled:
            log_activity('warning', 'webhook', 'Webhook received but bot is disabled')
            return jsonify({"error": "Bot is disabled"}), 400

        # Handle close position
        if close_position:
            logger.info(f"Closing position for {coin}")
            result = bot_manager.close_position(coin)

            # Update trade record
            trade = Trade.query.filter_by(coin=coin, status='open').first()
            if trade:
                prices = bot_manager.get_market_prices([coin])
                exit_price = prices.get(coin, trade.entry_price)
                pnl, pnl_pct = risk_manager.calculate_pnl(trade, exit_price)

                trade.exit_price = exit_price
                trade.pnl = pnl
                trade.pnl_percent = pnl_pct
                trade.status = 'closed'
                trade.close_reason = 'signal'
                db.session.commit()

                risk_manager.record_trade_result(pnl)

            log_activity('info', 'trade', f"Closed {coin} via webhook signal")

            return jsonify({
                "status": "success",
                "action": "close",
                "coin": coin,
                "result": result
            })

        # Validate action
        if action not in ["buy", "sell"]:
            return jsonify({"error": "Invalid action. Must be 'buy' or 'sell'"}), 400

        # Risk check
        allowed, reason = risk_manager.check_trading_allowed(coin, collateral_usd, leverage)
        if not allowed:
            log_activity('warning', 'risk', f"Webhook trade blocked: {reason}",
                        {'coin': coin, 'action': action})
            return jsonify({"error": reason}), 400

        # Get coin config for defaults
        coin_config = risk_manager.get_coin_config(coin)
        if stop_loss_pct is None and coin_config.default_stop_loss_pct:
            stop_loss_pct = coin_config.default_stop_loss_pct
        if take_profit_pct is None and coin_config.default_take_profit_pct:
            take_profit_pct = coin_config.default_take_profit_pct

        # Use coin config defaults for TP1/TP2 (webhook uses coin config defaults)
        tp1_pct = coin_config.tp1_pct
        tp1_size_pct = coin_config.tp1_size_pct
        tp2_pct = coin_config.tp2_pct
        tp2_size_pct = coin_config.tp2_size_pct

        # Execute trade
        result = bot_manager.execute_trade(
            coin=coin,
            action=action,
            leverage=leverage,
            collateral_usd=collateral_usd,
            stop_loss_pct=stop_loss_pct,
            take_profit_pct=take_profit_pct,
            tp1_pct=tp1_pct,
            tp1_size_pct=tp1_size_pct,
            tp2_pct=tp2_pct,
            tp2_size_pct=tp2_size_pct
        )

        if result.get('success'):
            # Record trade
            trade = Trade(
                coin=coin,
                action=action,
                side='long' if action == 'buy' else 'short',
                size=result['size'],
                entry_price=result['entry_price'],
                leverage=leverage,
                collateral_usd=collateral_usd,
                stop_loss=result.get('stop_loss'),
                take_profit=result.get('take_profit'),
                order_id=result.get('order_id'),
                indicator_name=indicator_key,
                status='open'
            )
            db.session.add(trade)
            db.session.commit()

            # Update indicator stats
            if indicator_key:
                indicator = Indicator.query.filter_by(webhook_key=indicator_key).first()
                if indicator:
                    indicator.total_trades += 1
                    db.session.commit()

            log_activity('info', 'trade',
                        f"Webhook: {action.upper()} {coin} @ ${result['entry_price']:.2f}",
                        {'indicator': indicator_key, **result})

            return jsonify({
                "status": "success",
                "action": action,
                "coin": coin,
                "leverage": leverage,
                "size": result['size'],
                "entry_price": result['entry_price'],
                "stop_loss": result.get('stop_loss'),
                "take_profit": result.get('take_profit'),
                "network": "testnet" if USE_TESTNET else "mainnet"
            })
        else:
            log_activity('error', 'trade', f"Webhook trade failed: {result.get('error')}")
            return jsonify({"status": "error", "message": result.get('error')}), 500

    except Exception as e:
        logger.exception(f"Webhook error: {e}")
        log_activity('error', 'webhook', f"Webhook error: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ============================================================================
# LEGACY ENDPOINTS (for backwards compatibility)
# ============================================================================

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint - also shows current config for debugging"""
    # Re-read env var to show what's actually set (vs cached value)
    current_env_value = os.environ.get("USE_TESTNET", "not set")
    return jsonify({
        "status": "healthy",
        "network": "testnet" if USE_TESTNET else "mainnet",
        "use_testnet_cached": USE_TESTNET,
        "use_testnet_env_current": current_env_value,
        "wallet_configured": bool(MAIN_WALLET_ADDRESS and API_WALLET_SECRET),
        "bot_enabled": bot_manager.is_enabled,
        "websocket_connected": bot_manager._ws_connected,
        "note": "If use_testnet_cached differs from use_testnet_env_current, restart the deployment"
    })


@app.route('/status', methods=['GET'])
def status():
    """Account status endpoint"""
    try:
        # Try to get user-specific account info if connected
        user = get_current_user()
        if user and user.has_agent_key():
            data = bot_manager.get_account_info(
                user_wallet=user.address,
                user_agent_key=user.get_agent_key()
            )
        else:
            data = {'error': 'Please connect your wallet'}
        return jsonify({
            "status": "success" if 'error' not in data else "error",
            "network": data.get('network'),
            "account": {
                "margin_summary": {
                    "accountValue": data.get('account_value', 0),
                    "totalMarginUsed": data.get('total_margin_used', 0),
                    "withdrawable": data.get('withdrawable', 0)
                },
                "positions": data.get('positions', [])
            }
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ============================================================================
# STARTUP INITIALIZATION
# ============================================================================

def initialize_on_startup():
    """Initialize WebSocket and refresh metadata on startup"""
    with app.app_context():
        try:
            # Start WebSocket price streaming
            logger.info("Starting WebSocket price streaming...")
            if bot_manager.start_price_stream():
                logger.info("WebSocket connected successfully")
            else:
                logger.warning("WebSocket not available, using REST API fallback")

            # Check if metadata needs refresh (older than 24 hours)
            from models import CoinConfig
            configs = CoinConfig.query.filter(CoinConfig.hl_metadata_updated.isnot(None)).first()
            needs_refresh = True

            if configs and configs.hl_metadata_updated:
                age_hours = (datetime.utcnow() - configs.hl_metadata_updated).total_seconds() / 3600
                if age_hours < 24:
                    needs_refresh = False
                    logger.info(f"Metadata is {age_hours:.1f} hours old, no refresh needed")

            if needs_refresh:
                logger.info("Refreshing Hyperliquid metadata...")
                meta = bot_manager.get_asset_metadata(force_refresh=True)
                if meta:
                    now = datetime.utcnow()
                    updated = 0
                    for coin, data in meta.items():
                        config = CoinConfig.query.filter_by(coin=coin).first()
                        if config:
                            config.hl_max_leverage = data.get('maxLeverage', 10)
                            config.hl_sz_decimals = data.get('szDecimals', 2)
                            config.hl_only_isolated = data.get('onlyIsolated', False)
                            config.hl_metadata_updated = now
                            updated += 1
                    db.session.commit()
                    logger.info(f"Updated metadata for {updated} coins")

        except Exception as e:
            logger.exception(f"Startup initialization error: {e}")


# ============================================================================
# RUN SERVER
# ============================================================================

if __name__ == '__main__':
    logger.info("=" * 60)
    logger.info("MAK TradingView to Hyperliquid Bot Starting...")
    logger.info(f"Network: {'TESTNET' if USE_TESTNET else 'MAINNET'}")
    logger.info(f"Wallet configured: {bool(MAIN_WALLET_ADDRESS and API_WALLET_SECRET)}")
    logger.info("Web UI available at http://localhost:5000")
    logger.info("=" * 60)

    # Initialize WebSocket and metadata
    initialize_on_startup()

    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
