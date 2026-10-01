# Business email deliverability

Publish DMARC for `albertogdlc.org`, then inspect received-message authentication headers before attributing spam placement to any one cause.

## Measured findings

- `_dmarc.albertogdlc.org` TXT returned NXDOMAIN during this investigation.
- `resend._domainkey.albertogdlc.org` publishes a DKIM public key.
- `send.albertogdlc.org` TXT publishes `v=spf1 include:amazonses.com ~all`.
- The service sends from `notificaciones@albertogdlc.org`.
- Resend dashboard inspection was denied by the browser; its domain status has not been independently verified.

These DNS records alone do not prove that an individual message passed aligned SPF/DKIM or explain Outlook's spam decision. Inspect `Authentication-Results`, the DKIM signing domain and the envelope sender in the received message.

## Cloudflare setup

In the `albertogdlc.org` zone, add:

| Field | Exact value |
|---|---|
| Type | TXT |
| Name | `_dmarc` |
| Content | `v=DMARC1; p=none;` |
| TTL | Auto |

`p=none` does not request rejection or quarantine for DMARC failures and does not guarantee inbox placement. It enables an initial non-enforcing policy; aggregate reports require a valid receiving address in `rua`, which has deliberately not been invented here. Re-query public DNS after publishing. [Resend DMARC guidance](https://resend.com/docs/dashboard/domains/dmarc).

## Reputation and verification

New senders can still land in spam after correct authentication; reputation builds over time, with no guaranteed warm-up duration. Mark legitimate test messages as not spam and add the sender to contacts or safe senders. This helps the recipient's mailbox classification but is not a guaranteed immediate global reputation fix. [Microsoft sender support](https://support.microsoft.com/en-us/outlook/sender-support-in-outlook-com).

HTML appearance and authentication are separate concerns. The business templates use table layouts, inline CSS and system font fallbacks: [Mailchimp HTML guidance](https://templates.mailchimp.com/development/html/), [CSS in email](https://mailchimp.com/help/css-in-html-email/). Browser previews cannot certify desktop Outlook rendering or delivery.
