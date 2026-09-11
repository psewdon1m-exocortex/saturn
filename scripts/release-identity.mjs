import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const saturnReleaseTag = /^saturn-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function versionFromSaturnReleaseTag(tag) {
  const match = saturnReleaseTag.exec(tag);
  if (match === null) {
    throw new Error("Saturn release tags must match saturn-vMAJOR.MINOR.PATCH");
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const tag = process.argv[2];
  if (tag === undefined) throw new Error("Usage: release-identity.mjs <saturn-vMAJOR.MINOR.PATCH>");
  process.stdout.write(`${versionFromSaturnReleaseTag(tag)}\n`);
}
