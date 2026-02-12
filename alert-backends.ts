/**
 * Alert Backend System - Pluggable alert delivery
 *
 * This allows us to swap between console logging (development)
 * and SMS messaging (production) without changing core logic.
 */

import nodemailer from 'nodemailer';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

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
 * Console Backend - Logs alerts to the console
 * Use this during development and testing
 */
export class ConsoleAlertBackend implements AlertBackend {
  getName(): string {
    return 'Console Logger';
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    const icon = message.severity === 'critical' ? '🚨' : '⚠️';
    const title = message.severity === 'critical' ? 'CRITICAL' : 'LOW FUEL WARNING';

    console.log(`\n${icon} ALERT TRIGGERED ${icon}`);
    console.log('─'.repeat(50));
    console.log(`Severity: ${title}`);
    console.log(`Range: ${message.range} miles remaining`);
    console.log(`Vehicle: ${message.vehicleName}`);
    console.log(`Time: ${message.timestamp.toLocaleString()}`);

    if (message.severity === 'critical') {
      console.log('\n🚗 Get gas immediately!');
    } else {
      console.log('\n⛽ Time to refuel soon.');
    }

    console.log('─'.repeat(50));
    console.log('(Using Console backend - will be SMS in production)\n');
  }
}

/**
 * T-Mobile Email-to-SMS Backend - Sends alerts via email to T-Mobile's SMS gateway
 * Uses phonenumber@tmomail.net trick to send free text messages
 * Requires SMTP server credentials (Gmail, etc.)
 */
export class TmobileEmailAlertBackend implements AlertBackend {
  private phoneNumbers: string[];
  private smtpHost: string;
  private smtpPort: number;
  private smtpUser: string;
  private smtpPassword: string;
  private fromEmail: string;

  constructor(
    phoneNumbers: string[],
    smtpHost: string,
    smtpPort: number,
    smtpUser: string,
    smtpPassword: string,
    fromEmail: string
  ) {
    this.phoneNumbers = phoneNumbers;
    this.smtpHost = smtpHost;
    this.smtpPort = smtpPort;
    this.smtpUser = smtpUser;
    this.smtpPassword = smtpPassword;
    this.fromEmail = fromEmail;
  }

  getName(): string {
    return `T-Mobile Email-to-SMS (${this.phoneNumbers.length} recipient${this.phoneNumbers.length > 1 ? 's' : ''})`;
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    // Create reusable transporter
    const transporter = nodemailer.createTransport({
      host: this.smtpHost,
      port: this.smtpPort,
      secure: this.smtpPort === 465, // true for 465, false for other ports
      auth: {
        user: this.smtpUser,
        pass: this.smtpPassword,
      },
    });

    // For SMS gateways, keep it ultra-simple and put everything in the body
    // Subject often gets mangled or concatenated poorly
    const icon = message.severity === 'critical' ? '🚨' : '⚠️';
    const urgency = message.severity === 'critical' ? 'CRITICAL' : 'Low Fuel';

    // Clean, simple message under 160 characters
    const body = `${icon} ${urgency}: ${message.vehicleName} has ${message.range} miles left. ` +
                 (message.severity === 'critical' ? 'Get gas NOW!' : 'Refuel soon.');

    console.log(`📧 Sending email-to-SMS to ${this.phoneNumbers.length} recipient(s)...`);

    // Send to all phone numbers via email gateway
    const promises = this.phoneNumbers.map(async (phoneNumber) => {
      // Convert phone number to email address (e.g., 5551234567@tmomail.net)
      const cleanNumber = phoneNumber.replace(/\D/g, ''); // Remove non-digits
      const toAddress = `${cleanNumber}@tmomail.net`;

      try {
        const info = await transporter.sendMail({
          from: this.fromEmail,
          to: toAddress,
          subject: '', // Empty subject - some carriers mangle it
          text: body,
        });
        console.log(`   ✅ Sent to ${phoneNumber} via ${toAddress} (ID: ${info.messageId})`);
        return info;
      } catch (error) {
        console.error(`   ❌ Failed to send to ${phoneNumber}:`, error);
        throw error;
      }
    });

    await Promise.all(promises);
    console.log(`\n✅ All email-to-SMS messages sent successfully!\n`);
  }
}

/**
 * AWS SNS Backend - Sends alerts via AWS SNS (no phone number needed!)
 * Most cost-effective option: ~$0.006 per SMS, no monthly fees
 * Requires AWS credentials and region configuration
 */
export class AwsSnsAlertBackend implements AlertBackend {
  private phoneNumbers: string[];
  private region: string;
  private snsClient: SNSClient;

