"""
Risk Management Module
=======================
Handles all risk checks before trade execution:
- Position limits
- Daily loss limits
- Consecutive loss circuit breakers
- Stop-loss and take-profit calculations
"""

import json
import logging
from datetime import datetime, timedelta
from models import db, Trade, RiskSettings, CoinConfig, ActivityLog

logger = logging.getLogger(__name__)


class RiskManager:
    """Manages risk checks and trade validation"""

    def __init__(self, app=None):
        self.app = app
        self._paused_until = None
        self._consecutive_losses = 0

    def log_activity(self, level, category, message, details=None):
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

    def get_risk_settings(self):
        """Get current risk settings"""
        settings = RiskSettings.query.first()
        if not settings:
            settings = RiskSettings()
            db.session.add(settings)
            db.session.commit()
        return settings

    def get_coin_config(self, coin):
        """Get coin-specific configuration"""
        config = CoinConfig.query.filter_by(coin=coin).first()
        if not config:
            config = CoinConfig(coin=coin)
            db.session.add(config)
            db.session.commit()
        return config

    def check_trading_allowed(self, coin, collateral_usd, leverage):
        """
        Run all risk checks before allowing a trade.
        Returns (allowed: bool, reason: str)
        """
        settings = self.get_risk_settings()
        coin_config = self.get_coin_config(coin)

        # Check if coin is enabled
        if not coin_config.enabled:
            return False, f"Trading disabled for {coin}"

        # Check if bot is paused due to losses
        if self._paused_until and datetime.utcnow() < self._paused_until:
            remaining = (self._paused_until - datetime.utcnow()).seconds // 60
            return False, f"Bot paused for {remaining} more minutes due to consecutive losses"

        # Check leverage limit
        if leverage > settings.max_leverage:
            return False, f"Leverage {leverage}x exceeds maximum {settings.max_leverage}x"

        # Check position value limit
        position_value = collateral_usd * leverage
        if position_value > settings.max_position_value_usd:
            return False, f"Position value ${position_value:.2f} exceeds limit ${settings.max_position_value_usd:.2f}"

        # Check max positions per coin
        open_positions_for_coin = Trade.query.filter_by(
            coin=coin, status='open'
        ).count()
        if open_positions_for_coin >= coin_config.max_open_positions:
            return False, f"Max open positions ({coin_config.max_open_positions}) reached for {coin}"

        # Check total open positions
        total_open = Trade.query.filter_by(status='open').count()
        if total_open >= settings.max_total_positions:
            return False, f"Max total positions ({settings.max_total_positions}) reached"

        # Check total exposure
        total_exposure = self._calculate_total_exposure()
        if total_exposure + position_value > settings.max_total_exposure_usd:
            return False, f"Total exposure would exceed ${settings.max_total_exposure_usd:.2f}"

        # Check daily loss limit
        daily_loss = self._calculate_daily_loss()
        if abs(daily_loss) >= settings.daily_loss_limit_usd:
            return False, f"Daily loss limit ${settings.daily_loss_limit_usd:.2f} reached"

        # Check daily trade count
        daily_trades = self._count_daily_trades()
        if daily_trades >= settings.max_daily_trades:
            return False, f"Max daily trades ({settings.max_daily_trades}) reached"

        return True, "All risk checks passed"

    def _calculate_total_exposure(self):
        """Calculate total USD exposure from open positions"""
        open_trades = Trade.query.filter_by(status='open').all()
        total = sum(t.collateral_usd * t.leverage for t in open_trades)
        return total

    def _calculate_daily_loss(self):
        """Calculate total P&L for today"""
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        trades = Trade.query.filter(
            Trade.timestamp >= today,
            Trade.status == 'closed'
        ).all()
        return sum(t.pnl or 0 for t in trades)

    def _count_daily_trades(self):
        """Count trades executed today"""
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        return Trade.query.filter(Trade.timestamp >= today).count()

    def record_trade_result(self, pnl):
        """Record trade result for consecutive loss tracking"""
        settings = self.get_risk_settings()

        if pnl < 0:
            self._consecutive_losses += 1
            if self._consecutive_losses >= settings.pause_on_consecutive_losses:
                self._paused_until = datetime.utcnow() + timedelta(
                    minutes=settings.pause_duration_minutes
                )
                self.log_activity(
                    'warning', 'risk',
                    f"Bot paused for {settings.pause_duration_minutes} minutes due to {self._consecutive_losses} consecutive losses",
                    {'consecutive_losses': self._consecutive_losses}
                )
                self._consecutive_losses = 0
        else:
            self._consecutive_losses = 0

    def calculate_stop_loss_price(self, entry_price, side, stop_loss_pct):
        """Calculate stop loss price based on percentage"""
        if not stop_loss_pct:
            return None

        if side == 'long':
            return entry_price * (1 - stop_loss_pct / 100)
        else:
            return entry_price * (1 + stop_loss_pct / 100)

    def calculate_take_profit_price(self, entry_price, side, take_profit_pct):
        """Calculate take profit price based on percentage"""
        if not take_profit_pct:
            return None

        if side == 'long':
            return entry_price * (1 + take_profit_pct / 100)
        else:
            return entry_price * (1 - take_profit_pct / 100)

    def should_close_position(self, trade, current_price):
        """
        Check if position should be closed based on SL/TP.
        Returns (should_close: bool, reason: str)
        """
        if trade.status != 'open':
            return False, None

        if trade.side == 'long':
            # Stop loss for long
            if trade.stop_loss and current_price <= trade.stop_loss:
                return True, 'stop_loss'
            # Take profit for long
            if trade.take_profit and current_price >= trade.take_profit:
                return True, 'take_profit'
        else:  # short
            # Stop loss for short
            if trade.stop_loss and current_price >= trade.stop_loss:
                return True, 'stop_loss'
            # Take profit for short
            if trade.take_profit and current_price <= trade.take_profit:
                return True, 'take_profit'

        return False, None

    def calculate_pnl(self, trade, exit_price):
        """Calculate P&L for a trade"""
        if trade.side == 'long':
            pnl_pct = ((exit_price - trade.entry_price) / trade.entry_price) * 100
        else:
            pnl_pct = ((trade.entry_price - exit_price) / trade.entry_price) * 100

        # Apply leverage to percentage
        pnl_pct_leveraged = pnl_pct * trade.leverage

        # Calculate USD P&L
        pnl_usd = trade.collateral_usd * (pnl_pct_leveraged / 100)

        return pnl_usd, pnl_pct_leveraged

    def get_open_positions(self):
        """Get all open positions from database"""
        return Trade.query.filter_by(status='open').all()

    def get_daily_stats(self):
        """Get trading statistics for today"""
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

        trades_today = Trade.query.filter(Trade.timestamp >= today).all()
        closed_today = [t for t in trades_today if t.status == 'closed']

        total_pnl = sum(t.pnl or 0 for t in closed_today)
        winning = len([t for t in closed_today if (t.pnl or 0) > 0])
        losing = len([t for t in closed_today if (t.pnl or 0) < 0])

        return {
            'total_trades': len(trades_today),
            'closed_trades': len(closed_today),
            'open_trades': len([t for t in trades_today if t.status == 'open']),
            'total_pnl': total_pnl,
            'winning_trades': winning,
            'losing_trades': losing,
            'win_rate': (winning / len(closed_today) * 100) if closed_today else 0,
            'consecutive_losses': self._consecutive_losses,
            'is_paused': self._paused_until and datetime.utcnow() < self._paused_until
        }


# Global risk manager instance
risk_manager = RiskManager()
