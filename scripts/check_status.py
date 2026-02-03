#!/usr/bin/env python3
"""
Quick script to check Hey Spotless status
"""

import sys
sys.path.insert(0, '/home/user/Heyspotless')

from datetime import datetime
from src.email_monitor import EmailMonitor
from src.calendar_manager import CalendarManager


def main():
    print("Hey Spotless - Status Check")
    print("="*50)
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    # Check emails
    print("Recent Emails (24h):")
    print("-"*50)
    email_monitor = EmailMonitor()
    messages = email_monitor.get_recent_messages(hours=24, unread_only=False)

    if messages:
        for msg in messages[:5]:
            print(f"\n  Subject: {msg['subject']}")
            print(f"  From: {msg['from']}")
            print(f"  Date: {msg['date']}")
            print(f"  Snippet: {msg['snippet'][:80]}...")
    else:
        print("  No recent messages")

    # Check calendar
    print("\n\nUpcoming Appointments:")
    print("-"*50)
    calendar = CalendarManager()
    appointments = calendar.get_cleaning_appointments()

    if appointments:
        for apt in appointments[:5]:
            print(f"\n  {apt['summary']}")
            print(f"  Start: {apt['start']}")
            print(f"  Location: {apt.get('location', 'N/A')}")
    else:
        print("  No upcoming appointments")

    print("\n" + "="*50)


if __name__ == '__main__':
    main()
