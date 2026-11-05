import { invoke } from "@tauri-apps/api/core";

export type Driver = "mysql" | "pgsql" | "sqlite";
export type SshAuth = "password" | "key";

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  keyPath: string;
}

export interface Connection {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  username: string;
  database: string;
  ssh: SshConfig | null;
  saved?: { dbPassword: boolean; sshPassword: boolean; keyPassphrase: boolean };
}

/** undefined = keep the stored value, "" = delete it */
export interface SecretsInput {
  dbPassword?: string;
  sshPassword?: string;
  keyPassphrase?: string;
}

export interface SessionInfo {
  sessionId: string;
  driver: string;
  server: string;
  username: string;
  password: string;
  database: string;
  token: string;
}

export interface Settings {
  lang: string;
  theme: string;
  zoom: number;
}

export interface AppInfo {
  version: string;
  keyringOk: boolean;
  phpUrl: string;
  settings: Settings;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  list: () => invoke<Connection[]>("list_connections"),
  save: (connection: Connection, secrets: SecretsInput) => invoke<Connection>("save_connection", { connection, secrets }),
  remove: (id: string) => invoke<void>("delete_connection", { id }),
  reorder: (ids: string[]) => invoke<void>("reorder_connections", { ids }),
  test: (connection: Connection, secrets: SecretsInput) => invoke<string>("test_connection", { connection, secrets }),
  forgetHostKey: (connection: Connection) => invoke<void>("forget_host_key", { connection }),
  openSession: (id: string) => invoke<SessionInfo>("open_session", { id }),
  closeSession: (sessionId: string) => invoke<void>("close_session", { sessionId }),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  pickFile: (kind: "sshKey" | "sqlite", current: string) => invoke<string | null>("pick_file", { kind, current }),
};

export const DRIVERS: Record<Driver, { label: string; port: number }> = {
  mysql: { label: "MySQL / MariaDB", port: 3306 },
  pgsql: { label: "PostgreSQL", port: 5432 },
  sqlite: { label: "SQLite", port: 0 },
};

export function describe(c: Connection): string {
  if (c.driver === "sqlite") return c.host;
  const db = `${c.username ? c.username + "@" : ""}${c.host}:${c.port || DRIVERS[c.driver].port}`;
  return c.ssh ? `${db} via ${c.ssh.username}@${c.ssh.host}` : db;
}
