# Hey Spotless Automation

Intelligent automation system for managing Hey Spotless cleaning service communications using Claude AI, Gmail API, and Google Calendar API.

## Features

- **Email Monitoring**: Automatically monitors your Gmail for Hey Spotless communications
- **Intelligent Processing**: Uses Claude AI to analyze emails and determine appropriate actions
- **Calendar Integration**: Manages cleaning appointments in Google Calendar
- **Smart Booking**: Finds available time slots and books appointments automatically (optional)
- **Multi-Channel Notifications**: Alerts via email, SMS (Twilio), or webhooks
- **Routine Correspondence**: Handles common inquiries with AI-generated responses

## System Capabilities

### Email Analysis
- Automatically categorizes emails (appointment confirmations, rescheduling requests, payment reminders, etc.)
- Extracts key information (dates, times, locations, costs)
- Determines urgency and required actions
- Generates appropriate responses

### Calendar Management
- Syncs appointments with Google Calendar
- Checks for scheduling conflicts
- Finds available time slots based on your preferences
- Sends reminders for upcoming cleanings

### Booking Automation
- Identifies when new appointments are needed
- Suggests available time slots matching your preferences
- Sends booking requests via email
- Confirms appointments automatically (optional)

### Notifications
- Real-time alerts for important emails
- Upcoming cleaning reminders
- Action required notifications
- Daily summary reports

## Prerequisites

- Python 3.8 or higher
- Gmail account with API access
- Google Calendar API access
- Anthropic API key (for Claude)
- Optional: Twilio account (for SMS notifications)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/mattcleans/Heyspotless.git
cd Heyspotless
```

### 2. Install Dependencies

```bash
# Create virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install requirements
pip install -r requirements.txt
```

### 3. Set Up Google API Credentials

#### Enable Gmail and Calendar APIs:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the following APIs:
   - Gmail API
   - Google Calendar API
4. Go to "Credentials" → "Create Credentials" → "OAuth client ID"
5. Choose "Desktop app" as application type
6. Download the credentials file and save as `credentials.json` in the project root

### 4. Get Anthropic API Key

1. Sign up at [Anthropic Console](https://console.anthropic.com/)
2. Navigate to API Keys section
3. Create a new API key
4. Copy the key for configuration

### 5. Configure Environment Variables

```bash
# Copy example configuration
cp .env.example .env

# Edit .env with your settings
nano .env  # or use your preferred editor
```

Required configuration:
```bash
# Claude AI
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Google APIs (credentials.json should be in project root)
GOOGLE_CREDENTIALS_PATH=credentials.json
GOOGLE_TOKEN_PATH=token.json

# Hey Spotless
HEYSPOTLESS_EMAIL=support@heyspotless.com
HEYSPOTLESS_DOMAIN=heyspotless.com

# Notifications
NOTIFICATION_EMAIL=your_email@example.com

# Monitoring
CHECK_INTERVAL_MINUTES=30
TIMEZONE=America/New_York

# Booking Preferences
PREFERRED_BOOKING_DAYS=Monday,Wednesday,Friday
PREFERRED_BOOKING_HOURS=9-17
AUTO_BOOK_ENABLED=false
```

Optional SMS notifications (Twilio):
```bash
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+1234567890
TWILIO_TO_NUMBER=+1234567890
```

### 6. First Run - Authenticate with Google

```bash
# Test the setup and authenticate
python3 main.py --test
```

This will:
1. Validate your configuration
2. Open a browser window for Google OAuth authentication
3. Request permissions for Gmail and Calendar access
4. Save authentication tokens for future use

## Usage

### Continuous Monitoring (Recommended)

Run the automation system continuously:

```bash
python3 main.py --mode continuous
```

This will:
- Check for new emails every 30 minutes (configurable)
- Process Hey Spotless communications automatically
- Send notifications for important items
- Monitor upcoming appointments

### Single Cycle

Run one automation cycle:

```bash
python3 main.py --mode once
```

### View Summary

Get a summary of current status:

```bash
python3 main.py --mode summary
```

### Custom Check Interval

Override the default check interval:

```bash
python3 main.py --mode continuous --interval 15
```

## Utility Scripts

### Manual Booking Request

```bash
python3 scripts/book_appointment.py
```

Manually trigger a booking request with your preferred time slots.

### Check Status

```bash
python3 scripts/check_status.py
```

View recent emails and upcoming appointments.

## How It Works

### Email Processing Flow

1. **Monitor**: System checks Gmail for unread messages from Hey Spotless
2. **Analyze**: Claude AI analyzes each email to determine:
   - Intent (confirmation, rescheduling, inquiry, etc.)
   - Key information (dates, times, important details)
   - Required action
   - Urgency level
3. **Act**: Based on analysis:
   - Add appointments to calendar
   - Send automatic responses (for simple inquiries)
   - Generate notifications (for items requiring attention)
   - Request booking for new appointments
4. **Track**: Mark emails as processed and maintain audit trail

### Calendar Integration

- Automatically adds confirmed appointments to Google Calendar
- Checks for scheduling conflicts before confirming
- Finds available time slots based on your preferences:
  - Preferred days of week
  - Preferred time windows
  - Appointment duration
- Sends reminders before upcoming cleanings

### Intelligent Booking

When auto-booking is enabled:
1. System monitors for gaps in cleaning schedule (30+ days without appointment)
2. Searches calendar for available time slots matching preferences
3. Generates professional booking request using Claude AI
4. Sends email to Hey Spotless with 3-5 suggested times
5. Processes confirmation and adds to calendar

### Notifications

The system sends notifications for:
- **High urgency**: Email + SMS + Webhook
  - Payment reminders
  - Schedule conflicts
  - Action required items
- **Medium urgency**: Email only
  - New appointment confirmations
  - Upcoming cleaning reminders (24h notice)
  - Rescheduling requests
- **Low urgency**: Daily summary
  - Activity overview
  - Pending items

## Configuration Options

### Booking Preferences

```bash
# Days of week for appointments (comma-separated)
PREFERRED_BOOKING_DAYS=Monday,Wednesday,Friday

