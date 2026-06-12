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
});
