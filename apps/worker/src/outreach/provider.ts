import { log } from '../log.ts';

export interface OutreachMessage {
  channel: 'email' | 'sms';
  recipient: string;
  subject: string;
  body: string;
  link: string;
  subscription_id: string;
}

export type DeliveryResult =
  | { ok: true; provider_ref: string }
  | { ok: false; error: string; retryable: boolean };

export interface OutreachProvider {
  readonly name: string;
  send(message: OutreachMessage): Promise<DeliveryResult>;
}

export class UnconfiguredProvider implements OutreachProvider {
  readonly name = 'unconfigured';

  async send(): Promise<DeliveryResult> {
    return {
      ok: false,
      error: 'No delivery provider is configured. The link was created but not sent.',
      retryable: true,
    };
  }
}

export class LoggingProvider implements OutreachProvider {
  readonly name = 'logging';
  private counter = 0;

  async send(message: OutreachMessage): Promise<DeliveryResult> {
    this.counter += 1;
    log.info('outreach.delivered', {
      channel: message.channel,
      subscription_id: message.subscription_id,
      link: message.link,
    });
    return { ok: true, provider_ref: `log_${this.counter}` };
  }
}

export function makeOutreachProvider(): OutreachProvider {
  if (process.env['OUTREACH_PROVIDER'] === 'logging') return new LoggingProvider();
  return new UnconfiguredProvider();
}
