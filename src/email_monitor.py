"""
Email monitoring module for Hey Spotless communications
Uses Gmail API to monitor and process emails
"""

import base64
import os
import pickle
from typing import List, Dict, Optional
from datetime import datetime, timedelta
from email.mime.text import MIMEText

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from .config import Config


class EmailMonitor:
    """Monitors Gmail for Hey Spotless communications"""

    def __init__(self):
        self.service = None
        self.credentials = None
        self._authenticate()

    def _authenticate(self):
        """Authenticate with Gmail API"""
        creds = None

        # Token file stores the user's access and refresh tokens
        if os.path.exists(Config.GOOGLE_TOKEN_PATH):
            with open(Config.GOOGLE_TOKEN_PATH, 'rb') as token:
                creds = pickle.load(token)

        # If credentials are invalid or don't exist, get new ones
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    Config.GOOGLE_CREDENTIALS_PATH,
                    Config.GMAIL_SCOPES
                )
                creds = flow.run_local_server(port=0)

            # Save credentials for future use
            with open(Config.GOOGLE_TOKEN_PATH, 'wb') as token:
                pickle.dump(creds, token)

        self.credentials = creds
        self.service = build('gmail', 'v1', credentials=creds)

    def get_recent_messages(
        self,
        hours: int = 24,
        unread_only: bool = True
    ) -> List[Dict]:
        """
        Get recent messages from Hey Spotless

        Args:
            hours: Number of hours to look back
            unread_only: Only retrieve unread messages

        Returns:
            List of message dictionaries
        """
        try:
            # Build query
            query_parts = [f"from:@{Config.HEYSPOTLESS_DOMAIN}"]

            if unread_only:
                query_parts.append("is:unread")

            # Calculate date for after: filter
            after_date = datetime.now() - timedelta(hours=hours)
            query_parts.append(f"after:{after_date.strftime('%Y/%m/%d')}")

            query = " ".join(query_parts)

            # Get message list
            results = self.service.users().messages().list(
                userId='me',
                q=query
            ).execute()

            messages = results.get('messages', [])

            if not messages:
                return []

            # Get full message details
            detailed_messages = []
            for msg in messages:
                msg_detail = self.service.users().messages().get(
                    userId='me',
                    id=msg['id'],
                    format='full'
                ).execute()

                detailed_messages.append(self._parse_message(msg_detail))

            return detailed_messages

        except Exception as e:
            print(f"Error fetching messages: {e}")
            return []

    def _parse_message(self, message: Dict) -> Dict:
        """Parse Gmail message into structured format"""
        headers = message['payload'].get('headers', [])

        # Extract headers
        subject = next(
            (h['value'] for h in headers if h['name'].lower() == 'subject'),
            'No Subject'
        )
        sender = next(
            (h['value'] for h in headers if h['name'].lower() == 'from'),
            'Unknown'
        )
        date = next(
            (h['value'] for h in headers if h['name'].lower() == 'date'),
            ''
        )

        # Extract body
        body = self._get_message_body(message['payload'])

        return {
            'id': message['id'],
            'thread_id': message['threadId'],
            'subject': subject,
            'from': sender,
            'date': date,
            'body': body,
            'snippet': message.get('snippet', ''),
            'labels': message.get('labelIds', [])
        }

    def _get_message_body(self, payload: Dict) -> str:
        """Extract message body from payload"""
        if 'body' in payload and 'data' in payload['body']:
            return base64.urlsafe_b64decode(
                payload['body']['data']
            ).decode('utf-8')

        # Handle multipart messages
        if 'parts' in payload:
            for part in payload['parts']:
                if part['mimeType'] == 'text/plain':
                    if 'data' in part['body']:
                        return base64.urlsafe_b64decode(
                            part['body']['data']
                        ).decode('utf-8')
                elif part['mimeType'] == 'text/html':
                    if 'data' in part['body']:
                        return base64.urlsafe_b64decode(
                            part['body']['data']
                        ).decode('utf-8')

        return ""

    def send_email(
        self,
        to: str,
        subject: str,
        body: str,
        thread_id: Optional[str] = None
    ) -> bool:
        """
        Send an email response

        Args:
            to: Recipient email address
            subject: Email subject
            body: Email body
            thread_id: Thread ID to reply to (optional)

        Returns:
            True if sent successfully
        """
        try:
            message = MIMEText(body)
            message['to'] = to
            message['subject'] = subject

            raw_message = base64.urlsafe_b64encode(
                message.as_bytes()
            ).decode('utf-8')

            send_message = {'raw': raw_message}

            if thread_id:
                send_message['threadId'] = thread_id

            self.service.users().messages().send(
                userId='me',
                body=send_message
            ).execute()

            return True

        except Exception as e:
            print(f"Error sending email: {e}")
            return False

    def mark_as_read(self, message_id: str) -> bool:
        """Mark a message as read"""
        try:
            self.service.users().messages().modify(
                userId='me',
                id=message_id,
                body={'removeLabelIds': ['UNREAD']}
            ).execute()
            return True
        except Exception as e:
            print(f"Error marking message as read: {e}")
            return False

    def add_label(self, message_id: str, label_name: str) -> bool:
        """Add a label to a message"""
        try:
            # First, get or create the label
            labels = self.service.users().labels().list(userId='me').execute()
            label_id = None

            for label in labels.get('labels', []):
                if label['name'] == label_name:
                    label_id = label['id']
                    break

            # Create label if it doesn't exist
            if not label_id:
                label_object = {
                    'name': label_name,
                    'labelListVisibility': 'labelShow',
                    'messageListVisibility': 'show'
                }
                created_label = self.service.users().labels().create(
                    userId='me',
                    body=label_object
                ).execute()
                label_id = created_label['id']

            # Add label to message
            self.service.users().messages().modify(
                userId='me',
                id=message_id,
                body={'addLabelIds': [label_id]}
            ).execute()

            return True

        except Exception as e:
            print(f"Error adding label: {e}")
            return False
