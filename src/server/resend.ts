import type { EmailMessage } from './email.js';

/**
 * A `send` for `emailProvider()` that goes through Resend's HTTP API. It needs nothing but
 * `fetch` and a key, so it runs wherever this library does, a Worker included. A message Resend did not accept rejects,
 * which fails the flow that asked for it, and what Resend said is dropped with the rest
 * of the response: it can name the key's account and is nobody's to read.
 */
export function resendSender(options: {
  apiKey: string;
  /** The sender, as `Name <address>` or an address, on a domain verified with Resend. */
  from: string;
  fetch?: typeof fetch;
}): (message: EmailMessage) => Promise<void> {
  const request = options.fetch ?? fetch;

  return async ({ to, subject, text, html, images }) => {
    const response = await request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: options.from,
        to: [to],
        subject,
        text,
        html,
        // Attached under a content id, which is what makes Resend send an image inline.
        attachments: images.map((image) => ({
          filename: image.filename,
          content: image.content,
          content_type: image.contentType,
          content_id: image.contentId,
        })),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    await response.body?.cancel();

    if (!response.ok) throw new Error('Mail was not accepted');
  };
}
