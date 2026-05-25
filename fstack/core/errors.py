"""Custom exceptions for fstack."""


class FstackError(Exception):
    """Base exception for fstack."""

    pass


class ConfigError(FstackError):
    """Configuration or environment error."""

    pass


class ValidationError(FstackError):
    """Data validation error."""

    pass


class APIError(FstackError):
    """Third-party API error."""

    pass


class QuoteServiceError(APIError):
    """Error fetching quote data."""

    pass


class EquityServiceError(APIError):
    """Error fetching equity data."""

    pass


class EmailServiceError(FstackError):
    """Error sending email notification."""

    pass


class DatabaseError(FstackError):
    """Database operation error."""

    pass
