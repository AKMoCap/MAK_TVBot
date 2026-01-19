"""Add quote_asset column to coin_configs and move HIP-3 perps to new category

Revision ID: add_quote_asset_003
Revises: add_margin_mode_002
Create Date: 2025-01-19
"""
from alembic import op
import sqlalchemy as sa


revision = 'add_quote_asset_003'
down_revision = 'add_margin_mode_002'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col['name'] for col in inspector.get_columns('coin_configs')]
    
    if 'quote_asset' not in columns:
        op.add_column('coin_configs', sa.Column('quote_asset', sa.String(20), server_default='USDC', nullable=True))

    try:
        op.execute("UPDATE coin_configs SET category = 'HIP-3 Perps' WHERE coin LIKE '%:%'")
    except Exception:
        pass


def downgrade():
    op.drop_column('coin_configs', 'quote_asset')
    try:
        op.execute("UPDATE coin_configs SET category = 'L1s' WHERE coin LIKE '%:%'")
    except Exception:
        pass
