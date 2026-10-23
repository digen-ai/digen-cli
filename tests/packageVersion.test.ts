import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/lib/packageVersion.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
).version;

describe("packageVersion", () => {
  it("reads the version from the repo package.json", () => {
    expect(packageVersion()).toBe(expected);
  });

  it("finds package.json from a bundled dist path", () => {
    const bundled = pathToFileURL(join(root, "dist", "index.js")).href;
    expect(packageVersion(bundled)).toBe(expected);
  });
});
