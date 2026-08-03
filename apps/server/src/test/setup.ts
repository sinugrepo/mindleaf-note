process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/mindleaf_test';
process.env.SESSION_SECRET ??= 'test-session-secret-not-for-production';
process.env.MASTER_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.ALLOWED_ORIGIN ??= 'http://localhost:3000';
