# Fuel Monitor Deployment Guide

This deployment uses Docker to create a completely self-contained fuel monitoring system with no dependency leakage into the host system.

## Prerequisites

On your Linux server, you only need:
- Docker
- docker-compose (optional, but recommended)

That's it! Everything else (Node.js, npm packages, cron) runs inside the container.

## Initial Setup

### 1. Copy Files to Server

Copy the entire bluelinky directory to your Linux server:

```bash
# From your local machine
scp -r /path/to/bluelinky user@server:/home/user/bluelinky
```

Or clone from git:

```bash
# On the server
git clone <your-repo-url> bluelinky
cd bluelinky
git checkout claude/bluelink-fuel-setup
```

### 2. Create .env File

Create a `.env` file in the bluelinky directory with your credentials:

```bash
cd /home/user/bluelinky
cp .env.example .env
nano .env  # or vim, or any editor
```

Fill in your actual credentials:

```env
BLUELINK_USERNAME=your_email@example.com
BLUELINK_PASSWORD=your_password
BLUELINK_PIN=1234
BLUELINK_BRAND=hyundai
BLUELINK_REGION=US

# For production SMS alerts
ALERT_BACKEND=sms

# Twilio configuration
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_PHONE=+15551234567
TWILIO_TO_PHONE=+15559876543,+15558675309
```

### 3. Build and Start the Container

Using docker-compose (recommended):

```bash
cd deployment
docker-compose up -d
```

Or using docker directly:

```bash
docker build -t bluelinky-fuel-monitor .
docker run -d \
  --name bluelinky-fuel-monitor \
  --restart unless-stopped \
  -v "$(pwd)/.env:/app/.env:ro" \
  -v fuel-state:/app \
  bluelinky-fuel-monitor
```

## Monitoring and Logs

### View Container Status

```bash
docker ps | grep bluelinky
```

### View Real-Time Logs

```bash
docker logs -f bluelinky-fuel-monitor
```

### View Cron Logs Only

```bash
docker exec bluelinky-fuel-monitor tail -f /var/log/fuel-monitor/cron.log
```

### Check Alert State

```bash
docker exec bluelinky-fuel-monitor cat /app/.fuel-alert-state.json
```

## Schedule Configuration

By default, the fuel check runs **every hour at :00** (e.g., 1:00, 2:00, 3:00).

To change the schedule, edit `deployment/crontab`:

```bash
# Run every 2 hours
0 */2 * * * cd /app && export $(grep -v '^#' .env | xargs) && /usr/local/bin/node /usr/local/bin/tsx monitor-fuel.ts >> /var/log/fuel-monitor/cron.log 2>&1

# Run twice daily (6am and 6pm UTC)
0 6,18 * * * cd /app && export $(grep -v '^#' .env | xargs) && /usr/local/bin/node /usr/local/bin/tsx monitor-fuel.ts >> /var/log/fuel-monitor/cron.log 2>&1

# Run every 30 minutes
*/30 * * * * cd /app && export $(grep -v '^#' .env | xargs) && /usr/local/bin/node /usr/local/bin/tsx monitor-fuel.ts >> /var/log/fuel-monitor/cron.log 2>&1
```

After changing the crontab, rebuild and restart:

```bash
docker-compose down
docker-compose up -d --build
```

## Testing

### Test Before Deploying

Test the monitoring script locally first:

```bash
# Test with console backend (no SMS)
ALERT_BACKEND=console npm run monitor-fuel

# Test alert (low fuel)
TEST_ALERT=low npm run monitor-fuel

# Test critical alert
TEST_ALERT=critical npm run monitor-fuel
```

### Test in Container

Once deployed, you can manually trigger a check:

```bash
# Run a manual check
docker exec bluelinky-fuel-monitor /bin/bash -c "cd /app && export \$(grep -v '^#' .env | xargs) && /usr/local/bin/node /usr/local/bin/tsx monitor-fuel.ts"

# Force a test alert
docker exec bluelinky-fuel-monitor /bin/bash -c "cd /app && export \$(grep -v '^#' .env | xargs) TEST_ALERT=low && /usr/local/bin/node /usr/local/bin/tsx monitor-fuel.ts"
```

## Updating the Code

If you make changes to the code:

```bash
cd /home/user/bluelinky
git pull  # or copy new files

# Rebuild and restart
cd deployment
docker-compose down
docker-compose up -d --build
```

## Stopping the Monitor

Temporary stop (preserves state):

```bash
docker-compose stop
```

Permanent removal (preserves state volume):

```bash
docker-compose down
```

Complete removal (destroys state):

```bash
docker-compose down -v
```

## Troubleshooting

### Container won't start

Check logs:
```bash
docker logs bluelinky-fuel-monitor
```

Common issues:
- Missing .env file
- Invalid credentials in .env
- Bluelink API is down

### No alerts being sent

1. Check if monitoring is running:
   ```bash
   docker exec bluelinky-fuel-monitor cat /var/log/fuel-monitor/cron.log
   ```

2. Check alert state:
   ```bash
   docker exec bluelinky-fuel-monitor cat /app/.fuel-alert-state.json
   ```

3. Verify cron is running:
   ```bash
   docker exec bluelinky-fuel-monitor ps aux | grep cron
   ```

### State file reset

If you want to reset alerts (force them to send again):

```bash
docker exec bluelinky-fuel-monitor /bin/bash -c 'echo "{\"alert50Sent\":false,\"alert15Sent\":false,\"lastRange\":0,\"lastCheck\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}" > /app/.fuel-alert-state.json'
```

## Security Notes

- The `.env` file contains sensitive credentials - keep it secure
- The container runs as root (needed for cron) but is isolated from the host
- No ports are exposed - the container only makes outbound API calls
- State file persists in a Docker volume, not on the host filesystem
- All timestamps use UTC to avoid timezone confusion

## System Requirements

**Host system needs:**
- Docker Engine 20.10+
- docker-compose 1.29+ (optional)
- ~500MB disk space for container and images
- Internet connection for Bluelink API and Twilio API

**The container provides:**
- Node.js 20
- All npm dependencies
- cron daemon
- All TypeScript files
- Isolated filesystem

No pollution of the host system!
