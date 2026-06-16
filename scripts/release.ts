import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import semver from "semver";

/** Abort the release with a one-line reason. */
function fail(reason: string): never {
  console.error(`release: ${reason}`);
  process.exit(1);
}

/** Run a shell command, streaming its output; a non-zero exit aborts the release. */
function run(command: string): void {
  execSync(command, { stdio: "inherit" });
}

const current: string = JSON.parse(readFileSync("package.json", "utf8")).version;

// The first CLI argument is an explicit target version; with none, bump the patch digit.
const requested = process.argv[2];
const next = requested
  ? semver.valid(requested) ?? fail(`"${requested}" is not a valid version, e.g. 0.11.4`)
  : semver.inc(current, "patch")!;

if (!semver.gt(next, current)) fail(`${next} is not newer than the current ${current}`);

console.log(`release: ${current} -> ${next}`);

run("npm run build"); // Fail fast: a broken build must abort before the version changes.
run(`npm version ${next} --no-git-tag-version`); // Bump package.json + lockfile only, no git tag.
run("git add package.json package-lock.json");
run(`git commit -m "release: ${next}"`); // Match the repo's "release: x.y.z" commit convention.
run("npm link"); // Expose the freshly built CLI on the global bin path.

console.log(`release: published ${next}`);
