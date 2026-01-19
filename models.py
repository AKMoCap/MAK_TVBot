"""
Database Models for Trading Bot
================================
PostgreSQL/SQLite database with SQLAlchemy for:
- Trade history
- Bot configuration
- Coin settings
- Risk management parameters
- User wallets and agent keys
"""

import os
import secrets
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from cryptography.fernet import Fernet

db = SQLAlchemy()
migrate = Migrate()

# Encryption key for agent secrets (generated once, stored in env)
def get_encryption_key():
    key = os.environ.get('AGENT_ENCRYPTION_KEY')
    if not key:
        # Generate a new key if not set (should be set in production)
        key = Fernet.generate_key().decode()
        os.environ['AGENT_ENCRYPTION_KEY'] = key
    return key.encode() if isinstance(key, str) else key


class UserWallet(db.Model):
    """User wallet connections and agent keys"""
    __tablename__ = 'user_wallets'

    id = db.Column(db.Integer, primary_key=True)
    address = db.Column(db.String(42), unique=True, nullable=False, index=True)  # Ethereum address

    # Agent wallet info (encrypted)
    agent_address = db.Column(db.String(42), nullable=True)  # Agent wallet address
    agent_key_encrypted = db.Column(db.Text, nullable=True)  # Encrypted agent private key
    agent_name = db.Column(db.String(100), nullable=True)  # Optional agent name

    # Network preference
    use_testnet = db.Column(db.Boolean, default=True)

    # Session tracking
    last_connected = db.Column(db.DateTime, default=datetime.utcnow)
    session_token = db.Column(db.String(64), nullable=True, index=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def set_agent_key(self, agent_key):
        """Encrypt and store agent private key"""
        if agent_key:
            f = Fernet(get_encryption_key())
            self.agent_key_encrypted = f.encrypt(agent_key.encode()).decode()

    def get_agent_key(self):
        """Decrypt and return agent private key"""
        if self.agent_key_encrypted:
            f = Fernet(get_encryption_key())
            return f.decrypt(self.agent_key_encrypted.encode()).decode()
        return None

    def generate_session_token(self):
        """Generate a new session token"""
        self.session_token = secrets.token_hex(32)
        return self.session_token

    def has_agent_key(self):
        """Check if user has an authorized agent"""
        return bool(self.agent_key_encrypted and self.agent_address)

    def to_dict(self):
        return {
            'address': self.address,
            'agent_address': self.agent_address,
            'has_agent_key': self.has_agent_key(),
            'use_testnet': self.use_testnet,
            'last_connected': self.last_connected.isoformat() if self.last_connected else None
        }


class Trade(db.Model):
    """Record of all executed trades"""
    __tablename__ = 'trades'

    # Composite indexes for commonly used query patterns
    __table_args__ = (
        db.Index('idx_trade_status_timestamp', 'status', 'timestamp'),  # For stats queries
        db.Index('idx_trade_status_pnl', 'status', 'pnl'),  # For win/loss aggregates
    )

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    coin = db.Column(db.String(20), nullable=False, index=True)
    action = db.Column(db.String(10), nullable=False)  # buy, sell, close
    side = db.Column(db.String(10), nullable=False)  # long, short
    size = db.Column(db.Float, nullable=False)
    entry_price = db.Column(db.Float, nullable=False)
    exit_price = db.Column(db.Float, nullable=True)
    leverage = db.Column(db.Integer, default=1)
    collateral_usd = db.Column(db.Float, nullable=False)
    pnl = db.Column(db.Float, nullable=True)  # Profit/Loss in USD
    pnl_percent = db.Column(db.Float, nullable=True)
    status = db.Column(db.String(20), default='open', index=True)  # open, closed, liquidated
    order_id = db.Column(db.String(100), nullable=True)
    stop_loss = db.Column(db.Float, nullable=True)
    take_profit = db.Column(db.Float, nullable=True)
    close_reason = db.Column(db.String(50), nullable=True)  # signal, stop_loss, take_profit, manual
    indicator_name = db.Column(db.String(100), nullable=True)
    notes = db.Column(db.Text, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'coin': self.coin,
            'action': self.action,
            'side': self.side,
            'size': self.size,
            'entry_price': self.entry_price,
            'exit_price': self.exit_price,
            'leverage': self.leverage,
            'collateral_usd': self.collateral_usd,
            'pnl': self.pnl,
            'pnl_percent': self.pnl_percent,
            'status': self.status,
            'stop_loss': self.stop_loss,
            'take_profit': self.take_profit,
            'close_reason': self.close_reason,
            'indicator_name': self.indicator_name
        }


class BotConfig(db.Model):
    """Global bot configuration"""
    __tablename__ = 'bot_config'

    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(100), unique=True, nullable=False)
    value = db.Column(db.Text, nullable=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    @classmethod
    def get(cls, key, default=None):
        config = cls.query.filter_by(key=key).first()
        return config.value if config else default

    @classmethod
    def set(cls, key, value):
        config = cls.query.filter_by(key=key).first()
        if config:
            config.value = str(value)
        else:
            config = cls(key=key, value=str(value))
            db.session.add(config)
        db.session.commit()
        return config


class CoinConfig(db.Model):
    """Per-coin trading configuration"""
    __tablename__ = 'coin_configs'

    id = db.Column(db.Integer, primary_key=True)
    coin = db.Column(db.String(20), unique=True, nullable=False)
    quote_asset = db.Column(db.String(20), default='USDC')  # Collateral asset: USDC, USDH, USDe, etc.
    category = db.Column(db.String(20), default='L1s')  # L1s, APPS, MEMES, HIP-3 Perps
    enabled = db.Column(db.Boolean, default=True)
    default_leverage = db.Column(db.Integer, default=3)
    default_collateral = db.Column(db.Float, default=100.0)
    max_position_size = db.Column(db.Float, default=1000.0)  # 10x default collateral
    max_open_positions = db.Column(db.Integer, default=10)  # Per this coin

    # Hyperliquid API metadata (refreshed via button)
    hl_max_leverage = db.Column(db.Integer, default=50)  # Max leverage from Hyperliquid
    hl_sz_decimals = db.Column(db.Integer, default=2)  # Size decimals for orders
    hl_only_isolated = db.Column(db.Boolean, default=False)  # Isolated margin only
    hl_margin_mode = db.Column(db.String(20), nullable=True)  # strictIsolated, noCross, or null (cross)
    hl_metadata_updated = db.Column(db.DateTime, nullable=True)  # Last metadata refresh

    # Stop Loss default
    default_stop_loss_pct = db.Column(db.Float, default=15.0)  # 15%

    # Take Profit Level 1
    tp1_pct = db.Column(db.Float, default=50.0)  # Target: 50% gain
    tp1_size_pct = db.Column(db.Float, default=25.0)  # Close 25% of position

    # Take Profit Level 2
    tp2_pct = db.Column(db.Float, default=100.0)  # Target: 100% gain
    tp2_size_pct = db.Column(db.Float, default=50.0)  # Close 50% of position

    # Legacy fields (kept for compatibility)
    default_take_profit_pct = db.Column(db.Float, nullable=True)
    use_trailing_stop = db.Column(db.Boolean, default=False)
    trailing_stop_pct = db.Column(db.Float, nullable=True)

    # Indicator settings
    indicator_source = db.Column(db.String(100), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'coin': self.coin,
            'quote_asset': self.quote_asset or 'USDC',
            'category': self.category,
            'enabled': self.enabled,
            'default_leverage': self.default_leverage,
            'default_collateral': self.default_collateral,
            'max_position_size': self.max_position_size,
            'max_open_positions': self.max_open_positions,
            'default_stop_loss_pct': self.default_stop_loss_pct,
            'tp1_pct': self.tp1_pct,
            'tp1_size_pct': self.tp1_size_pct,
            'tp2_pct': self.tp2_pct,
            'tp2_size_pct': self.tp2_size_pct,
            'use_trailing_stop': self.use_trailing_stop,
            'trailing_stop_pct': self.trailing_stop_pct,
            'indicator_source': self.indicator_source,
            # Hyperliquid metadata
            'hl_max_leverage': self.hl_max_leverage,
            'hl_sz_decimals': self.hl_sz_decimals,
            'hl_only_isolated': self.hl_only_isolated,
            'hl_margin_mode': self.hl_margin_mode,
            'hl_metadata_updated': self.hl_metadata_updated.isoformat() if self.hl_metadata_updated else None
        }


class RiskSettings(db.Model):
    """Global risk management settings"""
    __tablename__ = 'risk_settings'

    id = db.Column(db.Integer, primary_key=True)

    # Position limits
    max_position_value_usd = db.Column(db.Float, default=1000.0)
    max_total_exposure_pct = db.Column(db.Float, default=75.0)  # % of account USDC collateral

    # Leverage limits
    max_leverage = db.Column(db.Integer, default=10)

    # Legacy fields (kept for database compatibility)
    max_total_positions = db.Column(db.Integer, default=5)
    max_total_exposure_usd = db.Column(db.Float, default=5000.0)
    daily_loss_limit_usd = db.Column(db.Float, default=500.0)
    daily_loss_limit_pct = db.Column(db.Float, default=10.0)
    max_daily_trades = db.Column(db.Integer, default=20)
    max_risk_per_trade_pct = db.Column(db.Float, default=2.0)
    pause_on_consecutive_losses = db.Column(db.Integer, default=3)
    pause_duration_minutes = db.Column(db.Integer, default=60)

    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'max_position_value_usd': self.max_position_value_usd,
            'max_total_exposure_pct': self.max_total_exposure_pct,
            'max_leverage': self.max_leverage
        }


