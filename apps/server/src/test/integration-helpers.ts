import postgres from 'postgres';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db/index.js';
import { users, sessions, notes, attachments, tombstones } from '../db/schema.js';

/**
 * Integration tests are opt-in and require an explicit TEST_DATABASE_URL.
 * This prevents a normal unit-test run from accidentally mutating dev/prod.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const configuredDatabaseUrl = process.env.DATABASE_URL;
const testR2Endpoint = process.env.TEST_R2_ENDPOINT;
const testR2AccessKey = process.env.TEST_R2_ACCESS_KEY;
const testR2SecretKey = process.env.TEST_R2_SECRET_KEY;
const testR2Bucket = process.env.TEST_R2_BUCKET;

// Refuse an explicitly duplicated URL. The opt-in test suite must never be
// able to erase the application's normal database during cleanup.
if (testDatabaseUrl && configuredDatabaseUrl && testDatabaseUrl === configuredDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL must point to a dedicated database');
}

export const integrationEnabled = Boolean(testDatabaseUrl);
export const storageIntegrationEnabled = Boolean(
  integrationEnabled && testR2Endpoint && testR2AccessKey && testR2SecretKey && testR2Bucket,
);

export const integrationSql = integrationEnabled
  ? postgres(testDatabaseUrl!, { max: 3 })
  : null;

export const integrationS3 = storageIntegrationEnabled
  ? new S3Client({
      region: process.env.TEST_R2_REGION ?? 'auto',
      endpoint: testR2Endpoint,
      credentials: {
        accessKeyId: testR2AccessKey!,
        secretAccessKey: testR2SecretKey!,
      },
      forcePathStyle: true,
    })
  : null;

const execFileAsync = promisify(execFile);

export async function resetIntegrationStorage(): Promise<void> {
  if (!integrationS3 || !testR2Bucket) return;
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await integrationS3.send(new ListObjectsV2Command({
      Bucket: testR2Bucket,
      ContinuationToken: continuationToken,
    }));
    keys.push(
      ...(listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => Boolean(key)),
    );
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const batch = keys.slice(offset, offset + 1000);
    await integrationS3.send(new DeleteObjectsCommand({
      Bucket: testR2Bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })) },
    }));
  }
}

export function registerIntegrationLifecycle(): void {
  if (!integrationEnabled) return;

  beforeAll(async () => {
    if (!integrationSql) return;
    // Integration tests use a dedicated database and apply the current
    // schema there. This is intentionally opt-in and never runs against the
    // normal DATABASE_URL unless the caller explicitly sets both URLs to the
    // same value.
    const serverRoot = new URL('../../', import.meta.url).pathname;
    const testEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
    };
    await execFileAsync('npm', ['run', 'ownership:prepare'], {
      cwd: serverRoot,
      env: testEnv,
    });
    await execFileAsync('npm', ['run', 'db:push', '--', '--force'], {
      cwd: serverRoot,
      env: testEnv,
    });
    await integrationSql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;

    if (integrationS3 && testR2Bucket) {
      try {
        await integrationS3.send(new HeadBucketCommand({ Bucket: testR2Bucket }));
      } catch {
        await integrationS3.send(new CreateBucketCommand({ Bucket: testR2Bucket }));
      }
      await resetIntegrationStorage();
    }
  });

  beforeEach(async () => {
    await db.delete(tombstones);
    await db.delete(attachments);
    await db.delete(notes);
    await db.delete(sessions);
    await db.delete(users);
    await resetIntegrationStorage();
  });

  afterAll(async () => {
    await resetIntegrationStorage();
    await integrationSql?.end({ timeout: 5 });
    integrationS3?.destroy();
  });
}

export async function resetIntegrationSchema(): Promise<void> {
  if (!integrationSql) throw new Error('TEST_DATABASE_URL is required');
  await integrationSql`DROP TABLE IF EXISTS tombstones, attachments, notes, sessions, users CASCADE`;
}
