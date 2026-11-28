// Flow artifacts: the screenshots and desktop logs a flow keeps for a report
// or for diagnosing a failure.
//
// They are never repository files and never go to a path that only exists on
// one machine. Every artifact lands in the flow's own temp fixtures directory,
// which the runner removes when it exits. To keep them, name a directory with
// MOSA_E2E_SHOT_COPY_TO: each artifact is also copied there under the same
// file name (CI points it at the folder it uploads when a shard fails).
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ARTIFACT_COPY_ENV = "MOSA_E2E_SHOT_COPY_TO";

export function flowArtifactDir(ctx) {
  return join(ctx.fixturesDir, "artifacts");
}

// The surviving copy is a convenience for whoever reads the report; failing to
// write it must not fail the flow, but it is reported instead of swallowed.
async function keepCopy(fileName, write) {
  const copyTo = process.env[ARTIFACT_COPY_ENV];
  if (!copyTo) return;
  try {
    await mkdir(copyTo, { recursive: true });
    await write(join(copyTo, fileName));
  } catch (error) {
    console.log(`[e2e] could not keep a copy of ${fileName} in ${copyTo}: ${error.message}`);
  }
}

/** Write `data` as a flow artifact; returns the path inside the run's temp root. */
export async function writeFlowArtifact(ctx, fileName, data) {
  const dir = flowArtifactDir(ctx);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, data);
  await keepCopy(fileName, (target) => writeFile(target, data));
  return filePath;
}

/** Keep an existing file (a desktop main log, say) as a flow artifact. */
export async function copyFlowArtifact(ctx, sourcePath, fileName) {
  const dir = flowArtifactDir(ctx);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await copyFile(sourcePath, filePath);
  await keepCopy(fileName, (target) => copyFile(sourcePath, target));
  return filePath;
}
