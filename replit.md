# TradingView to Hyperliquid Trading Bot

## Overview
This is a Flask-based webhook server that receives TradingView alerts and executes trades on Hyperliquid exchange. The bot acts as a bridge between TradingView's alert system and Hyperliquid's trading API.

## Project Structure
```
.
├── main.py              # Main Flask application with webhook endpoints
├── test_setup.py        # Test file for setup verification
├── requirements.txt     # Python dependencies
└── README.md            # Basic project info
```

## How It Works
1. TradingView sends a webhook (HTTP POST) when an indicator triggers
2. The Flask server receives the webhook at `/webhook`
3. The bot validates the request using a secret key
4. If valid, executes the trade on Hyperliquid

## Endpoints
- `POST /webhook` - Receives TradingView alerts
- `GET /health` - Health check endpoint
- `GET /status` - Check account status and open positions

## Required Environment Variables
- `HL_MAIN_WALLET` - Your main Hyperliquid wallet address
- `HL_API_SECRET` - Your Hyperliquid API wallet secret key
- `WEBHOOK_SECRET` - Secret key that TradingView must include in webhook requests
- `USE_TESTNET` - Set to "true" for testnet, "false" for mainnet (defaults to testnet)

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

## Running Locally
```bash
python main.py
```
Server runs on port 5000.

## Recent Changes
- 2026-01-16: Initial import and setup in Replit environment
