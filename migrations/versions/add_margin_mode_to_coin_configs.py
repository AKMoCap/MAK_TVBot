"""Add hl_margin_mode column to coin_configs

Revision ID: add_margin_mode_002
Revises: add_category_002
Create Date: 2025-01-19
"""
from alembic import op
import sqlalchemy as sa


revision = 'add_margin_mode_002'
down_revision = 'add_category_002'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col['name'] for col in inspector.get_columns('coin_configs')]
    
    if 'hl_margin_mode' not in columns:
        op.add_column('coin_configs', sa.Column('hl_margin_mode', sa.String(20), nullable=True))


def downgrade():
    op.drop_column('coin_configs', 'hl_margin_mode')
