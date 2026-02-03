"""
Main automation orchestration for Hey Spotless
Coordinates email monitoring, calendar management, and booking
"""

import time
from datetime import datetime, timedelta
from typing import Dict, List

from .email_monitor import EmailMonitor
from .calendar_manager import CalendarManager
from .claude_assistant import ClaudeAssistant
from .booking_manager import BookingManager
from .notifier import Notifier
from .config import Config


class HeySpotlessAutomation:
    """Main automation coordinator"""

    def __init__(self):
        self.email_monitor = EmailMonitor()
        self.calendar = CalendarManager()
        self.assistant = ClaudeAssistant()
        self.booking = BookingManager()
        self.notifier = Notifier()
        self.processed_message_ids = set()

    def run_cycle(self):
        """Run one automation cycle"""
        print(f"\n{'='*60}")
        print(f"Running automation cycle at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*60}\n")

        # Step 1: Check for new emails
        print("1. Checking for new emails...")
        self._process_new_emails()

        # Step 2: Check for upcoming appointments
        print("\n2. Checking for upcoming appointments...")
        self._check_upcoming_appointments()

        # Step 3: Check if we need to book new appointments
        print("\n3. Checking booking needs...")
        self._check_booking_needs()

        print(f"\n{'='*60}")
        print("Cycle complete")
        print(f"{'='*60}\n")

    def _process_new_emails(self):
        """Process new emails from Hey Spotless"""
        try:
            # Get recent unread messages
            messages = self.email_monitor.get_recent_messages(
                hours=Config.CHECK_INTERVAL_MINUTES // 60 + 1,
                unread_only=True
            )

            if not messages:
                print("  No new messages")
                return

            print(f"  Found {len(messages)} new message(s)")

            for msg in messages:
                # Skip if already processed
                if msg['id'] in self.processed_message_ids:
                    continue

                print(f"\n  Processing: {msg['subject']}")

                # Analyze with Claude
                analysis = self.assistant.analyze_email(msg)
                print(f"    Intent: {analysis.get('intent')}")
                print(f"    Urgency: {analysis.get('urgency')}")
                print(f"    Action: {analysis.get('action_required')}")

                # Send notification
                self.notifier.notify_new_email(msg, analysis)

                # Handle based on intent
                self._handle_email_intent(msg, analysis)

                # Mark as processed
                self.processed_message_ids.add(msg['id'])
                self.email_monitor.add_label(msg['id'], 'HeySpotless/Processed')

        except Exception as e:
            print(f"  Error processing emails: {e}")

    def _handle_email_intent(self, email_data: Dict, analysis: Dict):
        """Handle email based on its intent"""
        intent = analysis.get('intent', 'unknown')

        if intent == 'appointment_confirmation':
            self._handle_appointment_confirmation(email_data, analysis)

        elif intent == 'rescheduling_request':
            self._handle_rescheduling_request(email_data, analysis)

        elif intent == 'payment_reminder':
            self._handle_payment_reminder(email_data, analysis)

        elif intent == 'availability_inquiry':
            self._handle_availability_inquiry(email_data, analysis)

        elif intent == 'service_question':
            if self.assistant.should_auto_respond(analysis):
                self._send_auto_response(email_data, analysis)

    def _handle_appointment_confirmation(self, email_data: Dict, analysis: Dict):
        """Handle appointment confirmation email"""
        print("    → Handling appointment confirmation")

        # Extract appointment details
        details = self.assistant.extract_appointment_details(email_data['body'])

        if details:
            # Check for conflicts
            has_conflict = self.booking.check_for_conflicts(details)

            if has_conflict:
                print("    ⚠ Calendar conflict detected!")
                self.notifier.notify_action_required(
                    "Calendar Conflict",
                    f"Appointment scheduled for {details.get('date')} conflicts with existing event"
                )
            else:
                # Confirm booking
                result = self.booking.confirm_booking(
                    details,
                    email_data.get('thread_id')
                )

                if result['success']:
                    print("    ✓ Booking confirmed and added to calendar")
                    self.notifier.notify_booking_confirmed(result.get('event', {}))
                else:
                    print(f"    ✗ Booking failed: {result['message']}")
        else:
            print("    ⚠ Could not extract appointment details")
            self.notifier.notify_action_required(
                "Review Required",
                f"Please review appointment confirmation: {email_data['subject']}"
            )

    def _handle_rescheduling_request(self, email_data: Dict, analysis: Dict):
        """Handle rescheduling request"""
        print("    → Rescheduling request detected")
        self.notifier.notify_action_required(
            "Rescheduling Needed",
            f"Hey Spotless is requesting to reschedule. Please review: {email_data['subject']}"
        )

    def _handle_payment_reminder(self, email_data: Dict, analysis: Dict):
        """Handle payment reminder"""
        print("    → Payment reminder received")
        self.notifier.notify_action_required(
            "Payment Required",
            f"Payment reminder from Hey Spotless: {email_data['snippet']}"
        )

    def _handle_availability_inquiry(self, email_data: Dict, analysis: Dict):
        """Handle availability inquiry"""
        print("    → Availability inquiry")

        if Config.AUTO_BOOK_ENABLED:
            # Find available slots and respond
            result = self.booking.process_booking_request()

            if result['success']:
                print("    ✓ Availability response sent")
            else:
                print(f"    ✗ Failed: {result['message']}")
        else:
            self.notifier.notify_action_required(
                "Availability Inquiry",
                "Hey Spotless is asking about your availability. Auto-booking is disabled."
            )

    def _send_auto_response(self, email_data: Dict, analysis: Dict):
        """Send automatic response to email"""
        print("    → Sending auto-response")

        response = self.assistant.generate_response(
            email_data,
            context=f"Urgency: {analysis.get('urgency')}"
        )

        sent = self.email_monitor.send_email(
            to=email_data['from'],
            subject=f"Re: {email_data['subject']}",
            body=response,
            thread_id=email_data.get('thread_id')
        )

        if sent:
            print("    ✓ Auto-response sent")
            self.email_monitor.mark_as_read(email_data['id'])
        else:
            print("    ✗ Failed to send auto-response")

    def _check_upcoming_appointments(self):
        """Check for upcoming cleaning appointments and send reminders"""
        try:
            appointments = self.booking.get_upcoming_cleanings()

            if not appointments:
                print("  No upcoming appointments")
                return

            print(f"  Found {len(appointments)} upcoming appointment(s)")

            now = datetime.now(Config.get_timezone())

            for apt in appointments:
                if apt['start_datetime']:
                    time_until = apt['start_datetime'] - now
                    hours_until = time_until.total_seconds() / 3600

                    # Send reminder for appointments within 24 hours
                    if 0 < hours_until <= 24:
                        print(f"    Reminder: {apt['summary']} in {hours_until:.1f} hours")
                        self.notifier.notify_upcoming_cleaning(
                            apt,
                            int(hours_until)
                        )

        except Exception as e:
            print(f"  Error checking appointments: {e}")

    def _check_booking_needs(self):
        """Check if we need to proactively book appointments"""
        try:
            # Get upcoming appointments
            appointments = self.booking.get_upcoming_cleanings()

            # Check if we need to book (no appointments in next 30 days)
            now = datetime.now(Config.get_timezone())
            has_upcoming = any(
                apt['start_datetime'] and
                (apt['start_datetime'] - now).days < 30
                for apt in appointments
                if apt['start_datetime']
            )

            if not has_upcoming and Config.AUTO_BOOK_ENABLED:
                print("  No appointments scheduled in next 30 days")
                print("  Initiating booking request...")

                result = self.booking.process_booking_request()

                if result['success']:
                    print("  ✓ Booking request sent")
                else:
                    print(f"  ✗ Booking failed: {result['message']}")
            else:
                print("  Booking check: OK")

        except Exception as e:
            print(f"  Error checking booking needs: {e}")

    def run_continuous(self, interval_minutes: Optional[int] = None):
        """
        Run automation continuously

        Args:
            interval_minutes: Check interval in minutes (defaults to config value)
        """
        interval = interval_minutes or Config.CHECK_INTERVAL_MINUTES

        print("="*60)
        print("Hey Spotless Automation Starting")
        print("="*60)
        print(f"Check interval: {interval} minutes")
        print(f"Timezone: {Config.TIMEZONE}")
        print(f"Auto-booking: {'Enabled' if Config.AUTO_BOOK_ENABLED else 'Disabled'}")
        print("="*60)

        try:
            while True:
                self.run_cycle()

                print(f"\nSleeping for {interval} minutes...")
                print(f"Next check at: {(datetime.now() + timedelta(minutes=interval)).strftime('%Y-%m-%d %H:%M:%S')}")

                time.sleep(interval * 60)

        except KeyboardInterrupt:
            print("\n\nAutomation stopped by user")
        except Exception as e:
            print(f"\n\nFatal error: {e}")
            raise

    def generate_summary(self) -> Dict:
        """Generate summary of current status"""
        upcoming = self.booking.get_upcoming_cleanings()
        recent_emails = self.email_monitor.get_recent_messages(hours=24)

        return {
            'upcoming_appointments': upcoming,
            'new_emails': recent_emails,
            'pending_actions': []  # Would track pending user actions
        }
