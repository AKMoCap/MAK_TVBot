"""Add CoinBasket model for custom coin groupings

Revision ID: add_coin_baskets
Revises: add_multi_user_support
Create Date: 2026-01-23

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'add_coin_baskets'
down_revision = 'add_multi_user_support'
branch_labels = None
depends_on = None


def upgrade():
    # Check if table already exists (safe migration)
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()

    if 'coin_baskets' not in existing_tables:
        # Create coin_baskets table
        op.create_table(
            'coin_baskets',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('name', sa.String(100), nullable=False),
            sa.Column('coins', sa.Text(), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['user_wallets.id'], ),
            sa.PrimaryKeyConstraint('id')
        )

        # Create indexes
        op.create_index('idx_coinbasket_user', 'coin_baskets', ['user_id'], unique=False)

        # Create unique constraint for user_id + name combination
        op.create_unique_constraint('uq_user_basket_name', 'coin_baskets', ['user_id', 'name'])


def downgrade():
    # Only drop if table exists
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()

    if 'coin_baskets' in existing_tables:
        op.drop_constraint('uq_user_basket_name', 'coin_baskets', type_='unique')
        op.drop_index('idx_coinbasket_user', table_name='coin_baskets')
        op.drop_table('coin_baskets')
