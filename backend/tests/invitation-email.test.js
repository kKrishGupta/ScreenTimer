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
