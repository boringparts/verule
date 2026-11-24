import { accounts } from "@verule/acceptance-host-drizzle-data";

function registerTable(_table: unknown): void {}

export function initAccountTables(): void {
  registerTable(accounts);
}
