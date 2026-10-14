# eas-update-diagnose

A local checklist for the case where an EAS Update was published and the device never installs it.

It reads `app.json` / `app.config.*` and `eas.json`, and the native project when `ios/` or `android/` is checked in. It follows the checks in [Debugging EAS Update](https://docs.expo.dev/eas-update/debug/): runtime version, `updates.url`, the channel on each build profile, and platform. With `--fetch-manifest` it GETs the manifest URL using the same platform, runtime, and channel headers a device sends.

**eas-update-diagnose is not affiliated with, endorsed by, or sponsored by Expo.** It does not install Expo, publish an update, or call `eas-cli`. Channel-to-branch mapping lives on EAS servers; this tool only tells you whether the binary has a channel that could be mapped.

## The problem

A build and an update are compatible only when they share a runtime version, a platform, and a channel that is mapped to a branch. When any of those disagree, the update server answers `NoUpdatesAvailable` and the app stays on the bundle embedded in the binary. Nothing crashes. The usual causes:

- The binary was built with a different `runtimeVersion` than the update you just published. [Debugging EAS Update](https://docs.expo.dev/eas-update/debug/)
- The build profile has no `channel`, so the binary never sends `expo-channel-name` and cannot be linked to a branch.
- The update was published for the other platform.
- `updates.url` was never set, or `updates.enabled` is `false`.
- On Android, Google Play's automatic app-string translation rewrites the `expo_runtime_version` string resource after upload. Devices in that locale ask for a stale runtime. iOS is unaffected. [expo/expo#48148](https://github.com/expo/expo/issues/48148)

## Install

Node 18 or newer. The package is ESM-only.

```bash
npm i -D eas-update-diagnose
npx eas-update-diagnose --from-project .
```

From a clone of this repo:

```bash
git clone https://github.com/Salman-Labs/eas-update-diagnose.git
cd eas-update-diagnose
npm ci
npm run build
```

## Demo

`fixtures/stuck` is a project whose published update will not reach devices. The app config resolves runtime `1.4.0` with policy `appVersion`, but the checked-in iOS project still has `1.2.1`. The `preview` profile has no channel. The Android project never had `expo-channel-name` written into it. A Greek strings file overrides `expo_runtime_version` to `1.2.1`, which is what Play's translator does in [expo/expo#48148](https://github.com/expo/expo/issues/48148).

```bash
node dist/cli.js --from-project fixtures/stuck
node dist/cli.js --from-project fixtures/stuck --ci
```

The first command prints the checklist and exits 0. `--ci` exits 1 because checks failed.

`fixtures/healthy` is the same app with a channel on every profile and no native project checked in. The Android Play translation warning remains, because any Android binary can be rewritten by Play after upload. Warnings do not fail `--ci`:

```bash
node dist/cli.js --from-project fixtures/healthy --ci
node dist/cli.js --from-project fixtures/healthy --json
```

Installed from npm, the same commands are `npx eas-update-diagnose --from-project fixtures/stuck`.

### Sample output

`node dist/cli.js --from-project fixtures/stuck`:

```text
eas-update-diagnose 0.1.0

project     fixtures/stuck
app config  fixtures/stuck/app.json
eas.json    fixtures/stuck/eas.json
runtime     ios 1.4.0, android 1.4.0 (policy appVersion)
updates url https://u.expo.dev/11111111-2222-4333-8444-555555555555
platforms   ios, android

checklist
  PASS  EXPO_UPDATES
        expo-updates is listed in package.json.
  PASS  UPDATES_ENABLED
        updates.enabled is not false.
  PASS  UPDATES_URL
        updates.url is https://u.expo.dev/11111111-2222-4333-8444-555555555555
  PASS  PROJECT_ID
        extra.eas.projectId matches updates.url.
  PASS  RUNTIME_VERSION
        runtimeVersion policy appVersion resolves to 1.4.0 on ios and android.
  WARN  CHANNEL_UNMAPPED
        Build profile "development" is a development client with no channel. Development builds load from Metro and do not apply published updates unless EX_UPDATES_NATIVE_DEBUG=1.
  FAIL  CHANNEL_UNMAPPED
        Build profile "preview" has no channel. The binary will not send expo-channel-name, so EAS cannot map it to a branch.
  PASS  CHANNEL
        Build profile "production" uses channel "production".
  PASS  NATIVE_CONFIG
        ios native project sets the update URL and runtime version (ios/Stuck/Supporting/Expo.plist).
  FAIL  RUNTIME_MISMATCH
        ios native runtime version is "1.2.1", but the app config resolves to "1.4.0". The device asks for 1.2.1, so an update published at 1.4.0 is never delivered. Rebuild after changing runtimeVersion.
  PASS  NATIVE_CONFIG
        android native project sets the update URL and runtime version (android/app/src/main/res/values/strings.xml).
  FAIL  CHANNEL_UNMAPPED
        android native project does not embed expo-channel-name. eas.json channels are copied into the binary at build time; this native project has not been rebuilt with a channel.
  FAIL  PLAY_TRANSLATION_HINT
        Android string expo_runtime_version is overridden per locale (android/app/src/main/res/values-el/strings.xml = "1.2.1"). Google Play's automatic app-string translation rewrites this resource after upload, so devices in that locale request a stale runtime and the server returns NoUpdatesAvailable with no error. Disable App string translation in Play Console and upload a new bundle. https://github.com/expo/expo/issues/48148

result  FAIL  4 failed, 1 warning, 8 passed
```

A terminal colors failures red, warnings yellow, and passes green. `NO_COLOR` and `--json` turn that off.

## What it reads

Config discovery matches Expo's order. `app.config.ts`, `app.config.mts`, `app.config.cts`, `app.config.js`, `app.config.mjs`, then `app.config.cjs` win over static JSON. A function export receives `{ config }`, the static Expo config from `app.config.json` or `app.json`. The return value may be the Expo object or `{ expo: { ... } }`. `app.config.ts` / `app.config.js` is executed. If neither file exists, the `"expo"` key in `package.json` is used.

`runtimeVersion` may be a fixed string or a policy:

| Policy | Resolved value |
| --- | --- |
| `"appVersion"` | `expo.version`, same on iOS and Android |
| `"nativeVersion"` | `version(buildNumber)` on iOS and `version(versionCode)` on Android, for example `1.4.0(12)` |
| `"sdkVersion"` | `expo.sdkVersion` |
| `"fingerprint"` | Not computed. `@expo/fingerprint` runs at build and publish time; this tool reports `RUNTIME_FINGERPRINT_UNRESOLVED`. |

A platform-specific `ios.runtimeVersion` or `android.runtimeVersion` overrides the top-level value. If the two platforms resolve to different runtimes, one published update cannot reach both binaries (`RUNTIME_MISMATCH`).

`eas.json` `build` profiles are resolved through `extends`, including an inherited `channel`. A `developmentClient` profile with no channel is a warning: those builds load from Metro unless `EX_UPDATES_NATIVE_DEBUG=1`. Any other profile without a channel fails.

When `ios/` or `android/` exists, the tool reads `Expo.plist` (`EXUpdatesRuntimeVersion`, `EXUpdatesURL`, `EXUpdatesRequestHeaders`) and `AndroidManifest.xml` plus `strings.xml` (`EXPO_RUNTIME_VERSION`, `EXPO_UPDATE_URL`, `expo-channel-name`, including `@string/` indirection). A locale `values-*` file that changes `expo_runtime_version` fails `PLAY_TRANSLATION_HINT`.

## Reason codes

Failed checks make `ok` false. `--ci` exits 1 only for failures. Warnings stay in the report and still exit 0.

| Code | When it fails |
| --- | --- |
| `RUNTIME_MISMATCH` | The device `--runtime-version`, the native embedded runtime, the manifest runtime, or the per-platform resolved runtimes disagree. |
| `CHANNEL_UNMAPPED` | A build profile has no channel, the native project does not embed `expo-channel-name`, `eas.json` has no profiles, or `--channel` matches nothing. Development clients warn instead of failing. |
| `PLATFORM_MISSING` | `--platform` is not in the app config `platforms` list, or a checked-in native project is missing the update URL or runtime version. |
| `UPDATES_URL_MISSING` | `updates.url` is not set. |
| `PLAY_TRANSLATION_HINT` | Android locale resources override `expo_runtime_version`. Otherwise an Android target warns and links [expo/expo#48148](https://github.com/expo/expo/issues/48148). |
| `UPDATES_DISABLED` | `updates.enabled` is `false`. |
| `UPDATES_URL_INVALID` | `updates.url` is not an http(s) URL. |
| `UPDATES_URL_INSECURE` | Warning. The URL is `http`. |
| `UPDATES_URL_NATIVE_MISMATCH` | The native update URL differs from `updates.url`. The binary uses the native value. |
| `PROJECT_ID_MISMATCH` | `extra.eas.projectId` is not the id in a `u.expo.dev` URL. |
| `PROJECT_ID_MISSING` | Warning. The URL is `u.expo.dev` and `extra.eas.projectId` is unset. |
| `RUNTIME_VERSION_MISSING` | No `runtimeVersion` for a platform. |
| `RUNTIME_POLICY_UNRESOLVED` | A policy is set but `expo.version`, `expo.sdkVersion`, or the policy name cannot be resolved. |
| `RUNTIME_FINGERPRINT_UNRESOLVED` | Warning. Policy is `fingerprint`. |
| `RUNTIME_NATIVE_VERSION_DEFAULTED` | Warning. `nativeVersion` is missing `ios.buildNumber` or `android.versionCode`, so the tool uses `1`. |
| `CHANNEL_HEADER_MISMATCH` | `updates.requestHeaders['expo-channel-name']` or the native channel disagrees with the build profile. A native channel that matches no profile fails. |
| `EXPO_UPDATES_MISSING` | `expo-updates` is not in `package.json`. |
| `APP_CONFIG_MISSING` | No app config file. |
| `APP_CONFIG_INVALID` | App config JSON did not parse. |
| `APP_CONFIG_LOAD_FAILED` | `app.config.*` threw while loading. |
| `EAS_JSON_INVALID` | `eas.json` did not parse, or a profile `extends` is missing or cyclic. |
| `MANIFEST_NO_UPDATE` | `--fetch-manifest` got no compatible update (HTTP 404 or a `noUpdateAvailable` directive). |
| `MANIFEST_ROLLBACK` | The server returned `rollBackToEmbedded`. |
| `MANIFEST_FETCH_FAILED` | The manifest request failed, or runtime / channel / URL was missing so it could not be sent. |

Passing rows use `EXPO_UPDATES`, `UPDATES_ENABLED`, `UPDATES_URL`, `PROJECT_ID`, `RUNTIME_VERSION`, `CHANNEL`, `NATIVE_CONFIG`, and `MANIFEST`.

## CLI

```text
eas-update-diagnose --from-project <dir> [options]
```

| Flag | Meaning |
| --- | --- |
| `--from-project <dir>` | Expo project. Default `.`. |
| `--profile <name>` | `eas.json` build profile. Repeatable. Default: every profile. |
| `--platform <ios\|android>` | Platform to check. Repeatable. Default: the app config, which is iOS and Android when `platforms` is omitted. |
| `--channel <name>` | Channel the device should be requesting. Repeatable. |
| `--runtime-version <ver>` | `Updates.runtimeVersion` from the device. Compared with the resolved config runtime. |
| `--fetch-manifest` | GET `updates.url` with the headers below. |
| `--manifest-timeout <ms>` | Manifest timeout. Default `10000`. |
| `--json` | Print the report as JSON. `ok` is false when any check failed. |
| `--ci` | Exit 1 when a check fails. |
| `--version` | |
| `--help` | |

Exit 0 means the checklist had no failures, or `--ci` was not set. Exit 1 means `--ci` and at least one failure. Exit 2 means the command was used incorrectly (unknown flag, missing directory, unknown profile).

### Manifest request

`--fetch-manifest` sends the [Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/) headers. The [debug guide](https://docs.expo.dev/eas-update/debug/) describes the same three values as `Expo-Platform`, `Expo-Runtime-Version`, and `expo-channel-name`. Header names are case-insensitive.

```text
accept: application/expo+json, application/json
expo-protocol-version: 1
expo-platform: ios | android
expo-runtime-version: <resolved runtime>
expo-channel-name: <channel>
expo-json-error: true
```

One request is sent for each selected platform and channel whose runtime resolved. JSON and `multipart/mixed` responses are both read. A manifest whose `runtimeVersion` differs from the project is `RUNTIME_MISMATCH`. Only `http` and `https` URLs are fetched.

```bash
npx eas-update-diagnose --from-project . --platform ios --profile production --fetch-manifest --ci
```

### JSON

`--json` prints the diagnosis document: `ok`, `summary`, `resolvedRuntime`, `profiles`, `checks`, `manifests`, and `notes`. Paths are absolute. The text report shows paths relative to the current directory when they sit inside it.

```bash
node dist/cli.js --from-project fixtures/healthy --json
```

The document is larger than this excerpt. `fixtures/healthy` looks like:

```json
{
  "tool": "eas-update-diagnose",
  "version": "0.1.0",
  "ok": true,
  "runtimeVersion": { "policy": "appVersion" },
  "resolvedRuntime": { "ios": "1.4.0", "android": "1.4.0" },
  "summary": { "pass": 8, "warn": 1, "fail": 0 }
}
```

## Library

`diagnose` returns the same object `--json` prints.

```ts
import { diagnose } from 'eas-update-diagnose';

const report = await diagnose({
  projectRoot: '.',
  platforms: ['ios'],
  runtimeVersion: '1.2.1',
  fetchManifest: true,
});

if (!report.ok) {
  console.log(report.checks.filter((check) => check.status === 'fail'));
}
```

## CI

Run the checklist on every pull request. Pin the actions to full commit SHAs.

```yaml
name: eas-update
on: [pull_request]
permissions:
  contents: read
jobs:
  diagnose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
      - run: npm ci
      - run: npx --yes eas-update-diagnose --from-project . --ci
```

This repository's own [CI workflow](.github/workflows/ci.yml) typechecks and runs the tests on Node 18, 20, and 22. Tag pushes `v*` publish to npm only when the tag matches `package.json`, after `npm ci`, build, and test.

## Limitations

This tool does not talk to the EAS API. It cannot see whether a channel is mapped to a branch, which update group is current, or whether a rollout was halted. Those are the Deployments, Channels, and Branches pages described in the [debug guide](https://docs.expo.dev/eas-update/debug/). After the local checklist is clean, a device can still stay on the embedded bundle because the new update crashed on launch and EAS rolled it back. See [error recovery](https://docs.expo.dev/eas-update/error-recovery/).

`fingerprint` runtimes are not hashed here. A managed project with no `ios/` or `android/` directory has nothing to compare against the binary until you run prebuild or inspect a build artifact.

## License

MIT. Copyright Salman Labs. See [LICENSE](LICENSE).

Security reports: [GitHub private vulnerability reporting](https://github.com/Salman-Labs/eas-update-diagnose/security/advisories/new). See [SECURITY.md](SECURITY.md).
