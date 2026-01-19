#!/usr/bin/env python3
"""Run database migrations and seeding as a build step before app starts.

This script sets up a minimal Flask app, runs migrations, then seeds default data.
Workers in production skip both migrations and seeding since this handles it.
"""
import os
import sys

from flask import Flask
from flask_migrate import Migrate, upgrade

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
    
    print("Seeding default data...")
    try:
        seed_defaults()
        print("Seeding completed successfully!")
    except Exception as e:
        print(f"Seeding error: {e}")

print("Build step completed. Workers can now start.")
