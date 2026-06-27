#!/usr/bin/env bun
/**
 * Dev loop: symlink this rib into a local Keelson checkout so the server's
 * boot-time discovery finds it (exactly as a published install would), then:
 *
 *   bun dev/link.ts
 *   cd <keelson> && KEELSON_RIBS=squad bun dev
 *
 * Discovery scans `<cwd>/node_modules/@keelson`. `keelson serve` runs from the
 * project root, but the monorepo's `bun dev:server` runs with cwd = apps/server
 * — so we link into every plausible scan root. Override the Keelson location
 * with KEELSON_DIR.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const keelson = process.env.KEELSON_DIR ?? resolve(import.meta.dir, "../../keelson");
const target = resolve(import.meta.dir, "..");

const scanRoots = [keelson, resolve(keelson, "apps/server")].filter((dir) => existsSync(dir));

for (const dir of scanRoots) {
  const linkDir = `${dir}/node_modules/@keelson`;
  const link = `${linkDir}/rib-squad`;
  Bun.spawnSync(["mkdir", "-p", linkDir]);
  const res = Bun.spawnSync(["ln", "-sfn", target, link]);
  if (res.exitCode !== 0) {
    console.error(`failed to link ${link}: ${res.stderr.toString().trim()}`);
    process.exit(1);
  }
  console.log(`linked ${link} -> ${target}`);
}
console.log(`next:  cd ${keelson} && KEELSON_RIBS=squad bun dev`);
