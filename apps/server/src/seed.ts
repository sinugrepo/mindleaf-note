import { hash } from '@node-rs/argon2';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';

/**
 * Seed script: creates the single Mindleaf user with a master password.
 *
 * Usage:
 *   npm run seed                    # prompts for password
 *   MINDLEAF_SEED_PASSWORD=xxx npm run seed  # non-interactive (CI)
 *
 * The seed command is the only initial-account creation path. The HTTP API
 * intentionally does not expose a public setup endpoint.
 *
 * If a user already exists, the script exits with an error unless
 * --reset is passed (which re-hashes the password).
 */

async function main() {
  const args = process.argv.slice(2);
  const isReset = args.includes('--reset');

  // Check for existing user.
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0 && !isReset) {
    console.error('✗ A user already exists. Use --reset to re-hash the password.');
    process.exit(1);
  }

  // Get password from env or prompt.
  let password = process.env.MINDLEAF_SEED_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    password = await new Promise<string>((resolve) => {
      rl.question('Enter master password (min 8 chars): ', (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  if (!password || password.length < 8) {
    console.error('✗ Password must be at least 8 characters.');
    process.exit(1);
  }

  // Hash with OWASP-recommended Argon2id parameters.
  // Algorithm.Argon2id = 2 (can't use the enum directly with isolatedModules).
  const passwordHash = await hash(password, {
    algorithm: 2, // Argon2id
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });

  if (existing.length > 0 && isReset) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, existing[0].id));
    console.log('✓ Password updated.');
  } else {
    await db.insert(users).values({ passwordHash });
    console.log('✓ User created. You can now log in.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
