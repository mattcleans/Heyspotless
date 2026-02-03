#!/usr/bin/env python3
"""
Hey Spotless Automation - Main Entry Point

This script provides the main interface for running the Hey Spotless automation system.
"""

import sys
import argparse
from datetime import datetime
from typing import Dict

from src.automation import HeySpotlessAutomation
from src.config import Config


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Hey Spotless Automation - Automate cleaning service communications"
    )

    parser.add_argument(
        '--mode',
        choices=['continuous', 'once', 'summary'],
        default='continuous',
        help='Run mode: continuous monitoring, single cycle, or summary only'
    )

    parser.add_argument(
        '--interval',
        type=int,
        help=f'Check interval in minutes (default: {Config.CHECK_INTERVAL_MINUTES})'
    )

    parser.add_argument(
        '--test',
        action='store_true',
        help='Test configuration and connectivity'
    )

    args = parser.parse_args()

    # Validate configuration
    try:
        Config.validate()
        print("✓ Configuration validated")
    except ValueError as e:
        print(f"✗ Configuration error: {e}")
        return 1

    # Initialize automation
    automation = HeySpotlessAutomation()

    # Test mode
    if args.test:
        print("\nTesting system connectivity...")
        test_system(automation)
        return 0

    # Run based on mode
    if args.mode == 'summary':
        print("\nGenerating summary...")
        summary = automation.generate_summary()
        print_summary(summary)

    elif args.mode == 'once':
        print("\nRunning single automation cycle...")
        automation.run_cycle()

    elif args.mode == 'continuous':
        automation.run_continuous(interval_minutes=args.interval)

    return 0


def test_system(automation: HeySpotlessAutomation):
    """Test system connectivity and configuration"""
    print("\n1. Testing email connectivity...")
    try:
        messages = automation.email_monitor.get_recent_messages(hours=1)
        print(f"   ✓ Email connected - Found {len(messages)} recent message(s)")
    except Exception as e:
        print(f"   ✗ Email error: {e}")

    print("\n2. Testing calendar connectivity...")
    try:
        events = automation.calendar.get_upcoming_events(days_ahead=7)
        print(f"   ✓ Calendar connected - Found {len(events)} upcoming event(s)")
    except Exception as e:
        print(f"   ✗ Calendar error: {e}")

    print("\n3. Testing Claude API...")
    try:
        test_email = {
            'subject': 'Test',
            'from': 'test@example.com',
            'body': 'This is a test message'
        }
        analysis = automation.assistant.analyze_email(test_email)
        print(f"   ✓ Claude API connected - Intent: {analysis.get('intent', 'unknown')}")
    except Exception as e:
        print(f"   ✗ Claude API error: {e}")

    print("\n4. Testing notification system...")
    try:
        result = automation.notifier.send_notification(
            "Test Notification",
            "This is a test notification from Hey Spotless Automation",
            urgency="low"
        )
        print(f"   ✓ Notifications configured - Channels: {', '.join(result.keys())}")
    except Exception as e:
        print(f"   ✗ Notification error: {e}")


def print_summary(summary: Dict):
    """Print automation summary"""
    print("\n" + "="*60)
    print(f"Hey Spotless Summary - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)

    # Upcoming appointments
    appointments = summary.get('upcoming_appointments', [])
    print(f"\nUpcoming Appointments: {len(appointments)}")
    for apt in appointments[:5]:
        print(f"  • {apt['summary']}")
        print(f"    {apt['start']}")

    # Recent emails
    emails = summary.get('new_emails', [])
    print(f"\nRecent Emails (24h): {len(emails)}")
    for email in emails[:5]:
        print(f"  • {email['subject']}")
        print(f"    From: {email['from']}")

    print("\n" + "="*60)


if __name__ == '__main__':
    sys.exit(main())
