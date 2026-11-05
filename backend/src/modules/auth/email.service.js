import nodemailer from 'nodemailer';

/**
 * Gmail SMTP delivery for security-sensitive account emails.
 * Credentials are read only from runtime configuration and are never logged.
 */
export function createEmailService(config = {}) {
  const hasExplicitConfig = Object.prototype.hasOwnProperty.call(config, 'smtpUser');
  const user = hasExplicitConfig
    ? config.smtpUser
    : (process.env.SMTP_USER || process.env.GMAIL_USER || process.env.google_email);
  const pass = hasExplicitConfig
    ? config.smtpPassword
    : (process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD || process.env.google_password);

  if (!user || !pass) {
    return {
      configured: false,
      async sendPasswordResetEmail() {
        const error = new Error('Email delivery is not configured');
        error.code = 'EMAIL_NOT_CONFIGURED';
        throw error;
      },
      async sendDeviceSetupReminder() {
        const error = new Error('Email delivery is not configured');
        error.code = 'EMAIL_NOT_CONFIGURED';
        throw error;
      },
    };
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(config.smtpPort || process.env.SMTP_PORT || 465),
    secure: String(config.smtpSecure ?? process.env.SMTP_SECURE ?? 'true').toLowerCase() === 'true',
    auth: { user, pass: String(pass).replace(/\s+/g, '') },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    dnsTimeout: 10000,
  });

  return {
    configured: true,
    async sendPasswordResetEmail({ to, resetToken, resetUrl, expiresInMinutes = 30 }) {
      const link = `${resetUrl}?token=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(to)}`;
      await transporter.sendMail({
        from: config.smtpFrom || process.env.SMTP_FROM || user,
        to,
        subject: 'Reset your DigitalPulse password',
        text: `Use this link to reset your DigitalPulse password. It expires in ${expiresInMinutes} minutes:\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>Use the link below to reset your DigitalPulse password. It expires in ${expiresInMinutes} minutes.</p><p><a href="${link}" referrerpolicy="no-referrer" rel="noreferrer">Reset your password</a></p><p>If you did not request this, you can ignore this email.</p>`,
      });
    },
    async sendInvitationEmail({ to, token, invitationUrl }) {
      const url = new URL(invitationUrl);
      url.hash = new URLSearchParams({ token }).toString();
      const link = url.toString();
      await transporter.sendMail({
        from: config.smtpFrom || process.env.SMTP_FROM || user,
        to,
        subject: 'You are invited to DigitalPulse',
        text: `You have been invited to DigitalPulse. Accept your invitation here:\n\n${link}`,
        html: `<p>You have been invited to DigitalPulse.</p><p><a href="${link}">Accept invitation</a></p>`,
      });
    },
    async sendDeviceSetupReminder({ to, setupUrl }) {
      await transporter.sendMail({
        from: config.smtpFrom || process.env.SMTP_FROM || user,
        to,
        subject: 'Complete your DigitalPulse device setup',
        text: `Your DigitalPulse account is ready. Sign in and follow the device setup steps here:\n\n${setupUrl}\n\nDigitalPulse collects foreground application names, activity and idle intervals, and foreground website domains when the agent or browser extension is running. It does not collect keystrokes, page contents, passwords, messages, or clipboard data.`,
        html: `<p>Your DigitalPulse account is ready. Sign in and follow the device setup steps here:</p><p><a href="${setupUrl}">Open device setup</a></p><p>DigitalPulse collects foreground application names, activity and idle intervals, and foreground website domains when the agent or browser extension is running. It does not collect keystrokes, page contents, passwords, messages, or clipboard data.</p>`,
      });
    },
  };
}
