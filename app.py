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
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///trading_bot.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize database
from models import db, init_db, Trade, BotConfig, CoinConfig, RiskSettings, Indicator, ActivityLog
init_db(app)

# Initialize managers
from risk_manager import risk_manager
from bot_manager import bot_manager

# ============================================================================
# CONFIGURATION
# ============================================================================

MAIN_WALLET_ADDRESS = os.environ.get("HL_MAIN_WALLET")
USE_TESTNET = os.environ.get("USE_TESTNET", "true").lower() == "true"

# Select API secret based on network
if USE_TESTNET:
    API_WALLET_SECRET = os.environ.get("HL_TESTNET_API_SECRET")
else:
    API_WALLET_SECRET = os.environ.get("HL_API_SECRET")

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
        data = bot_manager.get_account_info()
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
            account_info = bot_manager.get_account_info()
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
        data = request.get_json()

        coin = data.get('coin', 'BTC')  # Preserve case - Hyperliquid uses case-sensitive names like kBONK
        action = data.get('action', '').lower()
        leverage = int(data.get('leverage', 10))
        collateral_usd = float(data.get('collateral_usd', 100))
        stop_loss_pct = data.get('stop_loss_pct')
        take_profit_pct = data.get('take_profit_pct')

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

        # Execute trade
        result = bot_manager.execute_trade(
            coin=coin,
            action=action,
            leverage=leverage,
            collateral_usd=collateral_usd,
            stop_loss_pct=stop_loss_pct,
            take_profit_pct=take_profit_pct
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

    except Exception as e:
        logger.exception(f"Trade error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/close', methods=['POST'])
def api_close_position():
    """Close a position"""
    try:
        data = request.get_json()
        coin = data.get('coin', '')  # Preserve case - Hyperliquid uses case-sensitive names

        if not coin:
            return jsonify({'success': False, 'error': 'Coin is required'})

        result = bot_manager.close_position(coin)

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
        account = bot_manager.get_account_info()
        positions = account.get('positions', [])

        # Get current prices for all positions to calculate P&L
        coins = [pos['coin'] for pos in positions]
        prices = bot_manager.get_market_prices(coins) if coins else {}

        results = []
        total_pnl = 0
        for pos in positions:
            coin = pos['coin']
            result = bot_manager.close_position(coin)

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

        # Calculate stats
        all_closed = Trade.query.filter_by(status='closed').all()
        wins = [t for t in all_closed if (t.pnl or 0) > 0]
        losses = [t for t in all_closed if (t.pnl or 0) < 0]

        stats = {
            'total_trades': len(all_closed),
            'win_rate': (len(wins) / len(all_closed) * 100) if all_closed else 0,
            'total_pnl': sum(t.pnl or 0 for t in all_closed),
            'avg_win': (sum(t.pnl for t in wins) / len(wins)) if wins else 0,
            'avg_loss': (sum(t.pnl for t in losses) / len(losses)) if losses else 0,
            'best_trade': max((t.pnl or 0 for t in all_closed), default=0)
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

        indicator = Indicator(
            name=data.get('name'),
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
        return jsonify({'success': False, 'error': str(e)}), 500


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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/indicators/<int:id>', methods=['DELETE'])
def api_delete_indicator(id):
    """Delete an indicator"""
    try:
        indicator = Indicator.query.get_or_404(id)
        db.session.delete(indicator)
        db.session.commit()

        log_activity('info', 'system', f"Deleted indicator: {indicator.name}")

        return jsonify({'success': True})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ============================================================================
# API ROUTES - Settings
# ============================================================================

@app.route('/api/settings', methods=['GET'])
def api_get_settings():
    """Get all settings"""
    try:
        risk = RiskSettings.query.first()

        return jsonify({
            'bot_enabled': BotConfig.get('bot_enabled', 'true'),
            'use_testnet': str(USE_TESTNET).lower(),  # Use actual environment variable
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

        for key in ['enabled', 'default_leverage', 'default_collateral', 'max_position_size',
                    'max_open_positions', 'default_stop_loss_pct',
                    'tp1_pct', 'tp1_size_pct', 'tp2_pct', 'tp2_size_pct',
                    'use_trailing_stop', 'trailing_stop_pct']:
            if key in data:
                setattr(config, key, data[key])

        db.session.commit()

        return jsonify({'success': True})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/test-connection', methods=['GET'])
def api_test_connection():
    """Test Hyperliquid connection"""
    try:
        data = bot_manager.get_account_info()
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
    """Clear all trade history"""
    try:
        count = Trade.query.count()
        Trade.query.delete()
        db.session.commit()
        log_activity('info', 'system', f'Cleared {count} trades from history')
        return jsonify({'success': True, 'deleted': count})
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/logs/clear', methods=['DELETE'])
def api_clear_logs():
    """Clear all activity logs"""
    try:
        count = ActivityLog.query.count()
        ActivityLog.query.delete()
        db.session.commit()
        return jsonify({'success': True, 'deleted': count})
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


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

        # Execute trade
        result = bot_manager.execute_trade(
            coin=coin,
            action=action,
            leverage=leverage,
            collateral_usd=collateral_usd,
            stop_loss_pct=stop_loss_pct,
            take_profit_pct=take_profit_pct
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
    """Health check endpoint"""
    return jsonify({
        "status": "healthy",
        "network": "testnet" if USE_TESTNET else "mainnet",
        "wallet_configured": bool(MAIN_WALLET_ADDRESS and API_WALLET_SECRET),
        "bot_enabled": bot_manager.is_enabled,
        "websocket_connected": bot_manager._ws_connected
    })


@app.route('/status', methods=['GET'])
def status():
    """Account status endpoint"""
    try:
        data = bot_manager.get_account_info()
        return jsonify({
            "status": "success",
            "network": data.get('network'),
            "account": {
                "margin_summary": {
                    "accountValue": data.get('account_value'),
                    "totalMarginUsed": data.get('total_margin_used'),
                    "withdrawable": data.get('withdrawable')
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
