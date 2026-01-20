"""Add multi-user support with user_id foreign keys

Revision ID: add_multi_user_support
Revises: add_margin_mode_to_coin_configs
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

# revision identifiers, used by Alembic.
revision = 'add_multi_user_support'
down_revision = 'add_margin_mode_to_coin_configs'
branch_labels = None
depends_on = None


def upgrade():
    # Add user_id to trades
    with op.batch_alter_table('trades', schema=None) as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.Integer(), nullable=True))
        batch_op.create_index('idx_trade_user_status', ['user_id', 'status'])
        batch_op.create_index('idx_trade_user_timestamp', ['user_id', 'timestamp'])
        batch_op.create_foreign_key('fk_trades_user_id', 'user_wallets', ['user_id'], ['id'])

    # Add user_id to coin_configs (remove old unique constraint on coin, add new one)
    with op.batch_alter_table('coin_configs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.Integer(), nullable=True))
        batch_op.create_index('idx_coinconfig_user', ['user_id'])
        batch_op.create_foreign_key('fk_coin_configs_user_id', 'user_wallets', ['user_id'], ['id'])
        # Note: unique constraint on coin will be handled separately since SQLite doesn't support
        # dropping constraints easily in batch mode

    # Add user_id to risk_settings
    with op.batch_alter_table('risk_settings', schema=None) as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.Integer(), nullable=True))
        batch_op.create_index('idx_risksettings_user', ['user_id'])
        batch_op.create_foreign_key('fk_risk_settings_user_id', 'user_wallets', ['user_id'], ['id'])

    # Add user_id and webhook_secret to indicators
    with op.batch_alter_table('indicators', schema=None) as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('webhook_secret', sa.String(64), nullable=True))
        batch_op.create_index('idx_indicator_user', ['user_id'])
        batch_op.create_index('idx_indicator_webhook_secret', ['webhook_secret'])
        batch_op.create_foreign_key('fk_indicators_user_id', 'user_wallets', ['user_id'], ['id'])

    # Add user_id to activity_logs
    with op.batch_alter_table('activity_logs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.Integer(), nullable=True))
        batch_op.create_index('idx_activitylog_user_timestamp', ['user_id', 'timestamp'])
        batch_op.create_foreign_key('fk_activity_logs_user_id', 'user_wallets', ['user_id'], ['id'])


def downgrade():
    # Remove user_id from activity_logs
    with op.batch_alter_table('activity_logs', schema=None) as batch_op:
        batch_op.drop_constraint('fk_activity_logs_user_id', type_='foreignkey')
        batch_op.drop_index('idx_activitylog_user_timestamp')
        batch_op.drop_column('user_id')

    # Remove user_id and webhook_secret from indicators
    with op.batch_alter_table('indicators', schema=None) as batch_op:
        batch_op.drop_constraint('fk_indicators_user_id', type_='foreignkey')
        batch_op.drop_index('idx_indicator_webhook_secret')
        batch_op.drop_index('idx_indicator_user')
        batch_op.drop_column('webhook_secret')
        batch_op.drop_column('user_id')

    # Remove user_id from risk_settings
    with op.batch_alter_table('risk_settings', schema=None) as batch_op:
        batch_op.drop_constraint('fk_risk_settings_user_id', type_='foreignkey')
        batch_op.drop_index('idx_risksettings_user')
        batch_op.drop_column('user_id')

    # Remove user_id from coin_configs
    with op.batch_alter_table('coin_configs', schema=None) as batch_op:
        batch_op.drop_constraint('fk_coin_configs_user_id', type_='foreignkey')
        batch_op.drop_index('idx_coinconfig_user')
        batch_op.drop_column('user_id')

    # Remove user_id from trades
    with op.batch_alter_table('trades', schema=None) as batch_op:
        batch_op.drop_constraint('fk_trades_user_id', type_='foreignkey')
        batch_op.drop_index('idx_trade_user_timestamp')
        batch_op.drop_index('idx_trade_user_status')
        batch_op.drop_column('user_id')
