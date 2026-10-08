/**
 * Alert Backend - ntfy.sh push notifications
 */

export interface FuelAlertMessage {
  kind: 'fuel';
  severity: 'low' | 'critical';
  range: number;
  vehicleName: string;
  timestamp: Date;
}

export interface TpmsAlertMessage {
  kind: 'tpms';
  severity: 'warn' | 'critical'; // warn = 1-2 wheels; critical = 3-4 or all flag
  wheels: string[]; // e.g. ['frontLeft', 'rearRight']
  vehicleName: string;
  timestamp: Date;
}

export type AlertMessage = FuelAlertMessage | TpmsAlertMessage;

/** @deprecated Use FuelAlertMessage directly. */
export type LegacyAlertMessage = FuelAlertMessage;

export interface AlertBackend {
  sendAlert(message: AlertMessage): Promise<void>;
  getName(): string;
}

/** Format a wheel list like ['frontLeft', 'rearRight'] → "front-left, rear-right" */
function formatWheels(wheels: string[]): string {
  return wheels.map(w => w.replace(/([A-Z])/g, '-$1').toLowerCase()).join(', ');
}

/**
 * Refuse a message whose `kind` is neither of the two we know.
 *
 * The `never` parameter is the load-bearing part: it makes a backend that
 * forgets to handle a newly added member of `AlertMessage` a *compile* error at
 * the call site, rather than a message that silently takes the last branch. The
 * runtime throw covers the JS caller the type system cannot reach -- which is
 * exactly what #19 was, three `sendAlert` calls with no `kind` at all taking the
 * TPMS arm and then dying inside `formatWheels(undefined)`.
 */
function refuseUnknownAlertKind(message: never): never {
  const kind = (message as { kind?: unknown }).kind;
  throw new Error(`Unknown alert kind: ${kind === undefined ? '(missing)' : String(kind)}`);
}

/**
 * Console Backend - for development/testing
 */
export class ConsoleAlertBackend implements AlertBackend {
  getName(): string {
    return 'Console Logger';
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    if (message.kind === 'fuel') {
      const title = message.severity === 'critical' ? 'CRITICAL FUEL ALERT' : 'Low Fuel Warning';
      console.log(`\n[ALERT] ${title}`);
      console.log(`Vehicle: ${message.vehicleName}`);
      console.log(`Range: ${message.range} miles remaining`);
      console.log(`Time: ${message.timestamp.toISOString()}\n`);
    } else if (message.kind === 'tpms') {
      const title =
        message.severity === 'critical' ? 'CRITICAL: TPMS Warning' : 'Tire Pressure Warning';
      console.log(`\n[ALERT] ${title}`);
      console.log(`Vehicle: ${message.vehicleName}`);
      console.log(`Wheels: ${formatWheels(message.wheels)}`);
      console.log(`Time: ${message.timestamp.toISOString()}\n`);
    } else {
      refuseUnknownAlertKind(message);
    }
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
    let title: string;
    let body: string;
    let priority: string;

    if (message.kind === 'fuel') {
      const isCritical = message.severity === 'critical';
      title = isCritical ? 'CRITICAL: Get gas now!' : 'Low Fuel Warning';
      body = `${message.vehicleName} has ${message.range} miles of range remaining.`;
      priority = isCritical ? '5' : '4';
    } else if (message.kind === 'tpms') {
      const isCritical = message.severity === 'critical';
      title = isCritical ? 'CRITICAL: Tire Pressure Warning' : 'Tire Pressure Warning';
      body = `${message.vehicleName}: low pressure on ${formatWheels(message.wheels)}.`;
      priority = isCritical ? '5' : '3';
    } else {
      refuseUnknownAlertKind(message);
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
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