  constructor(phoneNumbers: string[], region: string, accessKeyId?: string, secretAccessKey?: string) {
    this.phoneNumbers = phoneNumbers;
    this.region = region;

    // Configure SNS client with credentials if provided, otherwise use default credential chain
    const clientConfig: any = { region };
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey,
      };
    }

    this.snsClient = new SNSClient(clientConfig);
  }

  getName(): string {
    return `AWS SNS (${this.phoneNumbers.length} recipient${this.phoneNumbers.length > 1 ? 's' : ''})`;
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    const icon = message.severity === 'critical' ? '🚨' : '⚠️';
    const title = message.severity === 'critical' ? 'CRITICAL FUEL ALERT' : 'Low Fuel Warning';
    const body = `${icon} ${title}\n` +
                 `Vehicle: ${message.vehicleName}\n` +
                 `Range: ${message.range} miles remaining\n` +
                 (message.severity === 'critical' ? 'Get gas immediately!' : 'Time to refuel soon.');

    console.log(`📱 Sending SMS via AWS SNS to ${this.phoneNumbers.length} recipient(s)...`);

    // Send to all phone numbers
    const promises = this.phoneNumbers.map(async (phoneNumber) => {
      try {
        const command = new PublishCommand({
          Message: body,
          PhoneNumber: phoneNumber,
        });

        const result = await this.snsClient.send(command);
        console.log(`   ✅ Sent to ${phoneNumber} (MessageId: ${result.MessageId})`);
        return result;
      } catch (error) {
        console.error(`   ❌ Failed to send to ${phoneNumber}:`, error);
        throw error;
      }
    });

    await Promise.all(promises);
    console.log(`\n✅ All AWS SNS messages sent successfully!\n`);
  }
}

/**
 * Create the appropriate alert backend based on environment
 */
export function createAlertBackend(): AlertBackend {
  const backendType = process.env.ALERT_BACKEND || 'console';

  switch (backendType.toLowerCase()) {
    case 'tmobile-email':
    case 'email':
      const phones = process.env.TMOBILE_PHONES;
      const smtpHost = process.env.EMAIL_SMTP_HOST;
      const smtpPort = process.env.EMAIL_SMTP_PORT;
      const smtpUser = process.env.EMAIL_SMTP_USER;
      const smtpPassword = process.env.EMAIL_SMTP_PASSWORD;
      const fromEmail = process.env.EMAIL_FROM;

      if (!phones || !smtpHost || !smtpPort || !smtpUser || !smtpPassword || !fromEmail) {
        console.error('❌ Missing required email environment variables:');
        if (!phones) console.error('  - TMOBILE_PHONES');
        if (!smtpHost) console.error('  - EMAIL_SMTP_HOST');
        if (!smtpPort) console.error('  - EMAIL_SMTP_PORT');
        if (!smtpUser) console.error('  - EMAIL_SMTP_USER');
        if (!smtpPassword) console.error('  - EMAIL_SMTP_PASSWORD');
        if (!fromEmail) console.error('  - EMAIL_FROM');
        throw new Error('Missing email configuration');
      }

      const phoneNumbers = phones.split(',').map(num => num.trim()).filter(num => num.length > 0);

      if (phoneNumbers.length === 0) {
        throw new Error('TMOBILE_PHONES must contain at least one phone number');
      }

      return new TmobileEmailAlertBackend(
        phoneNumbers,
        smtpHost,
        parseInt(smtpPort, 10),
        smtpUser,
        smtpPassword,
        fromEmail
      );

    case 'sns':
    case 'aws-sns':
    case 'aws':
      const snsPhones = process.env.AWS_SNS_PHONES;
      const snsRegion = process.env.AWS_REGION || 'us-east-1';
      const snsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const snsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

      if (!snsPhones) {
        console.error('❌ Missing required AWS SNS environment variables:');
        console.error('  - AWS_SNS_PHONES (comma-separated phone numbers with country code, e.g., +15551234567)');
        throw new Error('Missing AWS SNS configuration');
      }

      const snsPhoneNumbers = snsPhones.split(',').map(num => num.trim()).filter(num => num.length > 0);

      if (snsPhoneNumbers.length === 0) {
        throw new Error('AWS_SNS_PHONES must contain at least one phone number');
      }

      // Validate phone numbers have country code
      for (const phone of snsPhoneNumbers) {
        if (!phone.startsWith('+')) {
          console.warn(`⚠️  Warning: Phone number "${phone}" should start with + and country code (e.g., +1 for US)`);
        }
      }

      return new AwsSnsAlertBackend(snsPhoneNumbers, snsRegion, snsAccessKeyId, snsSecretAccessKey);

    case 'console':
    default:
      return new ConsoleAlertBackend();
  }
}
