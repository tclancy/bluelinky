# Fuel Monitor Deployment Guide

This deployment uses Docker to create a completely self-contained fuel monitoring system with no dependency leakage into the host system.

## Prerequisites

On your Linux server, you only need:
- Docker
- docker-compose (optional, but recommended)

That's it! Everything else (Node.js, npm packages, cron) runs inside the container.

## Deployed Instance (plexpi)

**Current deployment:** Running on plexpi.local (192.168.68.54)

- Vehicle: 2020 Santa Fe
- Alert Backend: T-Mobile Email-to-SMS
- Schedule: Every hour at :00
- SSH alias: `plexclaude`

### Quick Reference Commands

**View logs:**
```bash
ssh plexclaude "docker logs -f bluelinky-fuel-monitor"
```

**View cron execution logs:**
```bash
ssh plexclaude "docker exec bluelinky-fuel-monitor cat /var/log/fuel-monitor/cron.log"
```

**Manual test run:**
```bash
ssh plexclaude "docker exec bluelinky-fuel-monitor sh -c 'cd /app && export \$(grep -v \"^#\" .env | xargs) && npx tsx monitor-fuel.ts'"
```

**Restart container:**
```bash
ssh plexclaude "cd ~/fuelbot/deployment && docker compose restart"
```

**Rebuild and restart:**
```bash
ssh plexclaude "cd ~/fuelbot/deployment && docker compose down && docker compose up -d --build"
```

## Initial Setup

### 1. Clone Repository to Server

Clone the fuelbot repository to your Linux server:

```bash
# On the server
cd ~
git clone git@github.com:tclancy/bluelinky.git fuelbot
cd fuelbot
```

Alternatively, if you don't have SSH access to GitHub from the server:

```bash
# From your local machine
scp -r /path/to/fuelbot user@server:/home/user/fuelbot
# Then on the server, set up git:
cd ~/fuelbot
git init
git remote add origin git@github.com:tclancy/bluelinky.git
git fetch origin
git reset --hard origin/master
```

### 2. Create .env File

Create a `.env` file in the bluelinky directory with your credentials:

```bash
cd ~/fuelbot
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

# For production alerts - choose one backend:

# Option 1: AWS SNS (CHEAPEST - no phone number needed, $0.006/SMS)
ALERT_BACKEND=sns
AWS_SNS_PHONES=+15551234567,+15559876543
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key

# Option 2: T-Mobile Email-to-SMS (FREE but unreliable - may get blocked)
# ALERT_BACKEND=tmobile-email
# TMOBILE_PHONES=5551234567,5559876543
# EMAIL_FROM=youremail@gmail.com
# EMAIL_SMTP_HOST=smtp.gmail.com
# EMAIL_SMTP_PORT=587
# EMAIL_SMTP_USER=youremail@gmail.com
# EMAIL_SMTP_PASSWORD=your_gmail_app_password
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
0 */2 * * * cd /app && export $(grep -v '^#' .env | xargs) && npx tsx monitor-fuel.ts >> /var/log/fuel-monitor/cron.log 2>&1

# Run twice daily (6am and 6pm UTC)
0 6,18 * * * cd /app && export $(grep -v '^#' .env | xargs) && npx tsx monitor-fuel.ts >> /var/log/fuel-monitor/cron.log 2>&1

# Run every 30 minutes
*/30 * * * * cd /app && export $(grep -v '^#' .env | xargs) && npx tsx monitor-fuel.ts >> /var/log/fuel-monitor/cron.log 2>&1
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
docker exec bluelinky-fuel-monitor /bin/bash -c "cd /app && export \$(grep -v '^#' .env | xargs) && npx tsx monitor-fuel.ts"

# Force a test alert
docker exec bluelinky-fuel-monitor /bin/bash -c "cd /app && export \$(grep -v '^#' .env | xargs) TEST_ALERT=low && npx tsx monitor-fuel.ts"
```

## Updating the Code

When code changes are committed to the repository:

```bash
# On the server
cd ~/fuelbot
git pull origin master

# Rebuild and restart the container
cd deployment
docker compose down
docker compose up -d --build
```

**Note:** The `.env` file is gitignored, so your credentials are safe during updates.

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

## AWS SNS Setup (Recommended)

AWS SNS is the most cost-effective option with no monthly fees and no phone number needed.

### Step 1: Create AWS Account

If you don't have one already, create a free AWS account at https://aws.amazon.com

### Step 2: Create IAM User for SNS

1. Go to IAM Console: https://console.aws.amazon.com/iam/
2. Click "Users" → "Create user"
3. User name: `fuel-monitor-sns`
4. Click "Next"
5. Select "Attach policies directly"
6. Search for and select: `AmazonSNSFullAccess`
7. Click "Next" → "Create user"

### Step 3: Create Access Key

1. Click on the newly created user
2. Go to "Security credentials" tab
3. Click "Create access key"
4. Select "Application running outside AWS"
5. Click "Next" → "Create access key"
6. **Copy the Access Key ID and Secret Access Key** (you won't see the secret again!)

### Step 4: Configure in .env

Add these to your `.env` file:

```env
ALERT_BACKEND=sns
AWS_SNS_PHONES=+15551234567  # Your phone number with +1 country code
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

### Step 5: Move Out of SNS Sandbox (Optional)

By default, AWS SNS starts in sandbox mode and can only send to verified phone numbers.

**To verify a number in sandbox mode:**
1. Go to SNS Console: https://console.aws.amazon.com/sns/
2. Click "Text messaging (SMS)" → "Sandbox destination phone numbers"
3. Click "Add phone number"
4. Enter your phone number and verify it

**To send to ANY number (production mode):**
1. In SNS Console, go to "Text messaging (SMS)" → "Account information"
2. Click "Exit sandbox"
3. Fill out the request form (usually approved in 24 hours)
4. Once approved, you can send to any phone number

### Cost Breakdown

- **Free tier:** 1000 SMS/month for first 12 months
- **After free tier:** ~$0.00645 per SMS in US
- **Monthly cost for this project:** ~$0.05/month (checking hourly = ~8 alerts/month worst case)

Compare to T-Mobile email gateway: Free but unreliable (may be blocked by carrier)

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
