import nodemailer from 'nodemailer';

export function invitationDeliveryError(error) {
  const code = ['EMAIL_NOT_CONFIGURED', 'EAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'EDNS', 'EMAIL_RECIPIENT_REJECTED'].includes(error?.code) ? error.code : 'EMAIL_DELIVERY_FAILED';
  const messages = {
    EMAIL_NOT_CONFIGURED: 'Gmail SMTP delivery is not configured. Configure SMTP_USER and SMTP_PASS, then restart the backend.',
    EAUTH: 'Gmail rejected SMTP authentication. Check the Gmail address and Google App Password.',
    EMAIL_RECIPIENT_REJECTED: 'Gmail SMTP rejected the recipient address. Check the employee email.',
  };
  return { code, message: messages[code] || 'The backend could not submit the invitation to Gmail SMTP. Check the SMTP configuration and Gmail status, then resend.' };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

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
    : (process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD || process.env.google_password);
  const from = config.smtpFrom || process.env.EMAIL_FROM || process.env.SMTP_FROM || user;
  const configured = Boolean(user && pass);
  const configuredDeliveryTimeout = Number(config.smtpDeliveryTimeoutMs);
  const deliveryTimeoutMs = Number.isFinite(configuredDeliveryTimeout)
    ? Math.min(7000, Math.max(25, configuredDeliveryTimeout))
    : 5000;

  if (!configured) {
    return {
      configured: false,
      provider: 'none',
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
      async sendInvitationEmail() {
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
    connectionTimeout: Math.min(3000, deliveryTimeoutMs),
    greetingTimeout: Math.min(3000, deliveryTimeoutMs),
    socketTimeout: deliveryTimeoutMs,
    dnsTimeout: Math.min(3000, deliveryTimeoutMs),
  });

  const sendMessage = async ({ to, subject, text, html, requireRecipientAcceptance = false }) => {
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Gmail SMTP delivery attempt timed out');
        error.code = 'ETIMEDOUT';
        reject(error);
      }, deliveryTimeoutMs);
    });
    let delivery;
    try {
      delivery = await Promise.race([
        transporter.sendMail({ from, to, subject, text, html }),
        deadline,
      ]);
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') transporter.close?.();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (requireRecipientAcceptance && !delivery?.accepted?.some((recipient) => String(recipient.address || recipient).toLowerCase() === String(to).toLowerCase())) {
      const error = new Error('Email provider did not accept the recipient');
      error.code = 'EMAIL_RECIPIENT_REJECTED';
      throw error;
    }
  };

  return {
    configured: true,
    provider: 'gmail-smtp',
    
async sendPasswordResetEmail({
  to,
  resetToken,
  resetUrl,
  expiresInMinutes = 30,
}) {
  // 1. Generate reset URL safely
  const url = new URL(resetUrl);
  url.searchParams.set('token', resetToken);
  url.searchParams.set('email', to);

  const link = url.toString();

  // 2. Escape dynamic HTML values
  const safeLink = escapeHtml(link);
  const safeExpiry = escapeHtml(expiresInMinutes);

  // 3. Email subject
  const subject = 'Reset your DigitalPulse password';

  // 4. Plain text fallback
  const text = `
Hello,

We received a request to reset your DigitalPulse account password.

Use this link to create a new password:

${link}

This link expires in ${expiresInMinutes} minutes.

If you did not request this, you can safely ignore this email.
Your existing password will remain unchanged.

DigitalPulse Security Team
  `.trim();

  // 5. Professional HTML email
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your DigitalPulse password</title>
</head>

<body style="
  margin: 0;
  padding: 0;
  background-color: #080d19;
  font-family: Arial, Helvetica, sans-serif;
  color: #e2e8f0;
">

<table role="presentation" width="100%" cellpadding="0"
  cellspacing="0" border="0"
  style="background-color: #080d19;">

<tr>
<td align="center" style="padding: 40px 15px;">

<table role="presentation" width="100%" cellpadding="0"
  cellspacing="0" border="0"
  style="
    max-width: 560px;
    background-color: #101827;
    border: 1px solid #273449;
    border-radius: 14px;
  ">

<!-- HEADER -->
<tr>
<td align="center" style="
  padding: 30px 25px;
  border-bottom: 1px solid #273449;
">

<div style="
  color: #10d9a0;
  font-size: 21px;
  font-weight: 800;
  letter-spacing: 4px;
">
  DIGITALPULSE
</div>

<div style="
  margin-top: 8px;
  color: #8292aa;
  font-size: 11px;
  letter-spacing: 2px;
">
  WORKSPACE SECURITY
</div>

</td>
</tr>

<!-- CONTENT -->
<tr>
<td style="padding: 35px 30px;">

<h1 style="
  margin: 0 0 18px;
  color: #ffffff;
  font-size: 27px;
">
  Reset your password
</h1>

<p style="
  color: #a8b6cc;
  font-size: 15px;
  line-height: 1.8;
">
  Hello,
</p>

<p style="
  color: #a8b6cc;
  font-size: 15px;
  line-height: 1.8;
">
  We received a request to reset your DigitalPulse
  account password. Click below to securely create
  a new password.
</p>

<!-- RESET BUTTON -->
<table role="presentation" width="100%" cellpadding="0"
  cellspacing="0" border="0">

<tr>
<td align="center" style="padding: 20px 0;">

<a href="${safeLink}"
  referrerpolicy="no-referrer"
  rel="noreferrer"
  style="
    display: inline-block;
    padding: 15px 35px;
    background-color: #078bd0;
    color: #ffffff;
    font-size: 15px;
    font-weight: bold;
    text-decoration: none;
    border-radius: 8px;
  ">
  Reset My Password &rarr;
</a>

</td>
</tr>
</table>

<!-- EXPIRATION NOTICE -->
<table role="presentation" width="100%" cellpadding="0"
  cellspacing="0" border="0"
  style="
    background-color: #172437;
    border: 1px solid #34445c;
    border-radius: 8px;
">

<tr>
<td style="padding: 17px;">

<p style="
  margin: 0 0 8px;
  color: #fbbf24;
  font-size: 14px;
  font-weight: bold;
">
  Link expires in ${safeExpiry} minutes
</p>

<p style="
  margin: 0;
  color: #a8b6cc;
  font-size: 13px;
  line-height: 1.6;
">
  For your security, this link can only be used once.
</p>

</td>
</tr>
</table>

<!-- FALLBACK URL -->
<p style="
  margin: 28px 0 8px;
  color: #a8b6cc;
  font-size: 13px;
  line-height: 1.7;
">
  If the button doesn't work, copy and paste
  this link into your browser:
</p>

<p style="
  font-size: 12px;
  word-break: break-all;
">
  <a href="${safeLink}" referrerpolicy="no-referrer" rel="noreferrer" style="color: #38bdf8;">
    ${safeLink}
  </a>
</p>

<!-- SECURITY MESSAGE -->
<p style="
  margin-top: 25px;
  color: #a8b6cc;
  font-size: 13px;
  line-height: 1.8;
">
  <strong style="color: #ffffff;">
    Didn't request this?
  </strong>

  You can safely ignore this email.
  Your existing password will remain unchanged.
</p>

</td>
</tr>

<!-- FOOTER -->
<tr>
<td align="center" style="
  padding: 25px;
  background-color: #0c1422;
  border-top: 1px solid #273449;
">

<p style="
  margin: 0 0 8px;
  color: #10d9a0;
  font-size: 13px;
  font-weight: bold;
  letter-spacing: 2px;
">
  DIGITALPULSE
</p>

<p style="
  color: #8292aa;
  font-size: 12px;
">
  Smarter insights. Better productivity.
</p>

<p style="
  color: #64748b;
  font-size: 11px;
  line-height: 1.7;
">
  &copy; 2026 DigitalPulse. All rights reserved.
  <br>
  Automated security notification.
  Please do not reply.
</p>

</td>
</tr>

</table>
</td>
</tr>
</table>

</body>
</html>
  `.trim();

  // 6. Send email
  await sendMessage({
    to,
    subject,
    text,
    html,
  });

},
    async sendInvitationEmail({ to, token, invitationUrl }) {
      const url = new URL(invitationUrl);
      url.hash = new URLSearchParams({ token }).toString();
      const link = url.toString();
      await sendMessage({
        to,
        requireRecipientAcceptance: true,
        subject: 'You are invited to DigitalPulse',
        text: `You have been invited to DigitalPulse. Accept your invitation here:\n\n${link}`,
        html: `<p>You have been invited to DigitalPulse.</p><p><a href="${escapeHtml(link)}">Accept invitation</a></p><p>This invitation expires in seven days.</p>`,
      });
    },
    async sendDeviceSetupReminder({ to, setupUrl }) {
      await sendMessage({
        to,
        subject: 'Complete your DigitalPulse device setup',
        text: `Your DigitalPulse account is ready. Sign in and follow the device setup steps here:\n\n${setupUrl}\n\nDigitalPulse collects foreground application names, activity and idle intervals, and foreground website domains when the agent or browser extension is running. It does not collect keystrokes, page contents, passwords, messages, or clipboard data.`,
        html: `<p>Your DigitalPulse account is ready. Sign in and follow the device setup steps here:</p><p><a href="${setupUrl}">Open device setup</a></p><p>DigitalPulse collects foreground application names, activity and idle intervals, and foreground website domains when the agent or browser extension is running. It does not collect keystrokes, page contents, passwords, messages, or clipboard data.</p>`,
      });
    },
  };
}
