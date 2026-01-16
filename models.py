"""
Database Models for Trading Bot
================================
SQLite database with SQLAlchemy for:
- Trade history
- Bot configuration
- Coin settings
- Risk management parameters
"""

import os
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Trade(db.Model):
    """Record of all executed trades"""
    __tablename__ = 'trades'

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
    status = db.Column(db.String(20), default='open')  # open, closed, liquidated
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
    enabled = db.Column(db.Boolean, default=True)
    default_leverage = db.Column(db.Integer, default=10)
    default_collateral = db.Column(db.Float, default=100.0)
    max_position_size = db.Column(db.Float, nullable=True)  # Max position in USD
    max_open_positions = db.Column(db.Integer, default=1)  # Per this coin

    # Stop Loss / Take Profit defaults
    default_stop_loss_pct = db.Column(db.Float, nullable=True)  # e.g., 2.0 for 2%
    default_take_profit_pct = db.Column(db.Float, nullable=True)  # e.g., 5.0 for 5%
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
            'enabled': self.enabled,
            'default_leverage': self.default_leverage,
            'default_collateral': self.default_collateral,
            'max_position_size': self.max_position_size,
            'max_open_positions': self.max_open_positions,
            'default_stop_loss_pct': self.default_stop_loss_pct,
            'default_take_profit_pct': self.default_take_profit_pct,
            'use_trailing_stop': self.use_trailing_stop,
            'trailing_stop_pct': self.trailing_stop_pct,
            'indicator_source': self.indicator_source
        }


class RiskSettings(db.Model):
    """Global risk management settings"""
    __tablename__ = 'risk_settings'

    id = db.Column(db.Integer, primary_key=True)

    # Position limits
    max_total_positions = db.Column(db.Integer, default=5)
    max_position_value_usd = db.Column(db.Float, default=1000.0)
    max_total_exposure_usd = db.Column(db.Float, default=5000.0)

    # Daily limits
    daily_loss_limit_usd = db.Column(db.Float, default=500.0)
    daily_loss_limit_pct = db.Column(db.Float, default=10.0)  # % of account
    max_daily_trades = db.Column(db.Integer, default=20)

    # Risk per trade
    max_risk_per_trade_pct = db.Column(db.Float, default=2.0)  # % of account

    # Leverage limits
    max_leverage = db.Column(db.Integer, default=20)

    # Circuit breakers
    pause_on_consecutive_losses = db.Column(db.Integer, default=3)
    pause_duration_minutes = db.Column(db.Integer, default=60)

    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'max_total_positions': self.max_total_positions,
            'max_position_value_usd': self.max_position_value_usd,
            'max_total_exposure_usd': self.max_total_exposure_usd,
            'daily_loss_limit_usd': self.daily_loss_limit_usd,
            'daily_loss_limit_pct': self.daily_loss_limit_pct,
            'max_daily_trades': self.max_daily_trades,
            'max_risk_per_trade_pct': self.max_risk_per_trade_pct,
            'max_leverage': self.max_leverage,
            'pause_on_consecutive_losses': self.pause_on_consecutive_losses,
            'pause_duration_minutes': self.pause_duration_minutes
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

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    level = db.Column(db.String(20), default='info')  # info, warning, error, trade
    category = db.Column(db.String(50), nullable=False)  # trade, risk, system, webhook
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


def init_db(app):
    """Initialize database with default values"""
    db.init_app(app)

    with app.app_context():
        db.create_all()

        # Create default risk settings if not exist
        if not RiskSettings.query.first():
            default_risk = RiskSettings()
            db.session.add(default_risk)

        # Create default coin configs for popular coins
        # Hyperliquid asset IDs for configured coins
        default_coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'ENA', 'PENDLE', 'VIRTUAL',
                         'AERO', 'PUMP', 'DOGE', 'FARTCOIN', 'kBONK', 'kPEPE', 'PENGU']
        for coin in default_coins:
            if not CoinConfig.query.filter_by(coin=coin).first():
                coin_config = CoinConfig(coin=coin)
                db.session.add(coin_config)

        # Set default bot config
        defaults = {
            'bot_enabled': 'true',
            'use_testnet': 'true',
            'slippage_tolerance': '0.01',
            'default_leverage': '10',
            'default_collateral': '100'
        }
        for key, value in defaults.items():
            if not BotConfig.query.filter_by(key=key).first():
                BotConfig.set(key, value)

        db.session.commit()
