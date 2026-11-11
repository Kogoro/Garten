// Outgoing e-mail via SMTP (nodemailer). Optional: when SMTP_URL is empty the app works as before and shows links to copy.
import nodemailer from 'nodemailer';
import { SMTP_URL, SMTP_FROM, SMTP_REQUIRE_TLS, PROJECT_NAME } from './config.js';

function makeTransport() {
  if (!SMTP_URL) return null;
  const u = new URL(SMTP_URL);
  const secure = u.protocol === 'smtps:';
  return nodemailer.createTransport({
    host: u.hostname,
    port: Number(u.port) || (secure ? 465 : 587),
    secure,
    requireTLS: SMTP_REQUIRE_TLS,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}
const transport = makeTransport();
if (transport && !SMTP_REQUIRE_TLS && new URL(SMTP_URL).protocol !== 'smtps:') console.warn('SMTP_REQUIRE_TLS is off: mail (and the SMTP password) may travel unencrypted. Set SMTP_REQUIRE_TLS=1 unless the mail server is on this machine.');
export const mailEnabled = !!transport;
export const mailInfo = () => ({ enabled: mailEnabled, from: mailEnabled ? SMTP_FROM : null, host: mailEnabled ? new URL(SMTP_URL).hostname : null });

const clean = (s) => String(s ?? '').replace(/[\r\n\0]+/g, ' ').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function sendMail({ to, subject, text, html }) {
  if (!transport) throw new Error('E-mail is not configured on this server');
  await transport.sendMail({ from: SMTP_FROM, to, subject: clean(subject), text, html });
}

/** A short, secret-free reason for the UI (never the SMTP credentials). */
export const mailError = (e) => clean(e?.response || e?.message || 'unknown error').replace(/\/\/[^@\s]*@/g, '//***@').slice(0, 160);

export function invitationMail({ teamName, inviterName, role, link, expiresAt, userExists }) {
  const days = Math.max(1, Math.round((expiresAt - Date.now()) / 86400_000));
  const who = clean(inviterName) || 'A team admin';
  const team = clean(teamName);
  const lead = `${who} invited you to the team “${team}” on ${PROJECT_NAME === 'specs' ? 'Specs' : clean(PROJECT_NAME)} as ${role}.`;
  const how = userExists ? 'You already have an account: sign in and accept the invitation with this link.' : 'Create your account and join with this link.';
  const text = `${lead}\n\n${how}\n\n${link}\n\nThe link works once and expires in ${days} day${days === 1 ? '' : 's'}. If you did not expect this e-mail you can ignore it.\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#14181C"><p>${esc(lead)}</p><p>${esc(how)}</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#0B7A52;color:#fff;text-decoration:none;font-weight:600">Join ${esc(team)}</a></p>
<p style="color:#58636F;font-size:13px">Or open: <a href="${esc(link)}">${esc(link)}</a><br>The link works once and expires in ${days} day${days === 1 ? '' : 's'}. If you did not expect this e-mail you can ignore it.</p></div>`;
  return { subject: `${who} invited you to ${team}`, text, html };
}

export function feedbackMail({ teamName, items, link }) {
  const team = clean(teamName);
  const n = items.length;
  const subject = `${n} new feedback on specs in ${team}`;
  const line = (f) => `• ${f.specId} – ${f.kind}${f.section ? ` (${clean(f.section)})` : ''}: ${clean(f.text).slice(0, 240)}${f.via ? ` [${clean(f.via)}]` : ''}`;
  const text = `${n} new feedback entr${n === 1 ? 'y' : 'ies'} in “${team}”:\n\n${items.map(line).join('\n')}\n\nOpen the specs to read and triage it: ${link}\n\nYou get this because you are an approver or admin of the team. Team admins can switch these e-mails off on the team page.\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#14181C"><p>${n} new feedback entr${n === 1 ? 'y' : 'ies'} in “${esc(team)}”:</p><ul>${items.map((f) => `<li><b>${esc(f.specId)}</b> – ${esc(f.kind)}${f.section ? ` (${esc(f.section)})` : ''}: ${esc(clean(f.text).slice(0, 240))}${f.via ? ` <span style="color:#58636F">[${esc(f.via)}]</span>` : ''}</li>`).join('')}</ul>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#0B7A52;color:#fff;text-decoration:none;font-weight:600">Open and triage</a></p>
<p style="color:#58636F;font-size:13px">You get this because you are an approver or admin of the team. Team admins can switch these e-mails off on the team page.</p></div>`;
  return { subject, text, html };
}
