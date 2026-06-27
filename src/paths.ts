import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ribDataDir } from "@keelson/shared/paths";

// The Squad data home — the rib's data directory under the keelson home,
// captured once at activation from ctx.getDataDir() (setSquadDataHome) so every
// in-process reader (genesis write, charter reads, auth probe) and the baked-in
// roster bash node resolve the identical path, cwd-independently. The fallback,
// ribDataDir("squad"), is the same per-rib path the host's getDataDir seam
// returns, covering a harness predating the seam or an out-of-process caller
// with no captured value.
let dataHome: string | undefined;

export function setSquadDataHome(dir: string | undefined): void {
  dataHome = dir;
}

export function squadDataHome(): string {
  return dataHome ?? ribDataDir("squad");
}

export function membersDir(): string {
  return join(squadDataHome(), "members");
}

// Recursive mkdir doubles as a writability probe — idempotent if the dir exists
// (genesis creates it anyway), and fails only when the path isn't writable.
export async function isSquadDataHomeWritable(): Promise<boolean> {
  try {
    await mkdir(squadDataHome(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