# Time window in 24-hour format (start-end)
PREFERRED_BOOKING_HOURS=9-17

# Enable automatic booking requests
AUTO_BOOK_ENABLED=false  # Set to true for full automation
```

### Monitoring

```bash
# How often to check for new emails (minutes)
CHECK_INTERVAL_MINUTES=30

# Your local timezone
TIMEZONE=America/New_York
```

### Notifications

Configure which notification channels to use by providing the respective credentials in `.env`.

## Security & Privacy

- **API Keys**: Never commit `.env` or credentials files to version control
- **OAuth Tokens**: Stored locally in `token.json` (gitignored)
- **Permissions**: Only requests necessary Gmail and Calendar permissions
- **Data**: All data stays on your machine and between your APIs
- **Email Access**: Read-only for monitoring, send-only for responses

## Troubleshooting

### "Configuration error: ANTHROPIC_API_KEY is required"
- Ensure `.env` file exists and contains your API key
- Check that API key is valid

### "Google credentials file not found"
- Download OAuth credentials from Google Cloud Console
- Save as `credentials.json` in project root
- Run `python3 main.py --test` to authenticate

### "Error fetching messages: insufficient permissions"
- Delete `token.json`
- Re-run authentication: `python3 main.py --test`
- Ensure all requested permissions are granted

### Email/Calendar not updating
- Check that `credentials.json` has correct scopes
- Verify timezone settings in `.env`
- Review logs for specific error messages

## Development

### Project Structure

```
Heyspotless/
├── main.py                 # Main entry point
├── requirements.txt        # Python dependencies
├── setup.py               # Package setup
├── .env.example           # Example configuration
├── .gitignore            # Git ignore rules
├── README.md             # This file
├── src/
│   ├── __init__.py
│   ├── config.py          # Configuration management
│   ├── email_monitor.py   # Gmail integration
│   ├── calendar_manager.py # Google Calendar integration
│   ├── claude_assistant.py # Claude AI integration
│   ├── booking_manager.py  # Appointment booking logic
│   ├── notifier.py        # Notification system
│   └── automation.py      # Main orchestration
└── scripts/
    ├── book_appointment.py # Manual booking utility
    └── check_status.py     # Status check utility
```

### Extending the System

The modular design makes it easy to extend:

- Add new notification channels in `notifier.py`
- Customize email analysis prompts in `claude_assistant.py`
- Modify booking logic in `booking_manager.py`
- Add new automation workflows in `automation.py`

## Contributing

This is a personal automation tool, but suggestions and improvements are welcome!

## License

MIT License - feel free to use and modify for your own needs.

## Disclaimer

This is an automation tool for personal use. Always review important communications and decisions made by the system. The system is designed to assist, not replace, human judgment.

## Support

For issues or questions:
- Check the troubleshooting section above
- Review error logs for specific issues
- Ensure all prerequisites are met
- Verify API credentials and permissions

---

Built with Claude AI, Gmail API, Google Calendar API, and Python.
