"""
Bot Manager Module
==================
Manages bot state, trading operations, and position monitoring.
"""

import os
import json
import logging
import threading
import time
from datetime import datetime
from eth_account import Account
from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

logger = logging.getLogger(__name__)


class BotManager:
    """Manages bot state and trading operations"""

    def __init__(self):
        self._enabled = True
        self._info = None
        self._exchange = None
        self._lock = threading.Lock()
        self._position_monitor_thread = None
        self._stop_monitoring = False

    @property
    def is_enabled(self):
        return self._enabled

    def enable(self):
        self._enabled = True
        logger.info("Bot enabled")

    def disable(self):
        self._enabled = False
        logger.info("Bot disabled")

    def get_config(self):
        """Get configuration from environment"""
        return {
            'main_wallet': os.environ.get("HL_MAIN_WALLET"),
            'api_secret': os.environ.get("HL_API_SECRET"),
            'webhook_secret': os.environ.get("WEBHOOK_SECRET"),
            'use_testnet': os.environ.get("USE_TESTNET", "true").lower() == "true"
        }

    def is_configured(self):
        """Check if bot is properly configured"""
        config = self.get_config()
        return bool(config['main_wallet'] and config['api_secret'])

    def get_exchange(self):
        """Get or create exchange connection"""
        config = self.get_config()

        if not config['main_wallet'] or not config['api_secret']:
            raise ValueError("Missing wallet configuration")

        api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

        wallet = Account.from_key(config['api_secret'])
        info = Info(api_url, skip_ws=True)
        exchange = Exchange(wallet, api_url, account_address=config['main_wallet'])

        return info, exchange

    def get_account_info(self):
        """Get account balance and positions from Hyperliquid"""
        try:
            config = self.get_config()
            if not self.is_configured():
                return {'error': 'Bot not configured'}

            info, _ = self.get_exchange()
            user_state = info.user_state(config['main_wallet'])

            margin_summary = user_state.get('marginSummary', {})
            positions = user_state.get('assetPositions', [])

            # Format positions
            formatted_positions = []
            for pos in positions:
                position = pos.get('position', {})
                if float(position.get('szi', 0)) != 0:
                    formatted_positions.append({
                        'coin': position.get('coin'),
                        'size': float(position.get('szi', 0)),
                        'entry_price': float(position.get('entryPx', 0)),
                        'mark_price': float(position.get('positionValue', 0)) / abs(float(position.get('szi', 1))) if float(position.get('szi', 0)) != 0 else 0,
                        'unrealized_pnl': float(position.get('unrealizedPnl', 0)),
                        'leverage': int(position.get('leverage', {}).get('value', 1)),
                        'liquidation_price': float(position.get('liquidationPx', 0)) if position.get('liquidationPx') else None,
                        'margin_used': float(position.get('marginUsed', 0)),
                        'side': 'long' if float(position.get('szi', 0)) > 0 else 'short'
                    })

            return {
                'account_value': float(margin_summary.get('accountValue', 0)),
                'total_margin_used': float(margin_summary.get('totalMarginUsed', 0)),
                'total_ntl_pos': float(margin_summary.get('totalNtlPos', 0)),
                'withdrawable': float(margin_summary.get('withdrawable', 0)),
                'positions': formatted_positions,
                'network': 'testnet' if config['use_testnet'] else 'mainnet'
            }
        except Exception as e:
            logger.exception(f"Error getting account info: {e}")
            return {'error': str(e)}

    def get_market_prices(self, coins=None):
        """Get current market prices"""
        try:
            info, _ = self.get_exchange()
            all_mids = info.all_mids()

            if coins:
                return {coin: float(all_mids.get(coin, 0)) for coin in coins}
            return {coin: float(price) for coin, price in all_mids.items()}
        except Exception as e:
            logger.exception(f"Error getting prices: {e}")
            return {}

    def calculate_position_size(self, coin, collateral_usd, leverage):
        """Calculate position size based on collateral and leverage"""
        prices = self.get_market_prices([coin])
        current_price = prices.get(coin, 0)

        if current_price == 0:
            raise ValueError(f"Could not get price for {coin}")

        notional_value = collateral_usd * leverage
        size = notional_value / current_price

        # Round appropriately based on coin
        if coin in ['BTC']:
            size = round(size, 4)
        elif coin in ['ETH']:
            size = round(size, 3)
        else:
            size = round(size, 2)

        return size, current_price

    def execute_trade(self, coin, action, leverage, collateral_usd, stop_loss_pct=None, take_profit_pct=None, slippage=0.01):
        """Execute a trade on Hyperliquid"""
        if not self._enabled:
            return {'error': 'Bot is disabled'}

        try:
            info, exchange = self.get_exchange()

            # Set leverage
            logger.info(f"Setting leverage to {leverage}x for {coin}")
            exchange.update_leverage(leverage, coin, is_cross=False)

            # Calculate position size
            size, entry_price = self.calculate_position_size(coin, collateral_usd, leverage)

            # Execute order
            is_buy = action.lower() == 'buy'
            logger.info(f"Executing {'BUY' if is_buy else 'SELL'} {size} {coin} at ~${entry_price:.2f}")

            order_result = exchange.market_open(
                coin,
                is_buy,
                size,
                None,  # Market price
                slippage
            )

            logger.info(f"Order result: {json.dumps(order_result, indent=2)}")

            # Parse result
            if order_result.get("status") == "ok":
                statuses = order_result.get("response", {}).get("data", {}).get("statuses", [])
                fills = []
                actual_price = entry_price

                for status in statuses:
                    if "filled" in status:
                        filled = status["filled"]
                        actual_price = float(filled.get("avgPx", entry_price))
                        fills.append({
                            "oid": filled.get("oid"),
                            "size": filled.get("totalSz"),
                            "avg_price": actual_price
                        })

                # Calculate SL/TP prices
                side = 'long' if is_buy else 'short'
                sl_price = None
                tp_price = None

                if stop_loss_pct:
                    if side == 'long':
                        sl_price = actual_price * (1 - stop_loss_pct / 100)
                    else:
                        sl_price = actual_price * (1 + stop_loss_pct / 100)

                if take_profit_pct:
                    if side == 'long':
                        tp_price = actual_price * (1 + take_profit_pct / 100)
                    else:
                        tp_price = actual_price * (1 - take_profit_pct / 100)

                return {
                    'success': True,
                    'coin': coin,
                    'action': action,
                    'side': side,
                    'size': size,
                    'entry_price': actual_price,
                    'leverage': leverage,
                    'collateral_usd': collateral_usd,
                    'stop_loss': sl_price,
                    'take_profit': tp_price,
                    'fills': fills,
                    'order_id': fills[0]['oid'] if fills else None
                }
            else:
                error_msg = order_result.get("response", "Unknown error")
                return {'success': False, 'error': str(error_msg)}

        except Exception as e:
            logger.exception(f"Trade execution error: {e}")
            return {'success': False, 'error': str(e)}

    def close_position(self, coin, size=None):
        """Close a position for a coin"""
        try:
            _, exchange = self.get_exchange()

            if size:
                # Partial close - TODO: implement
                pass

            result = exchange.market_close(coin)
            logger.info(f"Close result for {coin}: {result}")

            return {'success': True, 'coin': coin, 'result': result}

        except Exception as e:
            logger.exception(f"Error closing position: {e}")
            return {'success': False, 'error': str(e)}

    def place_stop_loss_order(self, coin, side, trigger_price, size):
        """Place a stop loss order"""
        try:
            _, exchange = self.get_exchange()

            # For stop loss, we want to close the position
            # If we're long, we sell on stop loss
            # If we're short, we buy on stop loss
            is_buy = side == 'short'

            result = exchange.order(
                coin,
                is_buy,
                size,
                trigger_price,
                {"trigger": {"triggerPx": trigger_price, "isMarket": True, "tpsl": "sl"}}
            )

            return {'success': True, 'result': result}
        except Exception as e:
            logger.exception(f"Error placing stop loss: {e}")
            return {'success': False, 'error': str(e)}

    def place_take_profit_order(self, coin, side, trigger_price, size):
        """Place a take profit order"""
        try:
            _, exchange = self.get_exchange()

            is_buy = side == 'short'

            result = exchange.order(
                coin,
                is_buy,
                size,
                trigger_price,
                {"trigger": {"triggerPx": trigger_price, "isMarket": True, "tpsl": "tp"}}
            )

            return {'success': True, 'result': result}
        except Exception as e:
            logger.exception(f"Error placing take profit: {e}")
            return {'success': False, 'error': str(e)}

    def get_open_orders(self):
        """Get all open orders"""
        try:
            config = self.get_config()
            info, _ = self.get_exchange()
            orders = info.open_orders(config['main_wallet'])
            return orders
        except Exception as e:
            logger.exception(f"Error getting open orders: {e}")
            return []

    def cancel_all_orders(self, coin=None):
        """Cancel all open orders, optionally for a specific coin"""
        try:
            _, exchange = self.get_exchange()
            orders = self.get_open_orders()

            cancelled = []
            for order in orders:
                if coin and order.get('coin') != coin:
                    continue
                result = exchange.cancel(order['coin'], order['oid'])
                cancelled.append(order['oid'])

            return {'success': True, 'cancelled': cancelled}
        except Exception as e:
            logger.exception(f"Error cancelling orders: {e}")
            return {'success': False, 'error': str(e)}


# Global bot manager instance
bot_manager = BotManager()
