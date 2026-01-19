"""Add category column to coin_configs

Revision ID: add_category_002
Revises: 71e3d8630812
Create Date: 2026-01-19

"""
from alembic import op
import sqlalchemy as sa


revision = 'add_category_002'
down_revision = '71e3d8630812'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col['name'] for col in inspector.get_columns('coin_configs')]
    
    if 'category' not in columns:
        op.add_column('coin_configs', sa.Column('category', sa.String(length=20), server_default='L1s'))


def downgrade():
    op.drop_column('coin_configs', 'category')