class Indicator(db.Model):
    """Registered TradingView indicators"""
    __tablename__ = 'indicators'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    indicator_type = db.Column(db.String(50), nullable=False)  # custom, rsi, macd, ema, bollinger
    description = db.Column(db.Text, nullable=True)
    enabled = db.Column(db.Boolean, default=True)

    # Webhook identification
    webhook_key = db.Column(db.String(100), nullable=True)  # Unique key sent in webhook

    # Settings
    timeframe = db.Column(db.String(20), default='1h')  # 1m, 5m, 15m, 1h, 4h, 1d
    coins = db.Column(db.Text, nullable=True)  # JSON list of coins

    # Performance tracking
    total_trades = db.Column(db.Integer, default=0)
    winning_trades = db.Column(db.Integer, default=0)
    total_pnl = db.Column(db.Float, default=0.0)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'indicator_type': self.indicator_type,
            'description': self.description,
            'enabled': self.enabled,
            'webhook_key': self.webhook_key,
            'timeframe': self.timeframe,
            'coins': self.coins,
            'total_trades': self.total_trades,
            'winning_trades': self.winning_trades,
            'win_rate': (self.winning_trades / self.total_trades * 100) if self.total_trades > 0 else 0,
            'total_pnl': self.total_pnl
        }


class ActivityLog(db.Model):
    """Activity and event logging"""
    __tablename__ = 'activity_logs'

    # Composite index for efficient log queries by category
    __table_args__ = (
        db.Index('idx_activitylog_category_timestamp', 'category', 'timestamp'),
    )

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    level = db.Column(db.String(20), default='info', index=True)  # info, warning, error, trade
    category = db.Column(db.String(50), nullable=False, index=True)  # trade, risk, system, webhook
    message = db.Column(db.Text, nullable=False)
    details = db.Column(db.Text, nullable=True)  # JSON details

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'level': self.level,
            'category': self.category,
            'message': self.message,
            'details': self.details
        }


