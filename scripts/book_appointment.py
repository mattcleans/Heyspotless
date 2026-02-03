#!/usr/bin/env python3
"""
Quick script to manually book an appointment
"""

import sys
sys.path.insert(0, '/home/user/Heyspotless')

from src.booking_manager import BookingManager


def main():
    print("Hey Spotless - Manual Booking Request")
    print("="*50)

    booking = BookingManager()

    print("\nFinding available slots...")
    result = booking.process_booking_request(
        duration_minutes=120,
        max_slots=5
    )

    if result['success']:
        print("\n✓ Booking request sent successfully!")
        print("\nSuggested slots:")
        for slot in result['suggested_slots']:
            print(f"  • {slot['date']} ({slot['day_of_week']}) at {slot['time']}")

        print(f"\nEmail sent to: {result.get('email_body')[:100]}...")
    else:
        print(f"\n✗ Booking failed: {result['message']}")


if __name__ == '__main__':
    main()
