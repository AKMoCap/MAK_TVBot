#!/usr/bin/env python3
"""Run database migrations as a build step before app starts."""
import os
import sys

# Set up Flask app context
from app import app
from flask_migrate import upgrade

with app.app_context():
    print("Running database migrations...")
    try:
        upgrade()
        print("Migrations completed successfully!")
    except Exception as e:
        print(f"Migration error: {e}")
        sys.exit(1)
