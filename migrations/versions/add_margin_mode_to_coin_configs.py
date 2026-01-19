"""Add hl_margin_mode column to coin_configs

Revision ID: add_margin_mode_002
Revises: add_category_001
Create Date: 2025-01-19
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_margin_mode_002'
down_revision = 'add_category_001'
branch_labels = None
depends_on = None


def upgrade():
    # Add hl_margin_mode column if it doesn't exist
    # Using batch mode for SQLite compatibility
    with op.batch_alter_table('coin_configs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('hl_margin_mode', sa.String(20), nullable=True))


def downgrade():
    with op.batch_alter_table('coin_configs', schema=None) as batch_op:
        batch_op.drop_column('hl_margin_mode')
