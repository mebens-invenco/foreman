import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const isDirectoryEmpty = async (dirPath: string): Promise<boolean> => {
  const entries = await fs.readdir(dirPath);
  return entries.length === 0;
};

export const atomicWriteFile = async (
  filePath: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, contents, { encoding });
  await fs.rename(tempPath, filePath);
};

export const sha256File = async (filePath: string): Promise<string> => {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
};

export const walkParentsForFile = async (
  startPath: string,
  fileName: string,
): Promise<string | null> => {
  let current = path.resolve(startPath);

  while (true) {
    const candidate = path.join(current, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
};
