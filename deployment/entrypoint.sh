#!/bin/bash
# Entrypoint script for fuel monitor container
# Ensures .env file exists and starts cron daemon

set -e

echo "Starting Fuel Monitor Container..."

# Check if .env file exists
if [ ! -f /app/.env ]; then
    echo "ERROR: .env file not found at /app/.env"
    echo "Please create .env file with required credentials:"
    echo "  BLUELINK_USERNAME"
    echo "  BLUELINK_PASSWORD"
    echo "  BLUELINK_PIN"
    echo "  ALERT_BACKEND (console or sms)"
    echo ""
    echo "For SMS alerts, also add:"
    echo "  TWILIO_ACCOUNT_SID"
    echo "  TWILIO_AUTH_TOKEN"
    echo "  TWILIO_FROM_PHONE"
    echo "  TWILIO_TO_PHONE"
    exit 1
fi

echo "✓ Environment file found"

# Validate required environment variables
set -a; . /app/.env; set +a

if [ -z "$BLUELINK_USERNAME" ] || [ -z "$BLUELINK_PASSWORD" ] || [ -z "$BLUELINK_PIN" ]; then
    echo "ERROR: Missing required environment variables in .env"
    echo "Required: BLUELINK_USERNAME, BLUELINK_PASSWORD, BLUELINK_PIN"
    exit 1
fi

echo "✓ Required environment variables validated"

# Run an initial check to verify everything works
echo ""
echo "Running initial fuel check..."
cd /app
npx tsx monitor-fuel.ts

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Initial check successful"
else
    echo ""
    echo "✗ Initial check failed - please check your credentials"
    exit 1
fi

# Start cron in the foreground
echo ""
echo "Starting cron daemon..."
echo "Fuel monitoring will run every hour at :00"
echo "Logs: /var/log/fuel-monitor/cron.log"
echo ""

# Touch log file to ensure it exists
touch /var/log/fuel-monitor/cron.log

# Start cron and tail the log file
cron && tail -f /var/log/fuel-monitor/cron.log
