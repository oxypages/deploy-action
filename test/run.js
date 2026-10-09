/**
 * Tests for the two parts of this action that can be wrong silently: the
 * exclude matcher and the hand-written ZIP writer.
 *
 * The ZIP is verified by unzipping it with a DIFFERENT implementation than the
 * one that wrote it - fflate, which is what the API itself uses - so a bug in
 * my writer cannot be masked by a matching bug in my reader.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { unzipSync, strFromU8 } = require("fflate");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");

// Pull the pure helpers out of the action without running its main().
function extract(name, endMarker) {
  const start = src.indexOf(name);
  assert.ok(start > -1, `could not find ${name}`);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end);
}
const helpers = new Function(
  "require",
  "module",
  `${extract("function toMatcher", "// ------------------------------------------------------------------ walk")}
   ${extract("function walk", "// ------------------------------------------------------------------- zip")}
   ${extract("function makeZip", "// ------------------------------------------------------------------ main")}
   const { deflateRawSync, crc32 } = require("zlib");
   const fs = require("fs"); const path = require("path");
   return { toMatcher, buildExcluder, walk, makeZip };`,
)(require, module);

const { buildExcluder, walk, makeZip } = helpers;

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log("  ok   " + label);
  } catch (e) {
    failures++;
    console.log("  FAIL " + label + "\n       " + e.message);
  }
}

console.log("exclude matcher");
const ex = buildExcluder("node_modules,.git,*.md,package*.json");
check("hides a directory anywhere in the tree", () => {
  assert.equal(ex("node_modules/left-pad/index.js"), true);
  assert.equal(ex("src/node_modules/x.js"), true);
});
check("glob matches on basename", () => {
  assert.equal(ex("README.md"), true);
  assert.equal(ex("docs/NOTES.md"), true);
  assert.equal(ex("package.json"), true);
  assert.equal(ex("package-lock.json"), true);
});
check("does not over-match", () => {
  assert.equal(ex("index.html"), false);
  assert.equal(ex("css/style.css"), false);
  // "node_modules" as a segment only - not a file that merely contains it
  assert.equal(ex("my-node_modules-notes.txt"), false);
  // ".md" inside a name, not an extension
  assert.equal(ex("md.html"), false);
});
check("empty pattern list excludes nothing", () => {
  assert.equal(buildExcluder("")("anything.js"), false);
});

console.log("zip writer (read back with fflate, the API's own unzipper)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-action-"));
fs.mkdirSync(path.join(tmp, "css"), { recursive: true });
fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
const html = "<!doctype html><h1>Hello</h1>" + "\n<!-- padding -->".repeat(200);
fs.writeFileSync(path.join(tmp, "index.html"), html);
fs.writeFileSync(path.join(tmp, "css", "style.css"), "body{color:red}");
fs.writeFileSync(path.join(tmp, "README.md"), "should be excluded");
fs.writeFileSync(path.join(tmp, "node_modules", "junk.js"), "should be excluded");
// A tiny, high-entropy file: deflate will make it BIGGER, exercising the
// store-instead-of-deflate branch.
const noise = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) % 256));
fs.writeFileSync(path.join(tmp, "noise.bin"), noise);

const files = walk(tmp, buildExcluder("node_modules,*.md"));
check("walk applies excludes and finds the rest", () => {
  const rels = files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ["css/style.css", "index.html", "noise.bin"]);
});

const zip = makeZip(files);
const out = unzipSync(new Uint8Array(zip));
check("every entry round-trips byte-for-byte", () => {
  assert.deepEqual(Object.keys(out).sort(), ["css/style.css", "index.html", "noise.bin"]);
  assert.equal(strFromU8(out["index.html"]), html);
  assert.equal(strFromU8(out["css/style.css"]), "body{color:red}");
  assert.ok(Buffer.from(out["noise.bin"]).equals(noise), "stored entry differs");
});
check("forward slashes in paths, never backslashes", () => {
  assert.ok(Object.keys(out).every((k) => !k.includes("\\")), "a path used a backslash");
});
check("compressible file actually got deflated", () => {
  assert.ok(zip.length < Buffer.byteLength(html) + noise.length, "archive is not smaller than its input");
});
check("nested directory survives without an explicit dir entry", () => {
  assert.ok(out["css/style.css"], "nested file missing");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall tests passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
