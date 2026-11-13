# Releasing

For maintainers. Nothing here runs by itself.

## Before the repository goes public

1. Read every tracked file once more for anything that should not be public.
2. Delete the repository variable `CI_LINUX_RUNNER` (`gh variable delete CI_LINUX_RUNNER`) and remove every self-hosted runner (Settings, Actions, Runners). While the variable is set, every Linux job runs on a self-hosted runner, the Old engines check included (it runs there without Docker), and only the Windows unit job does not run. A public repository must not send pull requests from forks to a machine of ours.
3. Settings, Actions, General, "Approval for running fork pull request workflows from contributors": "Require approval for all external contributors".
4. Switch the repository to public. Then enable "Private vulnerability reporting" under Settings, Code security; `SECURITY.md` and `CODE_OF_CONDUCT.md` point at that form.
5. Make the settings under [Repository and registry settings](#repository-and-registry-settings), the public-only ones included (fork pull-request approval and Pages), and add the provenance gate below.

## Support policy

### What 1.x promises

- The reading's shape. Every field listed under "What 1.x keeps" in [docs/API.md](docs/API.md#what-1x-keeps) keeps its name, type and meaning in every 1.x release. `test/types/consumer.ts` pins each type; a minor release may add fields and `x.` hints, never remove or retype one.
- The id definition. Within 1.x the id definition of the current `ID_VERSION` does not change: a reading with a given `v` is always built by the same recipe from the same parts. If a browser makes a part unstable (it starts to randomise, clamp or change a value an id is built from), the fix is a new `ID_VERSION`, shipped in a minor release, never a patch, and its changelog entry comes first in that release's section and says that every id of the affected browsers changes. A fix to how a browser is classified counts as a change of id definition when it changes the answer for a real browser in range, and is a patch when it does not.
- The browser floor. ES5 output, checked with `es-check es5` on every build, from a source compiled against `lib: ["ES5", "DOM"]`. Chrome 53 is the floor. The old-engines check runs the core, deferred, lab and deep builds in Chrome 53, 59, 63, 68 and 80, each in a pinned image with no network, and fails unless the page reports no error, the callback fires once with a well-formed reading, and `id` and `idStrict` equal what Node recomputes from the reading's `c`. It does not run old Safari, old Firefox, old Android WebViews or any phone: those are covered by the ES5 check, not by a run.
- No network calls, no telemetry and no remote code, in every entry.
- Size. The core, `dist/visito.min.js`, stays at or under 8,192 bytes gzipped; the deferred build stays under 8,192 and within 134 bytes of the core. Both are enforced by `test/bundle.test.mjs`, and the limits are not raised within 1.x.

### Support window

1.x gets security fixes and browser-drift fixes for 24 months from the release of 1.0.0 (to 2028-11-13 if it is released on 2026-11-13), and for at least 12 months after 2.0.0 is released, whichever ends later. Fixes go to the latest 1.x minor release only.

### How fixes are released

- Security. Reported privately as `SECURITY.md` says. The fix ships as a patch of the latest 1.x minor, with a `### Security` entry in the changelog, and the advisory is published once the release is on npm.
- Browser drift. The weekly Browser drift run and the engine harness find a browser change before it reaches stable where they can. A fix that leaves every id the same in every real browser is a patch. A fix that changes an id is a new `ID_VERSION` in a minor release, as above.
- Every release goes through the whole of CI on the tagged commit, Windows and the old engines included, as "Each release" below says.

### Not promised

- Any accuracy, uniqueness or collision figure. None has been measured on enough devices to state one.
- Identification where browsers randomise or clamp values, as Brave, Safari and Firefox do and others may start to. There the id rests on fewer values, and two identical devices with identical settings always share an id.
- How long the stored id lasts. Browsers and people clear storage, and some browsers expire storage a script wrote.
- What the automation marks catch. Any client-side check can be patched around.
- The experimental `visitojs/deep` entry, whose values and `DEEP_VERSION` may change in a minor release, and the lab build and the lab harnesses, which may change in any release.
- The timings in `ms` and `t`, and their step names.

## Each release

1. Make sure `main` is green in CI (the `CI result` check). While `CI_LINUX_RUNNER` is set, CI skips the Windows unit job (Build and unit tests (Windows)), because that runner is Linux only; on pull requests and on `main`, `CI result` passes without it. The Old engines check (Chrome 53 to 80) still runs there: the runner has no Docker, so `lab/old-engines/run.sh` runs the same pinned images in user namespaces. A release asks CI for every job, so with the variable set its `CI result` fails and nothing is published: unset the variable before you tag, run CI on the commit you are releasing, and wait for it to pass.
   Then open the latest Browser drift run. It must be green, or each failure in it must be handled as "When the drift run fails" in `CONTRIBUTING.md` says. A release shipped across a drifting engine test or an opened private-window file system pins that wrong answer in every page that loads it. If the last run is more than a week old, start it by hand. In a public repository GitHub disables a scheduled workflow after 60 days without activity; re-enable it from the Actions tab if it shows as disabled.
2. Move the entries under "Unreleased" in `CHANGELOG.md` to a new version heading, `## [x.y.z] - <date>`, with the changes under it. If the parts of an id changed, say so first and check that `ID_VERSION` was raised.
3. Set the version in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`) and in the JSON-LD block of `demo/index.html` (`test/site.test.mjs` fails until they match), and merge that change into `main` through a pull request.
4. Tag the merged commit on `main` `v<x.y.z>` and push the tag. The Release workflow then:
   - runs the whole of CI on the tagged commit, the Windows unit tests, the browser harnesses and the Old engines check (Chrome 53 to 80) included, whatever the last change touched;
   - refuses the release if the tagged commit is not on `main`, if the tag differs from the version in `package.json` or in either place in `package-lock.json`, if `CHANGELOG.md` has no section for the version or an empty one, or if a version without a `-` part is lower than the `latest` dist-tag on npm (see "Versions");
   - builds, tests and packs once, and keeps the tarball, the three release files, the notes and their `SHA256SUMS` as the run's `release` artifact, for 30 days, as long as GitHub lets a run wait for an approval;
   - waits for approval of the `npm` environment.
5. Before approving, check on the run page that the `CI / ...` jobs (`CI / CI result` among them) and the build job's step "The tagged commit is on main" ran and passed. The release runs the `release.yml` of the tagged commit, so a tag on a commit whose `release.yml` dropped those gates would not run them, and the `v*` rule of the environment would still let it ask for approval; only the tag rules (setting 4) and this look stop that. Then read what changed in the package since the last release: `gh run download <run id> -n release -D release-<x.y.z>`, then `npm diff --diff=visitojs@<previous> --diff=release-<x.y.z>/visitojs-<x.y.z>.tgz`. A build tool that was tampered with changes these files, and no test is sure to notice. Then approve: the run page, Review deployments, tick `npm`, Approve and deploy.
6. The publish job checks the files against `SHA256SUMS`, publishes the tarball with trusted publishing (a version with a `-` part goes under the `next` dist-tag) and checks that npm serves the same tarball (`dist.integrity`). The last job creates the GitHub Release with the changelog section, the CDN integrity value and the same three files, marked as a pre-release for a `-` version.
7. Put the integrity value and the new version in the CDN snippet of the README. The release notes give the value for `visito.min.js` only; for the deferred build's snippet under "Waiting for consent" in `docs/API.md` and the deep entry's there, compute it from `dist/visito.defer.min.js` and `dist/deep.min.js` of the published tarball: `openssl dgst -sha384 -binary visito.defer.min.js | openssl base64 -A`. Put the new version in the deep entry's snippet too.
8. Check the CDN copy: the file at `https://cdn.jsdelivr.net/npm/visitojs@<x.y.z>/dist/visito.min.js` must be identical to the one attached to the release.

A run that stops halfway can be re-run with **Re-run failed jobs**, not "Re-run all jobs". Re-running failed jobs keeps the build job's outputs and its `release` artifact; publishing skips a version npm already has, then still checks that npm serves this run's tarball, and the release step skips a release that exists. "Re-run all jobs" builds and packs again: if npm already has the version, the new tarball must be byte-identical to the published one or the integrity check fails, and whether `upload-artifact` accepts a second `release` artifact in the same run is not confirmed.

Releases run one at a time: every tag shares the concurrency group `release`, and a release holds it while it waits for approval. A tag pushed during a release waits for it to end. GitHub keeps one waiting run per group, so a third tag pushed meanwhile cancels the second, which then has to be re-run, and is refused if a higher version has become `latest` in the meantime. Push one release tag at a time; to free the group, reject the waiting deployment.

Publishing from the workflow needs no token: `release.yml` is registered as a trusted publisher for the package on npmjs.com. The very first version was published by hand, because a trusted publisher can only be added to a package that exists. Trusted publishing has not published a version of this package yet, so prove it on a pre-release (`v1.0.0-rc.0`, with a `## [1.0.0-rc.0]` changelog section) before relying on it for 1.0.0.

In the branch rules, require the `CI result` check and no other job of CI. The jobs a change does not need are skipped by their own condition. The old-engines check is reported as `Old engines / Old engines (Chrome 53 to 80)` because CI calls it as another workflow, and a change that skips it never creates a check by that name, so requiring it would hold such a pull request for ever. `CI result` fails unless every job the change needed ran and passed, apart from the Windows job, which `CI_LINUX_RUNNER` turns off outside a release (step 1 of "Each release"); a job that ran and failed fails it in every case. No workflow filters `push` or `pull_request` by path, because a workflow skipped that way leaves its checks pending.

### Once the repository is public: the provenance gate

Add a provenance gate to the publish job in `release.yml`, as the step after "The registry serves the tarball that was built and tested". npm makes a provenance attestation for a trusted publish only from a public repository, so the step cannot be added before; from then on, a version published without one fails the release:

```yaml
      - name: npm holds a provenance attestation for this version
        env:
          VERSION: ${{ needs.build.outputs.version }}
        run: |
          got="$(npm view "visitojs@$VERSION" dist.attestations.provenance.predicateType --prefer-online)"
          if [ "$got" != https://slsa.dev/provenance/v1 ]; then
            echo "::error::visitojs@$VERSION has no SLSA provenance attestation on npm (got '$got')"
            exit 1
          fi
```

`npm view` prints nothing and exits 0 for a version without an attestation, which is why the step compares the value instead of relying on the exit code. Prove it on the first release after going public; `npm audit signatures` in a project that installs that version is a second check by hand.

## Repository and registry settings

These live in GitHub's and npm's settings, not in any file, so only a repository admin can make them. The workflows assume the first four; until they are made, the release still works but without the human approval and the branch and tag protection it is designed around.

1. **The `npm` environment, before the next tag.** GitHub: Settings, Environments, New environment, name `npm` (exactly). Under Deployment protection rules, tick Required reviewers and add yourself; leave "Prevent self-review" off while you are the only maintainer. Under Deployment branches and tags, choose Selected branches and tags and add a tag rule `v*`. Why: the publish job is the only job that can obtain an npm credential, and this makes a person approve each publish and stops any branch from using it. A job that names an environment which does not exist creates it with no protection, so create this one before a tag runs the new `release.yml`.
2. **The trusted publisher on npm, together with step 1.** npmjs.com, the `visitojs` package, Settings, Trusted publishing, the GitHub Actions entry: organization or user `visitojs`, repository `visitojs`, workflow filename `release.yml`, environment name `npm`. Every field is case-sensitive. Under allowed actions, allow `npm publish`: trusted publishers created after 2026-09-03 allow only `npm stage publish` by default, and this workflow publishes directly, behind the environment approval. Why: naming the environment means npm accepts a credential only from a job that passed the approval in step 1. If the names differ, publishing fails with an authentication error (`ENEEDAUTH`, or `E404 Not Found` on the publish request) and nothing is published. If you prefer npm's staged publishing (approve each version on npmjs.com with 2FA) to the environment approval, leave the stage-only default and change `npm publish` to `npm stage publish` in `release.yml`; the integrity check then has to wait for your approval on npm, so it would move out of the workflow.
3. **Rules for `main`.** Settings, Rules, Rulesets, "Protect main": add "Require a pull request before merging" (0 approvals is fine for one maintainer) and "Require status checks to pass" with the check `CI result` (source GitHub Actions; it is offered once it has run on a pull request). Keep the deletion and force-push blocks. Why: a release now refuses a commit that is not on `main`, and this makes everything on `main` a merged pull request that passed CI.
4. **Rules for release tags.** Settings, Rules, Rulesets, New ruleset, New tag ruleset: target tags matching `v*`; restrict creations, updates and deletions; bypass list: Repository admin. Why: a `v*` tag starts a release, so only you should be able to create one, and nobody should be able to move one after it was released.
5. **Actions allowed, and pinned.** Settings, Actions, General, Actions permissions: "Allow visitojs, and select non-visitojs, actions and reusable workflows" (the repository can offer it only where the organization's own policy, under the organization's Settings, Actions, General, allows it; set the same choice there), tick "Allow actions created by GitHub" and nothing else, and tick "Require actions to be pinned to a full-length commit SHA". Why: every action the workflows use is GitHub's own and is pinned to a commit with its tag in a comment; this makes GitHub refuse a run that adds anything else or loses a pin. Dependabot keeps the pins and their comments current.
6. **Immutable releases.** Settings, General, Releases: tick "Enable release immutability". Why: a published release's tag and files can then not be changed or replaced. `gh release create` with files uploads them before it publishes, which is what immutable releases expect; confirm it on the first release.
7. **npm publishing access.** npmjs.com, the `visitojs` package, Settings, Publishing access: "Require two-factor authentication and disallow tokens". Why: it closes publishing with a long-lived token, the other way in; trusted publishing is not affected.
8. **Workflow token defaults** (already set; keep them). Settings, Actions, General, Workflow permissions: "Read repository contents and packages permissions", and "Allow GitHub Actions to create and approve pull requests" off. Why: a job gets more only where its workflow asks for it.
9. **When the repository is public: fork pull requests.** Settings, Actions, General, "Approval for running fork pull request workflows from contributors": "Require approval for all external contributors". Why: CI runs the code of a fork's pull request in up to seven jobs, one of them on Windows; approval keeps new accounts from using the runners and lets you read a change to `.github/` before it runs.
10. **When the repository is public: Pages.** Settings, Pages, Build and deployment, Source: GitHub Actions. Why: `pages.yml` no longer configures Pages itself, and its deploy job publishes only to a site whose source is GitHub Actions.

Optional, not in the files: a Dependabot entry for the lab container images, so that `node:24-bookworm-slim` in `lab/containers/dev.Dockerfile` is tracked. Playwright's image stays ignored, because it moves together with the `playwright` package and the image digest in `ci.yml`. Add to `.github/dependabot.yml`:

```yaml
  - package-ecosystem: docker
    directory: /lab/containers
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    ignore:
      - dependency-name: mcr.microsoft.com/playwright
```

Then check under Insights, Dependency graph, Dependabot that it found both `*.Dockerfile` files and that it proposes no Playwright image, and extend the Dependabot test in `test/workflows.test.mjs`, which lists the ecosystems. The old-engines images are pinned by digest in `lab/old-engines/run.sh`, which Dependabot does not read.

## Versions

- A change to what an id is built from is a breaking change for anyone who stores ids: raise `ID_VERSION`. In 1.x it ships in a minor release, with its changelog entry first ([Support policy](#support-policy)); a change to a field of the reading's shape waits for 2.0.
- A new read in the lab build only is a patch.
- A version without a `-` part is published as `latest`. The release refuses one that is lower than the `latest` on npm (a fix for an older line, 1.0.5 after 1.1.0), because npm would move `latest` back to it. Such a release needs a dist-tag of its own, which the workflow does not do.
- The deep entry (`visitojs/deep`) is experimental: its shape (`get`, `DEEP_VERSION`, the fields of its reading) is kept, its values are not. `DEEP_VERSION` may be raised in a minor release; when it is, say so first in the changelog entry, since stored deep ids stop comparing. Raising it never raises `ID_VERSION`, and the reverse.
