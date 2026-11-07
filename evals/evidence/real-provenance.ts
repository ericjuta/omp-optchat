import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./real-budget.ts";
import { readBytes } from "./real-files.ts";

function sources(root: string, prefix: string): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("Implementation source symlinks are not admitted");
    return entry.isDirectory() ? sources(root, path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
/** Stable file-content binding; never includes private source paths or transcript bytes. */
export function implementationProvenance(root: string) {
  const paths = [
    ...sources(root, "src"),
    ...sources(root, "evals/evidence").filter((path) => path.split("/").at(-1)!.startsWith("real-")),
    "evals/recall/judge.ts", "evals/evidence/real-review.md", "plans/real-evidence-eval.md", "package.json", "bun.lock",
  ].sort();
  const files = paths.map((path) => {
    const bytes = readBytes(join(root, path));
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  // Package/lock binding is provenance, not a claim to have verified every installed dependency byte.
  const dependencies = ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-coding-agent"].map((name) => {
    const bytes = readFileSync(join(root, "node_modules", name, "package.json"));
    const metadata = JSON.parse(bytes.toString("utf8")) as { version?: unknown };
    if (typeof metadata.version !== "string") throw new Error("Dependency version unavailable");
    return { name, version: metadata.version, packageSha256: digest(bytes) };
  });
  const binding = { schemaVersion: 1, files, dependencies, bunVersion: Bun.version };
  return { ...binding, sha256: digest(JSON.stringify(binding)), dependencyIntegrity: "package manifests and lockfile only" };
}
