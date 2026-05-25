"""TraderAgent: Send batch notifications (email/SMS) for signals."""

import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
from datetime import datetime

from fstack.agents.base import BaseAgent
from fstack.core.models import Signal
from fstack.core.db import Database
from fstack.core.errors import EmailServiceError

logger = logging.getLogger(__name__)


class TraderAgent(BaseAgent):
    """Send notifications for investment signals."""

    def __init__(
        self,
        db: Database,
        gmail_address: str,
        gmail_app_password: str,
        notification_email: str,
    ):
        """Initialize TraderAgent.

        Args:
            db: Database connection
            gmail_address: Gmail sender address
            gmail_app_password: Gmail app password (for SMTP)
            notification_email: Recipient email address
        """
        super().__init__(name="TraderAgent")
        self.db = db
        self.gmail_address = gmail_address
        self.gmail_app_password = gmail_app_password
        self.notification_email = notification_email

    async def analyze(self, ticker: str, **kwargs) -> Optional[bool]:
        """TraderAgent doesn't analyze—it sends.

        Use send_batch_email() instead for batch notifications.

        Args:
            ticker: Unused
            **kwargs: Unused

        Returns:
            False (trader agent doesn't do analysis)
        """
        return False

    async def send_batch_email(
        self, signals: list[Signal], run_date: str = None
    ) -> bool:
        """Send batch email with all signals.

        One email per batch run with all BUY/SELL/HOLD recommendations.

        Args:
            signals: List of Signal objects
            run_date: Date of analysis (default today)

        Returns:
            True if email sent successfully, False otherwise
        """
        if not signals:
            self.logger.info("No signals to send")
            return True

        if run_date is None:
            run_date = datetime.now().strftime("%Y-%m-%d")

        try:
            # Organize signals by recommendation
            buys = [s for s in signals if s.recommendation == "BUY"]
            sells = [s for s in signals if s.recommendation == "SELL"]
            holds = [s for s in signals if s.recommendation == "HOLD"]

            # Build email body
            subject = self._build_subject(buys, sells, holds, run_date)
            body = self._build_email_body(buys, sells, holds, run_date)

            # Send email
            success = self._send_email(subject, body)

            if success:
                self.logger.info(
                    f"Email sent: {len(signals)} signals "
                    f"({len(buys)} BUY, {len(sells)} SELL, {len(holds)} HOLD)"
                )
                # Store signals in database
                for signal in signals:
                    signal_id = self.db.add_signal(
                        ticker=signal.ticker,
                        date=signal.date.isoformat(),
                        recommendation=signal.recommendation,
                        confidence=signal.confidence,
                        reasoning=signal.reasoning,
                        from_watchlist=signal.from_watchlist,
                    )
            else:
                # Queue failed signals for retry
                self.logger.warning("Email send failed, queueing for retry")
                for signal in signals:
                    signal_id = self.db.add_signal(
                        ticker=signal.ticker,
                        date=signal.date.isoformat(),
                        recommendation=signal.recommendation,
                        confidence=signal.confidence,
                        reasoning=signal.reasoning,
                        from_watchlist=signal.from_watchlist,
                    )
                    self.db.add_pending_notification(
                        ticker=signal.ticker,
                        signal_id=signal_id,
                        email=self.notification_email,
                        notification_type="email",
                    )

            return success

        except Exception as e:
            self.logger.error(f"Batch email send failed: {e}")
            raise EmailServiceError(f"Batch email failed: {e}")

    async def retry_pending_notifications(self) -> int:
        """Retry sending pending notifications.

        Returns:
            Number of notifications retried
        """
        pending = self.db.get_pending_notifications()
        if not pending:
            self.logger.info("No pending notifications")
            return 0

        retried = 0
        for notification in pending:
            try:
                # Rebuild email from signal
                signal = self.db.query(
                    "SELECT * FROM signals WHERE id = ?",
                    (notification.get("signal_id"),),
                )

                if not signal:
                    # Signal not found, remove notification
                    self.db.remove_pending_notification(notification.get("id"))
                    continue

                # Retry send
                success = self._send_email(
                    subject=f"fstack retry - {signal[0].get('ticker')}",
                    body=f"{signal[0].get('recommendation')}: {signal[0].get('reasoning')}",
                )

                if success:
                    self.db.remove_pending_notification(notification.get("id"))
                    retried += 1
                else:
                    # Update retry count
                    self.db.update_pending_notification_retry(notification.get("id"))

            except Exception as e:
                self.logger.error(f"Retry failed for notification {notification.get('id')}: {e}")
                self.db.update_pending_notification_retry(notification.get("id"))

        self.logger.info(f"Retried {retried} pending notifications")
        return retried

    @staticmethod
    def _build_subject(buys: list, sells: list, holds: list, run_date: str) -> str:
        """Build email subject.

        Args:
            buys: BUY signals
            sells: SELL signals
            holds: HOLD signals
            run_date: Analysis date

        Returns:
            Email subject line
        """
        return (
            f"fstack analysis {run_date} — "
            f"{len(buys)} BUY, {len(sells)} SELL, {len(holds)} HOLD"
        )

    @staticmethod
    def _build_email_body(buys: list, sells: list, holds: list, run_date: str) -> str:
        """Build email body.

        Args:
            buys: BUY signals
            sells: SELL signals
            holds: HOLD signals
            run_date: Analysis date

        Returns:
            Email body HTML/text
        """
        lines = [
            f"fstack Investment Analysis",
            f"{'='*50}",
            f"Date: {run_date}",
            "",
        ]

        if buys:
            lines.append("🟢 BUY SIGNALS")
            lines.append("-" * 50)
            for signal in buys:
                lines.append(f"{signal.ticker.upper()}")
                lines.append(f"  Confidence: {signal.confidence:.0%}")
                lines.append(f"  Reason: {signal.reasoning}")
                lines.append("")

        if sells:
            lines.append("🔴 SELL SIGNALS")
            lines.append("-" * 50)
            for signal in sells:
                lines.append(f"{signal.ticker.upper()}")
                lines.append(f"  Confidence: {signal.confidence:.0%}")
                lines.append(f"  Reason: {signal.reasoning}")
                lines.append("")

        if holds:
            lines.append("🟡 HOLD SIGNALS")
            lines.append("-" * 50)
            for signal in holds:
                lines.append(f"{signal.ticker.upper()} ({signal.confidence:.0%})")

            lines.append("")

        lines.append("=" * 50)
        lines.append("Generated by fstack")
        lines.append("Do not reply to this email")

        return "\n".join(lines)

    def _send_email(self, subject: str, body: str) -> bool:
        """Send email via Gmail SMTP.

        Args:
            subject: Email subject
            body: Email body

        Returns:
            True if successful, False otherwise
        """
        try:
            # Create message
            msg = MIMEMultipart()
            msg["From"] = self.gmail_address
            msg["To"] = self.notification_email
            msg["Subject"] = subject

            msg.attach(MIMEText(body, "plain"))

            # Send via Gmail SMTP
            with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
                server.login(self.gmail_address, self.gmail_app_password)
                server.send_message(msg)

            self.logger.info(f"Email sent to {self.notification_email}")
            return True

        except smtplib.SMTPAuthenticationError:
            self.logger.error("Gmail authentication failed (check password)")
            return False
        except smtplib.SMTPException as e:
            self.logger.error(f"SMTP error: {e}")
            return False
        except Exception as e:
            self.logger.error(f"Email send failed: {e}")
            return False
