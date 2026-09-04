import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function needsSsl(connectionString: string, explicit = process.env['DATABASE_SSL']): boolean {
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  if (/sslmode=disable/.test(connectionString)) return false;
  if (/sslmode=require|sslmode=verify/.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'db') return false;
    return true;
  } catch {
    return false;
  }
}

export function poolSize(): number {
  const raw = Number(process.env['DATABASE_POOL_MAX']);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 50);
  return 10;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) throw new Error('Missing required environment variable: DATABASE_URL');
    pool = new pg.Pool({
      connectionString,
      max: poolSize(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(needsSsl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
