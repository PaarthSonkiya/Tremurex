import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.CORE_PORT).toBe(4000);
    expect(config.ALERT_THRESHOLD).toBe('WARNING');
    expect(config.ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it('treats blank strings (compose-interpolated unset vars) as absent', () => {
    const config = loadConfig({
      ALERT_WEBHOOK_URL: '',
      SLACK_BOT_TOKEN: '',
      SLACK_CHANNEL: '',
    });
    expect(config.ALERT_WEBHOOK_URL).toBeUndefined();
    expect(config.SLACK_BOT_TOKEN).toBeUndefined();
    expect(config.SLACK_CHANNEL).toBeUndefined();
  });

  it('accepts configured alert destinations and rejects malformed ones', () => {
    const config = loadConfig({
      ALERT_WEBHOOK_URL: 'https://hooks.example.test/tremurex',
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_CHANNEL: '#drift',
    });
    expect(config.ALERT_WEBHOOK_URL).toBe('https://hooks.example.test/tremurex');
    expect(() => loadConfig({ ALERT_WEBHOOK_URL: 'not-a-url' })).toThrow();
  });

  it('defaults SMTP settings: port 587, secure off, fields absent', () => {
    const config = loadConfig({});
    expect(config.SMTP_PORT).toBe(587);
    expect(config.SMTP_SECURE).toBe(false);
    expect(config.SMTP_HOST).toBeUndefined();
    expect(config.ALERT_EMAIL_FROM).toBeUndefined();
    expect(config.ALERT_EMAIL_TO).toBeUndefined();
  });

  it('parses SMTP config and coerces port; SMTP_SECURE is not footgun-truthy', () => {
    const config = loadConfig({
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'apikey',
      SMTP_PASS: 'secret',
      ALERT_EMAIL_FROM: 'Tremurex <a@x.test>',
      ALERT_EMAIL_TO: 'oncall@x.test,team@x.test',
    });
    expect(config.SMTP_PORT).toBe(465);
    expect(config.SMTP_SECURE).toBe(true);
    expect(config.ALERT_EMAIL_TO).toBe('oncall@x.test,team@x.test');
    // The literal string "false" must stay false (z.coerce.boolean would not).
    expect(loadConfig({ SMTP_SECURE: 'false' }).SMTP_SECURE).toBe(false);
    expect(loadConfig({ SMTP_SECURE: '' }).SMTP_SECURE).toBe(false);
  });
});
