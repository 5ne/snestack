"""Interactive setup for fstack configuration."""

import getpass
import logging
from pathlib import Path

from fstack.config import Config, get_config
from fstack.core.errors import ConfigError, ValidationError

logger = logging.getLogger(__name__)


def setup_interactive(env_file: str = None) -> bool:
    """Run interactive setup to configure API keys.

    Prompts user for all required API keys, validates format,
    stores in .env file.

    Args:
        env_file: Path to .env file (default: .env in cwd)

    Returns:
        True if setup successful, False otherwise
    """
    if env_file is None:
        env_file = Path.cwd() / ".env"
    else:
        env_file = Path(env_file)

    print("\n" + "=" * 60)
    print("fstack Setup")
    print("=" * 60)
    print("\nThis will configure your API keys for fstack.")
    print("Press Ctrl+C to cancel.\n")

    try:
        # Finnhub
        print("1. FINNHUB API KEY")
        print("   Get free key at: https://finnhub.io/register")
        finnhub_key = getpass.getpass("   Finnhub API Key: ").strip()
        if not finnhub_key:
            print("   ✗ Finnhub key is required")
            return False
        if not Config.validate_api_key(finnhub_key, "finnhub"):
            print("   ✗ Invalid Finnhub key format")
            return False
        print("   ✓ Finnhub key validated")

        # Claude
        print("\n2. CLAUDE API KEY")
        print("   Get key at: https://console.anthropic.com/account/keys")
        claude_key = getpass.getpass("   Claude API Key (sk-...): ").strip()
        if not claude_key:
            print("   ✗ Claude key is required")
            return False
        if not Config.validate_api_key(claude_key, "claude"):
            print("   ✗ Invalid Claude key format (must start with sk-)")
            return False
        print("   ✓ Claude key validated")

        # Gmail
        print("\n3. GMAIL CONFIGURATION (for notifications)")
        print("   Generate app password: https://myaccount.google.com/apppasswords")
        gmail_address = input("   Gmail address: ").strip()
        if not gmail_address or "@" not in gmail_address:
            print("   ✗ Invalid email address")
            return False

        gmail_app_password = getpass.getpass("   Gmail app password: ").strip()
        if not gmail_app_password:
            print("   ✗ Gmail app password is required")
            return False
        print("   ✓ Gmail configured")

        notification_email = input("   Email to receive notifications: ").strip()
        if not notification_email or "@" not in notification_email:
            print("   ✗ Invalid email address")
            return False
        print("   ✓ Notification email set")

        # Twilio (optional)
        print("\n4. TWILIO (optional, for SMS)")
        setup_twilio = input("   Configure SMS notifications? (y/n): ").strip().lower()
        twilio_account_sid = None
        twilio_auth_token = None
        sms_phone = None

        if setup_twilio == "y":
            print("   Get credentials at: https://www.twilio.com/console")
            twilio_account_sid = input("   Twilio Account SID (AC...): ").strip()
            if twilio_account_sid:
                if not Config.validate_api_key(twilio_account_sid, "twilio_sid"):
                    print("   ✗ Invalid Twilio Account SID format")
                    twilio_account_sid = None
                else:
                    twilio_auth_token = getpass.getpass("   Twilio Auth Token: ").strip()
                    if not twilio_auth_token or not Config.validate_api_key(
                        twilio_auth_token, "twilio_token"
                    ):
                        print("   ✗ Invalid Twilio Auth Token")
                        twilio_account_sid = None
                        twilio_auth_token = None
                    else:
                        sms_phone = input("   Your phone number (e.g. +1234567890): ").strip()
                        if not sms_phone:
                            print("   ✗ Phone number required")
                            twilio_account_sid = None
                        else:
                            print("   ✓ Twilio configured")
        else:
            print("   ✓ SMS skipped")

        # Summary
        print("\n" + "=" * 60)
        print("Configuration Summary")
        print("=" * 60)
        print(f"Finnhub API Key: {'*' * (len(finnhub_key) - 4)}{finnhub_key[-4:]}")
        print(f"Claude API Key:  {'*' * (len(claude_key) - 4)}{claude_key[-4:]}")
        print(f"Gmail Address:   {gmail_address}")
        print(f"Notify Email:    {notification_email}")
        if twilio_account_sid:
            print(f"Twilio SID:      {twilio_account_sid[-4:]}")
            print(f"SMS Phone:       {sms_phone}")
        print("=" * 60)

        # Confirm
        confirm = input("\nSave configuration? (y/n): ").strip().lower()
        if confirm != "y":
            print("Setup cancelled.")
            return False

        # Save to env file
        Config.set("FSTACK_FINNHUB_API_KEY", finnhub_key)
        Config.set("FSTACK_CLAUDE_API_KEY", claude_key)
        Config.set("FSTACK_GMAIL_ADDRESS", gmail_address)
        Config.set("FSTACK_GMAIL_APP_PASSWORD", gmail_app_password)
        Config.set("FSTACK_NOTIFICATION_EMAIL", notification_email)

        if twilio_account_sid and twilio_auth_token:
            Config.set("FSTACK_TWILIO_ACCOUNT_SID", twilio_account_sid)
            Config.set("FSTACK_TWILIO_AUTH_TOKEN", twilio_auth_token)
            Config.set("FSTACK_SMS_PHONE", sms_phone)

        # Write to file
        config = get_config(str(env_file))
        config.save_to_file(env_file)

        print(f"\n✓ Configuration saved to {env_file}")
        print("\nNext steps:")
        print("  1. Add your positions:")
        print("     fstack position add NVDA 100 850.0")
        print("  2. Add your watchlist:")
        print("     fstack watchlist add TSLA 'looking for dip'")
        print("  3. Run analysis:")
        print("     fstack analyze --batch")
        print("  4. Or set up cron for daily analysis:")
        print("     fstack scheduler --setup")
        print()

        return True

    except KeyboardInterrupt:
        print("\n\nSetup cancelled by user.")
        return False
    except Exception as e:
        logger.error(f"Setup error: {e}")
        print(f"\n✗ Error: {e}")
        return False


def validate_env() -> bool:
    """Validate that all required environment variables are set.

    Returns:
        True if valid, False otherwise
    """
    try:
        config = get_config()
        config.get_finnhub_api_key()
        config.get_claude_api_key()
        config.get_gmail_address()
        config.get_notification_email()
        return True
    except ConfigError as e:
        logger.error(f"Configuration validation failed: {e}")
        print(f"✗ Configuration error: {e}")
        print("  Run 'fstack setup' to configure")
        return False
