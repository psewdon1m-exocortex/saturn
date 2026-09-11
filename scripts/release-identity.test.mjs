import assert from "node:assert/strict";
import test from "node:test";
import { versionFromSaturnReleaseTag } from "./release-identity.mjs";

test("derives the stable version from a module-scoped Saturn release tag", () => {
  assert.equal(versionFromSaturnReleaseTag("saturn-v0.1.2"), "0.1.2");
  assert.equal(versionFromSaturnReleaseTag("saturn-v12.34.56"), "12.34.56");
});

test("rejects legacy and ambiguous release refs", () => {
  for (const value of ["v0.1.0", "saturn-0.1.0", "saturn-v01.0.0", "saturn-v0.1.0-beta.1", "refs/tags/saturn-v0.1.0"]) {
    assert.throws(() => versionFromSaturnReleaseTag(value), /saturn-vMAJOR\.MINOR\.PATCH/);
  }
});
