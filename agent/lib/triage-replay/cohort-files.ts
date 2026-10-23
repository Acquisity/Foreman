import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const JSON_FILE = /\.json$/u;

/**
 * Every file the cohort hash covers: the case files and the frozen lists the
 * replay reads, named `cases/<file>` and `frozen/<file>` so the hash changes
 * when either side does.
 */
export function readCohortFiles(dir: string) {
  return ["cases", "frozen"].flatMap((folder) =>
    readdirSync(join(dir, folder))
      .filter((name) => JSON_FILE.test(name))
      .map((name) => ({
        content: readFileSync(join(dir, folder, name)),
        name: `${folder}/${name}`,
      }))
  );
}
