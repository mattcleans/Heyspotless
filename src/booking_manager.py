"""
Appointment booking manager for Hey Spotless
"""

from typing import Dict, List, Optional
from datetime import datetime, timedelta

from .email_monitor import EmailMonitor
from .calendar_manager import CalendarManager
from .claude_assistant import ClaudeAssistant
from .config import Config


class BookingManager:
    """Manages appointment bookings with Hey Spotless"""

    def __init__(self):
        self.email_monitor = EmailMonitor()
        self.calendar = CalendarManager()
        self.assistant = ClaudeAssistant()

    def process_booking_request(
        self,
        duration_minutes: int = 120,
        max_slots: int = 5
    ) -> Dict:
        """
        Process a booking request by finding available slots and sending request

        Args:
            duration_minutes: Appointment duration
            max_slots: Maximum number of slots to suggest

        Returns:
            Dictionary with booking request status
        """
        try:
            # Parse preferred hours from config
            hours_range = Config.PREFERRED_BOOKING_HOURS.split('-')
            preferred_hours = (int(hours_range[0]), int(hours_range[1]))

            # Find available slots
            available_slots = self.calendar.find_available_slots(
                duration_minutes=duration_minutes,
                days_ahead=14,
                preferred_days=Config.PREFERRED_BOOKING_DAYS,
                preferred_hours=preferred_hours
            )

            if not available_slots:
                return {
                    'success': False,
                    'message': 'No available slots found in the next 14 days'
                }

            # Generate booking request email
            email_body = self.assistant.generate_booking_request(
                available_slots=available_slots[:max_slots]
            )

            # Send booking request
            subject = "Cleaning Appointment Request"
            sent = self.email_monitor.send_email(
                to=Config.HEYSPOTLESS_EMAIL,
                subject=subject,
                body=email_body
            )

            if sent:
                return {
                    'success': True,
                    'message': 'Booking request sent successfully',
                    'suggested_slots': available_slots[:max_slots],
                    'email_body': email_body
                }
            else:
                return {
                    'success': False,
                    'message': 'Failed to send booking request'
                }

        except Exception as e:
            return {
                'success': False,
                'message': f'Error processing booking request: {e}'
            }

    def confirm_booking(
        self,
        appointment_details: Dict,
        email_thread_id: Optional[str] = None
    ) -> Dict:
        """
        Confirm a booking by adding to calendar and sending confirmation

        Args:
            appointment_details: Details extracted from email
            email_thread_id: Thread ID for response

        Returns:
            Status of booking confirmation
        """
        try:
            # Parse date and time
            date_str = appointment_details.get('date')
            time_str = appointment_details.get('time')
            duration = appointment_details.get('duration', 120)

            if not date_str or not time_str:
                return {
                    'success': False,
                    'message': 'Missing date or time information'
                }

            # Create datetime objects
            start_datetime = datetime.strptime(
                f"{date_str} {time_str}",
                "%Y-%m-%d %H:%M"
            )
            start_datetime = Config.get_timezone().localize(start_datetime)
            end_datetime = start_datetime + timedelta(minutes=duration)

            # Create calendar event
            event = self.calendar.create_event(
                summary="Hey Spotless Cleaning",
                start_time=start_datetime,
                end_time=end_datetime,
                description=f"Cleaning service appointment\n\nService: {appointment_details.get('service_type', 'Standard Cleaning')}",
                location=appointment_details.get('location', '')
            )

            if not event:
                return {
                    'success': False,
                    'message': 'Failed to create calendar event'
                }

            # Send confirmation email if thread_id provided
            if email_thread_id:
                confirmation_body = f"""Thank you for confirming the appointment.

I've added this to my calendar:
Date: {start_datetime.strftime('%A, %B %d, %Y')}
Time: {start_datetime.strftime('%I:%M %p')} - {end_datetime.strftime('%I:%M %p')}

Looking forward to the service!"""

                self.email_monitor.send_email(
                    to=Config.HEYSPOTLESS_EMAIL,
                    subject="Re: Appointment Confirmation",
                    body=confirmation_body,
                    thread_id=email_thread_id
                )

            return {
                'success': True,
                'message': 'Booking confirmed and added to calendar',
                'event': event
            }

        except Exception as e:
            return {
                'success': False,
                'message': f'Error confirming booking: {e}'
            }

    def reschedule_appointment(
        self,
        event_id: str,
        new_slot: Dict,
        email_thread_id: Optional[str] = None
    ) -> Dict:
        """
        Reschedule an existing appointment

        Args:
            event_id: Calendar event ID
            new_slot: New time slot dictionary
            email_thread_id: Thread ID for response

        Returns:
            Status of rescheduling
        """
        try:
            # Update calendar event
            updated = self.calendar.update_event(
                event_id=event_id,
                start_time=new_slot['start'],
                end_time=new_slot['end']
            )

            if not updated:
                return {
                    'success': False,
                    'message': 'Failed to update calendar event'
                }

            # Send rescheduling request if thread_id provided
            if email_thread_id:
                reschedule_body = f"""I need to reschedule our appointment.

Would this new time work?
Date: {new_slot['date']}
Time: {new_slot['time']}

Please let me know if this works. Thank you!"""

                self.email_monitor.send_email(
                    to=Config.HEYSPOTLESS_EMAIL,
                    subject="Re: Appointment Rescheduling",
                    body=reschedule_body,
                    thread_id=email_thread_id
                )

            return {
                'success': True,
                'message': 'Appointment rescheduled successfully',
                'updated_event': updated
            }

        except Exception as e:
            return {
                'success': False,
                'message': f'Error rescheduling appointment: {e}'
            }

    def cancel_appointment(
        self,
        event_id: str,
        reason: Optional[str] = None,
        email_thread_id: Optional[str] = None
    ) -> Dict:
        """
        Cancel an appointment

        Args:
            event_id: Calendar event ID
            reason: Cancellation reason
            email_thread_id: Thread ID for response

        Returns:
            Status of cancellation
        """
        try:
            # Delete calendar event
            deleted = self.calendar.delete_event(event_id)

            if not deleted:
                return {
                    'success': False,
                    'message': 'Failed to delete calendar event'
                }

            # Send cancellation email if thread_id provided
            if email_thread_id:
                reason_text = f"\n\nReason: {reason}" if reason else ""
                cancel_body = f"""I need to cancel our upcoming appointment.{reason_text}

I apologize for any inconvenience. I'll reach out to reschedule soon.

Thank you for your understanding."""

                self.email_monitor.send_email(
                    to=Config.HEYSPOTLESS_EMAIL,
                    subject="Appointment Cancellation",
                    body=cancel_body,
                    thread_id=email_thread_id
                )

            return {
                'success': True,
                'message': 'Appointment cancelled successfully'
            }

        except Exception as e:
            return {
                'success': False,
                'message': f'Error cancelling appointment: {e}'
            }

    def get_upcoming_cleanings(self) -> List[Dict]:
        """Get all upcoming Hey Spotless appointments"""
        return self.calendar.get_cleaning_appointments()

    def check_for_conflicts(self, appointment_details: Dict) -> bool:
        """
        Check if a proposed appointment conflicts with calendar

        Args:
            appointment_details: Appointment details to check

        Returns:
            True if there's a conflict
        """
        try:
            date_str = appointment_details.get('date')
            time_str = appointment_details.get('time')
            duration = appointment_details.get('duration', 120)

            if not date_str or not time_str:
                return False

            # Create datetime
            start_datetime = datetime.strptime(
                f"{date_str} {time_str}",
                "%Y-%m-%d %H:%M"
            )
            end_datetime = start_datetime + timedelta(minutes=duration)

            # Get events on that day
            events = self.calendar.get_upcoming_events(days_ahead=1)

            for event in events:
                if event['start_datetime'] and event['end_datetime']:
                    # Check for overlap
                    if (start_datetime < event['end_datetime'] and
                        end_datetime > event['start_datetime']):
                        return True

            return False

        except Exception as e:
            print(f"Error checking conflicts: {e}")
            return False
