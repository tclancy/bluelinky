/**
 * Alert Backend - ntfy.sh push notifications
 */

export interface AlertMessage {
  severity: 'low' | 'critical';
  range: number;
  vehicleName: string;
  timestamp: Date;
}

export interface AlertBackend {
  sendAlert(message: AlertMessage): Promise<void>;
  getName(): string;
}

/**
 * Console Backend - for development/testing
 */
export class ConsoleAlertBackend implements AlertBackend {
  getName(): string {
    return 'Console Logger';
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    const title = message.severity === 'critical' ? 'CRITICAL FUEL ALERT' : 'Low Fuel Warning';
    console.log(`\n[ALERT] ${title}`);
    console.log(`Vehicle: ${message.vehicleName}`);
    console.log(`Range: ${message.range} miles remaining`);
    console.log(`Time: ${message.timestamp.toISOString()}\n`);
  }
}

/**
 * ntfy Backend - sends push notifications via ntfy.sh
 *
 * Required environment variables:
 *   NTFY_URL      - full topic URL, e.g. https://notifications.example.com/fuelbot
 *   NTFY_USERNAME - ntfy username
 *   NTFY_PASSWORD - ntfy password
 */
export class NtfyAlertBackend implements AlertBackend {
  private url: string;
  private authHeader: string;

  constructor(url: string, username: string, password: string) {
    this.url = url;
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  getName(): string {
    return `ntfy (${this.url})`;
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    const isCritical = message.severity === 'critical';
    const title = isCritical ? 'CRITICAL: Get gas now!' : 'Low Fuel Warning';
    const body = `${message.vehicleName} has ${message.range} miles of range remaining.`;
    const priority = isCritical ? '5' : '4';

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'text/plain',
        'X-Title': title,
        'X-Priority': priority,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`ntfy request failed: ${response.status} ${response.statusText}`);
    }

    console.log(`✅ ntfy alert sent (${response.status})`);
  }
}

/**
 * Create alert backend from environment variables.
 * Set ALERT_BACKEND=ntfy for production; defaults to console.
 */
export function createAlertBackend(): AlertBackend {
  const backendType = process.env.ALERT_BACKEND || 'console';

  if (backendType.toLowerCase() === 'ntfy') {
    const url = process.env.NTFY_URL;
    const username = process.env.NTFY_USERNAME;
    const password = process.env.NTFY_PASSWORD;

    if (!url || !username || !password) {
      console.error('❌ Missing required ntfy environment variables:');
      if (!url) console.error('  - NTFY_URL');
      if (!username) console.error('  - NTFY_USERNAME');
      if (!password) console.error('  - NTFY_PASSWORD');
      throw new Error('Missing ntfy configuration');
    }

    return new NtfyAlertBackend(url, username, password);
  }

  return new ConsoleAlertBackend();
}
