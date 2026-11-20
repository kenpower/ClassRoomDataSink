import type { TestProject } from 'vitest/node';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';

let container: StartedMySqlContainer | undefined;

/**
 * Starts MySQL with Testcontainers for integration and abuse tests.
 * Set TEST_DB_HOST (etc.) to use an existing server instead, or run only `test/unit` to skip the DB.
 */
export async function setup(project: TestProject) {
  if (process.env.TEST_DB_HOST) {
    project.provide('db', {
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT ?? 3306),
      user: process.env.TEST_DB_USER ?? 'root',
      password: process.env.TEST_DB_PASSWORD ?? 'root',
      database: process.env.TEST_DB_NAME ?? 'roomsink_test',
    });
    return;
  }
  container = await new MySqlContainer('mysql:8.4').withDatabase('roomsink_test').withRootPassword('root').start();
  project.provide('db', {
    host: container.getHost(),
    port: container.getPort(),
    user: 'root',
    password: 'root',
    database: 'roomsink_test',
  });
}

export async function teardown() {
  await container?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    db: { host: string; port: number; user: string; password: string; database: string };
  }
}
