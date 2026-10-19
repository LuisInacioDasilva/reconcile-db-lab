import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const sql = (name) => fileURLToPath(new URL(`../sql/${name}`, import.meta.url));

export async function createDatabase({ seed = false } = {}) {
  const db = new PGlite();
  await db.exec(await readFile(sql('001_up.sql'), 'utf8'));
  await db.exec(await readFile(sql('002_up.sql'), 'utf8'));
  if (seed) await seedDatabase(db);
  return db;
}

export async function seedDatabase(db) {
  await db.exec(await readFile(sql('seed.sql'), 'utf8'));
  return db.exec(await readFile(sql('seed_snapshots.sql'), 'utf8'));
}

export async function rollbackDatabase(db) {
  await db.exec(await readFile(sql('002_down.sql'), 'utf8'));
  return db.exec(await readFile(sql('001_down.sql'), 'utf8'));
}
