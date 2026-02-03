"""
Claude AI integration for intelligent email processing and response generation
"""

import json
from typing import Dict, List, Optional
from datetime import datetime

from anthropic import Anthropic

from .config import Config


class ClaudeAssistant:
    """Claude AI assistant for processing Hey Spotless communications"""

    def __init__(self):
        self.client = Anthropic(api_key=Config.ANTHROPIC_API_KEY)
        self.model = "claude-3-5-sonnet-20241022"

    def analyze_email(self, email_data: Dict) -> Dict:
        """
        Analyze an email from Hey Spotless using Claude

        Args:
            email_data: Email dictionary with subject, body, etc.

        Returns:
            Analysis including intent, action items, and suggested response
        """
        prompt = f"""Analyze this email from Hey Spotless cleaning service and extract key information.

Email Subject: {email_data['subject']}
Email From: {email_data['from']}
Email Body:
{email_data['body']}

Please analyze this email and provide a structured response with:
1. Intent: What is the main purpose of this email? (e.g., appointment_confirmation, rescheduling_request, payment_reminder, service_update, etc.)
2. Key Information: Extract any important details (dates, times, addresses, costs, etc.)
3. Action Required: What action, if any, is needed from the recipient?
4. Urgency: Rate the urgency (low, medium, high)
5. Suggested Response: If a response is needed, provide a draft response

Format your response as JSON with these keys: intent, key_information, action_required, urgency, suggested_response"""

        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=2000,
                messages=[{
                    "role": "user",
                    "content": prompt
                }]
            )

            response_text = message.content[0].text

            # Try to parse JSON response
            try:
                # Find JSON in response
                start_idx = response_text.find('{')
                end_idx = response_text.rfind('}') + 1
                if start_idx != -1 and end_idx > start_idx:
                    json_str = response_text[start_idx:end_idx]
                    analysis = json.loads(json_str)
                else:
                    # Fallback if no JSON found
                    analysis = {
                        'intent': 'unknown',
                        'key_information': {},
                        'action_required': response_text,
                        'urgency': 'medium',
                        'suggested_response': ''
                    }
            except json.JSONDecodeError:
                # Fallback parsing
                analysis = {
                    'intent': 'unknown',
                    'key_information': {},
                    'action_required': response_text,
                    'urgency': 'medium',
                    'suggested_response': ''
                }

            return analysis

        except Exception as e:
            print(f"Error analyzing email with Claude: {e}")
            return {
                'intent': 'error',
                'key_information': {},
                'action_required': f'Error analyzing email: {e}',
                'urgency': 'low',
                'suggested_response': ''
            }

    def generate_booking_request(
        self,
        available_slots: List[Dict],
        preferences: Optional[Dict] = None
    ) -> str:
        """
        Generate a booking request email using Claude

        Args:
            available_slots: List of available time slots
            preferences: User preferences for the booking

        Returns:
            Email body for booking request
        """
        slots_text = "\n".join([
            f"- {slot['date']} ({slot['day_of_week']}) at {slot['time']}"
            for slot in available_slots[:5]  # Top 5 slots
        ])

        preferences_text = ""
        if preferences:
            preferences_text = f"\nPreferences: {json.dumps(preferences, indent=2)}"

        prompt = f"""Write a professional email to Hey Spotless requesting a cleaning appointment.

Available time slots:
{slots_text}

{preferences_text}

The email should:
1. Be polite and professional
2. Mention 2-3 preferred time slots
3. Be concise (3-4 sentences)
4. Include a friendly closing

Just provide the email body, no subject line needed."""

        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=500,
                messages=[{
                    "role": "user",
                    "content": prompt
                }]
            )

            return message.content[0].text.strip()

        except Exception as e:
            print(f"Error generating booking request: {e}")
            return f"Error generating email: {e}"

    def generate_response(
        self,
        email_data: Dict,
        context: Optional[str] = None
    ) -> str:
        """
        Generate an appropriate email response

        Args:
            email_data: Original email data
            context: Additional context for the response

        Returns:
            Email response body
        """
        context_text = f"\nAdditional Context: {context}" if context else ""

        prompt = f"""Generate a professional email response to this message from Hey Spotless.

Original Email:
Subject: {email_data['subject']}
From: {email_data['from']}
Body:
{email_data['body']}
{context_text}

Write a professional, friendly response that:
1. Acknowledges the email
2. Addresses any questions or requests
3. Is concise and clear
4. Uses a warm, professional tone

Just provide the email body, no subject line needed."""

        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=500,
                messages=[{
                    "role": "user",
                    "content": prompt
                }]
            )

            return message.content[0].text.strip()

        except Exception as e:
            print(f"Error generating response: {e}")
            return f"Error generating response: {e}"

    def should_auto_respond(self, analysis: Dict) -> bool:
        """
        Determine if an email should receive an automatic response

        Args:
            analysis: Email analysis from analyze_email()

        Returns:
            True if should auto-respond
        """
        # Define intents that should get auto-responses
        auto_respond_intents = [
            'appointment_confirmation',
            'rescheduling_request',
            'availability_inquiry',
            'service_question'
        ]

        # Don't auto-respond to high urgency items
        if analysis.get('urgency') == 'high':
            return False

        return analysis.get('intent') in auto_respond_intents

    def extract_appointment_details(self, email_body: str) -> Optional[Dict]:
        """
        Extract appointment details from email body

        Args:
            email_body: Email content

        Returns:
            Dictionary with appointment details or None
        """
        prompt = f"""Extract appointment details from this email if present.

Email:
{email_body}

If the email contains appointment information, extract:
- date (in YYYY-MM-DD format)
- time (in HH:MM format, 24-hour)
- duration (in minutes)
- location/address
- service_type

Return as JSON with these keys. If no appointment details found, return null."""

        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=500,
                messages=[{
                    "role": "user",
                    "content": prompt
                }]
            )

            response_text = message.content[0].text.strip()

            # Try to parse JSON
            start_idx = response_text.find('{')
            end_idx = response_text.rfind('}') + 1

            if start_idx == -1 or end_idx <= start_idx:
                return None

            json_str = response_text[start_idx:end_idx]
            details = json.loads(json_str)

            return details if details else None

        except Exception as e:
            print(f"Error extracting appointment details: {e}")
            return None

    def summarize_conversation(self, emails: List[Dict]) -> str:
        """
        Summarize an email thread

        Args:
            emails: List of email messages in thread

        Returns:
            Summary of conversation
        """
        thread_text = "\n\n---\n\n".join([
            f"From: {email['from']}\nDate: {email['date']}\nSubject: {email['subject']}\n\n{email['body']}"
            for email in emails
        ])

        prompt = f"""Summarize this email conversation thread with Hey Spotless in 2-3 sentences.

Thread:
{thread_text}

Provide a concise summary focusing on:
1. The main topic/issue
2. Current status
3. Any pending actions"""

        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=300,
                messages=[{
                    "role": "user",
                    "content": prompt
                }]
            )

            return message.content[0].text.strip()

        except Exception as e:
            print(f"Error summarizing conversation: {e}")
            return "Error generating summary"
