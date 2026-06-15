import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createDiffEntry } from '@tremurex/shared';
import { createDb } from '../db/client.js';
import type { Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { alerts, baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { DependencyRow, DiffRow } from '../db/schema.js';
import {
  buildPayload,
  createAlertDispatcher,
  createEmailChannel,
  createSlackChannel,
  createWebhookChannel,
  formatEmailSubject,
  formatEmailText,
  formatSlackText,
} from './alerting.js';
import type { AlertPayload, MailMessage } from './alerting.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const TEST_DB = 'tremurex_test';
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

let db: Db;
let pool: pg.Pool;
let server: http.Server;
let webhookUrl: string;
let received: { body: string }[] = [];
let respondWith = 200;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  ({ db, pool } = createDb(TEST_URL));
  await runMigrations(db);

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ body });
      res.statusCode = respondWith;
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  webhookUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  received = [];
  respondWith = 200;
  await db.delete(alerts);
  await db.delete(diffs);
  await db.delete(baselines);
  await db.delete(samples);
  await db.delete(dependencies);
});

async function fixture(): Promise<{ dependency: DependencyRow; diffRow: DiffRow }> {
  const [dependency] = await db
    .insert(dependencies)
    .values({ name: 'payments-api', url: 'https://api.example.test/v1' })
    .returning();
  if (!dependency) throw new Error('insert failed');
  const [baseline] = await db
    .insert(baselines)
    .values({ dependencyId: dependency.id, schema: { type: 'object' }, sampleCount: 3 })
    .returning();
  if (!baseline) throw new Error('insert failed');
  const [diffRow] = await db
    .insert(diffs)
    .values({
      dependencyId: dependency.id,
      baselineId: baseline.id,
      entries: [
        createDiffEntry('required-field-removed', ['id'], { before: { type: 'integer' } }),
        createDiffEntry('field-added', ['note'], { after: { type: 'string' } }),
      ],
      severity: 'BREAKING',
      capturedSchema: { type: 'object' },
    })
    .returning();
  if (!diffRow) throw new Error('insert failed');
  return { dependency, diffRow };
}

describe('webhook channel', () => {
  it('POSTs the structured payload and records a sent alert', async () => {
    const { dependency, diffRow } = await fixture();
    const dispatch = createAlertDispatcher(db, [createWebhookChannel(webhookUrl)]);
    await dispatch({ dependency, diffRow, severity: 'BREAKING' });

    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]?.body ?? '{}') as AlertPayload;
    expect(payload.event).toBe('drift-detected');
    expect(payload.severity).toBe('BREAKING');
    expect(payload.dependency.name).toBe('payments-api');
    expect(payload.entries).toHaveLength(2);

    const history = await db.select().from(alerts);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ channel: 'webhook', status: 'sent', error: null });
  });

  it('records a failed alert when the webhook rejects, without throwing', async () => {
    const { dependency, diffRow } = await fixture();
    respondWith = 500;
    const dispatch = createAlertDispatcher(db, [createWebhookChannel(webhookUrl)]);
    await expect(dispatch({ dependency, diffRow, severity: 'BREAKING' })).resolves.toBeUndefined();

    const history = await db.select().from(alerts);
    expect(history[0]).toMatchObject({ channel: 'webhook', status: 'failed' });
    expect(history[0]?.error).toContain('500');
  });

  it('never includes request headers or captured values in the payload', async () => {
    const { dependency, diffRow } = await fixture();
    await db.update(dependencies).set({ headers: { authorization: 'Bearer super-secret' } });
    const dispatch = createAlertDispatcher(db, [createWebhookChannel(webhookUrl)]);
    await dispatch({ dependency, diffRow, severity: 'BREAKING' });
    expect(received[0]?.body).not.toContain('super-secret');
    expect(received[0]?.body).not.toContain('authorization');
  });
});

