import { buildApp } from './app.js';

const app = buildApp();
const port = Number(process.env.CORE_PORT ?? 4000);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
