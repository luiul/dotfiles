# Shell helpers

## Git prompt startup

The prompt starts gitstatus only in repos without clean or process filters. Other repos use background Git. Startup reads the process-group header, opens the request FIFO without waiting, then buffers the hello reply. An early header is not daemon readiness. One five-second deadline bounds all phases, including FIFO retries.

The startup adapter checks the installed plugin's private protocol before launch and handoff. An unsupported contract falls back to background Git. Query parsing and normal descriptor cleanup remain with the plugin. Its query parser can still wait for a fragmented response; the startup fix does not change that parser or promise a fully nonblocking query path.

Disabled device configs such as `/dev/null` do not contribute changing device timestamps to the filter cache fingerprint. Real config files still invalidate that cache.

```sh
/bin/zsh -f scripts/test-git-prompt.zsh
node scripts/test-git-prompt-handshake.mjs
bun scripts/test-git-prompt-live.ts
```

The handshake test uses new real shells on private Rex endpoints. It checks delayed binaries, split replies, bad replies, EOF, silence and shutdown. The login test loads the candidate prompt without changing the live file. It checks completion, filtered Git results, responsive input, cancellation and shell exit.

## Shell launch helpers

`cod` and `piw` use the same directory rules. Both change the calling shell's directory when you supply arguments. Both keep the current directory and skip `cd` hooks when you omit arguments.

| Command | No arguments | With arguments | Window behavior |
| --- | --- | --- | --- |
| `cod` | Open the current directory in VS Code | Run the configured `cd`, then open VS Code | Delegate window reuse to `code .` |
| `piw` | Open Pi in the current directory | Run the configured `cd`, then open Pi | Create a new Ghostty window in the existing app instance |

Arguments belong to `cd`, not to VS Code or Pi. Paths with spaces, `..`, `-`, `-- PATH`, and zoxide queries follow your configured `cd` rules. A failed `cd` prevents launch and keeps its exit status. A successful directory change stays in the calling shell, even when launch fails. Tab completion delegates to `_cd` for both commands.

The public functions in `.zsh_config/funcs.zsh` are short directory wrappers. `_piw_launch` holds Ghostty's app-specific launch work. It checks app state without System Events, reports check failures, and preserves launch errors. A failed app check or window creation never triggers a second launch attempt.

Pi starts in an interactive zsh to load the shell environment. Its boot command discards buffered keystrokes before `exec pi`. The empty-input wait is 0.2 seconds. Buffered input adds a quiet-period wait. Cold launch keeps the single-instance `open -a` path and disables saved-window restoration. Do not replace it with `open -na`.

## Verification

Run from the repo root:

```sh
/bin/zsh scripts/test-cod.zsh
/bin/zsh scripts/test-piw.zsh
/bin/zsh -n zsh/.zsh_config/funcs.zsh
uv run scripts/test-launch-benchmark.py
```

The fixture tests never open apps. Both wrappers run the same 24 directory tests, including real zoxide queries against a private database. Pi launcher tests also check running and cold app paths, quoting, app-check errors, and launch errors. Benchmark cleanup tests check real SIGTERM cancellation and delayed exit after forced shutdown.

The live tests below create temporary app windows. They close only their own windows and stop the isolated VS Code instance. The Pi test uses a fake executable, checks interactive shell startup and real Pi lookup, and tests buffered-input removal in a controlling PTY. It does not make model calls. Ghostty must already be running.

```sh
uv run scripts/test-piw-live.py --benchmark
uv run scripts/bench-cod-live.py
```

## Benchmarks

```sh
/bin/zsh scripts/bench-launch-helpers.zsh --app-check
```

The shell benchmark compares the worktree with `HEAD`. It rotates case order and reports medians and ranges. No-op launchers isolate external process cost. Local backend replacements isolate wrapper overhead. Real app checks are read-only. All function replacements stay inside the benchmark process.

The live Pi benchmark compares three launches per version, with order reversed each round. It measures launch return and readiness of the fake Pi executable. The latter includes Ghostty creation, interactive shell startup, and input drain, but excludes Pi startup and model calls.

The live VS Code benchmark uses a private user-data directory and disables extensions. It measures five warm CLI calls per case. It checks the exact folder and reports one cold folder-ready sample. These timings are not a benchmark of your normal VS Code extensions.

### Measured results

Measured on this Mac against baseline `6a990e2`. Values are medians unless noted. App startup varies, so these numbers describe the run, not a fixed guarantee.

| Measurement | Baseline | Current | Samples |
| --- | --- | --- | --- |
| Ghostty app check | 106.7 ms (98.6 to 132.8) | 51.1 ms (47.2 to 60.8) | 9 per version |
| Real Pi window launch return | 413.9 ms (402.2 to 523.4) | 304.5 ms (262.0 to 330.3) | 3 per version |
| Fake Pi ready | 734.1 ms (686.9 to 820.6) | 640.8 ms (627.5 to 1076.7) | 3 per version |
| Warm isolated VS Code dispatch | 1234.5 ms (1189.9 to 1476.9) | 1209.4 ms (1168.6 to 1365.0) | 5 per version |
| `cod` wrapper, backend removed | 5.5 µs | 5.6 µs | 9 batches of 2000 |
| `piw` wrapper, backend removed | 5.5 µs | 8.5 µs | 9 batches of 2000 |

Direct VS Code dispatch measured 1160.7 ms. One cold isolated folder-ready sample measured 1492.3 ms. There is no clear VS Code speed improvement. The private Pi backend adds about 3 µs of shell overhead, while the real app-state check is about 56 ms faster. Fake Pi readiness has overlapping ranges, so do not treat its median change as a stable speedup.
