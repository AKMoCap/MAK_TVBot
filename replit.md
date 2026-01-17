# MAK TradingView to Hyperliquid Trading Bot

## Overview
A full-featured trading bot that bridges TradingView alerts with Hyperliquid exchange. Includes a web-based dashboard for monitoring and configuration.

## Features
- Web-based UI dashboard
- Multi-coin trading support
- Risk management (SL/TP, position limits, circuit breakers)
- Trade history and analytics
- TradingView webhook integration

## Project Structure
```
.
├── app.py               # Main Flask application with web UI and webhook endpoints
├── models.py            # SQLAlchemy database models with Flask-Migrate
├── bot_manager.py       # Trading bot logic and Hyperliquid integration
├── risk_manager.py      # Risk management logic
├── migrations/          # Alembic database migrations (auto-run on startup)
├── static/              # Frontend assets (CSS, JS)
├── templates/           # HTML templates (including login.html)
├── main.py              # Legacy simple webhook handler
├── requirements.txt     # Python dependencies
└── README.md            # Basic project info
```

## Running
The application runs on port 5000 with a web dashboard accessible at the root URL.

## Endpoints
- `/` - Web dashboard
- `POST /webhook` - Receives TradingView alerts
- `GET /health` - Health check endpoint
- `GET /api/status` - API status and account info

## Database
Uses PostgreSQL for persistent storage of settings and trade history. The `DATABASE_URL` environment variable is automatically set by Replit's built-in PostgreSQL database.

Database tables:
- `trades` - Trade history and execution details
- `bot_config` - Bot configuration settings
- `coin_configs` - Per-coin trading configurations
- `risk_settings` - Risk management parameters
- `indicators` - Technical indicator settings
- `activity_logs` - Activity and event logging

## Required Environment Variables
- `DATABASE_URL` - PostgreSQL connection string (auto-configured by Replit)
- `HL_MAIN_WALLET` - Your main Hyperliquid wallet address
- `HL_API_SECRET` - Your Hyperliquid API wallet secret key (mainnet)
- `HL_TESTNET_API_SECRET` - Your Hyperliquid API wallet secret key (testnet)
- `WEBHOOK_SECRET` - Secret key for TradingView webhook validation
- `USE_TESTNET` - Set to "true" for testnet, "false" for mainnet
- `SECRET_KEY` - Flask session secret key
- `SITE_PASSWORD` - Password to access the web dashboard (optional but recommended)

## TradingView Webhook Payload Format
```json
{
    "secret": "your-webhook-secret",
    "action": "buy" or "sell",
    "coin": "BTC",
    "leverage": 10,
    "collateral_usd": 100,
    "close_position": false
}
```

## Database Migrations
The application uses Flask-Migrate (Alembic) for database schema management. Migrations run automatically on startup to prevent schema drift issues.

To create a new migration after changing models:
```bash
FLASK_APP=app.py flask db migrate -m "Description of changes"
FLASK_APP=app.py flask db upgrade
```

## Recent Changes
- 2026-01-17: Added password protection for web dashboard (login page with session-based auth)
- 2026-01-17: Implemented Flask-Migrate for automated database migrations
- 2026-01-16: Initial import and setup in Replit environment
- 2026-01-16: Added flask-sqlalchemy for database support
- 2026-01-16: Updated workflow to run app.py with web UI
- 2026-01-16: Migrated from SQLite to PostgreSQL for persistent database storage
