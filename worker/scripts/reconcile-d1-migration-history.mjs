import { execFileSync } from "node:child_process";

const database = "telegram-video-clipper";
const migration = "0002_add_github_run_url.sql";

function execute(sql) {
  const stdout = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );

  let payload;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Could not parse Wrangler JSON output: ${stdout}`);
  }

  const batches = Array.isArray(payload) ? payload : [payload];
  return batches.flatMap((batch) =>
    Array.isArray(batch?.results) ? batch.results : []
  );
}

console.log("Checking remote D1 schema before applying migrations...");

const columns = execute("PRAGMA table_info('jobs')");
const hasJobsTable = columns.length > 0;
const hasGithubRunUrl = columns.some((column) => column.name === "github_run_url");

if (!hasJobsTable || !hasGithubRunUrl) {
  console.log(
    "The jobs.github_run_url column is absent. Leaving migration 0002 to Wrangler."
  );
  process.exit(0);
}

const historyTables = execute(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'"
);
const hasMigrationHistory = historyTables.some(
  (table) => table.name === "d1_migrations"
);

if (hasMigrationHistory) {
  const recorded = execute(
    "SELECT name FROM d1_migrations WHERE name = '0002_add_github_run_url.sql'"
  );
  if (recorded.length > 0) {
    console.log("Migration 0002 is already recorded; no reconciliation needed.");
    process.exit(0);
  }
}

console.log(
  "The column exists but migration 0002 is not recorded. Reconciling its index and migration record."
);

// Wrangler's documented D1 migration-history schema.
// The migration record is inserted only after confirming the column exists.
execute(`
  CREATE INDEX IF NOT EXISTS idx_jobs_github_run ON jobs(github_run_url);
  CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${migration}');
`);

console.log("Migration 0002 safely reconciled. Wrangler can now apply remaining migrations.");
