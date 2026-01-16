"""
Test Script for TradingView-Hyperliquid Bot
============================================
Run this to test your configuration before going live.

Usage: python test_setup.py
"""

import os
import json
import requests

# Try to load environment variables
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def test_environment_variables():
    """Check that required environment variables are set."""
    print("\n📋 Checking Environment Variables...")
    print("-" * 40)
    
    main_wallet = os.environ.get("HL_MAIN_WALLET")
    api_secret = os.environ.get("HL_API_SECRET")
    webhook_secret = os.environ.get("WEBHOOK_SECRET")
    use_testnet = os.environ.get("USE_TESTNET", "true")
    
    issues = []
    
    if main_wallet:
        print(f"✅ HL_MAIN_WALLET: {main_wallet[:10]}...{main_wallet[-4:]}")
    else:
        print("❌ HL_MAIN_WALLET: NOT SET")
        issues.append("Set HL_MAIN_WALLET to your main wallet address")
    
    if api_secret:
        print(f"✅ HL_API_SECRET: {api_secret[:6]}...{api_secret[-4:]}")
    else:
        print("❌ HL_API_SECRET: NOT SET")
        issues.append("Set HL_API_SECRET to your API wallet's private key")
    
    if webhook_secret and webhook_secret != "your-secret-key-change-me":
        print(f"✅ WEBHOOK_SECRET: {'*' * len(webhook_secret)}")
    else:
        print("⚠️  WEBHOOK_SECRET: Using default (change this!)")
        issues.append("Set a unique WEBHOOK_SECRET for security")
    
    print(f"ℹ️  USE_TESTNET: {use_testnet}")
    
    return len(issues) == 0, issues


def test_hyperliquid_connection():
    """Test connection to Hyperliquid."""
    print("\n🔗 Testing Hyperliquid Connection...")
    print("-" * 40)
    
    try:
        from hyperliquid.info import Info
        from hyperliquid.utils import constants
        
        use_testnet = os.environ.get("USE_TESTNET", "true").lower() == "true"
        api_url = constants.TESTNET_API_URL if use_testnet else constants.MAINNET_API_URL
        
        info = Info(api_url, skip_ws=True)
        
        # Test getting all mids (market prices)
        all_mids = info.all_mids()
        btc_price = all_mids.get("BTC", "N/A")
        eth_price = all_mids.get("ETH", "N/A")
        
        print(f"✅ Connected to {'TESTNET' if use_testnet else 'MAINNET'}")
        print(f"   BTC Price: ${float(btc_price):,.2f}")
        print(f"   ETH Price: ${float(eth_price):,.2f}")
        
        return True
    except Exception as e:
        print(f"❌ Connection failed: {str(e)}")
        return False


def test_wallet_authentication():
    """Test that we can authenticate with the API wallet."""
    print("\n🔐 Testing Wallet Authentication...")
    print("-" * 40)
    
    try:
        from eth_account import Account
        from hyperliquid.info import Info
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants
        
        main_wallet = os.environ.get("HL_MAIN_WALLET")
        api_secret = os.environ.get("HL_API_SECRET")
        
        if not main_wallet or not api_secret:
            print("❌ Missing wallet credentials")
            return False
        
        # Create wallet from API secret
        wallet = Account.from_key(api_secret)
        print(f"✅ API wallet loaded: {wallet.address[:10]}...{wallet.address[-4:]}")
        
        use_testnet = os.environ.get("USE_TESTNET", "true").lower() == "true"
        api_url = constants.TESTNET_API_URL if use_testnet else constants.MAINNET_API_URL
        
        # Create exchange instance
        info = Info(api_url, skip_ws=True)
        exchange = Exchange(wallet, api_url, account_address=main_wallet)
        
        # Try to get user state
        user_state = info.user_state(main_wallet)
        
        margin_summary = user_state.get("marginSummary", {})
        account_value = margin_summary.get("accountValue", "0")
        
        print(f"✅ Account authenticated")
        print(f"   Account Value: ${float(account_value):,.2f}")
        
        positions = user_state.get("assetPositions", [])
        if positions:
            print(f"   Open Positions: {len(positions)}")
            for pos in positions[:3]:  # Show first 3
                coin = pos.get("position", {}).get("coin", "?")
                size = pos.get("position", {}).get("szi", "0")
                print(f"     - {coin}: {size}")
        else:
            print("   Open Positions: None")
        
        return True
        
    except Exception as e:
        print(f"❌ Authentication failed: {str(e)}")
        return False


def test_webhook_format():
    """Show the correct webhook format for TradingView."""
    print("\n📝 TradingView Webhook Format...")
    print("-" * 40)
    
    webhook_secret = os.environ.get("WEBHOOK_SECRET", "your-secret-key-change-me")
    
    example_buy = {
        "secret": webhook_secret,
        "action": "buy",
        "coin": "BTC",
        "leverage": 10,
        "collateral_usd": 100
    }
    
    example_sell = {
        "secret": webhook_secret,
        "action": "sell",
        "coin": "ETH",
        "leverage": 5,
        "collateral_usd": 50
    }
    
    example_close = {
        "secret": webhook_secret,
        "coin": "BTC",
        "close_position": True
    }
    
    print("\nFor a LONG position (buy):")
    print(json.dumps(example_buy, indent=2))
    
    print("\nFor a SHORT position (sell):")
    print(json.dumps(example_sell, indent=2))
    
    print("\nTo CLOSE a position:")
    print(json.dumps(example_close, indent=2))


def main():
    print("=" * 50)
    print("🤖 TradingView-Hyperliquid Bot Setup Test")
    print("=" * 50)
    
    # Run tests
    env_ok, issues = test_environment_variables()
    
    if env_ok:
        connection_ok = test_hyperliquid_connection()
        auth_ok = test_wallet_authentication()
    else:
        connection_ok = False
        auth_ok = False
    
    test_webhook_format()
    
    # Summary
    print("\n" + "=" * 50)
    print("📊 SUMMARY")
    print("=" * 50)
    
    if env_ok and connection_ok and auth_ok:
        print("✅ All tests passed! Your bot is ready to run.")
        print("\nNext steps:")
        print("1. Run the bot: python main.py")
        print("2. Note your webhook URL")
        print("3. Create a TradingView alert with that URL")
    else:
        print("⚠️  Some tests failed. Please fix these issues:")
        for issue in issues:
            print(f"   - {issue}")
        if not connection_ok:
            print("   - Check your internet connection")
        if not auth_ok:
            print("   - Verify your API wallet is authorized on Hyperliquid")


if __name__ == "__main__":
    main()
