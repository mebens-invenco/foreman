import { createRepos } from "../repos/index.js";
import { openSqliteDatabase } from "../repos/impl/sqlite-database.js";
import { loadWorkspace } from "../workspace/load-workspace.js";

export const importLegacyMemory = async (workspaceName: string, legacyDbPath: string): Promise<void> => {
  const { paths } = await loadWorkspace(workspaceName);
  const repos = createRepos(await openSqliteDatabase(paths.dbPath));
  try {
    repos.migrationRunner.importLegacyDatabase(legacyDbPath);
  } finally {
    repos.close();
  }
};
