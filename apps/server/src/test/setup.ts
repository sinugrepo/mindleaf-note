process.env.NODE_ENV ??= 'test';
// Normal unit tests stay database-free. PostgreSQL route tests are opt-in via
// TEST_DATABASE_URL and the integration helper refuses duplicate URLs.
// Do not manufacture a DATABASE_URL here: importing the app must remain safe
// when no test database has been provisioned.
if (!process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/mindleaf_test';
}
process.env.SESSION_SECRET ??= 'test-session-secret-not-for-production';
process.env.MASTER_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.ALLOWED_ORIGIN ??= 'http://localhost:3000';
// Object-storage integration tests opt in with TEST_R2_* variables. Copy
// them to the runtime names before route modules initialize their singleton.
if (process.env.TEST_R2_ENDPOINT) {
  process.env.R2_ENDPOINT ??= process.env.TEST_R2_ENDPOINT;
  process.env.R2_ACCESS_KEY ??= process.env.TEST_R2_ACCESS_KEY;
  process.env.R2_SECRET_KEY ??= process.env.TEST_R2_SECRET_KEY;
  process.env.R2_BUCKET ??= process.env.TEST_R2_BUCKET;
  process.env.R2_REGION ??= process.env.TEST_R2_REGION ?? 'auto';
}
