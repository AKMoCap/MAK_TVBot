#!/usr/bin/env python3
"""Run database migrations and seeding as a build step before app starts.

This script sets up a minimal Flask app, runs migrations, then seeds default data.
Workers in production skip both migrations and seeding since this handles it.
"""
import os
import sys

from flask import Flask
from flask_migrate import Migrate, upgrade
from sqlalchemy import inspect, text

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///trading_bot.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

from models import db, migrate, seed_defaults, RiskSettings, CoinConfig, BotConfig

db.init_app(app)
migrate.init_app(app, db)

with app.app_context():
    print("Running database migrations...")
    try:
        upgrade()
        print("Migrations completed successfully!")
    except Exception as e:
        print(f"Migration error: {e}")
        sys.exit(1)

    # Ensure critical tables exist (fallback for Replit's auto-migration issues)
    print("Verifying critical tables...")
    try:
        inspector = inspect(db.engine)
        existing_tables = inspector.get_table_names()

        # Ensure coin_baskets table exists
        if 'coin_baskets' not in existing_tables:
            print("WARNING: coin_baskets table missing, creating it...")
            db.session.execute(text('''
                CREATE TABLE IF NOT EXISTS coin_baskets (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES user_wallets(id),
                    name VARCHAR(100) NOT NULL,
                    coins TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_user_basket_name UNIQUE (user_id, name)
                )
            '''))
            db.session.execute(text('CREATE INDEX IF NOT EXISTS idx_coinbasket_user ON coin_baskets(user_id)'))
            db.session.commit()
            print("coin_baskets table created successfully!")
        else:
            print("coin_baskets table exists, OK")
    except Exception as e:
        print(f"Table verification error: {e}")

    print("Seeding default data...")
    try:
        seed_defaults()
        print("Seeding completed successfully!")
    except Exception as e:
        print(f"Seeding error: {e}")

print("Build step completed. Workers can now start.")
