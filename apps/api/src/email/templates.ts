/**
 * Email templates: plain, branded, readable on a phone, each with a text version.
 * Every value is HTML-escaped. Links point only at APP_URL.
 */
export type TemplateName =
  | 'account-activation'
  | 'password-reset'
  | 'sign-invite'
  | 'sign-code'
  | 'document-completed'
  | 'document-declined'
  | 'document-voided'
  | 'document-expired'
  | 'approval-request'
  | 'approval-returned'
  | 'audit-anchor'
  | 'test-email';

export interface RenderedEmail {
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, bodyHtml: string, appUrl: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f3;font-family:Segoe UI,Arial,sans-serif;color:#2e323c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="padding:18px 24px;border-bottom:4px solid #bf4520">
<img src="${escapeHtml(appUrl)}/logo-192.png" width="56" height="56" alt="Ruliba Clays" style="display:block;border:0">
</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 12px;color:#2e323c">${escapeHtml(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#646a75;border-top:1px solid #eee">
Ruliba Clays Ltd, Kigali, Rwanda. Sent by Ruliba Clays eSign from sign@ruliba.com.<br>
If you did not expect this email, do not click anything and tell the sender.</td></tr>
</table></td></tr></table></body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="background:#bf4520;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`;
}

const p = (s: string) => `<p style="margin:0 0 12px;line-height:1.55">${s}</p>`;
const quiet = (s: string) => `<p style="margin:12px 0 0;font-size:13px;color:#646a75;line-height:1.5">${s}</p>`;