def init_db(app, run_migrations=None, seed_data=None):
    """Initialize database with Flask-Migrate and seed default values
    
    run_migrations: True = always run, False = never run, None = auto-detect
    seed_data: True = always seed, False = never seed, None = auto-detect
    In development (python app.py), migrations and seeding run automatically.
    In production (gunicorn), migrations run via build step, workers skip seeding.
    """
    import logging
    import os
    logger = logging.getLogger(__name__)
    
    db.init_app(app)
    migrate.init_app(app, db)
    
    # Auto-detect: run migrations/seeding in dev but not under gunicorn workers
    is_production = 'gunicorn' in os.environ.get('SERVER_SOFTWARE', '')
    
    if run_migrations is None:
        run_migrations = not is_production
    if seed_data is None:
        seed_data = not is_production

    with app.app_context():
        # Run migrations to ensure schema is up to date
        if run_migrations:
            try:
                from flask_migrate import upgrade
                upgrade()
                logger.info("Database migrations applied successfully")
            except Exception as e:
                logger.warning(f"Migration warning: {e}")
        
        # Skip seeding in production - workers shouldn't modify data
        if not seed_data:
            logger.info("Skipping database seeding (production mode)")
            return
        
        # Run seeding
        seed_defaults()


def seed_defaults():
    """Seed default values into database. Call after migrations are complete."""
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        # Create default risk settings if not exist
        if not RiskSettings.query.first():
            default_risk = RiskSettings()
            db.session.add(default_risk)

        # Create default coin configs for popular coins
        default_coins = {
            'L1s': ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'MON', 'BNB', 'LTC', 'CC', 'TAO', 'TON', 'WLD'],
            'APPS': ['AAVE', 'ENA', 'PENDLE', 'AERO', 'VIRTUAL', 'PUMP', 'LIT', 'CRV', 'LINK', 'ETHFI', 'MORPHO', 'SYRUP', 'JUP'],
            'MEMES': ['DOGE', 'FARTCOIN', 'kBONK', 'kPEPE', 'PENGU', 'SPX'],
            'HIP-3 Perps': []
        }

        for category, coins in default_coins.items():
            for coin in coins:
                existing = CoinConfig.query.filter_by(coin=coin).first()
                if existing:
                    if existing.category != category:
                        existing.category = category
                else:
                    coin_config = CoinConfig(
                        coin=coin,
                        category=category,
                        default_collateral=100.0,
                        max_position_size=1000.0,
                        default_stop_loss_pct=15.0,
                        tp1_pct=50.0,
                        tp1_size_pct=25.0,
                        tp2_pct=100.0,
                        tp2_size_pct=50.0
                    )
                    db.session.add(coin_config)

        # Set default bot config
        defaults = {
            'bot_enabled': 'true',
            'use_testnet': 'true',
            'slippage_tolerance': '0.003',
            'default_leverage': '3',
            'default_collateral': '100'
        }
        for key, value in defaults.items():
            if not BotConfig.query.filter_by(key=key).first():
                BotConfig.set(key, value)

        db.session.commit()
        logger.info("Database seeding completed")
    except Exception as e:
        logger.error(f"Seeding error: {e}")
        db.session.rollback()
