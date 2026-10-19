import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const sql = (name) => fileURLToPath(new URL(`../sql/${name}`, import.meta.url));

export async function createDatabase({ seed = false } = {}) {
  const db = new PGlite();
  await db.exec(await readFile(sql('001_up.sql'), 'utf8'));
  if (seed) await db.exec(await readFile(sql('seed.sql'), 'utf8'));
  return db;
}

export async function seedDatabase(db) {
  return db.exec(await readFile(sql('seed.sql'), 'utf8'));
}

export async function rollbackDatabase(db) {
  return db.exec(await readFile(sql('001_down.sql'), 'utf8'));
}
