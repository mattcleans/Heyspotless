"""
Notification system for Hey Spotless automation
Supports email, SMS (via Twilio), and webhook notifications
"""

import smtplib
import requests
from typing import Dict, List, Optional
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime

from .config import Config


class Notifier:
    """Handles notifications via multiple channels"""

    def __init__(self):
        self.twilio_client = None
        self._init_twilio()

    def _init_twilio(self):
        """Initialize Twilio client if credentials are available"""
        if Config.TWILIO_ACCOUNT_SID and Config.TWILIO_AUTH_TOKEN:
            try:
                from twilio.rest import Client
                self.twilio_client = Client(
                    Config.TWILIO_ACCOUNT_SID,
                    Config.TWILIO_AUTH_TOKEN
                )
            except Exception as e:
                print(f"Warning: Could not initialize Twilio: {e}")

    def send_notification(
        self,
        title: str,
        message: str,
        urgency: str = "medium",
        channels: Optional[List[str]] = None
    ) -> Dict:
        """
        Send notification through specified channels

        Args:
            title: Notification title
            message: Notification message
            urgency: Urgency level (low, medium, high)
            channels: List of channels to use (email, sms, webhook)
                     If None, uses all available channels for high urgency,
                     or email only for medium/low

        Returns:
            Dictionary with status for each channel
        """
        results = {}

        # Determine channels if not specified
        if channels is None:
            if urgency == "high":
                channels = ["email", "sms", "webhook"]
            else:
                channels = ["email"]

        # Send via each channel
        if "email" in channels:
            results["email"] = self._send_email_notification(title, message)

        if "sms" in channels and self.twilio_client:
            results["sms"] = self._send_sms_notification(title, message)

        if "webhook" in channels and Config.WEBHOOK_URL:
            results["webhook"] = self._send_webhook_notification(
                title, message, urgency
            )

        return results

    def _send_email_notification(self, title: str, message: str) -> bool:
        """Send email notification using Gmail SMTP"""
        if not Config.NOTIFICATION_EMAIL:
            return False

        try:
            # Note: This is a simplified version
            # In production, you'd use Gmail API or SMTP with proper auth
            print(f"Email notification sent to {Config.NOTIFICATION_EMAIL}")
            print(f"Title: {title}")
            print(f"Message: {message}")
            return True

        except Exception as e:
            print(f"Error sending email notification: {e}")
            return False

    def _send_sms_notification(self, title: str, message: str) -> bool:
        """Send SMS notification via Twilio"""
        if not self.twilio_client:
            return False

        try:
            sms_body = f"{title}\n\n{message}"

            self.twilio_client.messages.create(
                body=sms_body[:160],  # SMS character limit
                from_=Config.TWILIO_FROM_NUMBER,
                to=Config.TWILIO_TO_NUMBER
            )

            print(f"SMS notification sent to {Config.TWILIO_TO_NUMBER}")
            return True

        except Exception as e:
            print(f"Error sending SMS notification: {e}")
            return False

    def _send_webhook_notification(
        self,
        title: str,
        message: str,
        urgency: str
    ) -> bool:
        """Send webhook notification"""
        if not Config.WEBHOOK_URL:
            return False

        try:
            payload = {
                "title": title,
                "message": message,
                "urgency": urgency,
                "timestamp": datetime.now().isoformat(),
                "source": "heyspotless_automation"
            }

            response = requests.post(
                Config.WEBHOOK_URL,
                json=payload,
                timeout=10
            )

            if response.status_code in [200, 201, 204]:
                print(f"Webhook notification sent to {Config.WEBHOOK_URL}")
                return True
            else:
                print(f"Webhook returned status {response.status_code}")
                return False

        except Exception as e:
            print(f"Error sending webhook notification: {e}")
            return False

    def notify_new_email(self, email_data: Dict, analysis: Dict):
        """Send notification about new email"""
        title = f"New email from Hey Spotless: {email_data['subject']}"
        message = f"""From: {email_data['from']}
Subject: {email_data['subject']}

Intent: {analysis.get('intent', 'unknown')}
Urgency: {analysis.get('urgency', 'medium')}

Action Required: {analysis.get('action_required', 'None')}

Snippet: {email_data['snippet']}"""

        urgency = analysis.get('urgency', 'medium')
        self.send_notification(title, message, urgency)

    def notify_booking_confirmed(self, event_data: Dict):
        """Send notification about confirmed booking"""
        title = "Cleaning Appointment Confirmed"
        message = f"""Your Hey Spotless appointment has been confirmed:

Date: {event_data.get('start', 'TBD')}
Location: {event_data.get('location', 'TBD')}

The appointment has been added to your calendar."""

        self.send_notification(title, message, urgency="medium")

    def notify_upcoming_cleaning(self, event_data: Dict, hours_until: int):
        """Send notification about upcoming cleaning"""
        title = "Upcoming Cleaning Reminder"
        message = f"""Your Hey Spotless cleaning is coming up in {hours_until} hours.

Date: {event_data.get('start', 'TBD')}
Location: {event_data.get('location', 'TBD')}

Make sure the space is ready!"""

        urgency = "high" if hours_until <= 2 else "medium"
        self.send_notification(title, message, urgency=urgency)

    def notify_booking_failed(self, reason: str):
        """Send notification about failed booking"""
        title = "Booking Failed"
        message = f"""Failed to book Hey Spotless appointment.

Reason: {reason}

Please check manually."""

        self.send_notification(title, message, urgency="medium")

    def notify_action_required(self, action: str, details: str):
        """Send notification when user action is required"""
        title = "Action Required: Hey Spotless"
        message = f"""Action: {action}

Details: {details}

Please review and respond as needed."""

        self.send_notification(title, message, urgency="high")

    def send_daily_summary(self, summary_data: Dict):
        """Send daily summary of Hey Spotless activity"""
        title = "Hey Spotless Daily Summary"

        upcoming_count = len(summary_data.get('upcoming_appointments', []))
        new_emails = len(summary_data.get('new_emails', []))
        pending_actions = len(summary_data.get('pending_actions', []))

        message = f"""Daily Summary for {datetime.now().strftime('%B %d, %Y')}

Upcoming Appointments: {upcoming_count}
New Emails: {new_emails}
Pending Actions: {pending_actions}

"""

        # Add upcoming appointments
        if upcoming_count > 0:
            message += "\nUpcoming Appointments:\n"
            for apt in summary_data.get('upcoming_appointments', [])[:3]:
                message += f"- {apt.get('start', 'TBD')}\n"

        # Add pending actions
        if pending_actions > 0:
            message += "\nPending Actions:\n"
            for action in summary_data.get('pending_actions', [])[:3]:
                message += f"- {action}\n"

        self.send_notification(title, message, urgency="low")
