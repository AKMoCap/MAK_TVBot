# MAK Trading Bot

A full-featured TradingView to Hyperliquid trading bot with a web-based dashboard, multi-coin support, and comprehensive risk management.

## Features

### Trading
- **TradingView Webhook Integration** - Receive alerts from any TradingView indicator or strategy
- **Multi-Coin Support** - Trade BTC, ETH, SOL, and other Hyperliquid-supported assets simultaneously
- **Custom & Standard Indicators** - Use your own Pine Script indicators or built-in strategies
- **Manual Trading** - Execute trades directly from the web dashboard

### Risk Management
- **Stop-Loss & Take-Profit** - Automatic SL/TP orders with every trade
- **Position Limits** - Max position size, max open positions, max total exposure
- **Daily Limits** - Daily loss limit and max daily trades
- **Circuit Breakers** - Auto-pause after consecutive losses
- **Leverage Limits** - Max leverage enforcement

### Web Dashboard
- **Real-Time Positions** - Live view of all open positions with P&L
- **Trade History** - Complete trade log with filtering and export
- **Analytics** - Win rate, cumulative P&L, and performance charts
- **Settings Panel** - Configure all bot parameters via the UI
- **Indicator Management** - Add, enable/disable, and track indicator performance

## Quick Start

### 1. Configure Environment Variables

Create a `.env` file with your credentials:

```env
# Hyperliquid Wallet Configuration
HL_MAIN_WALLET=0xYourMainWalletAddress
HL_API_SECRET=0xYourAPIWalletPrivateKey

# Webhook Security
WEBHOOK_SECRET=your-secret-key-here

# Network Selection (true for testnet, false for mainnet)
USE_TESTNET=true
```

### 2. Install Dependencies

```bash
pip install -r requirements.txt
```

### 3. Run the Bot

```bash
python app.py
```

The web dashboard will be available at `http://localhost:5000`

## TradingView Setup

### Webhook URL
```
https://your-domain.com/webhook
```

### Alert Message Template
```json
{
    "secret": "your-webhook-secret",
    "action": "{{strategy.order.action}}",
    "coin": "{{ticker}}",
    "leverage": 10,
    "collateral_usd": 100,
    "indicator": "my-indicator-key",
    "stop_loss_pct": 2,
    "take_profit_pct": 5
}
```

### Webhook Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `secret` | string | Yes | Your webhook secret for authentication |
| `action` | string | Yes | "buy" or "sell" |
| `coin` | string | No | Asset symbol (default: BTC) |
| `leverage` | number | No | Leverage multiplier (default: 10) |
| `collateral_usd` | number | No | Collateral amount in USD (default: 100) |
| `stop_loss_pct` | number | No | Stop loss percentage |
| `take_profit_pct` | number | No | Take profit percentage |
| `indicator` | string | No | Indicator identifier for tracking |
| `close_position` | boolean | No | Set to true to close existing position |

## Pine Script Examples

### RSI Strategy
```pinescript
//@version=5
strategy("RSI Strategy", overlay=true)

rsiValue = ta.rsi(close, 14)

if (ta.crossover(rsiValue, 30))
    strategy.entry("Long", strategy.long)
    alert('{"secret":"YOUR_SECRET","action":"buy","coin":"' + syminfo.ticker + '","leverage":10,"collateral_usd":100}', alert.freq_once_per_bar)

if (ta.crossunder(rsiValue, 70))
    strategy.entry("Short", strategy.short)
    alert('{"secret":"YOUR_SECRET","action":"sell","coin":"' + syminfo.ticker + '","leverage":10,"collateral_usd":100}', alert.freq_once_per_bar)
```

### EMA Crossover
```pinescript
//@version=5
strategy("EMA Cross", overlay=true)

fastEMA = ta.ema(close, 9)
slowEMA = ta.ema(close, 21)

if (ta.crossover(fastEMA, slowEMA))
    alert('{"secret":"YOUR_SECRET","action":"buy","coin":"' + syminfo.ticker + '"}', alert.freq_once_per_bar)

if (ta.crossunder(fastEMA, slowEMA))
    alert('{"secret":"YOUR_SECRET","action":"sell","coin":"' + syminfo.ticker + '"}', alert.freq_once_per_bar)
```

## API Endpoints

### Trading
- `POST /webhook` - Receive TradingView alerts
- `POST /api/trade` - Execute manual trade
- `POST /api/close` - Close a position
- `POST /api/close-all` - Close all positions

### Account
- `GET /api/account` - Get account info and positions
- `GET /api/prices` - Get market prices
- `GET /api/stats/daily` - Get daily statistics

### Configuration
- `GET /api/settings` - Get all settings
- `POST /api/settings` - Update general settings
- `POST /api/settings/risk` - Update risk settings
- `GET /api/coins` - Get coin configurations
- `PUT /api/coins/{coin}` - Update coin configuration

### Indicators
- `GET /api/indicators` - List indicators
- `POST /api/indicators` - Create indicator
- `PUT /api/indicators/{id}` - Update indicator
- `DELETE /api/indicators/{id}` - Delete indicator

### History
- `GET /api/trades` - Get trade history
- `GET /api/trades/export` - Export trades as CSV

## Project Structure

```
MAK_TVBot/
├── app.py              # Main application with all routes
├── models.py           # Database models (SQLAlchemy)
├── risk_manager.py     # Risk management logic
├── bot_manager.py      # Trading operations manager
├── main.py             # Legacy entry point (deprecated)
├── requirements.txt    # Python dependencies
├── templates/          # HTML templates
│   ├── base.html
│   ├── dashboard.html
│   ├── trades.html
│   ├── indicators.html
│   └── settings.html
└── static/
    ├── css/
    │   └── style.css
    └── js/
        └── app.js
```

## Security Notes

1. **Never expose your API keys** - Use environment variables
2. **Use a strong webhook secret** - Prevents unauthorized trade execution
3. **Start with testnet** - Verify your setup before trading real funds
4. **Set position limits** - Protect against runaway trades

## Development

### Running Locally
```bash
python app.py
```

### Running with Gunicorn (Production)
```bash
gunicorn app:app --bind 0.0.0.0:5000
```

## License

MIT License - See LICENSE file for details.
