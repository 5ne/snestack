"""Configuration management for fstack.

Handles environment variables, API key validation, and configuration storage.
"""

import os
from pathlib import Path
from typing import Optional, Dict, Any
from dotenv import load_dotenv
import json

from fstack.core.errors import ConfigError, ValidationError


class Config:
    """Configuration manager for fstack."""

    # API Keys
    FINNHUB_API_KEY = "FSTACK_FINNHUB_API_KEY"
    CLAUDE_API_KEY = "FSTACK_CLAUDE_API_KEY"
    GMAIL_API_KEY = "FSTACK_GMAIL_API_KEY"
    TWILIO_ACCOUNT_SID = "FSTACK_TWILIO_ACCOUNT_SID"
    TWILIO_AUTH_TOKEN = "FSTACK_TWILIO_AUTH_TOKEN"

    # Email config
    GMAIL_ADDRESS = "FSTACK_GMAIL_ADDRESS"
    NOTIFICATION_EMAIL = "FSTACK_NOTIFICATION_EMAIL"

    # SMS config
    SMS_PHONE = "FSTACK_SMS_PHONE"

    # Database
    DATABASE_PATH = "FSTACK_DATABASE_PATH"

    # Defaults
    DEFAULT_DB_PATH = "../fstack.db"

    def __init__(self, env_file: Optional[str] = None):
        """Initialize config from environment.

        Args:
            env_file: Path to .env file (defaults to .env in project root)
        """
        # Load .env if it exists
        if env_file is None:
            env_file = Path.cwd() / ".env"
        else:
            env_file = Path(env_file)

        if env_file.exists():
            load_dotenv(env_file)

        self.env_file = env_file
        self._validate_loaded_config()

    def _validate_loaded_config(self):
        """Validate that critical config exists."""
        # Don't fail on missing keys during init—let lazy loading handle it
        pass

    @staticmethod
    def get(key: str, default: Optional[str] = None) -> Optional[str]:
        """Get configuration value from environment.

        Args:
            key: Configuration key
            default: Default value if not found

        Returns:
            Configuration value or default
        """
        return os.getenv(key, default)

    @staticmethod
    def require(key: str) -> str:
        """Get required configuration value.

        Args:
            key: Configuration key

        Returns:
            Configuration value

        Raises:
            ConfigError: If key is not set
        """
        value = os.getenv(key)
        if not value:
            raise ConfigError(f"Required configuration missing: {key}")
        return value

    def get_database_path(self) -> str:
        """Get database path."""
        return self.get(self.DATABASE_PATH, self.DEFAULT_DB_PATH)

    def get_finnhub_api_key(self) -> str:
        """Get Finnhub API key with validation."""
        key = self.require(self.FINNHUB_API_KEY)
        if not key or len(key) < 10:
            raise ValidationError("Invalid Finnhub API key format")
        return key

    def get_claude_api_key(self) -> str:
        """Get Claude API key with validation."""
        key = self.require(self.CLAUDE_API_KEY)
        if not key.startswith("sk-"):
            raise ValidationError("Invalid Claude API key format (must start with sk-)")
        return key

    def get_gmail_address(self) -> str:
        """Get Gmail address for sending notifications."""
        return self.require(self.GMAIL_ADDRESS)

    def get_notification_email(self) -> str:
        """Get email address to receive notifications."""
        return self.require(self.NOTIFICATION_EMAIL)

    def get_gmail_api_key(self) -> Optional[str]:
        """Get Gmail API key (optional)."""
        return self.get(self.GMAIL_API_KEY)

    def get_twilio_credentials(self) -> tuple[Optional[str], Optional[str]]:
        """Get Twilio credentials (optional).

        Returns:
            Tuple of (account_sid, auth_token) or (None, None) if not configured
        """
        account_sid = self.get(self.TWILIO_ACCOUNT_SID)
        auth_token = self.get(self.TWILIO_AUTH_TOKEN)

        if (account_sid and not auth_token) or (not account_sid and auth_token):
            raise ConfigError("Both Twilio account SID and auth token must be provided")

        return (account_sid, auth_token)

    def get_sms_phone(self) -> Optional[str]:
        """Get SMS phone number (optional)."""
        return self.get(self.SMS_PHONE)

    @staticmethod
    def set(key: str, value: str):
        """Set configuration value in environment.

        Args:
            key: Configuration key
            value: Configuration value
        """
        os.environ[key] = value

    def save_to_file(self, env_file: Optional[Path] = None) -> Path:
        """Save current environment to .env file.

        Args:
            env_file: Path to save to (defaults to self.env_file)

        Returns:
            Path to saved file
        """
        if env_file is None:
            env_file = self.env_file

        env_file = Path(env_file)
        env_file.parent.mkdir(parents=True, exist_ok=True)

        # Read existing .env if it exists
        existing = {}
        if env_file.exists():
            with open(env_file) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, val = line.split("=", 1)
                        existing[key.strip()] = val.strip()

        # Update with current environment variables (FSTACK_* only)
        for key, value in os.environ.items():
            if key.startswith("FSTACK_"):
                existing[key] = value

        # Write back to file
        with open(env_file, "w") as f:
            f.write("# fstack configuration\n")
            f.write("# Auto-generated - edit with care\n\n")
            for key, value in sorted(existing.items()):
                # Quote values that contain special characters
                if " " in value or "=" in value:
                    f.write(f'{key}="{value}"\n')
                else:
                    f.write(f"{key}={value}\n")

        return env_file

    @staticmethod
    def validate_api_key(key: str, key_type: str) -> bool:
        """Validate API key format without making API calls.

        Args:
            key: API key to validate
            key_type: Type of key ('finnhub', 'claude', 'gmail', etc.)

        Returns:
            True if valid format, False otherwise
        """
        if not key or not isinstance(key, str):
            return False

        validations = {
            "finnhub": lambda k: len(k) > 10,
            "claude": lambda k: k.startswith("sk-") and len(k) > 20,
            "gmail": lambda k: "@" in k or len(k) > 20,
            "twilio_sid": lambda k: k.startswith("AC") and len(k) == 34,
            "twilio_token": lambda k: len(k) > 30,
        }

        if key_type not in validations:
            return False

        return validations[key_type](key)


# Singleton config instance
_config: Optional[Config] = None


def get_config(env_file: Optional[str] = None) -> Config:
    """Get or create singleton config instance.

    Args:
        env_file: Path to .env file for initialization

    Returns:
        Config instance
    """
    global _config
    if _config is None:
        _config = Config(env_file)
    return _config
