/**
 * What `src/core/index.ts` reaches: the files it imports through relative paths, and the
 * non-relative specifiers (packages and Node built-ins) those files import. This is what the
 * package is built from, so the pins test and the smoke check both read it from here.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ts from "typescript";

export interface CoreImports {
  /** Absolute paths, sorted. */
  files: string[];
  /** Module specifiers as written, sorted. */
  specifiers: string[];
}

export function readCoreImports(entry: string): CoreImports {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (fileName.startsWith(".")) pending.push(resolve(dirname(file), fileName));
      else specifiers.add(fileName);
    }
  }
  return { files: [...files].sort(), specifiers: [...specifiers].sort() };
}
