import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "../../..");

describe("SQLite native wrapper lifetime", () => {
  test.each([
    { embeddings: false, retainReferences: false },
    { embeddings: false, retainReferences: true },
    { embeddings: true, retainReferences: false },
    { embeddings: true, retainReferences: true },
  ])("exits normally with embeddings=$embeddings and retained references=$retainReferences", async ({ embeddings, retainReferences }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "foreman-sqlite-lifetime-"));
    try {
      const script = `
        const assert = require("node:assert/strict");
        const Database = require("better-sqlite3");
        ${embeddings ? `
          const { FlagEmbedding, EmbeddingModel } = require("fastembed");
          assert.equal(typeof FlagEmbedding.init, "function");
          assert.equal(EmbeddingModel.BGESmallENV15, "fast-bge-small-en-v1.5");
        ` : ""}

        const resources = [];
        for (let index = 0; index < 10_000; index++) {
          const db = new Database(":memory:");
          const statement = db.prepare("SELECT 42 AS answer");
          assert.equal(statement.get().answer, 42);
          db.close();
          ${retainReferences ? "resources.push({ db, statement });" : ""}
        }
        globalThis.resources = resources;

        const db = new Database(process.argv[1]);
        db.exec("CREATE TABLE embedding (model TEXT, vector BLOB)");
        const vector = Buffer.from(Float32Array.from([1, 0, 0]).buffer);
        db.prepare("INSERT INTO embedding VALUES (?, ?)").run("bge-small-en-v1.5", vector);
        db.close();
        const reopened = new Database(process.argv[1], { readonly: true, fileMustExist: true });
        const row = reopened.prepare("SELECT * FROM embedding").get();
        assert.equal(row.model, "bge-small-en-v1.5");
        assert.deepEqual(row.vector, vector);
        reopened.close();
        console.log("lifetime and persistence verified");
      `;

      for (let trial = 0; trial < 3; trial++) {
        const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", script, path.join(directory, `${trial}.db`)], {
          cwd: projectRoot,
          timeout: 15_000,
        });
        expect(stderr).toBe("");
        expect(stdout.trim()).toBe("lifetime and persistence verified");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
