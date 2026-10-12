import { openDb, closeDb } from '../src/main/db';
import { setSecretCipher } from '../src/main/repos/keys';
import { seedDatabase } from '../src/main/seed';

/** Fresh in-memory DB with migrations + seed data, and a reversible fake cipher. */
export function setupTestDb(): void {
  closeDb();
  setSecretCipher({
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (blob) => Buffer.from(blob.toString().slice(4), 'base64').toString(),
  });
  openDb(':memory:');
  seedDatabase();
}
