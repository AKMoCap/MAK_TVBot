"""Add category column to coin_configs

Revision ID: add_category_001
Revises: 71e3d8630812
Create Date: 2025-01-19
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_category_001'
down_revision = '71e3d8630812'
branch_labels = None
depends_on = None


def upgrade():
    # Add category column if it doesn't exist
    # Using batch mode for SQLite compatibility
    with op.batch_alter_table('coin_configs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('category', sa.String(20), nullable=True, server_default='L1s'))

    # Update existing coins with their categories
    # L1s (formerly MAJORS)
    op.execute("UPDATE coin_configs SET category = 'L1s' WHERE coin IN ('BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'MON', 'BNB', 'LTC', 'CC', 'TAO', 'TON', 'WLD')")

    # APPS (formerly DEFI, plus VIRTUAL and PUMP)
    op.execute("UPDATE coin_configs SET category = 'APPS' WHERE coin IN ('AAVE', 'ENA', 'PENDLE', 'AERO', 'VIRTUAL', 'PUMP', 'LIT', 'CRV', 'LINK', 'ETHFI', 'MORPHO', 'SYRUP', 'JUP')")

    # MEMES (formerly HIGH BETA/MEMES, minus VIRTUAL and PUMP)
    op.execute("UPDATE coin_configs SET category = 'MEMES' WHERE coin IN ('DOGE', 'FARTCOIN', 'kBONK', 'kPEPE', 'PENGU', 'SPX')")

    # Set default for any remaining coins
    op.execute("UPDATE coin_configs SET category = 'L1s' WHERE category IS NULL")


def downgrade():
    with op.batch_alter_table('coin_configs', schema=None) as batch_op:
        batch_op.drop_column('category')
