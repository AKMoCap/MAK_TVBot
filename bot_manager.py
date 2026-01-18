"""
Bot Manager Module
==================
Manages bot state, trading operations, and position monitoring.
Uses WebSocket for real-time price streaming to minimize API calls.
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

# Try to import WebsocketManager for price streaming
try:
    from hyperliquid.websocket_manager import WebsocketManager
    WEBSOCKET_AVAILABLE = True
except ImportError:
    WEBSOCKET_AVAILABLE = False

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

        # Cache for asset metadata to reduce API calls
        self._asset_meta_cache = {}
        self._asset_meta_cache_time = 0
        self._asset_meta_cache_ttl = 300  # 5 minutes TTL

        # WebSocket price streaming
        self._ws_manager = None
        self._ws_prices = {}  # Real-time prices from WebSocket
        self._ws_prices_lock = threading.Lock()
        self._ws_connected = False
        self._ws_last_update = 0

        # Fallback cache for REST API prices (only used if WebSocket is down)
        self._prices_cache = {}
        self._prices_cache_time = 0
        self._prices_cache_ttl = 2  # 2 seconds TTL for REST fallback

    @property
    def is_enabled(self):
        return self._enabled

    def enable(self):
        self._enabled = True
        logger.info("Bot enabled")

    def disable(self):
        self._enabled = False
        logger.info("Bot disabled")

    def get_config(self, user_wallet=None, user_agent_key=None):
        """Get configuration - can be user-specific or from environment"""
        use_testnet = os.environ.get("USE_TESTNET", "true").lower() == "true"

        # If user credentials provided, use those
        if user_wallet and user_agent_key:
            return {
                'main_wallet': user_wallet,
                'api_secret': user_agent_key,
                'webhook_secret': os.environ.get("WEBHOOK_SECRET"),
                'use_testnet': use_testnet
            }

        # Fall back to environment variables (for webhook/legacy support)
        if use_testnet:
            api_secret = os.environ.get("HL_TESTNET_API_SECRET")
        else:
            api_secret = os.environ.get("HL_API_SECRET")

        return {
            'main_wallet': os.environ.get("HL_MAIN_WALLET"),
            'api_secret': api_secret,
            'webhook_secret': os.environ.get("WEBHOOK_SECRET"),
            'use_testnet': use_testnet
        }

    def is_configured(self, user_wallet=None, user_agent_key=None):
        """Check if bot is properly configured"""
        config = self.get_config(user_wallet, user_agent_key)
        return bool(config['main_wallet'] and config['api_secret'])

    def get_exchange(self, user_wallet=None, user_agent_key=None):
        """Get or create exchange connection - can be user-specific"""
        config = self.get_config(user_wallet, user_agent_key)

        if not config['main_wallet'] or not config['api_secret']:
            raise ValueError("Missing wallet configuration. Please connect your wallet.")

        api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

        wallet = Account.from_key(config['api_secret'])
        info = Info(api_url, skip_ws=True)
        exchange = Exchange(wallet, api_url, account_address=config['main_wallet'])

        return info, exchange

    def get_exchange_for_user(self, user):
        """Get exchange connection for a specific user from database model"""
        if not user or not user.has_agent_key():
            raise ValueError("User wallet not authorized. Please connect and authorize your wallet.")

        return self.get_exchange(
            user_wallet=user.address,
            user_agent_key=user.get_agent_key()
        )

    def enable_dex_abstraction(self, user_wallet=None, user_agent_key=None):
        """
        Enable HIP-3 DEX abstraction for the user's agent wallet.
        This allows trading on HIP-3 perps (builder-deployed perpetuals).
        Must be called after agent wallet is approved.
        """
        try:
            _, exchange = self.get_exchange(user_wallet, user_agent_key)

            # Check if the SDK has the method
            if hasattr(exchange, 'agent_enable_dex_abstraction'):
                result = exchange.agent_enable_dex_abstraction()
                logger.info(f"DEX abstraction enabled via SDK for {user_wallet[:10]}...: {result}")
                return {'success': True, 'result': result}
            else:
                # Fallback: manually call the API if SDK doesn't have the method
                import requests
                from hyperliquid.utils import constants
                from hyperliquid.utils.signing import get_timestamp_ms, sign_l1_action

                config = self.get_config(user_wallet, user_agent_key)
                api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

                timestamp = get_timestamp_ms()
                action = {"type": "agentEnableDexAbstraction"}

                # Get the wallet from exchange
                wallet = exchange.wallet

                # Sign the action
                signature = sign_l1_action(
                    wallet,
                    action,
                    None,  # vault_address
                    timestamp,
                    None,  # expires_after
                    not config['use_testnet'],  # is_mainnet
                )

                payload = {
                    "action": action,
                    "nonce": timestamp,
                    "signature": signature,
                    "vaultAddress": None
                }

                response = requests.post(
                    f"{api_url}/exchange",
                    json=payload,
                    headers={"Content-Type": "application/json"}
                )

                result = response.json()
                logger.info(f"DEX abstraction enabled manually for {user_wallet[:10]}...: {result}")

                if result.get('status') == 'ok' or 'response' in result:
                    return {'success': True, 'result': result}
                else:
                    return {'success': False, 'error': result.get('error', 'Unknown error')}

        except Exception as e:
            logger.exception(f"Error enabling DEX abstraction: {e}")
            return {'success': False, 'error': str(e)}

    def _on_ws_prices(self, msg):
        """Callback for WebSocket price updates"""
        try:
            # allMids message format: {"channel": "allMids", "data": {"mids": {"BTC": "50000.5", ...}}}
            if isinstance(msg, dict):
                mids = msg.get('mids', msg.get('data', {}).get('mids', {}))
                if mids:
                    with self._ws_prices_lock:
                        for coin, price in mids.items():
                            self._ws_prices[coin] = float(price)
                        self._ws_last_update = time.time()
                        self._ws_connected = True
        except Exception as e:
            logger.error(f"Error processing WebSocket price update: {e}")

    def start_price_stream(self):
        """Start WebSocket price streaming"""
        if not WEBSOCKET_AVAILABLE:
            logger.warning("WebSocket not available, using REST API fallback")
            return False

        if self._ws_manager is not None:
            logger.info("WebSocket already running")
            return True

        try:
            config = self.get_config()
            api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

            self._ws_manager = WebsocketManager(api_url)
            self._ws_manager.start()

            # Wait for connection
            time.sleep(1)

            # Subscribe to all mid prices
            self._ws_manager.subscribe({"type": "allMids"}, self._on_ws_prices)

            logger.info("WebSocket price streaming started")
            return True

        except Exception as e:
            logger.exception(f"Failed to start WebSocket: {e}")
            self._ws_manager = None
            return False

    def stop_price_stream(self):
        """Stop WebSocket price streaming"""
        if self._ws_manager:
            try:
                self._ws_manager.stop()
            except:
                pass
            self._ws_manager = None
            self._ws_connected = False
            logger.info("WebSocket price streaming stopped")

    def get_account_info(self, user_wallet=None, user_agent_key=None):
        """Get account balance and positions from Hyperliquid (including HIP-3 perps)"""
        try:
            config = self.get_config(user_wallet, user_agent_key)
            if not self.is_configured(user_wallet, user_agent_key):
                return {'error': 'Bot not configured'}

            info, _ = self.get_exchange(user_wallet, user_agent_key)
            user_state = info.user_state(config['main_wallet'])

            margin_summary = user_state.get('marginSummary', {})
            positions = user_state.get('assetPositions', [])

            # Fetch funding rates for all assets
            funding_rates = self._get_funding_rates(info)

            # Format native perp positions
            formatted_positions = []
            for pos in positions:
                position = pos.get('position', {})
                if float(position.get('szi', 0)) != 0:
                    coin = position.get('coin')
                    size = float(position.get('szi', 0))

                    # Get mark price for funding calculation
                    mark_price = float(position.get('positionValue', 0)) / abs(size) if size != 0 else 0

                    # Calculate hourly funding payment
                    # Positive rate = longs pay shorts, Negative rate = shorts pay longs
                    funding_rate = funding_rates.get(coin, 0)
                    # Funding payment = size * mark_price * funding_rate
                    # If long (size > 0) and rate > 0: paying (negative for user)
                    # If long (size > 0) and rate < 0: receiving (positive for user)
                    # If short (size < 0) and rate > 0: receiving (positive for user)
                    # If short (size < 0) and rate < 0: paying (negative for user)
                    hourly_funding = abs(size) * mark_price * funding_rate
                    if size > 0:  # Long position
                        hourly_funding = -hourly_funding  # Longs pay when rate positive
                    # For shorts, hourly_funding stays positive when rate positive (shorts receive)

                    formatted_positions.append({
                        'coin': coin,
                        'size': size,
                        'entry_price': float(position.get('entryPx', 0)),
                        'mark_price': mark_price,
                        'unrealized_pnl': float(position.get('unrealizedPnl', 0)),
                        'leverage': int(position.get('leverage', {}).get('value', 1)),
                        'liquidation_price': float(position.get('liquidationPx', 0)) if position.get('liquidationPx') else None,
                        'margin_used': float(position.get('marginUsed', 0)),
                        'side': 'long' if size > 0 else 'short',
                        'is_hip3': False,
                        'funding_rate': funding_rate,
                        'hourly_funding': hourly_funding
                    })

            # Also fetch HIP-3 perp positions (builder-deployed perpetuals)
            try:
                hip3_positions = self._get_hip3_positions(info, config['main_wallet'])
                if hip3_positions:
                    formatted_positions.extend(hip3_positions)
                    logger.info(f"Loaded {len(hip3_positions)} HIP-3 positions")
            except Exception as hip3_err:
                logger.warning(f"Could not fetch HIP-3 positions: {hip3_err}")

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

    def _get_funding_rates(self, info):
        """
        Get current funding rates for all assets.
        Returns dict mapping coin -> funding_rate (hourly)
        """
        try:
            # Get meta and asset contexts which includes funding rates
            meta_and_ctxs = info.meta_and_asset_ctxs()

            funding_rates = {}
            if meta_and_ctxs and len(meta_and_ctxs) >= 2:
                meta = meta_and_ctxs[0]
                asset_ctxs = meta_and_ctxs[1]
                universe = meta.get('universe', [])

                for i, asset in enumerate(universe):
                    coin = asset.get('name', '')
                    if i < len(asset_ctxs):
                        ctx = asset_ctxs[i]
                        # funding is the current hourly funding rate
                        funding_rate = float(ctx.get('funding', 0))
                        funding_rates[coin] = funding_rate

            return funding_rates
        except Exception as e:
            logger.warning(f"Error fetching funding rates: {e}")
            return {}

    def _get_hip3_funding_rates(self, api_url, dex_name):
        """
        Get funding rates for a specific HIP-3 DEX.
        Returns dict mapping "dex:COIN" -> funding_rate (hourly)
        """
        import requests

        try:
            # Fetch metaAndAssetCtxs with dex parameter for HIP-3 perps
            response = requests.post(
                f"{api_url}/info",
                json={
                    "type": "metaAndAssetCtxs",
                    "dex": dex_name
                },
                headers={"Content-Type": "application/json"}
            )

            data = response.json()
            funding_rates = {}

            if data and isinstance(data, list) and len(data) >= 2:
                meta = data[0]
                asset_ctxs = data[1]
                universe = meta.get('universe', [])

                for i, asset in enumerate(universe):
                    # HIP-3 coins are stored as "dex:COIN" format
                    coin = asset.get('name', '')
                    if coin and i < len(asset_ctxs):
                        ctx = asset_ctxs[i]
                        funding_rate = float(ctx.get('funding', 0))
                        funding_rates[coin] = funding_rate
                        logger.debug(f"HIP-3 funding rate for {coin}: {funding_rate}")

            logger.info(f"Fetched {len(funding_rates)} HIP-3 funding rates for DEX: {dex_name}")
            return funding_rates

        except Exception as e:
            logger.warning(f"Error fetching HIP-3 funding rates for {dex_name}: {e}")
            return {}

    def _get_hip3_positions(self, info, wallet_address):
        """
        Get HIP-3 (builder-deployed perpetual) positions.
        These are separate from native perps and require DEX abstraction to be enabled.

        HIP-3 API requires:
        1. First fetch all DEX names via type: "perpDexs"
        2. Then query clearinghouseState with dex parameter for each DEX
        """
        import requests
        from hyperliquid.utils import constants

        config = self.get_config()
        api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

        try:
            # Step 1: Get list of all HIP-3 DEXs
            dex_response = requests.post(
                f"{api_url}/info",
                json={"type": "perpDexs"},
                headers={"Content-Type": "application/json"}
            )

            dex_list = dex_response.json()
            logger.info(f"HIP-3 perpDexs response: {json.dumps(dex_list)[:500]}")

            if not dex_list or not isinstance(dex_list, list):
                logger.info("No HIP-3 DEXs found")
                return []

            hip3_positions = []

            # Step 2: Query clearinghouseState for each DEX
            for dex_info in dex_list:
                # dex_info could be a string (dex name) or a dict with dex details
                if isinstance(dex_info, dict):
                    dex_name = dex_info.get('name', dex_info.get('dex', ''))
                else:
                    dex_name = str(dex_info)

                if not dex_name:
                    continue

                logger.info(f"Fetching HIP-3 positions for DEX: {dex_name}")

                # Query clearinghouseState with dex parameter
                state_response = requests.post(
                    f"{api_url}/info",
                    json={
                        "type": "clearinghouseState",
                        "user": wallet_address,
                        "dex": dex_name
                    },
                    headers={"Content-Type": "application/json"}
                )

                state = state_response.json()
                logger.info(f"HIP-3 clearinghouseState for {dex_name}: {json.dumps(state)[:500]}")

                if not state or isinstance(state, str):
                    continue

                # Fetch HIP-3 funding rates for this DEX
                hip3_funding_rates = self._get_hip3_funding_rates(api_url, dex_name)

                # Parse positions from clearinghouseState
                positions = state.get('assetPositions', [])
                for pos in positions:
                    position = pos.get('position', pos)
                    size = float(position.get('szi', 0))
                    if size != 0:
                        coin_name = position.get('coin', '')
                        # HIP-3 coins have format "dex:COIN" e.g., "xyz:BTC"
                        # Lookup funding rate using the full coin name (dex:COIN)
                        funding_rate = hip3_funding_rates.get(coin_name, 0)
                        hip3_positions.append({
                            'coin': coin_name,
                            'size': size,
                            'entry_price': float(position.get('entryPx', 0)),
                            'mark_price': float(position.get('positionValue', 0)) / abs(size) if size != 0 else 0,
                            'unrealized_pnl': float(position.get('unrealizedPnl', 0)),
                            'leverage': int(position.get('leverage', {}).get('value', 1)) if isinstance(position.get('leverage'), dict) else int(position.get('leverage', 1)),
                            'liquidation_price': float(position.get('liquidationPx', 0)) if position.get('liquidationPx') else None,
                            'margin_used': float(position.get('marginUsed', 0)),
                            'side': 'long' if size > 0 else 'short',
                            'is_hip3': True,
                            'dex_name': dex_name,
                            'funding_rate': funding_rate
                        })

            logger.info(f"Total HIP-3 positions found: {len(hip3_positions)}")
            return hip3_positions

        except Exception as e:
            logger.warning(f"Error fetching HIP-3 positions: {e}")
            return []

    def get_asset_metadata(self, force_refresh=False):
        """
        Get asset metadata from Hyperliquid including szDecimals, maxLeverage, and onlyIsolated.
        Returns dict mapping coin -> {szDecimals, maxLeverage, onlyIsolated}
        Uses caching to reduce API calls (5 minute TTL).
        """
        current_time = time.time()

        # Return cached data if still valid
        if not force_refresh and self._asset_meta_cache and (current_time - self._asset_meta_cache_time) < self._asset_meta_cache_ttl:
            return self._asset_meta_cache

        try:
            info, _ = self.get_exchange()
            meta = info.meta()

            # meta contains 'universe' which is a list of asset info
            universe = meta.get('universe', [])

            asset_meta = {}
            for asset in universe:
                coin = asset.get('name')
                if coin:
                    asset_meta[coin] = {
                        'szDecimals': asset.get('szDecimals', 2),
                        'maxLeverage': asset.get('maxLeverage', 10),
                        'onlyIsolated': asset.get('onlyIsolated', False)
                    }

            # Update cache
            self._asset_meta_cache = asset_meta
            self._asset_meta_cache_time = current_time

            logger.info(f"Loaded metadata for {len(asset_meta)} assets (cached for {self._asset_meta_cache_ttl}s)")
            return asset_meta

        except Exception as e:
            logger.exception(f"Error getting asset metadata: {e}")
            # Return stale cache if available
            if self._asset_meta_cache:
                logger.warning("Returning stale metadata cache due to error")
                return self._asset_meta_cache
            return {}

    def get_market_prices(self, coins=None, force_refresh=False):
        """
        Get current market prices.
        Uses WebSocket prices if available (no API call), falls back to REST API.
        """
        current_time = time.time()

        # Try WebSocket prices first (no API call needed)
        if self._ws_connected and (current_time - self._ws_last_update) < 10:
            with self._ws_prices_lock:
                if self._ws_prices:
                    if coins:
                        return {coin: self._ws_prices.get(coin, 0) for coin in coins}
                    return dict(self._ws_prices)

        # Fallback: Check REST API cache
        if not force_refresh and self._prices_cache and (current_time - self._prices_cache_time) < self._prices_cache_ttl:
            if coins:
                return {coin: self._prices_cache.get(coin, 0) for coin in coins}
            return self._prices_cache

        # Fallback: Fetch from REST API
        try:
            info, _ = self.get_exchange()
            all_mids = info.all_mids()

            # Update cache
            self._prices_cache = {coin: float(price) for coin, price in all_mids.items()}
            self._prices_cache_time = current_time

            if coins:
                return {coin: self._prices_cache.get(coin, 0) for coin in coins}
            return self._prices_cache
        except Exception as e:
            logger.exception(f"Error getting prices: {e}")
            # Return stale cache if available
            if self._prices_cache:
                logger.warning("Returning stale price cache due to error")
                if coins:
                    return {coin: self._prices_cache.get(coin, 0) for coin in coins}
                return self._prices_cache
            return {}

    def get_size_decimals(self, coin, asset_meta=None):
        """
        Get the number of decimal places for position size based on coin.
        Uses Hyperliquid API metadata when available.
        """
        # Try to get from cached/passed metadata first
        if asset_meta and coin in asset_meta:
            return asset_meta[coin].get('szDecimals', 2)

        # Try to fetch from API
        try:
            meta = self.get_asset_metadata()
            if coin in meta:
                return meta[coin].get('szDecimals', 2)
        except:
            pass

        # Fallback to reasonable defaults
        if coin in ['BTC']:
            return 5
        elif coin in ['ETH']:
            return 4
        else:
            return 2  # Default

    def get_max_leverage(self, coin, asset_meta=None):
        """
        Get the maximum allowed leverage for a coin.
        Uses Hyperliquid API metadata.
        """
        # Try to get from cached/passed metadata first
        if asset_meta and coin in asset_meta:
            return asset_meta[coin].get('maxLeverage', 10)

        # Try to fetch from API
        try:
            meta = self.get_asset_metadata()
            if coin in meta:
                return meta[coin].get('maxLeverage', 10)
        except:
            pass

        return 10  # Default

    def calculate_position_size(self, coin, collateral_usd, leverage, asset_meta=None):
        """Calculate position size based on collateral and leverage"""
        # Use cached prices
        prices = self.get_market_prices([coin])
        current_price = prices.get(coin, 0)

        if current_price == 0:
            raise ValueError(f"Could not get price for {coin}")

        notional_value = collateral_usd * leverage
        size = notional_value / current_price

        # Get szDecimals from passed metadata or cache
        decimals = self.get_size_decimals(coin, asset_meta)
        size = round(size, decimals)

        # Ensure minimum size (at least 1 unit for 0 decimal coins)
        if decimals == 0 and size < 1:
            size = 1
        elif size == 0:
            # If rounding resulted in 0, use minimum increment
            size = 10 ** (-decimals)

        logger.info(f"Calculated size for {coin}: {size} (szDecimals: {decimals}, price: ${current_price:.4f})")

        return size, current_price

    def _retry_api_call(self, func, max_retries=3, initial_delay=2):
        """
        Execute an API call with retry logic for rate limiting (429 errors).
        Uses exponential backoff: 2s, 4s, 8s
        """
        last_error = None
        for attempt in range(max_retries):
            try:
                return func()
            except Exception as e:
                last_error = e
                error_str = str(e)
                # Check for rate limiting (429)
                if '429' in error_str:
                    if attempt < max_retries - 1:
                        delay = initial_delay * (2 ** attempt)  # Exponential backoff
                        logger.warning(f"Rate limited (429), retrying in {delay}s... (attempt {attempt + 1}/{max_retries})")
                        time.sleep(delay)
                        continue
                # Non-429 errors or max retries reached
                raise
        raise last_error

    def execute_trade(self, coin, action, leverage, collateral_usd, stop_loss_pct=None, take_profit_pct=None,
                       tp1_pct=None, tp1_size_pct=None, tp2_pct=None, tp2_size_pct=None, slippage=0.01,
                       user_wallet=None, user_agent_key=None):
        """Execute a trade on Hyperliquid"""
        if not self._enabled:
            return {'success': False, 'error': 'Bot is disabled'}

        try:
            info, exchange = self.get_exchange(user_wallet, user_agent_key)

            # Get full asset metadata (uses cache)
            asset_meta = self.get_asset_metadata()
            coin_meta = asset_meta.get(coin, {})

            # Check if coin exists in Hyperliquid universe
            if not coin_meta:
                # Log available coins for debugging
                available_coins = list(asset_meta.keys())
                similar = [c for c in available_coins if coin.lower() in c.lower() or c.lower() in coin.lower()]
                error_msg = f"Coin '{coin}' not found in Hyperliquid. Similar: {similar[:5]}"
                logger.error(error_msg)
                return {'success': False, 'error': error_msg}

            max_leverage = coin_meta.get('maxLeverage', 10)
            only_isolated = coin_meta.get('onlyIsolated', False)

            # Log asset info for debugging
            logger.info(f"Asset {coin}: maxLeverage={max_leverage}, onlyIsolated={only_isolated}")

            # Check max leverage for this coin
            if leverage > max_leverage:
                error_msg = f"Leverage {leverage}x exceeds max allowed for {coin} ({max_leverage}x)"
                logger.error(error_msg)
                return {'success': False, 'error': error_msg}

            # Set leverage - always use isolated margin (is_cross=False)
            # This is required for assets with onlyIsolated=True (like AERO)
            logger.info(f"Setting leverage to {leverage}x for {coin} (max: {max_leverage}x, isolated margin)")
            try:
                leverage_result = self._retry_api_call(
                    lambda: exchange.update_leverage(leverage, coin, is_cross=False)
                )
                logger.info(f"Leverage update result for {coin}: {leverage_result}")
            except Exception as lev_error:
                error_msg = f"Failed to set leverage for {coin}: {str(lev_error)}"
                logger.error(error_msg)
                return {'success': False, 'error': error_msg}

            # Calculate position size (uses cached prices and metadata)
            size, entry_price = self.calculate_position_size(coin, collateral_usd, leverage, asset_meta=asset_meta)

            # Execute order with retry logic
            is_buy = action.lower() == 'buy'
            logger.info(f"Executing {'BUY' if is_buy else 'SELL'} {size} {coin} at ~${entry_price:.2f}")

            order_result = self._retry_api_call(
                lambda: exchange.market_open(coin, is_buy, size, None, slippage)
            )

            logger.info(f"Order result: {json.dumps(order_result, indent=2)}")

            # Parse result
            if order_result.get("status") == "ok":
                statuses = order_result.get("response", {}).get("data", {}).get("statuses", [])
                fills = []
                actual_price = entry_price
                errors = []

                for status in statuses:
                    if "filled" in status:
                        filled = status["filled"]
                        actual_price = float(filled.get("avgPx", entry_price))
                        fills.append({
                            "oid": filled.get("oid"),
                            "size": filled.get("totalSz"),
                            "avg_price": actual_price
                        })
                    elif "error" in status:
                        errors.append(status["error"])
                    elif "resting" in status:
                        # Order placed but not filled - this shouldn't happen with market orders
                        logger.warning(f"Order resting (not filled): {status}")
                        errors.append("Order placed but not filled")

                # Check for errors
                if errors:
                    error_msg = "; ".join(errors)
                    logger.error(f"Order errors for {coin}: {error_msg}")
                    return {'success': False, 'error': error_msg}

                # Verify we actually have fills
                if not fills:
                    logger.error(f"No fills received for {coin} order. Statuses: {statuses}")
                    return {'success': False, 'error': 'Order accepted but no fills received'}

                # Calculate SL/TP prices
                side = 'long' if is_buy else 'short'
                filled_size = float(fills[0]['size']) if fills else size
                sz_decimals = self.get_size_decimals(coin)
                sl_price = None
                tp_price = None
                sl_order_result = None
                tp_order_result = None

                if stop_loss_pct:
                    if side == 'long':
                        sl_price = actual_price * (1 - stop_loss_pct / 100)
                    else:
                        sl_price = actual_price * (1 + stop_loss_pct / 100)
                    # Round to 5 significant figures
                    sl_price = float(f"{sl_price:.5g}")

                    # Place stop loss order on exchange
                    sl_order_result = self.place_stop_loss_order(coin, side, sl_price, filled_size, user_wallet, user_agent_key)
                    if sl_order_result.get('success'):
                        logger.info(f"Stop loss order placed for {coin} at ${sl_price:.2f}")
                    else:
                        logger.warning(f"Failed to place stop loss for {coin}: {sl_order_result.get('error')}")

                # Handle TP1 and TP2 (multi-level take profits)
                tp1_price = None
                tp2_price = None
                tp1_order_result = None
                tp2_order_result = None

                if tp1_pct and tp1_size_pct:
                    if side == 'long':
                        tp1_price = actual_price * (1 + tp1_pct / 100)
                    else:
                        tp1_price = actual_price * (1 - tp1_pct / 100)
                    # Round to 5 significant figures
                    tp1_price = float(f"{tp1_price:.5g}")

                    # Calculate TP1 size (percentage of position) and round
                    tp1_size = filled_size * (tp1_size_pct / 100)
                    tp1_size = round(tp1_size, sz_decimals)

                    # Only place order if size is valid
                    if tp1_size > 0:
                        # Place TP1 order on exchange
                        tp1_order_result = self.place_take_profit_order(coin, side, tp1_price, tp1_size, user_wallet, user_agent_key)
                        if tp1_order_result.get('success'):
                            logger.info(f"TP1 order placed for {coin} at ${tp1_price:.2f} for {tp1_size_pct}% of position")
                        else:
                            logger.warning(f"Failed to place TP1 for {coin}: {tp1_order_result.get('error')}")
                    else:
                        logger.warning(f"TP1 size too small for {coin}: {tp1_size}")
                        tp1_order_result = {'success': False, 'error': 'Size too small after rounding'}

                if tp2_pct and tp2_size_pct:
                    if side == 'long':
                        tp2_price = actual_price * (1 + tp2_pct / 100)
                    else:
                        tp2_price = actual_price * (1 - tp2_pct / 100)
                    # Round to 5 significant figures
                    tp2_price = float(f"{tp2_price:.5g}")

                    # Calculate TP2 size (percentage of position) and round
                    tp2_size = filled_size * (tp2_size_pct / 100)
                    tp2_size = round(tp2_size, sz_decimals)

                    # Only place order if size is valid
                    if tp2_size > 0:
                        # Place TP2 order on exchange
                        tp2_order_result = self.place_take_profit_order(coin, side, tp2_price, tp2_size, user_wallet, user_agent_key)
                        if tp2_order_result.get('success'):
                            logger.info(f"TP2 order placed for {coin} at ${tp2_price:.2f} for {tp2_size_pct}% of position")
                        else:
                            logger.warning(f"Failed to place TP2 for {coin}: {tp2_order_result.get('error')}")
                    else:
                        logger.warning(f"TP2 size too small for {coin}: {tp2_size}")
                        tp2_order_result = {'success': False, 'error': 'Size too small after rounding'}

                # Fallback to single take_profit_pct if TP1/TP2 not specified
                if take_profit_pct and not tp1_pct and not tp2_pct:
                    if side == 'long':
                        tp_price = actual_price * (1 + take_profit_pct / 100)
                    else:
                        tp_price = actual_price * (1 - take_profit_pct / 100)
                    # Round to 5 significant figures
                    tp_price = float(f"{tp_price:.5g}")

                    # Place take profit order on exchange
                    tp_order_result = self.place_take_profit_order(coin, side, tp_price, filled_size, user_wallet, user_agent_key)
                    if tp_order_result.get('success'):
                        logger.info(f"Take profit order placed for {coin} at ${tp_price:.2f}")
                    else:
                        logger.warning(f"Failed to place take profit for {coin}: {tp_order_result.get('error')}")

                logger.info(f"Trade filled: {coin} {action} {fills[0]['size']} @ ${actual_price:.2f}")

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
                    'take_profit': tp_price or tp1_price,  # Use tp1 as primary TP for backward compat
                    'tp1_price': tp1_price,
                    'tp2_price': tp2_price,
                    'sl_order': sl_order_result,
                    'tp_order': tp_order_result,
                    'tp1_order': tp1_order_result,
                    'tp2_order': tp2_order_result,
                    'fills': fills,
                    'order_id': fills[0]['oid'] if fills else None
                }
            else:
                error_msg = order_result.get("response", {})
                if isinstance(error_msg, dict):
                    error_msg = error_msg.get("error", str(error_msg))
                logger.error(f"Order failed for {coin}: {error_msg}")
                return {'success': False, 'error': str(error_msg)}

        except Exception as e:
            logger.exception(f"Trade execution error: {e}")
            return {'success': False, 'error': str(e)}

    def close_position(self, coin, size=None, user_wallet=None, user_agent_key=None):
        """Close a position for a coin"""
        try:
            _, exchange = self.get_exchange(user_wallet, user_agent_key)

            if size:
                # Partial close - TODO: implement
                pass

            result = exchange.market_close(coin)
            logger.info(f"Close result for {coin}: {result}")

            return {'success': True, 'coin': coin, 'result': result}

        except Exception as e:
            logger.exception(f"Error closing position: {e}")
            return {'success': False, 'error': str(e)}

    def place_stop_loss_order(self, coin, side, trigger_price, size, user_wallet=None, user_agent_key=None):
        """Place a stop loss order on the exchange"""
        try:
            _, exchange = self.get_exchange(user_wallet, user_agent_key)

            # Get size decimals for proper rounding
            sz_decimals = self.get_size_decimals(coin)
            size = round(size, sz_decimals)

            # Skip if size is too small after rounding
            if size <= 0:
                logger.warning(f"Stop loss size too small for {coin} after rounding")
                return {'success': False, 'error': 'Size too small'}

            # For stop loss, we want to close the position
            # If we're long, we sell on stop loss (is_buy=False)
            # If we're short, we buy on stop loss (is_buy=True)
            is_buy = side == 'short'

            # Round prices to avoid floating point precision issues
            # Use 5 significant figures like the SDK does
            trigger_price = float(f"{trigger_price:.5g}")

            # Set limit price with slippage to ensure execution
            # For sell stop (long position): limit below trigger (price dropping)
            # For buy stop (short position): limit above trigger (price rising)
            slippage = 0.05  # 5% slippage allowance for stop loss
            if is_buy:
                # Short position - buying back, price is rising, set limit higher
                limit_price = trigger_price * (1 + slippage)
            else:
                # Long position - selling, price is dropping, set limit lower
                limit_price = trigger_price * (1 - slippage)

            # Round limit price as well
            limit_price = float(f"{limit_price:.5g}")

            order_type = {"trigger": {"triggerPx": trigger_price, "isMarket": True, "tpsl": "sl"}}
            result = exchange.order(
                coin,
                is_buy,
                size,
                limit_price,
                order_type,
                reduce_only=True
            )

            logger.info(f"Stop loss order result for {coin}: trigger={trigger_price}, size={size}, result={result}")

            # Check if order was successful
            statuses = result.get("response", {}).get("data", {}).get("statuses", [])
            if statuses and len(statuses) > 0:
                status = statuses[0]
                if "error" in status:
                    logger.error(f"Stop loss order error for {coin}: {status['error']}")
                    return {'success': False, 'error': status['error']}
                elif "resting" in status or "filled" in status:
                    logger.info(f"Stop loss order placed successfully for {coin}")
                    return {'success': True, 'result': result}

            # Check for top-level error
            if result.get("status") == "err":
                error_msg = result.get("response", "Unknown error")
                logger.error(f"Stop loss order failed for {coin}: {error_msg}")
                return {'success': False, 'error': str(error_msg)}

            return {'success': True, 'result': result}
        except Exception as e:
            logger.exception(f"Error placing stop loss: {e}")
            return {'success': False, 'error': str(e)}

    def place_take_profit_order(self, coin, side, trigger_price, size, user_wallet=None, user_agent_key=None):
        """Place a take profit order on the exchange"""
        try:
            _, exchange = self.get_exchange(user_wallet, user_agent_key)

            # Get size decimals for proper rounding
            sz_decimals = self.get_size_decimals(coin)
            size = round(size, sz_decimals)

            # Skip if size is too small after rounding
            if size <= 0:
                logger.warning(f"Take profit size too small for {coin} after rounding")
                return {'success': False, 'error': 'Size too small'}

            # For take profit, we want to close the position
            # If we're long, we sell on take profit (is_buy=False)
            # If we're short, we buy on take profit (is_buy=True)
            is_buy = side == 'short'

            # Round prices to avoid floating point precision issues
            # Use 5 significant figures like the SDK does
            trigger_price = float(f"{trigger_price:.5g}")

            # Set limit price with small slippage to ensure execution
            # For sell TP (long position): limit slightly below trigger
            # For buy TP (short position): limit slightly above trigger
            slippage = 0.02  # 2% slippage allowance for take profit
            if is_buy:
                # Short position - buying back, set limit higher
                limit_price = trigger_price * (1 + slippage)
            else:
                # Long position - selling, set limit lower
                limit_price = trigger_price * (1 - slippage)

            # Round limit price as well
            limit_price = float(f"{limit_price:.5g}")

            order_type = {"trigger": {"triggerPx": trigger_price, "isMarket": True, "tpsl": "tp"}}
            result = exchange.order(
                coin,
                is_buy,
                size,
                limit_price,
                order_type,
                reduce_only=True
            )

            logger.info(f"Take profit order result for {coin}: trigger={trigger_price}, size={size}, result={result}")

            # Check if order was successful
            statuses = result.get("response", {}).get("data", {}).get("statuses", [])
            if statuses and len(statuses) > 0:
                status = statuses[0]
                if "error" in status:
                    logger.error(f"Take profit order error for {coin}: {status['error']}")
                    return {'success': False, 'error': status['error']}
                elif "resting" in status or "filled" in status:
                    logger.info(f"Take profit order placed successfully for {coin}")
                    return {'success': True, 'result': result}

            # Check for top-level error
            if result.get("status") == "err":
                error_msg = result.get("response", "Unknown error")
                logger.error(f"Take profit order failed for {coin}: {error_msg}")
                return {'success': False, 'error': str(error_msg)}

            return {'success': True, 'result': result}
        except Exception as e:
            logger.exception(f"Error placing take profit: {e}")
            return {'success': False, 'error': str(e)}

    def get_open_orders(self, wallet_address):
        """
        Get all open orders for a wallet address.
        Uses direct API call with type: openOrders
        """
        import requests
        from hyperliquid.utils import constants

        config = self.get_config()
        api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

        try:
            all_orders = []

            # Get native perps + spot open orders (dex: "")
            response = requests.post(
                f"{api_url}/info",
                json={
                    "type": "openOrders",
                    "user": wallet_address
                },
                headers={"Content-Type": "application/json"}
            )

            native_orders = response.json()
            if isinstance(native_orders, list):
                all_orders.extend(native_orders)
                logger.info(f"Fetched {len(native_orders)} native open orders for {wallet_address}")

            # Also fetch HIP-3 open orders from each DEX
            dex_response = requests.post(
                f"{api_url}/info",
                json={"type": "perpDexs"},
                headers={"Content-Type": "application/json"}
            )
            dex_list = dex_response.json()

            if dex_list and isinstance(dex_list, list):
                for dex_info in dex_list:
                    dex_name = dex_info.get('name', dex_info.get('dex', '')) if isinstance(dex_info, dict) else str(dex_info)
                    if not dex_name:
                        continue

                    hip3_response = requests.post(
                        f"{api_url}/info",
                        json={
                            "type": "openOrders",
                            "user": wallet_address,
                            "dex": dex_name
                        },
                        headers={"Content-Type": "application/json"}
                    )
                    hip3_orders = hip3_response.json()
                    if isinstance(hip3_orders, list) and hip3_orders:
                        all_orders.extend(hip3_orders)
                        logger.info(f"Fetched {len(hip3_orders)} HIP-3 orders from {dex_name}")

            return all_orders

        except Exception as e:
            logger.exception(f"Error getting open orders: {e}")
            return []

    def cancel_all_orders(self, wallet_address, agent_key, coin=None):
        """Cancel all open orders, optionally for a specific coin"""
        try:
            _, exchange = self.get_exchange(wallet_address, agent_key)
            orders = self.get_open_orders(wallet_address)

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

    def cancel_order(self, user_wallet, user_agent_key, oid, coin):
        """Cancel a specific order by oid"""
        try:
            _, exchange = self.get_exchange(user_wallet, user_agent_key)
            result = exchange.cancel(coin, oid)

            if result and result.get('status') == 'ok':
                return {'success': True}
            else:
                error_msg = result.get('response', {}).get('data', {}).get('statuses', [{}])[0].get('error', 'Unknown error')
                return {'success': False, 'error': error_msg}
        except Exception as e:
            logger.exception(f"Error cancelling order: {e}")
            return {'success': False, 'error': str(e)}

    def get_spot_balances(self, wallet_address):
        """
        Get spot balances for a wallet.
        Returns list of token balances with USD values.
        Uses spotClearinghouseState API endpoint.
        """
        import requests
        from hyperliquid.utils import constants

        config = self.get_config()
        api_url = constants.TESTNET_API_URL if config['use_testnet'] else constants.MAINNET_API_URL

        logger.info(f"Fetching spot balances for {wallet_address} from {api_url}")

        try:
            # Fetch spot balances using spotClearinghouseState
            response = requests.post(
                f"{api_url}/info",
                json={
                    "type": "spotClearinghouseState",
                    "user": wallet_address
                },
                headers={"Content-Type": "application/json"}
            )

            data = response.json()
            logger.info(f"Spot balances API response: {json.dumps(data)[:500] if data else 'None'}")
            balances = []

            if data and isinstance(data, dict):
                # Parse balances from spotClearinghouseState
                # API returns: coin, total (token amount), hold (in orders), entryNtl (USD value)
                spot_balances = data.get('balances', [])

                for bal in spot_balances:
                    token = bal.get('coin', '')
                    total = float(bal.get('total', 0) or 0)
                    entry_ntl = float(bal.get('entryNtl', 0) or 0)

                    # Skip zero balances
                    if total == 0:
                        continue

                    # For USD stablecoins (USDC, USDH, etc.), use total as USD value
                    # For other tokens, use entryNtl (the USD notional value)
                    if token in ('USDC', 'USDH', 'USDT'):
                        value_usd = total
                    else:
                        value_usd = entry_ntl

                    balances.append({
                        'token': token,
                        'total': total,
                        'value_usd': value_usd
                    })

            logger.info(f"Fetched {len(balances)} spot balances for {wallet_address}")
            return balances

        except Exception as e:
            logger.exception(f"Error fetching spot balances: {e}")
            return []


# Global bot manager instance
bot_manager = BotManager()
