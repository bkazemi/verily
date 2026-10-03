import { Refused, type CodeProvider, type ExternalAccount } from '../core/index.js';
import { emailLogo } from './email-logo.js';
import { escape } from './escape.js';

/**
 * One message for whatever sends this deployment's mail, written twice: as HTML, and as
 * the plain text a reader without it is shown. Send both, as alternatives of one message.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Images the HTML shows, which travel inside the message and are attached inline under
   * the id the HTML names each by, as `cid:<contentId>`. A sender that leaves them out
   * still sends a whole message: the image's place reads "Verity" instead.
   */
  images: EmailImage[];
}

export interface EmailImage {
  contentId: string;
  filename: string;
  contentType: string;
  /** The image's bytes, in base 64. */
  content: string;
}

/** The logotype as the message carries it. */
const logo: EmailImage = {
  contentId: 'verity-logo',
  filename: 'verity.png',
  contentType: 'image/png',
  content: emailLogo,
};

export interface EmailProviderOptions {
  /** Shown as "Verify with …". */
  name?: string;
  /**
   * Hands one message to whatever sends this deployment's mail: an API, a relay, a queue.
   * Rejecting fails the flow. Nothing here retries, since a second message would carry a
   * code the holder was never shown a place to enter.
   */
  send(message: EmailMessage): Promise<void>;
}

/** Atoms and single dots, as an address is written without quoting. */
const local = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

const domain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Proves control of a mailbox by sending a code to it and having the holder read it back.
 * No registration with anybody and nothing published: the proof is that the code arrived,
 * so it says somebody could read that mailbox when the link was made, and nothing later.
 * A domain can hand an address to somebody else, which is why the link expires and is
 * renewed like any other.
 *
 * This sends mail to an address a visitor types, so the message carries the code, the
 * site's name and nothing a visitor chose. How often it may be asked to send is the
 * deployment's to limit, like every other request here.
 */
export function emailProvider(options: EmailProviderOptions): CodeProvider {
  return {
    id: 'email',
    name: options.name ?? 'Email',
    method: 'code',
    field: 'Your email address',
    input: 'email',
    account,

    async deliver({ account, link, code, siteName, expiresAt }) {
      // The name lands in a header, where a line break would start another one.
      const site = siteName.replace(/\s+/g, ' ').trim();

      const words = {
        ask: `Press the button to show ${site} that this address is yours.`,
        button: 'Confirm this address',
        enter: 'Or enter this code on the page that asked for it:',
        lasts: `Both work until ${new Date(expiresAt).toISOString().slice(11, 16)} UTC.`,
        ignore:
          'If you did not ask for this, ignore this message. Nothing is linked unless you confirm.',
      };

      await options.send({
        to: account.id,
        subject: `Confirm your address for ${site}`,
        text: [
          `Open this link to show ${site} that this address is yours:`,
          link,
          words.enter,
          code,
          words.lasts,
          words.ignore,
        ].join('\n\n'),
        html: letter({ link, code, ...words }),
        images: [logo],
      });
    },
  };
}

/**
 * The message as HTML, in the colours of the pages this library serves. Mail clients are
 * not browsers: the layout is a table and every style is on its element, because that is
 * what all of them keep, and the style block only adds a dark scheme where one is honoured.
 * Nothing is fetched, so there is nothing to block and nothing to tell anyone the message
 * was opened: the logotype is an image the message carries with it, on the plate it sits
 * on everywhere else, and where a client will not show it the word stands in its place.
 *
 * Everything sits on the column's middle, said twice over, as an attribute and as a style,
 * since clients differ on which they honour. The code's cell is padded three pixels more
 * on the left: letter spacing follows every character, the last included, and would
 * otherwise push the code that far off centre.
 */
function letter(parts: {
  link: string;
  code: string;
  ask: string;
  button: string;
  enter: string;
  lasts: string;
  ignore: string;
}): string {
  const sans = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Verity</title>
<style>
@media (prefers-color-scheme: dark) {
  .page { background: #161a18 !important; }
  .ink { color: #dde5e0 !important; }
  .muted { color: #96a39b !important; }
  .button { background: #7fc4a2 !important; }
  .button a { color: #10231a !important; }
  .code { background: #1d2220 !important; border-color: #2f3b35 !important; color: #dde5e0 !important; }
  .rule { border-color: #2f3b35 !important; }
}
</style>
</head>
<body class="page" style="margin:0;padding:0;background:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(parts.ask)} ${escape(parts.lasts)}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td align="center" style="padding:40px 16px 48px;">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;margin:0 auto;">
<tr><td align="center" style="padding:0 0 28px;">
<img src="cid:${logo.contentId}" width="97" height="40" alt="Verity" style="display:block;margin:0 auto;border:0;outline:none;font:700 20px/40px ${sans};color:#23312b;">
</td></tr>
<tr><td class="ink" align="center" style="padding:0 0 10px;font:650 22px/1.3 ${sans};color:#23312b;text-align:center;">Confirm your address</td></tr>
<tr><td class="ink" align="center" style="padding:0 0 24px;font:16px/1.6 ${sans};color:#23312b;text-align:center;">${escape(parts.ask)}</td></tr>
<tr><td align="center" style="padding:0 0 28px;">
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td class="button" align="center" style="background:#245f43;border-radius:10px;"><a href="${escape(parts.link)}" style="display:inline-block;padding:13px 26px;font:600 16px/1.2 ${sans};color:#ffffff;text-decoration:none;">${escape(parts.button)}</a></td></tr></table>
</td></tr>
<tr><td class="muted" align="center" style="padding:0 0 10px;font:14px/1.5 ${sans};color:#6b786f;text-align:center;">${escape(parts.enter)}</td></tr>
<tr><td class="code" align="center" style="padding:14px 12px 14px 15px;background:#f7f9f7;border:1px solid #dce2de;border-radius:10px;font:600 22px/1.2 ${mono};letter-spacing:.14em;color:#23312b;text-align:center;">${escape(parts.code)}</td></tr>
<tr><td class="muted" align="center" style="padding:12px 0 28px;font:14px/1.5 ${sans};color:#6b786f;text-align:center;">${escape(parts.lasts)}</td></tr>
<tr><td class="rule" style="border-top:1px solid #dce2de;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td class="muted" align="center" style="padding:18px 0 0;font:13px/1.6 ${sans};color:#6b786f;text-align:center;">${escape(parts.ignore)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The mailbox an address names. Lowercased throughout: the part before the @ may be case
 * sensitive by the letter of the standard and is not in any mailbox a person holds, and
 * two spellings of one address must not be two records. Nothing else is folded, because
 * whether a dot or a plus suffix names the same mailbox is each domain's own rule.
 */
function account(address: string): ExternalAccount {
  const text = address.trim().toLowerCase();
  const at = text.lastIndexOf('@');
  const name = text.slice(0, at);
  const host = text.slice(at + 1);

  if (
    at < 1 ||
    text.length > 254 ||
    name.length > 64 ||
    !local.test(name) ||
    !domain.test(host) ||
    // An address literal, or a name nobody could have registered.
    /^[\d.]+$/.test(host)
  )
    throw new Refused('Not an email address this can send to');

  return {
    id: text,
    kind: 'mailbox',
    handle: text,
    profileUrl: `mailto:${encodeURIComponent(name)}@${host}`,
  };
}
