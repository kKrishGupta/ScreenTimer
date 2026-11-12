import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createEmailService, invitationDeliveryError } from '../src/modules/auth/email.service.js';

test('invitation requires SMTP recipient acceptance and uses a fragment token', async (t) => {
  let accepted = [];
  let mail;
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (value) => { mail = value; return { accepted }; } }));
  const service = createEmailService({ smtpUser: 'sender@example.test', smtpPassword: 'test-password' });
  const request = { to: 'employee@example.test', token: 'test-token', invitationUrl: 'https://app.example.test/accept-invitation' };
  await assert.rejects(service.sendInvitationEmail(request), { code: 'EMAIL_RECIPIENT_REJECTED' });
  accepted = ['employee@example.test'];
  await service.sendInvitationEmail(request);
  assert.match(mail.text, /accept-invitation#token=test-token/);
  assert.doesNotMatch(mail.text, /\?token=/);
});

test('delivery diagnostics never expose provider messages or credentials', () => {
  const result = invitationDeliveryError({ code: 'EAUTH', message: 'secret-password private SMTP response' });
  assert.equal(result.code, 'EAUTH');
  assert.doesNotMatch(JSON.stringify(result), /secret-password|private SMTP/);
});

test('Gmail SMTP uses the documented secure transport and authorized sender', async (t) => {
  let transportConfig;
  let mail;
  t.mock.method(nodemailer, 'createTransport', (value) => {
    transportConfig = value;
    return { sendMail: async (message) => { mail = message; return { accepted: ['employee@example.test'] }; } };
  });
  const service = createEmailService({
    smtpHost: 'smtp.gmail.com',
    smtpPort: '465',
    smtpSecure: 'true',
    smtpUser: 'sender@gmail.com',
    smtpPassword: 'test app password',
    smtpFrom: 'sender@gmail.com',
  });

  await service.sendInvitationEmail({
    to: 'employee@example.test',
    token: 'test-token',
    invitationUrl: 'https://app.example.test/accept-invitation',
  });

  assert.equal(service.provider, 'gmail-smtp');
  assert.equal(transportConfig.host, 'smtp.gmail.com');
  assert.equal(transportConfig.port, 465);
  assert.equal(transportConfig.secure, true);
  assert.equal(transportConfig.auth.user, 'sender@gmail.com');
  assert.equal(transportConfig.auth.pass, 'testapppassword');
  assert.equal(mail.from, 'sender@gmail.com');
  assert.match(mail.text, /accept-invitation#token=test-token/);
});

test('missing Gmail SMTP credentials fail closed without creating a transport', async (t) => {
  const createTransport = t.mock.method(nodemailer, 'createTransport', () => { throw new Error('must not be called'); });
  const service = createEmailService({ smtpUser: '', smtpPassword: '', smtpFrom: '' });
  assert.equal(service.configured, false);
  assert.equal(service.provider, 'none');
  await assert.rejects(service.sendInvitationEmail({}), { code: 'EMAIL_NOT_CONFIGURED' });
  assert.equal(createTransport.mock.callCount(), 0);
});

test('Gmail SMTP attempts have a hard deadline and close the stalled transport', async (t) => {
  let closed = false;
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => new Promise(() => {}),
    close: () => { closed = true; },
  }));
  const service = createEmailService({
    smtpUser: 'sender@gmail.com',
    smtpPassword: 'test-app-password',
    smtpFrom: 'sender@gmail.com',
    smtpDeliveryTimeoutMs: 25,
  });

  const startedAt = Date.now();
  await assert.rejects(service.sendInvitationEmail({
    to: 'employee@example.test',
    token: 'test-token',
    invitationUrl: 'https://app.example.test/accept-invitation',
  }), { code: 'ETIMEDOUT' });

  assert.equal(closed, true);
  assert.ok(Date.now() - startedAt < 1000);
});