describe('slack channel', () => {
  it('posts a readable summary to the configured channel and records it', async () => {
    const { dependency, diffRow } = await fixture();
    const posted: { channel: string; text: string }[] = [];
    const fakeSlack = {
      chat: {
        postMessage: (args: { channel: string; text: string }) => {
          posted.push(args);
          return Promise.resolve({ ok: true });
        },
      },
    };
    const dispatch = createAlertDispatcher(db, [createSlackChannel('#drift', fakeSlack)]);
    await dispatch({ dependency, diffRow, severity: 'BREAKING' });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.channel).toBe('#drift');
    expect(posted[0]?.text).toContain('BREAKING');
    expect(posted[0]?.text).toContain('payments-api');
    expect(posted[0]?.text).toContain('required-field-removed');

    const history = await db.select().from(alerts);
    expect(history[0]).toMatchObject({ channel: 'slack', status: 'sent' });
  });

  it('one failing channel does not block the other', async () => {
    const { dependency, diffRow } = await fixture();
    const failingSlack = {
      chat: {
        postMessage: () => Promise.reject(new Error('slack_unavailable')),
      },
    };
    const dispatch = createAlertDispatcher(db, [
      createSlackChannel('#drift', failingSlack),
      createWebhookChannel(webhookUrl),
    ]);
    await dispatch({ dependency, diffRow, severity: 'WARNING' });

    expect(received).toHaveLength(1); // webhook still delivered
    const history = await db.select().from(alerts);
    expect(history.map((h) => [h.channel, h.status]).sort()).toEqual([
      ['slack', 'failed'],
      ['webhook', 'sent'],
    ]);
  });
});

describe('email channel', () => {
  it('sends a formatted message via the transport and records it sent', async () => {
    const { dependency, diffRow } = await fixture();
    const sent: MailMessage[] = [];
    const transport = {
      sendMail: (m: MailMessage) => {
        sent.push(m);
        return Promise.resolve({ messageId: 'x' });
      },
    };
    const dispatch = createAlertDispatcher(db, [
      createEmailChannel({ from: 'Tremurex <a@x.test>', to: 'oncall@x.test' }, transport),
    ]);
    await dispatch({ dependency, diffRow, severity: 'BREAKING' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'Tremurex <a@x.test>', to: 'oncall@x.test' });
    expect(sent[0]?.subject).toContain('BREAKING');
    expect(sent[0]?.subject).toContain('payments-api');
    expect(sent[0]?.text).toContain('required-field-removed at $.id');

    const history = await db.select().from(alerts);
    expect(history[0]).toMatchObject({ channel: 'email', status: 'sent' });
  });

  it('records a failed alert when the transport throws, without throwing', async () => {
    const { dependency, diffRow } = await fixture();
    const transport = { sendMail: () => Promise.reject(new Error('smtp_connection_refused')) };
    const dispatch = createAlertDispatcher(db, [
      createEmailChannel({ from: 'a@x.test', to: 'b@x.test' }, transport),
    ]);
    await expect(dispatch({ dependency, diffRow, severity: 'BREAKING' })).resolves.toBeUndefined();

    const history = await db.select().from(alerts);
    expect(history[0]).toMatchObject({ channel: 'email', status: 'failed' });
    expect(history[0]?.error).toContain('smtp_connection_refused');
  });

  it('never includes request headers or captured values in the message', async () => {
    const { dependency, diffRow } = await fixture();
    await db.update(dependencies).set({ headers: { authorization: 'Bearer super-secret' } });
    const sent: MailMessage[] = [];
    const transport = {
      sendMail: (m: MailMessage) => {
        sent.push(m);
        return Promise.resolve({});
      },
    };
    const dispatch = createAlertDispatcher(db, [
      createEmailChannel({ from: 'a@x.test', to: 'b@x.test' }, transport),
    ]);
    await dispatch({ dependency, diffRow, severity: 'BREAKING' });
    const blob = JSON.stringify(sent[0]);
    expect(blob).not.toContain('super-secret');
    expect(blob).not.toContain('authorization');
  });
});

describe('payload formatting', () => {
  it('summarizes counts and truncates long entry lists in Slack text', async () => {
    const { dependency, diffRow } = await fixture();
    const payload = buildPayload({ dependency, diffRow, severity: 'BREAKING' });
    const many = {
      ...payload,
      entries: Array.from({ length: 8 }, (_, i) =>
        createDiffEntry('field-added', [`f${String(i)}`], { after: { type: 'string' } }),
      ),
    };
    const text = formatSlackText(many);
    expect(text).toContain('8 INFO');
    expect(text).toContain('…and 3 more');
  });

  it('lists every entry and a severity summary in email text', async () => {
    const { dependency, diffRow } = await fixture();
    const payload = buildPayload({ dependency, diffRow, severity: 'BREAKING' });

    expect(formatEmailSubject(payload)).toBe('[Tremurex] BREAKING drift in payments-api');
    const text = formatEmailText(payload);
    expect(text).toContain('1 BREAKING, 1 INFO');
    expect(text).toContain('[BREAKING] required-field-removed at $.id');
    expect(text).toContain('[INFO] field-added at $.note');
    expect(text).toContain(`Diff ID: ${payload.diffId}`);
  });
});
