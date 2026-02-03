"""
Configuration management for Hey Spotless automation system
"""

import os
from typing import List, Optional
from dotenv import load_dotenv
import pytz

# Load environment variables
load_dotenv()


class Config:
    """Application configuration"""

    # Claude AI
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")

    # Google APIs
    GOOGLE_CREDENTIALS_PATH: str = os.getenv("GOOGLE_CREDENTIALS_PATH", "credentials.json")
    GOOGLE_TOKEN_PATH: str = os.getenv("GOOGLE_TOKEN_PATH", "token.json")

    # Gmail API scopes
    GMAIL_SCOPES: List[str] = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify'
    ]

    # Calendar API scopes
    CALENDAR_SCOPES: List[str] = [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events'
    ]

    # Hey Spotless
    HEYSPOTLESS_EMAIL: str = os.getenv("HEYSPOTLESS_EMAIL", "support@heyspotless.com")
    HEYSPOTLESS_DOMAIN: str = os.getenv("HEYSPOTLESS_DOMAIN", "heyspotless.com")

    # Notifications
    NOTIFICATION_EMAIL: str = os.getenv("NOTIFICATION_EMAIL", "")
    TWILIO_ACCOUNT_SID: Optional[str] = os.getenv("TWILIO_ACCOUNT_SID")
    TWILIO_AUTH_TOKEN: Optional[str] = os.getenv("TWILIO_AUTH_TOKEN")
    TWILIO_FROM_NUMBER: Optional[str] = os.getenv("TWILIO_FROM_NUMBER")
    TWILIO_TO_NUMBER: Optional[str] = os.getenv("TWILIO_TO_NUMBER")
    WEBHOOK_URL: Optional[str] = os.getenv("WEBHOOK_URL")

    # Monitoring
    CHECK_INTERVAL_MINUTES: int = int(os.getenv("CHECK_INTERVAL_MINUTES", "30"))
    TIMEZONE: str = os.getenv("TIMEZONE", "America/New_York")

    # Booking preferences
    PREFERRED_BOOKING_DAYS: List[str] = os.getenv(
        "PREFERRED_BOOKING_DAYS", "Monday,Wednesday,Friday"
    ).split(",")
    PREFERRED_BOOKING_HOURS: str = os.getenv("PREFERRED_BOOKING_HOURS", "9-17")
    AUTO_BOOK_ENABLED: bool = os.getenv("AUTO_BOOK_ENABLED", "false").lower() == "true"

    @classmethod
    def validate(cls) -> bool:
        """Validate required configuration"""
        if not cls.ANTHROPIC_API_KEY:
            raise ValueError("ANTHROPIC_API_KEY is required")

        if not os.path.exists(cls.GOOGLE_CREDENTIALS_PATH):
            raise ValueError(
                f"Google credentials file not found at {cls.GOOGLE_CREDENTIALS_PATH}. "
                "Please follow setup instructions in README."
            )

        return True

    @classmethod
    def get_timezone(cls):
        """Get configured timezone"""
        return pytz.timezone(cls.TIMEZONE)


# Validate configuration on import
try:
    Config.validate()
except ValueError as e:
    print(f"Configuration warning: {e}")
