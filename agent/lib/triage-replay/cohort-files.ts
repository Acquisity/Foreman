import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The real path of a file that must live outside this repository. Both paths
 * are resolved through symlinks first, so a link, a relative path or a name
 * such as `..x.json` can't pass for an outside file. Throws when the file is
 * missing or inside the repository.
 */
export function outsideRepositoryPath(
  path: string,
  what: string,
  root: string = REPOSITORY_ROOT
): string {
  const real = realpathSync(resolve(path));
  const fromRoot = relative(realpathSync(root), real);
  const inside =
    fromRoot === "" ||
    !(
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    );
  if (inside) {
    throw new Error(
      `${what} must live outside this repository; ${path} is inside it.`
    );
  }
  return real;
}
