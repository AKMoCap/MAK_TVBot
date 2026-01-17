"""Initial migration with all models

Revision ID: 71e3d8630812
Revises: 
Create Date: 2026-01-17 15:43:34.619234

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '71e3d8630812'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # This is a baseline migration representing the existing schema
    # Tables already exist in the database, so we only create them if they don't exist
    
    # Check if tables exist before creating
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()
    
    if 'trades' not in existing_tables:
        op.create_table('trades',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('timestamp', sa.DateTime(), nullable=True),
            sa.Column('coin', sa.String(length=20), nullable=False),
            sa.Column('action', sa.String(length=10), nullable=False),
            sa.Column('side', sa.String(length=10), nullable=False),
            sa.Column('size', sa.Float(), nullable=False),
            sa.Column('entry_price', sa.Float(), nullable=False),
            sa.Column('exit_price', sa.Float(), nullable=True),
            sa.Column('leverage', sa.Integer(), nullable=True),
            sa.Column('collateral_usd', sa.Float(), nullable=False),
            sa.Column('pnl', sa.Float(), nullable=True),
            sa.Column('pnl_percent', sa.Float(), nullable=True),
            sa.Column('status', sa.String(length=20), nullable=True),
            sa.Column('order_id', sa.String(length=100), nullable=True),
            sa.Column('stop_loss', sa.Float(), nullable=True),
            sa.Column('take_profit', sa.Float(), nullable=True),
            sa.Column('close_reason', sa.String(length=50), nullable=True),
            sa.Column('indicator_name', sa.String(length=100), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint('id')
        )
        op.create_index(op.f('ix_trades_coin'), 'trades', ['coin'], unique=False)
        op.create_index(op.f('ix_trades_timestamp'), 'trades', ['timestamp'], unique=False)

    if 'bot_config' not in existing_tables:
        op.create_table('bot_config',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('key', sa.String(length=100), nullable=False),
            sa.Column('value', sa.Text(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('key')
        )

    if 'coin_configs' not in existing_tables:
        op.create_table('coin_configs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('coin', sa.String(length=20), nullable=False),
            sa.Column('enabled', sa.Boolean(), nullable=True),
            sa.Column('default_leverage', sa.Integer(), nullable=True),
            sa.Column('default_collateral', sa.Float(), nullable=True),
            sa.Column('max_position_size', sa.Float(), nullable=True),
            sa.Column('max_open_positions', sa.Integer(), nullable=True),
            sa.Column('hl_max_leverage', sa.Integer(), nullable=True),
            sa.Column('hl_sz_decimals', sa.Integer(), nullable=True),
            sa.Column('hl_only_isolated', sa.Boolean(), nullable=True),
            sa.Column('hl_metadata_updated', sa.DateTime(), nullable=True),
            sa.Column('default_stop_loss_pct', sa.Float(), nullable=True),
            sa.Column('tp1_pct', sa.Float(), nullable=True),
            sa.Column('tp1_size_pct', sa.Float(), nullable=True),
            sa.Column('tp2_pct', sa.Float(), nullable=True),
            sa.Column('tp2_size_pct', sa.Float(), nullable=True),
            sa.Column('default_take_profit_pct', sa.Float(), nullable=True),
            sa.Column('use_trailing_stop', sa.Boolean(), nullable=True),
            sa.Column('trailing_stop_pct', sa.Float(), nullable=True),
            sa.Column('indicator_source', sa.String(length=100), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('coin')
        )

    if 'risk_settings' not in existing_tables:
        op.create_table('risk_settings',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('max_position_value_usd', sa.Float(), nullable=True),
            sa.Column('max_total_exposure_pct', sa.Float(), nullable=True),
            sa.Column('max_leverage', sa.Integer(), nullable=True),
            sa.Column('max_total_positions', sa.Integer(), nullable=True),
            sa.Column('max_total_exposure_usd', sa.Float(), nullable=True),
            sa.Column('daily_loss_limit_usd', sa.Float(), nullable=True),
            sa.Column('daily_loss_limit_pct', sa.Float(), nullable=True),
            sa.Column('max_daily_trades', sa.Integer(), nullable=True),
            sa.Column('max_risk_per_trade_pct', sa.Float(), nullable=True),
            sa.Column('cooldown_after_loss_minutes', sa.Integer(), nullable=True),
            sa.Column('circuit_breaker_enabled', sa.Boolean(), nullable=True),
            sa.Column('circuit_breaker_loss_threshold', sa.Float(), nullable=True),
            sa.Column('circuit_breaker_duration_hours', sa.Integer(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id')
        )

    if 'indicators' not in existing_tables:
        op.create_table('indicators',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('name', sa.String(length=100), nullable=False),
            sa.Column('indicator_type', sa.String(length=50), nullable=False),
            sa.Column('enabled', sa.Boolean(), nullable=True),
            sa.Column('config', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('name')
        )

    if 'activity_logs' not in existing_tables:
        op.create_table('activity_logs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('timestamp', sa.DateTime(), nullable=True),
            sa.Column('level', sa.String(length=20), nullable=False),
            sa.Column('category', sa.String(length=50), nullable=True),
            sa.Column('message', sa.Text(), nullable=False),
            sa.Column('details', sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint('id')
        )
        op.create_index(op.f('ix_activity_logs_timestamp'), 'activity_logs', ['timestamp'], unique=False)


def downgrade():
    op.drop_index(op.f('ix_activity_logs_timestamp'), table_name='activity_logs')
    op.drop_table('activity_logs')
    op.drop_table('indicators')
    op.drop_table('risk_settings')
    op.drop_table('coin_configs')
    op.drop_table('bot_config')
    op.drop_index(op.f('ix_trades_timestamp'), table_name='trades')
    op.drop_index(op.f('ix_trades_coin'), table_name='trades')
    op.drop_table('trades')
