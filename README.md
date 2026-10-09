# OxyPages Deploy

Deploy a static site or a built folder to [OxyPages](https://oxypages.com) from
GitHub Actions. No git provider to connect on our side, no CLI to install: the
action zips your output folder and makes one API call.

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oxypages/deploy-action@v1
        with:
          api-key: ${{ secrets.OXYPAGES_API_KEY }}
          site-id: ${{ vars.OXYPAGES_SITE_ID }}
```

With a build step:

```yaml
      - uses: oxypages/deploy-action@v1
        with:
          api-key: ${{ secrets.OXYPAGES_API_KEY }}
          site-id: ${{ vars.OXYPAGES_SITE_ID }}
          build-command: npm run build
          build-dir: ./dist
```

## Setup

1. **Get an API key.** oxypages.com → Profile → API Keys → create one. It
   starts with `oxy_` and is shown once. Every plan can use the API, including
   the free one; the only requirement is a verified email address.
2. **Store it** as a repository secret named `OXYPAGES_API_KEY`
   (Settings → Secrets and variables → Actions).
3. **Find your site id.** It is in the site's dashboard URL, or from
   `GET /v1/sites`. It is not secret, so a repository *variable* is the right
   home for it, not a secret.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `api-key` | yes | | Your `oxy_...` key. Always from a secret. |
| `site-id` | yes | | Which site to deploy into. |
| `build-dir` | no | `./` | The folder that gets zipped and uploaded. |
| `build-command` | no | | Run before deploying, e.g. `npm run build`. Dependencies install first if a `package.json` is present. |
| `install-command` | no | `npm ci` | Used only when `build-command` is set. |
| `exclude` | no | see below | Comma-separated names and globs to leave out. |
| `api-url` | no | `https://api.oxypages.com` | Override only for staging. |

Default excludes:
`node_modules, .git, .github, *.md, package*.json, package-lock.json, .DS_Store, .env, .env.*`

A bare name (`node_modules`) excludes that path segment anywhere in the tree.
A pattern with `*` or `?` (`*.md`) matches against the file name.

## Outputs

| Output | Example |
|---|---|
| `site-url` | `https://yoursite.myoxypages.com` |
| `deployment-number` | `7` |
| `pages` | `5` |
| `files` | `12` |
| `bytes` | `812345` |

```yaml
      - uses: oxypages/deploy-action@v1
        id: deploy
        with: { api-key: "${{ secrets.OXYPAGES_API_KEY }}", site-id: "${{ vars.OXYPAGES_SITE_ID }}" }
      - run: echo "Live at ${{ steps.deploy.outputs.site-url }}"
```

The action also writes a job summary with the live link, so you do not have to
dig through logs to find the URL.

## Things worth knowing before you wire this up

**A deploy is a full replace.** Whatever is in the zip becomes the site.
Anything not in the zip is gone from the live site. That is the same behaviour
as publishing from the dashboard, and it is why `build-dir` should point at your
output folder rather than the repository root.

**`site-id` is deliberately required.** Some deploy actions create a new site
when the id is missing, which means one typo silently produces a fresh site on
every push. This one fails on the first run instead.

**Every version is kept.** Each run adds a numbered deployment you can see and
roll back to under Version History, marked as an API deploy.

**Limits.** 100 MB per archive, 5 MB per HTML page, 25 MB per other file, and
60 deploys an hour per account. Storage and page counts follow your plan. When
one of these is hit the API says which, and the action fails the step with that
message.

**An `index.html` must sit at the top of `build-dir`.** OxyPages serves it as
the homepage. The action checks before uploading, so you get a clear failure
rather than a rejected deploy.

## Development

```bash
npm install
npm test          # zip writer + exclude matcher, verified with fflate
node test/e2e.js  # the bundled action against a stubbed API
npm run build     # bundle src/index.js -> dist/index.js with ncc
```

`dist/index.js` is committed, because GitHub Actions runs the bundle directly
rather than installing dependencies. CI rebuilds it and fails if the committed
bundle does not match the source, so the two cannot drift.

The zip writer is hand-rolled against `node:zlib` rather than pulled from npm.
A bundled action ships its dependencies in the repository, and a zip library is
a lot of vendored code to keep patched for something this small. It is covered
by tests that read the archives back with `fflate`, which is the library the
OxyPages API itself unzips with.

## Licence

MIT
