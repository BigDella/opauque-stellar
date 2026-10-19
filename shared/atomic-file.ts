import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

let sequence = 0;

/** Write a file so readers see either the old complete value or the new one. */
export function writeAtomic(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${++sequence}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    const bytes = Buffer.from(contents, "utf8");
    const written = writeSync(fd, bytes, 0, bytes.length, 0);
    if (written !== bytes.length) throw new Error(`short write: ${written}/${bytes.length} bytes`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      // Best effort cleanup; preserve the original failure for the caller.
      unlinkSync(tempPath);
    } catch {
      // The original rename error is the actionable one.
    }
    throw err;
  }
}

/** Parse persisted JSON. Corrupt files are renamed aside before failing loudly. */
export function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (err) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(filePath, quarantinePath);
    } catch (quarantineErr) {
      throw new Error(`Could not parse or quarantine ${filePath}`, { cause: quarantineErr });
    }
    throw new Error(`Corrupt state moved to ${quarantinePath}`, { cause: err });
  }
}
