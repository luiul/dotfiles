---
description: Proofread and polish a message, then copy the final version to the clipboard
argument-hint: "<message> [--context <text>] [--scratch] [--no-copy]"
---

Proofread a message from me. Context: I am a data engineer. I use this daily for messages to recruiters, colleagues, and Slack replies.

## Input format and flags

My input has this shape:

    <message> [--context <text>] [flags]

Flags (I can combine them freely):

- `--context <text>` or `-c <text>`: everything after the FIRST standalone `--context` or `-c` token is context only (for example a pasted Slack thread or background on the situation). Never proofread or rewrite the context. Do not treat flag-like text inside it as flags. Use it to judge correctness, tone, and meaning.
- `--scratch` or `-s`: also save the full review to a scratch file (see "Scratch file" below).
- `--no-copy` or `-n`: skip the clipboard step.

Parsing rules:

1. Split my input on the first standalone `--context` or `-c` token. Before it is the message part, after it is the context.
2. Boolean flags (`--scratch`/`-s`, `--no-copy`/`-n`) are valid in the message part, or as trailing tokens at the very end of the whole input. Remove them. What remains of the message part is the message to proofread.
3. If `-c` appears inside what looks like a shell command in my message (for example `git commit -c HEAD~1`), treat it as message content, not as the context delimiter. If unsure, ask me.

Usage examples:

- `/proofread thanks for the call today, I startet last week -n`
  Proofread the message, do not copy to the clipboard.
- `/proofread can we move the deploy to friday --context <pasted Slack thread>`
  Proofread the message, use the thread as context, copy to the clipboard.
- `/proofread lgtm, ship it --context <pasted Slack thread> -s`
  Proofread the message, use the thread as context, copy to the clipboard, also save the review to a scratch file.

## Hard rule

Never change the meaning of my message. Keep every fact, decision, and intent exactly as I wrote it. If a fix would change the meaning, or the message is ambiguous or missing context, ask me for clarification before rewriting.

## Do all of the following

1. Fix spelling, grammar, and punctuation.
2. Check that the content is correct and makes sense. If I state something factually or technically wrong, flag it and propose a fix instead of silently rewriting it.
3. Rewrite in ASD-STE100 style (Simplified Technical English, lighter variant): short sentences (aim for 20 words or fewer), one idea per sentence, active voice, simple common words, no filler or hedging.
4. Improve structure where needed: greeting, one idea per paragraph or bullet, clear closing.
5. Keep it professional but natural. Match the register of my original (casual Slack reply stays casual, recruiter reply stays formal).

Input:
$ARGUMENTS

## Output

- The final reviewed message.
- Questions for me (only if something was ambiguous or missing context; skip this section otherwise).
- A short bullet list of what you changed and why, plus anything you flagged.

## Clipboard

Unless `--no-copy` or `-n` was given, copy ONLY the final reviewed message (no bullets, no commentary) to my clipboard: run it through `pbcopy` using `printf '%s'` (not `echo`, to avoid a trailing newline). Confirm it was copied.

## Scratch file (only with `--scratch` or `-s`)

Write the full review (final message, questions if any, change list) to `~/scratch/<descriptive-name>.md` (e.g. `proofread-team-update.md`) and print the full absolute path so I can click to open it. Without the flag, do not create any file.

## Feedback loop

If I correct your reviewed message or state a writing preference during this session, save it with `memory_add` (target: user, category: preference, mention "proofread") so future runs apply it.

If no message was provided above, ask me to paste it, then do the same.
