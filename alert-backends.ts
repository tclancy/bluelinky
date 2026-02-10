/**
 * Alert Backend System - Pluggable alert delivery
 *
 * This allows us to swap between console logging (development)
 * and SMS messaging (production) without changing core logic.
 */

import twilio from 'twilio';
import nodemailer from 'nodemailer';

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
 * Twilio Trial SMS Backend - Sends alerts via SMS using trial account
 * Only works with verified phone numbers in Twilio console
 */
export class TwilioTrialSMSAlertBackend implements AlertBackend {
  private toPhoneNumbers: string[];
  private fromPhoneNumber: string;
  private accountSid: string;
  private authToken: string;

  constructor(toPhoneNumbers: string[], fromPhoneNumber: string, accountSid: string, authToken: string) {
    this.toPhoneNumbers = toPhoneNumbers;
    this.fromPhoneNumber = fromPhoneNumber;
    this.accountSid = accountSid;
    this.authToken = authToken;
  }

  getName(): string {
    return `Twilio Trial SMS (${this.toPhoneNumbers.length} verified recipient${this.toPhoneNumbers.length > 1 ? 's' : ''})`;
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    const client = twilio(this.accountSid, this.authToken);
    const icon = message.severity === 'critical' ? '🚨' : '⚠️';
    const title = message.severity === 'critical' ? 'CRITICAL FUEL ALERT' : 'Low Fuel Warning';
    const body = `${icon} ${title}\n` +
                 `Vehicle: ${message.vehicleName}\n` +
                 `Range: ${message.range} miles remaining\n` +
                 (message.severity === 'critical' ? 'Get gas immediately!' : 'Time to refuel soon.');

    console.log(`📱 Sending trial SMS to ${this.toPhoneNumbers.length} recipient(s)...`);
    console.log(`   (Recipients must be verified in Twilio console)`);

    // Send to all phone numbers
    const promises = this.toPhoneNumbers.map(async (toNumber) => {
      try {
        const result = await client.messages.create({
          from: this.fromPhoneNumber,
          to: toNumber,
          body
        });
        console.log(`   ✅ Sent to ${toNumber} (SID: ${result.sid})`);
        return result;
      } catch (error) {
        console.error(`   ❌ Failed to send to ${toNumber}:`, error);
        throw error;
      }
    });

    await Promise.all(promises);
    console.log(`\n✅ All trial SMS messages sent successfully!\n`);
  }
}

/**
 * Twilio Paid SMS Backend - Sends alerts via SMS with paid account (10DLC registered)
 * Requires business registration and campaign setup
 */
export class TwilioSMSAlertBackend implements AlertBackend {
  private toPhoneNumbers: string[];
  private fromPhoneNumber: string;
  private accountSid: string;
  private authToken: string;

  constructor(toPhoneNumbers: string[], fromPhoneNumber: string, accountSid: string, authToken: string) {
    this.toPhoneNumbers = toPhoneNumbers;
    this.fromPhoneNumber = fromPhoneNumber;
    this.accountSid = accountSid;
    this.authToken = authToken;
  }

  getName(): string {
    return `Twilio Paid SMS (${this.toPhoneNumbers.length} recipient${this.toPhoneNumbers.length > 1 ? 's' : ''})`;
  }

  async sendAlert(message: AlertMessage): Promise<void> {
    const client = twilio(this.accountSid, this.authToken);
    const icon = message.severity === 'critical' ? '🚨' : '⚠️';
    const title = message.severity === 'critical' ? 'CRITICAL FUEL ALERT' : 'Low Fuel Warning';
    const body = `${icon} ${title}\n` +
                 `Vehicle: ${message.vehicleName}\n` +
                 `Range: ${message.range} miles remaining\n` +
                 (message.severity === 'critical' ? 'Get gas immediately!' : 'Time to refuel soon.');

    console.log(`📱 Sending SMS to ${this.toPhoneNumbers.length} recipient(s)...`);

    // Send to all phone numbers
    const promises = this.toPhoneNumbers.map(async (toNumber) => {
      try {
        const result = await client.messages.create({
          from: this.fromPhoneNumber,
          to: toNumber,
          body
        });
        console.log(`   ✅ Sent to ${toNumber} (SID: ${result.sid})`);
        return result;
      } catch (error) {
        console.error(`   ❌ Failed to send to ${toNumber}:`, error);
        throw error;
      }
    });

    await Promise.all(promises);
    console.log(`\n✅ All SMS messages sent successfully!\n`);
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
 * Create the appropriate alert backend based on environment
 */
export function createAlertBackend(): AlertBackend {
  const backendType = process.env.ALERT_BACKEND || 'console';

  switch (backendType.toLowerCase()) {
    case 'twilio-trial':
      const trialToPhone = process.env.TWILIO_TO_PHONE;
      const trialFromPhone = process.env.TWILIO_FROM_PHONE;
      const trialAccountSid = process.env.TWILIO_ACCOUNT_SID;
      const trialAuthToken = process.env.TWILIO_AUTH_TOKEN;

      if (!trialToPhone || !trialFromPhone || !trialAccountSid || !trialAuthToken) {
        console.error('❌ Missing required Twilio environment variables:');
        if (!trialToPhone) console.error('  - TWILIO_TO_PHONE');
        if (!trialFromPhone) console.error('  - TWILIO_FROM_PHONE');
        if (!trialAccountSid) console.error('  - TWILIO_ACCOUNT_SID');
        if (!trialAuthToken) console.error('  - TWILIO_AUTH_TOKEN');
        throw new Error('Missing Twilio configuration');
      }

      const trialToPhoneNumbers = trialToPhone.split(',').map(num => num.trim()).filter(num => num.length > 0);

      if (trialToPhoneNumbers.length === 0) {
        throw new Error('TWILIO_TO_PHONE must contain at least one phone number');
      }

      return new TwilioTrialSMSAlertBackend(trialToPhoneNumbers, trialFromPhone, trialAccountSid, trialAuthToken);

    case 'sms':
    case 'twilio':
    case 'twilio-paid':
      const toPhone = process.env.TWILIO_TO_PHONE;
      const fromPhone = process.env.TWILIO_FROM_PHONE;
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;

      if (!toPhone || !fromPhone || !accountSid || !authToken) {
        console.error('❌ Missing required Twilio environment variables:');
        if (!toPhone) console.error('  - TWILIO_TO_PHONE');
        if (!fromPhone) console.error('  - TWILIO_FROM_PHONE');
        if (!accountSid) console.error('  - TWILIO_ACCOUNT_SID');
        if (!authToken) console.error('  - TWILIO_AUTH_TOKEN');
        throw new Error('Missing Twilio configuration');
      }

      const toPhoneNumbers = toPhone.split(',').map(num => num.trim()).filter(num => num.length > 0);

      if (toPhoneNumbers.length === 0) {
        throw new Error('TWILIO_TO_PHONE must contain at least one phone number');
      }

      return new TwilioSMSAlertBackend(toPhoneNumbers, fromPhone, accountSid, authToken);

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

    case 'console':
    default:
      return new ConsoleAlertBackend();
  }
}