export function render(template: TemplateName, d: Record<string, string>, appUrl: string): RenderedEmail {
  const e = (k: string) => escapeHtml(d[k] ?? '');
  switch (template) {
    case 'test-email':
      return {
        html: layout(
          'Test email from Ruliba Clays eSign',
          p(`Hello,`) +
            p(`${e('by')} sent this test from Settings to check that eSign emails arrive in the inbox, not in spam.`) +
            p('If you found it in spam or junk, mark it as "Not spam" and tell the IT office: the ruliba.com email settings (SPF, DKIM, DMARC) need checking.') +
            quiet(`Sent ${e('when')} by ${e('transport')}.`),
          appUrl,
        ),
        text: `Hello,\n\n${d.by} sent this test from Settings to check that eSign emails arrive in the inbox, not in spam.\n\nIf you found it in spam or junk, mark it as "Not spam" and tell the IT office: the ruliba.com email settings (SPF, DKIM, DMARC) need checking.\n\nSent ${d.when} by ${d.transport}.`,
      };

    case 'account-activation':
      return {
        html: layout(
          'Activate your eSign account',
          p(`Hello ${e('name')},`) +
            p('An administrator created a Ruliba Clays eSign account for you. To start using it, open the link below and choose your password.') +
            button(d.link, 'Activate my account') +
            quiet(`This link works once, until ${e('expires')}. If it has expired, ask the IT office to send a new one. Do not forward this email: the link is for you alone. We never send passwords by email.`),
          appUrl,
        ),
        text: `Hello ${d.name},

An administrator created a Ruliba Clays eSign account for you. To start using it, open this link and choose your password:

${d.link}

This link works once, until ${d.expires}. If it has expired, ask the IT office to send a new one. Do not forward this email: the link is for you alone. We never send passwords by email.`,
      };

    case 'password-reset':
      return {
        html: layout(
          'Reset your eSign password',
          p(`Hello ${e('name')},`) +
            p(
              d.byAdmin
                ? 'An administrator reset your Ruliba Clays eSign password. Your old password no longer works. Open the link below to choose a new one.'
                : 'Someone, hopefully you, asked to reset your Ruliba Clays eSign password. Open the link below to choose a new one.',
            ) +
            button(d.link, 'Choose a new password') +
            quiet(
              `This link works once, until ${e('expires')}. ${d.byAdmin ? '' : 'If you did not ask for this, ignore this email: your password stays the same. '}Two-step sign-in still applies. We never send passwords by email.`,
            ),
          appUrl,
        ),
        text: `Hello ${d.name},

${d.byAdmin ? 'An administrator reset your Ruliba Clays eSign password. Your old password no longer works.' : 'Someone, hopefully you, asked to reset your Ruliba Clays eSign password.'} Choose a new password here:

${d.link}

This link works once, until ${d.expires}. ${d.byAdmin ? '' : 'If you did not ask for this, ignore this email: your password stays the same. '}Two-step sign-in still applies. We never send passwords by email.`,
      };

    case 'sign-invite':
      return {
        html: layout(
          d.reminder ? `Reminder: ${d.title}` : `Please sign: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`${e('senderName')} of Ruliba Clays has sent you <b>${e('title')}</b>${d.reference ? ` (${e('reference')})` : ''} to sign.`) +
            (d.message ? `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #f26b3a;background:#f8f8f7">${e('message').replace(/\n/g, '<br>')}</blockquote>` : '') +
            (d.activationLink
              ? p('<b>First, activate your Ruliba Clays eSign account</b> and choose your password. You can sign once your account is active.') +
                button(d.activationLink, '1. Activate my account') +
                p('Then open the document:') +
                button(d.link, '2. Review and sign')
              : button(d.link, d.internal ? 'Open in eSign and sign' : 'Review and sign')) +
            quiet(
              d.internal
                ? `Sign in to eSign with your Ruliba account to sign; the link takes you to the document.${d.expires ? ` Please sign before ${e('expires')}.` : ''}`
                : `We will email you a one-time code to confirm it is you. No account or password is needed.${d.expires ? ` This link works until ${e('expires')}.` : ''} Do not forward this email: the link is for you alone.`,
            ),
          appUrl,
        ),
        text: `Hello ${d.name},\n\n${d.senderName} of Ruliba Clays has sent you "${d.title}"${d.reference ? ` (${d.reference})` : ''} to sign.\n\n${d.message ? d.message + '\n\n' : ''}${d.activationLink ? `First activate your eSign account and choose your password: ${d.activationLink}\n\nThen review and sign: ` : 'Review and sign: '}${d.link}\n\n${d.internal ? `Sign in to eSign with your Ruliba account to sign.${d.expires ? ` Please sign before ${d.expires}.` : ''}` : `We will email you a one-time code to confirm it is you.${d.expires ? ` This link works until ${d.expires}.` : ''} Do not forward this email: the link is for you alone.`}`,
      };

    case 'sign-code':
      return {
        html: layout(
          `Your code: ${d.code}`,
          p(`Hello ${e('name')},`) +
            p(`Use this code to open <b>${e('title')}</b>:`) +
            `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:10px 0 16px;color:#2e323c">${e('code')}</p>` +
            quiet('It works for 10 minutes. If you did not ask for it, someone may have your signing link: tell the sender.'),
          appUrl,
        ),
        text: `Hello ${d.name},\n\nYour code to open "${d.title}" is: ${d.code}\n\nIt works for 10 minutes. If you did not ask for it, someone may have your signing link: tell the sender.`,
      };

    case 'document-completed':
      return {
        html: layout(
          `Signed by everyone: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`Everyone has signed <b>${e('title')}</b>${d.reference ? ` (${e('reference')})` : ''}.`) +
            p(d.attached ? 'The signed copy, with its signing record, is attached. Keep it for your files.' : 'The signed copy is too large to attach. Ask the sender for it, or staff can download it from eSign.') +
            (d.link ? button(d.link, 'Open in eSign (Ruliba staff)') : '') +
            quiet(`Fingerprint of the signed file (SHA-256): ${e('sha256')}`),
          appUrl,
        ),
        text: `Hello ${d.name},\n\nEveryone has signed "${d.title}"${d.reference ? ` (${d.reference})` : ''}.\n${d.attached ? 'The signed copy, with its signing record, is attached.' : 'The signed copy is too large to attach. Ask the sender for it.'}\n\nFingerprint of the signed file (SHA-256): ${d.sha256}`,
      };

    case 'document-declined':
      return {
        html: layout(
          `Declined: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`${e('decliner')} declined to sign <b>${e('title')}</b>. Signing has stopped.`) +
            `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #b42318;background:#fdecea">${e('reason')}</blockquote>` +
            button(d.link, 'Open the document'),
          appUrl,
        ),
        text: `Hello ${d.name},\n\n${d.decliner} declined to sign "${d.title}". Signing has stopped.\n\nReason: ${d.reason}\n\n${d.link}`,
      };

    case 'document-voided':
      return {
        html: layout(
          `Cancelled: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`${e('senderName')} cancelled <b>${e('title')}</b>. There is nothing more to sign, and any earlier link no longer works.`) +
            `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #646a75;background:#f8f8f7">${e('reason')}</blockquote>`,
          appUrl,
        ),
        text: `Hello ${d.name},\n\n${d.senderName} cancelled "${d.title}". There is nothing more to sign, and any earlier link no longer works.\n\nReason: ${d.reason}`,
      };

    case 'document-expired':
      return {
        html: layout(
          `Expired: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`The signing links for <b>${e('title')}</b> have expired before everyone signed. Nothing more can be signed on this copy.`) +
            (d.link ? button(d.link, 'Open the document') : '') +
            quiet('To continue, the sender prepares the document again and sends a new one.'),
          appUrl,
        ),
        text: `Hello ${d.name},\n\nThe signing links for "${d.title}" have expired before everyone signed. Nothing more can be signed on this copy.\n${d.link ? d.link + '\n' : ''}\nTo continue, the sender prepares the document again and sends a new one.`,
      };

    case 'approval-request':
      return {
        html: layout(
          `Approval needed: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`${e('senderName')} has sent <b>${e('title')}</b> for your approval before it goes out for signing.`) +
            (d.message ? `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #f26b3a;background:#f8f8f7">${e('message').replace(/\n/g, '<br>')}</blockquote>` : '') +
            button(d.link, 'Review and approve') +
            quiet('You will need to sign in to Ruliba Clays eSign.'),
          appUrl,
        ),
        text: `Hello ${d.name},\n\n${d.senderName} has sent "${d.title}" for your approval before it goes out for signing.\n\nReview and approve: ${d.link}`,
      };

    case 'approval-returned':
      return {
        html: layout(
          `Returned for changes: ${d.title}`,
          p(`Hello ${e('name')},`) +
            p(`${e('approver')} returned <b>${e('title')}</b> to you. It is a draft again; correct it and send it again.`) +
            `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #b42318;background:#fdecea">${e('reason')}</blockquote>` +
            button(d.link, 'Open the draft'),
          appUrl,
        ),
        text: `Hello ${d.name},\n\n${d.approver} returned "${d.title}" to you. It is a draft again; correct it and send it again.\n\nReason: ${d.reason}\n\n${d.link}`,
      };

    case 'audit-anchor':
      return {
        html: layout(
          `eSign activity log fingerprint, ${d.date}`,
          p('This is the daily fingerprint of the Ruliba Clays eSign activity log. Keep these emails: they let anyone show later that the log was not rewritten.') +
            `<p style="font-family:Consolas,monospace;font-size:14px;word-break:break-all;background:#f8f8f7;padding:10px">${e('hash')}</p>` +
            quiet(`Entries checked: ${e('count')}. Result: ${e('result')}.`),
          appUrl,
        ),
        text: `Daily fingerprint of the Ruliba Clays eSign activity log (${d.date}):\n${d.hash}\nEntries checked: ${d.count}. Result: ${d.result}.`,
      };
  }
}
