import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const guideSourcePath = (root: string, path: string): string => {
  const base = resolve(root);
  const target = resolve(path);
  const inside = (candidate: string) => {
    const offset = relative(base, candidate);
    return !(
      isAbsolute(offset) ||
      offset === ".." ||
      offset.startsWith(`..${sep}`)
    );
  };
  if (!inside(target)) {
    throw new Error(`guide source outside docs tree: ${path}`);
  }
  let current = base;
  const parts = relative(base, target).split(sep).filter(Boolean);
  for (const part of ["", ...parts]) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`guide source symlink: ${current}`);
    }
  }
  if (!inside(realpathSync(target))) {
    throw new Error(`guide source real path outside docs tree: ${path}`);
  }
  return target;
};
