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
├── models.py            # SQLAlchemy database models
├── bot_manager.py       # Trading bot logic and Hyperliquid integration
├── risk_manager.py      # Risk management logic
├── static/              # Frontend assets (CSS, JS)
├── templates/           # HTML templates
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

## Required Environment Variables
- `HL_MAIN_WALLET` - Your main Hyperliquid wallet address
- `HL_API_SECRET` - Your Hyperliquid API wallet secret key
- `WEBHOOK_SECRET` - Secret key for TradingView webhook validation
- `USE_TESTNET` - Set to "true" for testnet, "false" for mainnet
- `SECRET_KEY` - Flask session secret key

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

## Recent Changes
- 2026-01-16: Initial import and setup in Replit environment
- 2026-01-16: Added flask-sqlalchemy for database support
- 2026-01-16: Updated workflow to run app.py with web UI
