import assert from "node:assert/strict"
import { test } from "node:test"
import { packageNameMatchesScope } from "../script/package-name-policy.ts"

test("publishable AKB packages and explicitly private project packages use distinct scopes", () => {
  assert.equal(packageNameMatchesScope({ name: "@slop-lab/akb", private: false }), true)
  assert.equal(packageNameMatchesScope({ name: "@slop-lab/akb-project-kb", private: false }), true)
  assert.equal(packageNameMatchesScope({ name: "@this-project/akb", private: true }), true)
  assert.equal(packageNameMatchesScope({ name: "@this-project/akb", private: false }), false)
  assert.equal(packageNameMatchesScope({ name: "@slop-lab/akb-project-kb", private: true }), false)
  assert.equal(packageNameMatchesScope({ name: "@slop-lab/qg", private: false }), false)
  assert.equal(packageNameMatchesScope({ name: "@akb/project-kb", private: false }), false)
  assert.equal(packageNameMatchesScope({ name: "@this-project/", private: true }), false)
})
