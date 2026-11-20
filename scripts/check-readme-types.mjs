// Type-checks every fenced `ts` block of README.md with tsc (strict), each block
// as its own module. `@lexapi/client` resolves to the built types
// (dist/index.d.ts) by default, or to the sources with `--src`.
// Names the examples leave undeclared (`client`, `app`, …) are declared below.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv.includes("--src") ? join(root, "src/index.ts") : join(root, "dist/index.d.ts");
const readme = readFileSync(join(root, "README.md"), "utf8");
const blocks = [...readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
if (blocks.length === 0) throw new Error("no ts blocks found in README.md");

const dir = mkdtempSync(join(tmpdir(), "lexapi-readme-"));
try {
  const files = blocks.map((code, i) => {
    const file = join(dir, `block-${String(i + 1).padStart(2, "0")}.ts`);
    writeFileSync(file, `${code}\nexport {};\n`);
    return file;
  });
  writeFileSync(
    join(dir, "globals.d.ts"),
    [
      'declare const client: import("@lexapi/client").LexAPI;',
      "declare const myFetch: typeof fetch;",
      "interface ExpressRequest { body: Buffer; get(name: string): string | undefined }",
      "interface ExpressResponse { sendStatus(status: number): void }",
      "type ExpressHandler = (req: ExpressRequest, res: ExpressResponse) => unknown;",
      "declare const app: { post(path: string, ...handlers: ExpressHandler[]): void };",
      "declare const express: { raw(options: { type: string }): ExpressHandler };",
      'declare const req: import("node:events").EventEmitter;',
      "declare function handleRow(...args: unknown[]): void;",
    ].join("\n"),
  );
  const compilerOptions = {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    skipLibCheck: true, noEmit: true, types: ["node"], typeRoots: [join(root, "node_modules/@types")],
    baseUrl: dir, paths: { "@lexapi/client": [target] },
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, files: [join(dir, "globals.d.ts"), ...files] }));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { stdio: "pipe", cwd: dir });
  } catch (err) {
    process.stderr.write(String(err.stdout ?? "") + String(err.stderr ?? ""));
    process.exitCode = 1;
  }
  if (!process.exitCode) console.log(`README: ${blocks.length} ts blocks type-check against ${target.slice(root.length + 1)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
