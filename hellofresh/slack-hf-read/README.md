# slack-hf-read (retired, see slack-reader)

This directory held Pi's managed Slack browser reader. It was replaced on 2026-10-12 by **slack-reader** after a day of cascading lifecycle failures (stale recorded tab IDs, stale Chromium singleton files after SIGTERM, spawn PID vs CDP listener mismatch).

- New home: `~/projects/personal/slack-reader` (https://github.com/luiul/slack-reader)
- Root causes and design: https://github.com/luiul/slack-reader/issues/1
- Command: `slack-reader` (also via the `slack-hf-read` / `slack-hf-session-login` shims in `../.local/bin/`)
- Recovery: `slack-reader reset`, then `slack-reader login`

The source and tests remain here during the soak period and will be removed once the shim flip is confirmed stable (rollout checklist in issue 1). All policy (read-only, fail closed, no credential replay) is unchanged.
