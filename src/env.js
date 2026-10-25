// Loads variables from the project's .env file into process.env.
// This keeps the API key out of the code: the key lives only in .env,
// and .env is listed in .gitignore so it never gets committed.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export function loadEnv(path = DEFAULT_ENV_PATH) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();

    // Allow values wrapped in quotes: KEY="value"
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);

    // A real environment variable wins over the .env file
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
