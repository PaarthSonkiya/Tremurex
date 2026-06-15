/**
 * Alert delivery (CLAUDE.md §8): fires on BREAKING/WARNING by default
 * (threshold checked upstream in the pipeline); INFO stays timeline-only.
 * Destinations come ONLY from user config (§7.1) — never from captured data.
 * Every attempt is recorded in alert history; a failing channel never fails
 * the poll job or blocks other channels.
 */
import { request } from 'undici';
import { WebClient } from '@slack/web-api';
import nodemailer from 'nodemailer';
import { countBySeverity } from '@tremurex/shared';
import type { Db } from '../db/client.js';
import { alerts } from '../db/schema.js';
import type { AlertDispatcher, DriftAlert } from '../pipeline/pipeline.js';

export interface AlertPayload {
  event: 'drift-detected';
  severity: string;
  dependency: { id: string; name: string; url: string };
  diffId: string;
  detectedAt: string;
  entries: DriftAlert['diffRow']['entries'];
}

export interface AlertChannel {
  name: 'webhook' | 'slack' | 'email';
  send(payload: AlertPayload): Promise<void>;
}

export function buildPayload(alert: DriftAlert): AlertPayload {
  return {
    event: 'drift-detected',
    severity: alert.severity,
    dependency: {
      id: alert.dependency.id,
      name: alert.dependency.name,
      // The monitored URL is user config, not captured data. Headers never
      // appear here.
      url: alert.dependency.url,
    },
    diffId: alert.diffRow.id,
    detectedAt: alert.diffRow.createdAt.toISOString(),
    entries: alert.diffRow.entries,
  };
}

export function createWebhookChannel(url: string): AlertChannel {
  return {
    name: 'webhook',
    async send(payload: AlertPayload): Promise<void> {
      const res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await res.body.dump();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`webhook returned HTTP ${String(res.statusCode)}`);
      }
    },
  };
}

/** Structural slice of @slack/web-api's WebClient, so tests can fake it. */
export interface SlackClientLike {
  chat: {
    postMessage(args: { channel: string; text: string }): Promise<unknown>;
  };
}

export function createSlackChannel(channel: string, client: SlackClientLike): AlertChannel {
  return {
    name: 'slack',
    async send(payload: AlertPayload): Promise<void> {
      await client.chat.postMessage({ channel, text: formatSlackText(payload) });
    },
  };
}

export function createSlackClient(token: string): SlackClientLike {
  return new WebClient(token);
}

/** One outbound email. Matches the slice of nodemailer's sendMail we use. */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** Structural slice of nodemailer's Transporter, so tests can fake it. */
export interface MailTransportLike {
  sendMail(message: MailMessage): Promise<unknown>;
}

export interface EmailChannelOptions {
  /** Envelope sender, e.g. "Tremurex <alerts@example.com>". */
  from: string;
  /** One or more recipients (a comma-separated list is allowed). */
  to: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** true for implicit TLS (port 465); false uses STARTTLS where offered. */
  secure: boolean;
  /** Omit for relays that accept unauthenticated mail. */
  auth?: { user: string; pass: string };
}

export function createEmailChannel(
  opts: EmailChannelOptions,
  transport: MailTransportLike,
): AlertChannel {
  return {
    name: 'email',
    async send(payload: AlertPayload): Promise<void> {
      await transport.sendMail({
        from: opts.from,
        to: opts.to,
        subject: formatEmailSubject(payload),
        text: formatEmailText(payload),
      });
    },
  };
}

export function createSmtpTransport(config: SmtpConfig): MailTransportLike {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth ? { auth: config.auth } : {}),
  });
}

export function formatEmailSubject(payload: AlertPayload): string {
  return `[Tremurex] ${payload.severity} drift in ${payload.dependency.name}`;
}

export function formatEmailText(payload: AlertPayload): string {
  const counts = countBySeverity({ entries: payload.entries });
  const summary = (['BREAKING', 'WARNING', 'INFO'] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${String(counts[s])} ${s}`)
    .join(', ');
  const lines = payload.entries.map((e) => `  • [${e.severity}] ${e.rule} at ${e.path}`);
  return [
    `Tremurex detected ${payload.severity} drift in ${payload.dependency.name} (${payload.dependency.url}).`,
    '',
    `Detected: ${payload.detectedAt}`,
    `Changes:  ${summary}`,
    '',
    ...lines,
    '',
    `Diff ID: ${payload.diffId}`,
  ].join('\n');
}

export function formatSlackText(payload: AlertPayload): string {
  const counts = countBySeverity({ entries: payload.entries });
  const summary = (['BREAKING', 'WARNING', 'INFO'] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${String(counts[s])} ${s}`)
    .join(', ');
  const lines = payload.entries
    .slice(0, 5)
    .map((e) => `• [${e.severity}] ${e.rule} at \`${e.path}\``);
  const more =
    payload.entries.length > 5 ? `\n…and ${String(payload.entries.length - 5)} more` : '';
  return (
    [
      `:rotating_light: *Tremurex drift detected* — *${payload.severity}*`,
      `Dependency: *${payload.dependency.name}* (${payload.dependency.url})`,
      `Changes: ${summary}`,
      ...lines,
    ].join('\n') + more
  );
}

/**
 * Fan a drift alert out to every configured channel, recording each attempt.
 */
export function createAlertDispatcher(db: Db, channels: AlertChannel[]): AlertDispatcher {
  return async (alert: DriftAlert): Promise<void> => {
    const payload = buildPayload(alert);
    for (const channel of channels) {
      let status: 'sent' | 'failed' = 'sent';
      let error: string | null = null;
      try {
        await channel.send(payload);
      } catch (err) {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
      }
      await db.insert(alerts).values({
        dependencyId: alert.dependency.id,
        diffId: alert.diffRow.id,
        channel: channel.name,
        status,
        error,
      });
    }
  };
}
