"""Add quote_asset column to coin_configs and move HIP-3 perps to new category

Revision ID: add_quote_asset
Revises: add_margin_mode
Create Date: 2025-01-19
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_quote_asset_003'
down_revision = 'add_margin_mode_002'
branch_labels = None
depends_on = None


def upgrade():
    # Add quote_asset column with default value 'USDC'
    try:
        op.add_column('coin_configs', sa.Column('quote_asset', sa.String(20), server_default='USDC', nullable=True))
    except Exception as e:
        # Column may already exist
        pass

    # Move HIP-3 perps (coins with ':' in name) to HIP-3 Perps category
    # This catches: xyz:XYZ100, xyz:GOLD, xyz:SILVER, km:US500, km:SMALL2000
    try:
        op.execute("UPDATE coin_configs SET category = 'HIP-3 Perps' WHERE coin LIKE '%:%'")
    except Exception as e:
        pass


def downgrade():
    try:
        op.drop_column('coin_configs', 'quote_asset')
    except Exception as e:
        pass

    # Move HIP-3 perps back to L1s category
    try:
        op.execute("UPDATE coin_configs SET category = 'L1s' WHERE coin LIKE '%:%'")
    except Exception as e:
        pass
