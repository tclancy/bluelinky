# Dockerfile for Bluelinky Fuel Monitor
# Completely self-contained deployment with no host dependencies

FROM node:20-slim

# Install cron
RUN apt-get update && \
    apt-get install -y cron && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --production=false

# Copy application code
COPY . .

# Build TypeScript (if needed)
RUN npm run build || true

# Copy cron configuration
COPY deployment/crontab /etc/cron.d/fuel-monitor

# Give execution rights on the cron job
RUN chmod 0644 /etc/cron.d/fuel-monitor

# Apply cron job
RUN crontab /etc/cron.d/fuel-monitor

# Create log directory
RUN mkdir -p /var/log/fuel-monitor

# Create entrypoint script
COPY deployment/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run the entrypoint script
CMD ["/entrypoint.sh"]
