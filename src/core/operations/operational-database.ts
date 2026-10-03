import pg from 'pg';

/** Dedicated, same-process reader: never shared with application writes. */
export class OperationalDatabase {
  private readonly pool: pg.Pool;
  private closing = false;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 500,
      idleTimeoutMillis: 10_000, allowExitOnIdle: true, statement_timeout: 1500 });
    // Idle connection errors must not become uncaught exceptions.
    this.pool.on('error', () => {});
  }

  async query<T extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
    if (this.closing) throw new Error('Operational reader unavailable');
    let client: pg.PoolClient | undefined;
    let expired = false;
    let released = false;
    const release = (destroy: boolean) => {
      if (client && !released) { released = true; client.release(destroy); }
    };
    let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      const acquisition = this.pool.connect().then((acquired) => {
        if (expired) { acquired.release(true); throw new Error('Operational reader unavailable'); }
        client = acquired;
        return acquired;
      });
      await Promise.race([acquisition, new Promise<never>((_, reject) => {
        acquisitionTimer = setTimeout(() => { expired = true; reject(new Error('Operational reader unavailable')); }, 500);
        acquisitionTimer.unref();
      })]);
      clearTimeout(acquisitionTimer);
      if (!client || expired) throw new Error('Operational reader unavailable');
      const assertActive = () => { if (expired) throw new Error('Operational reader unavailable'); };
      await client.query('BEGIN READ ONLY');
      assertActive();
      await client.query("SET LOCAL statement_timeout = '1500ms'");
      assertActive();
      const result = await client.query<T>(text, values ? [...values] : undefined);
      assertActive();
      await client.query('COMMIT');
      return { rows: result.rows };
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => { expired = true; release(true); reject(new Error('Operational reader unavailable')); }, 2200);
        wallTimer.unref();
      })]);
    } catch (error) {
      expired = true;
      release(true); // Failed transactions and timeouts are never returned to the pool.
      throw error;
    } finally {
      clearTimeout(acquisitionTimer);
      clearTimeout(wallTimer);
      release(expired);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.pool.end();
  }
}
