/**
 * End-to-end test of the BUNDLED action (dist/index.js).
 *
 * Inputs arrive the way GitHub Actions supplies them (INPUT_* env vars) and
 * outputs are read back out of the GITHUB_OUTPUT file, so this exercises the
 * real @actions/core plumbing inside the bundle.
 *
 * The single HTTP call is intercepted by stubbing global.fetch rather than
 * standing up a local server: the assertions are about the REQUEST the API
 * would receive, and Node's own fetch does not need proving. The captured body
 * is unzipped with fflate - the same library api-command-center uses - so a bug
 * in the action's hand-written zip writer cannot hide behind a matching bug in
 * the test's reader.
 *
 * Checks the request shape against api-command-center's
 * POST /v1/sites/:siteId/deployments:
 *   Authorization: Bearer oxy_...
 *   multipart/form-data with a field literally named "zip"
 * and then checks the action fails loudly on every error the API can return,
 * rather than reporting a green deploy that never happened.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { unzipSync, strFromU8 } = require("fflate");

const ACTION = require.resolve(path.join(__dirname, "..", "dist", "index.js"));

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

// ------------------------------------------------------------ fixture
const site = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-site-"));
fs.mkdirSync(path.join(site, "css"), { recursive: true });
fs.mkdirSync(path.join(site, "node_modules", "junk"), { recursive: true });
const INDEX = "<!doctype html><h1>Deployed</h1>";
fs.writeFileSync(path.join(site, "index.html"), INDEX);
fs.writeFileSync(path.join(site, "css", "style.css"), "body{margin:0}");
fs.writeFileSync(path.join(site, "README.md"), "excluded");
fs.writeFileSync(path.join(site, "node_modules", "junk", "big.js"), "excluded");

/** Run the bundled action once with a stubbed fetch. */
async function runAction({ respond, inputs = {} } = {}) {
  const outFile = path.join(os.tmpdir(), `gh-out-${Math.random().toString(36).slice(2)}`);
  const sumFile = path.join(os.tmpdir(), `gh-sum-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(outFile, "");
  fs.writeFileSync(sumFile, "");

  const env = {
    "INPUT_API-KEY": "oxy_testkey_1234567890abcdef",
    "INPUT_SITE-ID": "site-abc-123",
    "INPUT_BUILD-DIR": site,
    "INPUT_EXCLUDE": "node_modules,*.md",
    "INPUT_API-URL": "https://api.example.test",
    "INPUT_INSTALL-COMMAND": "npm ci",
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: sumFile,
    ...inputs,
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  let captured = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const buf = Buffer.from(await new Response(init.body).arrayBuffer());
    captured = { url: String(url), method: init.method, headers: init.headers, contentType: new Response(init.body).headers.get("content-type") ?? "", body: buf };
    if (respond instanceof Error) throw respond;
    return new Response(JSON.stringify(respond.body), {
      status: respond.status,
      headers: { "content-type": "application/json" },
    });
  };

  const logs = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c, ...a) => { logs.push(String(c)); return true; };
  process.exitCode = 0;

  delete require.cache[ACTION];
  try {
    require(ACTION);
    // the action's main() is async; let its promise chain drain
    for (let i = 0; i < 60 && process.exitCode === 0 && captured === null && logs.join("").indexOf("::error::") === -1; i++) {
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.stdout.write = realWrite;
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const outputs = {};
  // @actions/core writes this file with os.EOL, so on Windows every value
  // arrives with a trailing \r. Normalise before parsing rather than asserting
  // against a line ending that only exists on this machine.
  const raw = fs.readFileSync(outFile, "utf8").replace(/\r\n/g, "\n");
  for (const m of raw.matchAll(/^(\S+?)<<ghadelimiter_[^\n]*\n([\s\S]*?)\nghadelimiter_[^\n]*$/gm)) {
    outputs[m[1]] = m[2];
  }
  const summary = fs.readFileSync(sumFile, "utf8");
  fs.rmSync(outFile, { force: true });
  fs.rmSync(sumFile, { force: true });

  const out = { captured, outputs, summary, log: logs.join(""), failed: process.exitCode !== 0 };
  process.exitCode = 0;
  return out;
}

(async () => {
  console.log("happy path");
  const ok = {
    status: 200,
    body: { ok: true, deployment_number: 4, pages: 1, files: 2, bytes: 61, url: "https://demo.myoxypages.com", warnings: [] },
  };
  let r = await runAction({ respond: ok });

  check("step succeeds", () => assert.ok(!r.failed, r.log));
  check("POSTs to /v1/sites/:id/deployments", () => {
    assert.equal(r.captured.method, "POST");
    assert.equal(r.captured.url, "https://api.example.test/v1/sites/site-abc-123/deployments");
  });
  check("sends Authorization: Bearer oxy_...", () => {
    assert.equal(r.captured.headers.Authorization, "Bearer oxy_testkey_1234567890abcdef");
  });
  check("body is multipart/form-data", () => {
    assert.ok(/^multipart\/form-data; boundary=/.test(r.captured.contentType), r.captured.contentType);
  });
  check('form field is literally named "zip"', () => {
    assert.ok(r.captured.body.toString("latin1").includes('name="zip"'), "no field named zip");
  });
  check("uploaded bytes unzip to exactly the deployed tree", () => {
    const s = r.captured.body.toString("latin1");
    const start = s.indexOf("PK");
    assert.ok(start > -1, "no local file header in the body");
    const eocd = s.lastIndexOf("PK");
    assert.ok(eocd > start, "no end-of-central-directory record");
    const out = unzipSync(new Uint8Array(r.captured.body.subarray(start, eocd + 22)));
    assert.deepEqual(Object.keys(out).sort(), ["css/style.css", "index.html"]);
    assert.equal(strFromU8(out["index.html"]), INDEX);
    assert.equal(strFromU8(out["css/style.css"]), "body{margin:0}");
  });
  check("excludes kept README.md and node_modules out", () => {
    const s = r.captured.body.toString("latin1");
    assert.ok(!s.includes("README.md"), "README.md leaked in");
    assert.ok(!s.includes("node_modules"), "node_modules leaked in");
  });
  check("outputs come from the API response", () => {
    assert.equal(r.outputs["site-url"], "https://demo.myoxypages.com");
    assert.equal(r.outputs["deployment-number"], "4");
    assert.equal(r.outputs["pages"], "1");
    assert.equal(r.outputs["files"], "2");
    assert.equal(r.outputs["bytes"], "61");
  });
  check("writes a job summary with the live link", () => {
    assert.ok(r.summary.includes("https://demo.myoxypages.com"), r.summary.slice(0, 200));
  });

  console.log("failure paths");
  r = await runAction({ respond: { status: 401, body: { ok: false, error: "Invalid API key." } } });
  check("401 fails the step, with the API message and a hint", () => {
    assert.ok(r.failed, "passed on a 401");
    assert.ok(r.log.includes("Invalid API key."), r.log);
    assert.ok(r.log.includes("OXYPAGES_API_KEY"), "no actionable hint");
  });

  r = await runAction({ respond: { status: 403, body: { ok: false, error: "Verify your email address before using the API." } } });
  check("403 fails and repeats the API's instruction", () => {
    assert.ok(r.failed);
    assert.ok(r.log.includes("Verify your email"), r.log);
  });

  r = await runAction({ respond: { status: 404, body: { ok: false, error: "Site not found." } } });
  check("404 names the site-id that was wrong", () => {
    assert.ok(r.failed);
    assert.ok(r.log.includes("site-abc-123"), r.log);
  });

  r = await runAction({ respond: { status: 413, body: { ok: false, error: "This publish is 120.0 MB but your account has 40.0 MB of storage left on the Free plan." } } });
  check("413 surfaces the plan-limit message verbatim", () => {
    assert.ok(r.failed);
    assert.ok(r.log.includes("40.0 MB of storage left"), r.log);
  });

  r = await runAction({ respond: { status: 429, body: { ok: false, error: "Rate limit exceeded - 60 deploys per hour.", code: "rate_limited" } } });
  check("429 fails and mentions the hourly budget", () => {
    assert.ok(r.failed);
    assert.ok(r.log.includes("60 deploys"), r.log);
  });

  r = await runAction({ respond: new Error("ECONNREFUSED") });
  check("a network error fails the step instead of passing silently", () => {
    assert.ok(r.failed);
    assert.ok(r.log.includes("Could not reach"), r.log);
  });

  r = await runAction({
    respond: { status: 200, body: { ok: true, deployment_number: 5, pages: 1, files: 2, url: "https://x.myoxypages.com", warnings: ["An asset was skipped."] } },
  });
  check("API warnings become step warnings without failing", () => {
    assert.ok(!r.failed);
    assert.ok(r.log.includes("::warning::An asset was skipped."), r.log);
  });

  console.log("guards that fire before anything is uploaded");
  r = await runAction({ respond: ok, inputs: { "INPUT_API-KEY": "not-a-key" } });
  check("rejects a key that is not oxy_*", () => {
    assert.ok(r.failed);
    assert.equal(r.captured, null, "it uploaded anyway");
    assert.ok(r.log.includes('should start with "oxy_"'), r.log);
  });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-empty-"));
  fs.writeFileSync(path.join(empty, "notes.md"), "only an excluded file");
  r = await runAction({ respond: ok, inputs: { "INPUT_BUILD-DIR": empty } });
  check("refuses an effectively empty build-dir", () => {
    assert.ok(r.failed);
    assert.equal(r.captured, null, "it uploaded anyway");
    assert.ok(r.log.includes("Nothing to deploy"), r.log);
  });

  const noIndex = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-noindex-"));
  fs.writeFileSync(path.join(noIndex, "about.html"), "<h1>no index</h1>");
  r = await runAction({ respond: ok, inputs: { "INPUT_BUILD-DIR": noIndex } });
  check("refuses a folder with no index.html, before uploading", () => {
    assert.ok(r.failed);
    assert.equal(r.captured, null, "it uploaded anyway");
    assert.ok(r.log.includes("No index.html"), r.log);
  });

  r = await runAction({ respond: ok, inputs: { "INPUT_BUILD-DIR": path.join(os.tmpdir(), "nope-" + Date.now()) } });
  check("refuses a build-dir that does not exist", () => {
    assert.ok(r.failed);
    assert.equal(r.captured, null);
    assert.ok(r.log.includes("does not exist"), r.log);
  });

  for (const d of [site, empty, noIndex]) fs.rmSync(d, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall e2e tests passed" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
