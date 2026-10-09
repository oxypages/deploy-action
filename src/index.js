/**
 * OxyPages Deploy - GitHub Action.
 *
 * The whole job is: optionally build, zip the output, POST it once.
 *
 *   POST {api-url}/v1/sites/{site-id}/deployments
 *   Authorization: Bearer oxy_...
 *   multipart/form-data: zip=<archive>
 *
 * The API already accepts a zip on that endpoint and already returns the live
 * URL, the deployment number and the file/page counts, so this action does no
 * work the platform does not already do. A deploy is a FULL REPLACE: whatever
 * is in the zip becomes the site.
 *
 * Node 20 gives us fetch, FormData, Blob and node:zlib's deflateRawSync, so
 * there are no runtime dependencies beyond @actions/core and @actions/exec and
 * nothing to keep patched in a vendored bundle.
 */
const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const path = require("path");
const { deflateRawSync, crc32 } = require("zlib");

/** Bytes we will not even try to upload; the API's own cap is 100 MB. */
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

// --------------------------------------------------------------- excludes
/**
 * Turn one exclude entry into a matcher. Plain names match a whole path
 * segment ("node_modules" hides the directory wherever it sits); anything
 * containing * or ? is treated as a glob against the basename ("*.md").
 */
function toMatcher(pattern) {
  const p = pattern.trim();
  if (!p) return null;
  if (!/[*?]/.test(p)) {
    return (rel) => rel.split("/").includes(p);
  }
  const rx = new RegExp(
    "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i",
  );
  return (rel) => rx.test(path.basename(rel));
}

function buildExcluder(raw) {
  const matchers = raw.split(",").map(toMatcher).filter(Boolean);
  return (rel) => matchers.some((m) => m(rel));
}

// ------------------------------------------------------------------ walk
function walk(dir, excluded, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (excluded(rel)) continue;
    if (entry.isSymbolicLink()) continue; // never follow links out of the tree
    if (entry.isDirectory()) walk(abs, excluded, base, out);
    else if (entry.isFile()) out.push({ rel, abs, size: fs.statSync(abs).size });
  }
  return out;
}

// ------------------------------------------------------------------- zip
/**
 * Minimal ZIP writer (store or deflate per entry, no dependencies).
 *
 * Written by hand rather than pulled from npm because a bundled action ships
 * its dependencies in the repo, and a zip library is a lot of vendored code to
 * keep patched for something this small. Entries are deflate-raw, which every
 * unzip implementation reads, and the API unzips with fflate.
 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.rel, "utf8");
    const data = fs.readFileSync(f.abs);
    const crc = crc32(data) >>> 0;
    const deflated = deflateRawSync(data, { level: 6 });
    // Storing is smaller than deflating for already-compressed assets.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ------------------------------------------------------------------ main
async function run() {
  const apiKey = core.getInput("api-key", { required: true });
  const siteId = core.getInput("site-id", { required: true });
  const buildDir = core.getInput("build-dir") || "./";
  const buildCommand = core.getInput("build-command");
  const installCommand = core.getInput("install-command") || "npm ci";
  const exclude = core.getInput("exclude") || "";
  const apiUrl = (core.getInput("api-url") || "https://api.oxypages.com").replace(/\/+$/, "");

  // Fail on an obviously wrong key before doing minutes of build work.
  if (!apiKey.startsWith("oxy_")) {
    core.setFailed('The api-key does not look like an OxyPages key - it should start with "oxy_". Check the secret is set and not empty.');
    return;
  }

  if (buildCommand) {
    if (fs.existsSync("package.json")) {
      core.info(`Installing dependencies: ${installCommand}`);
      await exec.exec(installCommand, [], { shell: true });
    } else {
      core.info("No package.json found, skipping the install step.");
    }
    core.info(`Building: ${buildCommand}`);
    await exec.exec(buildCommand, [], { shell: true });
  }

  const root = path.resolve(buildDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    core.setFailed(`build-dir "${buildDir}" does not exist${buildCommand ? " after the build ran" : ""}. Point it at the folder that holds index.html.`);
    return;
  }

  const files = walk(root, buildExcluder(exclude));
  if (files.length === 0) {
    core.setFailed(`Nothing to deploy: "${buildDir}" is empty once the exclude list is applied.`);
    return;
  }
  if (!files.some((f) => f.rel === "index.html")) {
    // The API rejects this too, but failing here names the actual folder.
    core.setFailed(`No index.html at the top of "${buildDir}". OxyPages serves index.html as the homepage, so the deploy would be refused. Found: ${files.slice(0, 5).map((f) => f.rel).join(", ")}${files.length > 5 ? ", ..." : ""}`);
    return;
  }

  core.info(`Packing ${files.length} file${files.length === 1 ? "" : "s"} from ${buildDir}`);
  const zip = makeZip(files);
  const mb = (zip.length / (1024 * 1024)).toFixed(2);
  if (zip.length > MAX_ZIP_BYTES) {
    core.setFailed(`The archive is ${mb} MB and the limit is 100 MB. Trim the folder or add more to the exclude list.`);
    return;
  }
  core.info(`Archive is ${mb} MB, uploading`);

  const form = new FormData();
  form.append("zip", new Blob([zip], { type: "application/zip" }), "site.zip");

  let res;
  try {
    res = await fetch(`${apiUrl}/v1/sites/${encodeURIComponent(siteId)}/deployments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    core.setFailed(`Could not reach ${apiUrl}: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    core.setFailed(`Unexpected ${res.status} response from the API: ${text.slice(0, 300)}`);
    return;
  }

  if (!res.ok || body.ok === false) {
    // The API writes for humans, so lead with its message rather than a code.
    const hint =
      res.status === 401 ? " Check the OXYPAGES_API_KEY secret is a current, unrevoked key."
      : res.status === 403 ? " Verify the account's email address, then run this again."
      : res.status === 404 ? ` Check site-id "${siteId}" is right and belongs to this account.`
      : res.status === 429 ? " The API allows 60 deploys an hour per account."
      : "";
    core.setFailed(`${body.error ?? `Deploy failed with ${res.status}.`}${hint}`);
    return;
  }

  for (const w of body.warnings ?? []) core.warning(String(w));

  core.setOutput("site-url", body.url ?? "");
  core.setOutput("deployment-number", String(body.deployment_number ?? ""));
  core.setOutput("pages", String(body.pages ?? ""));
  core.setOutput("files", String(body.files ?? ""));
  core.setOutput("bytes", String(body.bytes ?? ""));

  core.info(`Deployed v${body.deployment_number}: ${body.pages} page(s), ${body.files} file(s)`);
  core.info(`Live at ${body.url}`);
  await core.summary
    .addHeading("Deployed to OxyPages", 3)
    .addTable([
      [{ data: "Site", header: true }, { data: "Version", header: true }, { data: "Pages", header: true }, { data: "Files", header: true }],
      [`<a href="${body.url}">${body.url}</a>`, `v${body.deployment_number}`, String(body.pages), String(body.files)],
    ])
    .write();
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
