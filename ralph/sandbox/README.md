# Ralph sandbox

The Docker sandbox runs everything that executes agent-written or agent-influenced code: the `claude` agent, dependency installs and the final project gate. It is **mandatory when `ralph.enabled` is `true`**. There is no host fallback: if Docker is unavailable, nothing runs.

`ralph/sandbox.js` is the only module that calls the Docker CLI. It takes a trusted call specification from its caller and never reads the profile from a working clone. Which call needs a read-only `.git`, which network it gets (internal network and proxy for the agent and installs, `none` for the gate) and which credentials the agent receives is the caller's policy (the controller task), not this module's. The git binary in the image does not mean the agent is given git or gh tools.

## Settings

There are two sources, kept apart on purpose.

### Profile: `sandbox` in `.factory/profile.json` (tracked, project-wide)

The profile holds the values that describe the image and what it may reach. It holds no credentials: `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are passed by the controller from its environment.

| Field | Required | Rule |
|---|---|---|
| `image` | yes | Docker image name with an explicit tag, `name:tag`. An untagged image is rejected. |
| `nodeVersion` | yes | Numeric string: `22`, `22.1` or `22.1.2`. |
| `claudeCodeVersion` | yes | Exact `X.Y.Z`. No range, `latest` or pre-release. |
| `allowedHosts` | yes | Non-empty array of DNS names with at least two labels. No scheme, IP, port, path or wildcard. The egress proxy allows only `CONNECT` to port 443 of exactly these names (case-insensitive); subdomains are not included. |
| `installEnv` | no | Object of string values for dependency installs. Names match `^[A-Za-z_][A-Za-z0-9_]*$`. Reserved (any case): `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `DOCKER_*`, `GIT_*`, `GCM_*`, `GH_*`, `HOME`, `CLAUDE_CONFIG_DIR`. A missing `installEnv` means `{}` in the runtime config only; the profile is not rewritten. |

Any other field is rejected as unknown. The section is required when `ralph.enabled` is `true`. When Ralph is absent or disabled it may be omitted, but a given `sandbox` is always validated in full.

`loadProfile` checks the section with the schema and with `collectSandboxProblems` from `sandbox.js`, the same function `validateSandboxConfig` uses at runtime. A profile error names the file and the full path of the field, for example `sandbox.installEnv.HTTPS_PROXY`.

### Local run config (personal, outside Git): `runsRoot`

Clones and agent session journals live under the runs root. It is a personal setting of the person who runs Ralph, so it is **not** in the profile (`runsRoot` in the profile, at the root or in `sandbox`, is rejected as an unknown field).

- Optional, top level of the local run config. Absent means `<consumerRoot>/.ralph-runs`.
- When set: a non-empty string, absolute or relative to `consumerRoot`.
- `resolveRunsRoot(localRunOptions, consumerRoot)` takes both explicitly. It never uses the directory of the installed package as a state root.
- The root is mounted into containers, so after resolving links it must be **outside the operator's home directory**, which is never mounted. A path inside the home is rejected with a message asking for an external `runsRoot`; the protection is not switched off and no unsafe fallback is chosen. On a machine where the project itself is in the home directory, set `runsRoot` to a directory elsewhere (for example on another drive or under `/var`).

## Protections kept from the reference runtime

- Nothing under the operator's home (symlinks and junctions resolved) is ever mounted.
- Only the run clone, its own `.git` (read-only when the call requires it; it must be a real directory, not a link) and the session directory are mounted; the work directory stays inside the workspace.
- `--cap-drop ALL`, `no-new-privileges`, `--init`, `--rm`, ownership labels for cleanup.
- Call arguments are checked before any Docker or filesystem action: `image` needs an explicit `name:tag`; `rootKey` and `runLabel` (label values, filters and object names) and `network` / `name` (Docker object names) must be plain names of letters, digits, `_`, `.`, `-`. The same checks apply to `startProxy` (including every `allowedHosts` entry) and `removeLeftovers`. Which network a call uses is the caller's policy; this module only checks that the value is a well-formed name.
- A variable name may be given once. A secret name (`env`) that also appears in `publicEnv`, or among the proxy variables the runtime adds when `proxyUrl` is set, is rejected with the name (never the value), because the container would receive that name from two sources. A `publicEnv` entry with a proxy name is not an error: the runtime's proxy value replaces it.
- Secrets go as `-e NAME`; values live only in the Docker CLI's own process environment and never in argv. Public settings and the proxy address are `-e NAME=value` and do not change the CLI's environment.
- Cleanup removes only containers and networks that carry the consumer's own `managed` label; a timeout or failure removes the container.

## Known limitation: proxy filters names, not addresses

The egress proxy limits destinations by **host name** (exact match, `CONNECT` to port 443). It does not check the class of the IP address the name resolves to, for example a private or link-local address. The allowlist and the DNS used by the machine that runs the proxy are therefore trusted: list only names the owner trusts. This limitation applies to local runs too.

## Module independence

`sandbox.js` and `sandbox/proxy.js` use **only Node built-ins** (`proxy.js` also requires `sandbox.js`). The Dockerfile copies exactly these two files into the image, so they cannot import the profile loader, Ajv, the agent, the workspace or the boundary. Requiring them starts no process and opens no socket; the proxy listens only when `proxy.js` is run as the entrypoint. The build context and the `ralph` named context are files of the installed package, never the consumer's checkout or a run clone.

## What is proven where

- **This task (portable tests, `npm test`):** settings and validation, the proxy decision, runs root resolution, mount, work-directory and environment boundaries, build arguments, cleanup and timeout handling. Processes are replaced at the `child_process` boundary and HOME is a controlled temporary directory. No Docker, network or AI is needed on Linux or Windows.
- **Not proven by these tests:** that the image builds, and the real container protections (isolation from the home, empty git credentials, no network for the gate, the proxy blocking foreign hosts, read-only `.git`, file ownership, session journals, container labelling). The original Docker scenarios are kept verbatim in `test/fixtures/ralph-sandbox/source/` with a map of each scenario in `cases.json`; they are data, not passing tests.
- **Wiring into the controller:** done in `ralph/` (see `ralph/README.md`): the controller chooses the policy per phase (agent and installs on the run network through the proxy, the gate with no network, read-only `.git` everywhere, `installEnv` only for installs and dependency sync).
- **Real Docker integration:** `test/integration/ralph-sandbox.test.js`, created by the integration task after the controller move. It is not run by `npm test` and is never replaced by a skip that reports success.
