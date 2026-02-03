"""
Google Calendar integration for managing cleaning appointments
"""

import os
import pickle
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from dateutil import parser
import pytz

from .config import Config


class CalendarManager:
    """Manages Google Calendar for cleaning appointments"""

    def __init__(self):
        self.service = None
        self.credentials = None
        self._authenticate()

    def _authenticate(self):
        """Authenticate with Google Calendar API"""
        creds = None

        # Check if we already have valid credentials
        if os.path.exists(Config.GOOGLE_TOKEN_PATH):
            with open(Config.GOOGLE_TOKEN_PATH, 'rb') as token:
                creds = pickle.load(token)

        # If credentials are invalid, refresh or get new ones
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    Config.GOOGLE_CREDENTIALS_PATH,
                    Config.CALENDAR_SCOPES
                )
                creds = flow.run_local_server(port=0)

            # Save credentials
            with open(Config.GOOGLE_TOKEN_PATH, 'wb') as token:
                pickle.dump(creds, token)

        self.credentials = creds
        self.service = build('calendar', 'v3', credentials=creds)

    def get_upcoming_events(
        self,
        days_ahead: int = 30,
        query: Optional[str] = None
    ) -> List[Dict]:
        """
        Get upcoming calendar events

        Args:
            days_ahead: Number of days to look ahead
            query: Search query for event summary/description

        Returns:
            List of calendar events
        """
        try:
            now = datetime.utcnow().isoformat() + 'Z'
            end_date = (datetime.utcnow() + timedelta(days=days_ahead)).isoformat() + 'Z'

            events_result = self.service.events().list(
                calendarId='primary',
                timeMin=now,
                timeMax=end_date,
                maxResults=100,
                singleEvents=True,
                orderBy='startTime',
                q=query
            ).execute()

            events = events_result.get('items', [])

            return [self._parse_event(event) for event in events]

        except Exception as e:
            print(f"Error fetching calendar events: {e}")
            return []

    def _parse_event(self, event: Dict) -> Dict:
        """Parse calendar event into structured format"""
        start = event['start'].get('dateTime', event['start'].get('date'))
        end = event['end'].get('dateTime', event['end'].get('date'))

        # Parse dates
        try:
            start_dt = parser.parse(start)
            end_dt = parser.parse(end)
        except:
            start_dt = None
            end_dt = None

        return {
            'id': event['id'],
            'summary': event.get('summary', 'No Title'),
            'description': event.get('description', ''),
            'location': event.get('location', ''),
            'start': start,
            'end': end,
            'start_datetime': start_dt,
            'end_datetime': end_dt,
            'attendees': event.get('attendees', []),
            'html_link': event.get('htmlLink', '')
        }

    def find_available_slots(
        self,
        duration_minutes: int = 120,
        days_ahead: int = 14,
        preferred_days: Optional[List[str]] = None,
        preferred_hours: Tuple[int, int] = (9, 17)
    ) -> List[Dict]:
        """
        Find available time slots for booking

        Args:
            duration_minutes: Duration of appointment in minutes
            days_ahead: How many days to look ahead
            preferred_days: List of preferred day names (e.g., ['Monday', 'Wednesday'])
            preferred_hours: Tuple of (start_hour, end_hour) in 24-hour format

        Returns:
            List of available time slots
        """
        try:
            # Get existing events
            events = self.get_upcoming_events(days_ahead=days_ahead)

            # Build list of busy times
            busy_times = []
            for event in events:
                if event['start_datetime'] and event['end_datetime']:
                    busy_times.append({
                        'start': event['start_datetime'],
                        'end': event['end_datetime']
                    })

            # Find available slots
            available_slots = []
            current_date = datetime.now(Config.get_timezone())
            end_date = current_date + timedelta(days=days_ahead)

            while current_date < end_date:
                # Check if this day matches preferred days
                if preferred_days and current_date.strftime('%A') not in preferred_days:
                    current_date += timedelta(days=1)
                    continue

                # Check time slots during preferred hours
                start_hour, end_hour = preferred_hours
                slot_start = current_date.replace(
                    hour=start_hour,
                    minute=0,
                    second=0,
                    microsecond=0
                )

                while slot_start.hour < end_hour:
                    slot_end = slot_start + timedelta(minutes=duration_minutes)

                    # Check if slot is available
                    is_available = True
                    for busy in busy_times:
                        # Convert to timezone-aware if needed
                        busy_start = busy['start']
                        busy_end = busy['end']

                        if busy_start.tzinfo is None:
                            busy_start = Config.get_timezone().localize(busy_start)
                        if busy_end.tzinfo is None:
                            busy_end = Config.get_timezone().localize(busy_end)

                        # Check for overlap
                        if (slot_start < busy_end and slot_end > busy_start):
                            is_available = False
                            break

                    if is_available and slot_end.hour <= end_hour:
                        available_slots.append({
                            'start': slot_start,
                            'end': slot_end,
                            'date': slot_start.strftime('%Y-%m-%d'),
                            'time': slot_start.strftime('%I:%M %p'),
                            'day_of_week': slot_start.strftime('%A')
                        })

                    # Move to next slot (try every hour)
                    slot_start += timedelta(hours=1)

                current_date += timedelta(days=1)

            return available_slots

        except Exception as e:
            print(f"Error finding available slots: {e}")
            return []

    def create_event(
        self,
        summary: str,
        start_time: datetime,
        end_time: datetime,
        description: str = "",
        location: str = ""
    ) -> Optional[Dict]:
        """
        Create a calendar event

        Args:
            summary: Event title
            start_time: Start datetime
            end_time: End datetime
            description: Event description
            location: Event location

        Returns:
            Created event or None if failed
        """
        try:
            # Ensure timezone-aware datetimes
            if start_time.tzinfo is None:
                start_time = Config.get_timezone().localize(start_time)
            if end_time.tzinfo is None:
                end_time = Config.get_timezone().localize(end_time)

            event = {
                'summary': summary,
                'description': description,
                'location': location,
                'start': {
                    'dateTime': start_time.isoformat(),
                    'timeZone': Config.TIMEZONE,
                },
                'end': {
                    'dateTime': end_time.isoformat(),
                    'timeZone': Config.TIMEZONE,
                },
                'reminders': {
                    'useDefault': False,
                    'overrides': [
                        {'method': 'email', 'minutes': 24 * 60},  # 1 day before
                        {'method': 'popup', 'minutes': 60},  # 1 hour before
                    ],
                },
            }

            created_event = self.service.events().insert(
                calendarId='primary',
                body=event
            ).execute()

            return self._parse_event(created_event)

        except Exception as e:
            print(f"Error creating calendar event: {e}")
            return None

    def update_event(
        self,
        event_id: str,
        summary: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        description: Optional[str] = None
    ) -> Optional[Dict]:
        """Update an existing calendar event"""
        try:
            # Get existing event
            event = self.service.events().get(
                calendarId='primary',
                eventId=event_id
            ).execute()

            # Update fields
            if summary:
                event['summary'] = summary
            if description:
                event['description'] = description
            if start_time:
                if start_time.tzinfo is None:
                    start_time = Config.get_timezone().localize(start_time)
                event['start'] = {
                    'dateTime': start_time.isoformat(),
                    'timeZone': Config.TIMEZONE,
                }
            if end_time:
                if end_time.tzinfo is None:
                    end_time = Config.get_timezone().localize(end_time)
                event['end'] = {
                    'dateTime': end_time.isoformat(),
                    'timeZone': Config.TIMEZONE,
                }

            updated_event = self.service.events().update(
                calendarId='primary',
                eventId=event_id,
                body=event
            ).execute()

            return self._parse_event(updated_event)

        except Exception as e:
            print(f"Error updating event: {e}")
            return None

    def delete_event(self, event_id: str) -> bool:
        """Delete a calendar event"""
        try:
            self.service.events().delete(
                calendarId='primary',
                eventId=event_id
            ).execute()
            return True
        except Exception as e:
            print(f"Error deleting event: {e}")
            return False

    def get_cleaning_appointments(self) -> List[Dict]:
        """Get all Hey Spotless cleaning appointments"""
        return self.get_upcoming_events(
            days_ahead=90,
            query="Hey Spotless"
        )
