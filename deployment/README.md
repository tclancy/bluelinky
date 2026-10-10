# Fuel Monitor Deployment Guide

This deployment uses Docker to create a completely self-contained fuel monitoring system with no dependency leakage into the host system.

## Prerequisites

On your Linux server, you only need:

- Docker Engine 20.10+
- The `docker compose` plugin (v2 or newer)

That's it! Everything else (Node.js, npm packages, cron) runs inside the
container.

**`docker compose`, never `docker-compose`.** plexpi has the plugin
(`v5.1.3`, measured 2026-10-08) and no hyphenated v1 binary at all, so every
`docker-compose ...` line is a `command not found` on the only box this is
deployed to.

## Deployed Instance (plexpi)

**Current deployment:** Running on plexpi.local (192.168.68.54)

- Vehicle: 2020 Santa Fe
- Alert Backend: T-Mobile Email-to-SMS
- Schedule: Every hour at :00
- SSH alias: `plexclaude`
- Checkout: `~/bluelinky` (i.e. `/home/pi/bluelinky`)
- Compose file: `~/bluelinky/docker-compose.yml` — the tracked one at the
  **checkout root**, not under `deployment/`. See "Where the compose file
  lives" below, including the **one-time switchover** needed the first time you
  pull this: until 2026-10-08 that path held an _untracked_ file, and `git pull`
  refuses to overwrite it.

### Quick Reference Commands

**View logs:**

```bash
ssh plexclaude "docker logs -f bluelinky-fuel-monitor"
```

**View cron execution logs:**

```bash
ssh plexclaude "docker exec bluelinky-fuel-monitor cat /var/log/fuel-monitor/cron.log"
```

**Manual test run** — same script the schedule runs (fuel + TPMS + history):

```bash
ssh plexclaude "docker exec bluelinky-fuel-monitor sh -c 'cd /app && export \$(grep -v \"^#\" .env | xargs) && npx tsx monitor.ts'"
```

The `export` is needed here and not in the crontab: `docker exec` does not read
`/etc/environment`. Swap `monitor.ts` for `monitor-fuel.ts` for the older
fuel-only check, which writes no history row.

**Restart container:**

```bash
ssh plexclaude "cd ~/bluelinky && docker compose restart"
```

`restart` re-runs the **image that is already built**. The Dockerfile `COPY . .`s
the source in, so after a `git pull` you want the rebuild below instead.

**Rebuild and restart:**

```bash
ssh plexclaude "cd ~/bluelinky && git pull --ff-only && docker compose up -d --build"
```

## Where the compose file lives (and why it matters)

The tracked compose file is `docker-compose.yml` at the **checkout root**, and
it is deliberately not under `deployment/`.

Compose derives the **project name** from the directory containing the compose
file, not from the directory you run the command in. The project name prefixes
every named volume. So:

| compose file                                | project      | state volume            |
| ------------------------------------------- | ------------ | ----------------------- |
| `~/bluelinky/docker-compose.yml`            | `bluelinky`  | `bluelinky_fuel-state`  |
| `~/bluelinky/deployment/docker-compose.yml` | `deployment` | `deployment_fuel-state` |

The second row holds even when you invoke it from the checkout root as
`docker compose -f deployment/docker-compose.yml up` — the `-f` path moves the
project directory with it. Measured on compose v5.1.2.

`bluelinky_fuel-state` is the volume the running container is mounted from; it
holds the alert state and the SQLite history (`checks`, `tpms_readings`,
`alerts`). Deploying from a `deployment/`-relative compose file does not merely
look different — it mounts a **different, empty** volume, so the car's history
and the "already alerted at 15%" state silently start over.

What "reaches for" means depends on whether the old container is still
there. Measured against a container already up under project `bluelinky`,
`docker compose up -d` from `deployment/` creates `deployment_fuel-state` and
then **fails** on the `container_name` conflict, leaving the running container
alone. Remove the container first and the same command comes up on the empty
volume with no complaint. So: loud and harmless, or silent and lossy, depending
on the order.

`docker volume ls` on plexpi lists **both** `bluelinky_fuel-state` and
`deployment_fuel-state` today, the second one empty — which is the first of
those two outcomes, fossilised. Something once ran compose from inside
`deployment/` here. The volume is measured; the exact command that made it is a
guess.

### One-time switchover (Tom, once, after this merges)

**`git pull` will refuse until the untracked file is gone.** The box runs from
an **untracked** `~/bluelinky/docker-compose.yml` at this very path, and this
change adds a tracked file there, so git aborts rather than overwrite it:

