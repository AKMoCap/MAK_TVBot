"""Add multi-user support with user_id foreign keys

Revision ID: add_multi_user_support
Revises: add_quote_asset_003
Create Date: 2025-01-20

Adds user_id foreign key to:
- trades
- coin_configs
- risk_settings
- indicators
- activity_logs

Also adds webhook_secret to indicators for per-user TradingView secrets.
"""
from alembic import op
import sqlalchemy as sa

revision = 'add_multi_user_support'
down_revision = 'add_quote_asset_003'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    
    # Check which columns already exist in each table
    trades_cols = [c['name'] for c in inspector.get_columns('trades')]
    coin_configs_cols = [c['name'] for c in inspector.get_columns('coin_configs')]
    risk_settings_cols = [c['name'] for c in inspector.get_columns('risk_settings')]
    indicators_cols = [c['name'] for c in inspector.get_columns('indicators')]
    activity_logs_cols = [c['name'] for c in inspector.get_columns('activity_logs')]
    
    # Add user_id to trades
    if 'user_id' not in trades_cols:
        op.add_column('trades', sa.Column('user_id', sa.Integer(), nullable=True))
        try:
            op.create_index('idx_trade_user_status', 'trades', ['user_id', 'status'])
            op.create_index('idx_trade_user_timestamp', 'trades', ['user_id', 'timestamp'])
            op.create_foreign_key('fk_trades_user_id', 'trades', 'user_wallets', ['user_id'], ['id'])
        except Exception:
            pass

    # Add user_id to coin_configs
    if 'user_id' not in coin_configs_cols:
        op.add_column('coin_configs', sa.Column('user_id', sa.Integer(), nullable=True))
        try:
            op.create_index('idx_coinconfig_user', 'coin_configs', ['user_id'])
            op.create_foreign_key('fk_coin_configs_user_id', 'coin_configs', 'user_wallets', ['user_id'], ['id'])
        except Exception:
            pass

    # Add user_id to risk_settings
    if 'user_id' not in risk_settings_cols:
        op.add_column('risk_settings', sa.Column('user_id', sa.Integer(), nullable=True))
        try:
            op.create_index('idx_risksettings_user', 'risk_settings', ['user_id'])
            op.create_foreign_key('fk_risk_settings_user_id', 'risk_settings', 'user_wallets', ['user_id'], ['id'])
        except Exception:
            pass

    # Add user_id and webhook_secret to indicators
    if 'user_id' not in indicators_cols:
        op.add_column('indicators', sa.Column('user_id', sa.Integer(), nullable=True))
        try:
            op.create_index('idx_indicator_user', 'indicators', ['user_id'])
            op.create_foreign_key('fk_indicators_user_id', 'indicators', 'user_wallets', ['user_id'], ['id'])
        except Exception:
            pass
    
    if 'webhook_secret' not in indicators_cols:
        op.add_column('indicators', sa.Column('webhook_secret', sa.String(64), nullable=True))
        try:
            op.create_index('idx_indicator_webhook_secret', 'indicators', ['webhook_secret'])
        except Exception:
            pass

    # Add user_id to activity_logs
    if 'user_id' not in activity_logs_cols:
        op.add_column('activity_logs', sa.Column('user_id', sa.Integer(), nullable=True))
        try:
            op.create_index('idx_activitylog_user_timestamp', 'activity_logs', ['user_id', 'timestamp'])
            op.create_foreign_key('fk_activity_logs_user_id', 'activity_logs', 'user_wallets', ['user_id'], ['id'])
        except Exception:
            pass


def downgrade():
    try:
        op.drop_constraint('fk_activity_logs_user_id', 'activity_logs', type_='foreignkey')
        op.drop_index('idx_activitylog_user_timestamp', 'activity_logs')
        op.drop_column('activity_logs', 'user_id')
    except Exception:
        pass

    try:
        op.drop_constraint('fk_indicators_user_id', 'indicators', type_='foreignkey')
        op.drop_index('idx_indicator_webhook_secret', 'indicators')
        op.drop_index('idx_indicator_user', 'indicators')
        op.drop_column('indicators', 'webhook_secret')
        op.drop_column('indicators', 'user_id')
    except Exception:
        pass

    try:
        op.drop_constraint('fk_risk_settings_user_id', 'risk_settings', type_='foreignkey')
        op.drop_index('idx_risksettings_user', 'risk_settings')
        op.drop_column('risk_settings', 'user_id')
    except Exception:
        pass

    try:
        op.drop_constraint('fk_coin_configs_user_id', 'coin_configs', type_='foreignkey')
        op.drop_index('idx_coinconfig_user', 'coin_configs')
        op.drop_column('coin_configs', 'user_id')
    except Exception:
        pass

    try:
        op.drop_constraint('fk_trades_user_id', 'trades', type_='foreignkey')
        op.drop_index('idx_trade_user_timestamp', 'trades')
        op.drop_index('idx_trade_user_status', 'trades')
        op.drop_column('trades', 'user_id')
    except Exception:
        pass