```
error: The following untracked working tree files would be overwritten by merge:
	docker-compose.yml
Please move or remove them before you merge.
```

So, once:

```bash
ssh plexclaude
cd ~/bluelinky
# Confirm the tracked file is the one you want (expect: context/.env paths and TZ)
git fetch origin && git diff origin/main:docker-compose.yml docker-compose.yml
mv docker-compose.yml /tmp/docker-compose.yml.untracked-backup
git pull --ff-only && docker compose up -d --build
# The container must still be in project `bluelinky`, on the volume with the history
docker inspect bluelinky-fuel-monitor \
  --format '{{index .Config.Labels "com.docker.compose.project"}}'
docker inspect bluelinky-fuel-monitor --format '{{range .Mounts}}{{println .Name}}{{end}}'
```

Expect `bluelinky` and `bluelinky_fuel-state`. If either reads `deployment`,
stop — the history is not mounted. Nothing in a repo can see an untracked file
on a remote box, so no test here can catch this; it is a one-time step.

Keeping the file at the root also means the deploy needs no `-f` flag and no
second `cd`: it runs from the directory you just `git pull`ed. There is nothing
to remember and nothing to get wrong.

`__tests__/deploy-docs.spec.ts` fails if the compose file moves back, if it
grows a `../` path, if a deploy command in this file names `deployment`, or if
a retired `fuelbot` checkout path reappears anywhere tracked.

## Initial Setup

### 1. Clone Repository to Server

Clone the repository to your Linux server. **Keep the default directory name**
— `bluelinky` — because the compose project name, and therefore the name of the
state volume, is derived from it (see "Where the compose file lives"):

```bash
# On the server
cd ~
git clone git@github.com:tclancy/bluelinky.git
cd bluelinky
```

Alternatively, if you don't have SSH access to GitHub from the server:

```bash
# From your local machine
scp -r /path/to/bluelinky user@server:/home/user/bluelinky
# Then on the server, set up git:
cd ~/bluelinky
git init
git remote add origin git@github.com:tclancy/bluelinky.git
git fetch origin
git reset --hard origin/main
```

### 2. Create .env File

Create a `.env` file in the bluelinky directory with your credentials:

```bash
cd ~/bluelinky
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

Using compose (recommended) — from the **checkout root**, where the compose
file lives:

```bash
cd ~/bluelinky
docker compose up -d --build
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

The scheduled job is `monitor.ts` — fuel **and** TPMS **and** the SQLite
history in one run. (`monitor-fuel.ts` is the older fuel-only script; it is
still there for a manual one-off, but nothing schedules it.) No `export` line
is needed: `entrypoint.sh` writes `/app/.env` into `/etc/environment`, which
cron reads.

```bash
# Run every 2 hours
0 */2 * * * cd /app && npx tsx monitor.ts >> /var/log/fuel-monitor/cron.log 2>&1

# Run twice daily (6am and 6pm UTC)
0 6,18 * * * cd /app && npx tsx monitor.ts >> /var/log/fuel-monitor/cron.log 2>&1

# Run every 30 minutes
*/30 * * * * cd /app && npx tsx monitor.ts >> /var/log/fuel-monitor/cron.log 2>&1
```

Times are **UTC**: the container sets `TZ=UTC` in `docker-compose.yml`.

After changing the crontab, rebuild and restart — the crontab is `COPY`d into
the image, so a plain `restart` keeps the old schedule:

```bash
cd ~/bluelinky
docker compose up -d --build
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
ssh plexclaude
cd ~/bluelinky && git pull --ff-only && docker compose up -d --build
```

Or in one line from your laptop:

```bash
ssh plexclaude 'cd ~/bluelinky && git pull --ff-only && docker compose up -d --build'
```

**`--build` is required, not optional.** The Dockerfile `COPY . .`s the source
into the image, so `docker compose restart` re-runs the old code with a
straight face. The named volume `bluelinky_fuel-state` survives the recreate,
which is what keeps the alert state and the history.

**Note:** The `.env` file is gitignored, so your credentials are safe during updates.

## Stopping the Monitor

All from `~/bluelinky`.

Temporary stop (preserves state):

```bash
docker compose stop
```

Permanent removal (preserves state volume):

```bash
docker compose down
```

Complete removal (destroys state):

```bash
docker compose down -v
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
- The `docker compose` plugin (v2+); the hyphenated v1 binary is not used
- ~500MB disk space for container and images
- Internet connection for Bluelink API and Twilio API

**The container provides:**

- Node.js 20
- All npm dependencies
- cron daemon
- All TypeScript files
- Isolated filesystem

No pollution of the host system!
