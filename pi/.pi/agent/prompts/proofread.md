---
description: Proofread and polish a message, then copy the final version to the clipboard
argument-hint: "<message> [/c context] [--no-copy]"
---

Proofread a message from me. Context: I am a data engineer. I use this daily for messages to recruiters, colleagues, and Slack replies.

Input format:
- Everything before the first standalone `/c` token is the message to proofread.
- Everything after `/c` is context only (for example a pasted Slack thread or background on the situation). Do not proofread or rewrite the context. Use it to judge correctness, tone, and meaning.
- If the input contains `--no-copy`, skip the clipboard step and ignore that token as message content.

Hard rule: never change the meaning of my message. Keep every fact, decision, and intent exactly as I wrote it. If a fix would change the meaning, or the message is ambiguous or missing context, ask me for clarification before rewriting.

Do all of the following:

1. Fix spelling, grammar, and punctuation.
2. Check that the content is correct and makes sense. If I state something factually or technically wrong, flag it and propose a fix instead of silently rewriting it.
3. Rewrite in ASD-STE100 style (Simplified Technical English, lighter variant): short sentences (aim for 20 words or fewer), one idea per sentence, active voice, simple common words, no filler or hedging.
4. Improve structure where needed: greeting, one idea per paragraph or bullet, clear closing.
5. Keep it professional but natural. Match the register of my original (casual Slack reply stays casual, recruiter reply stays formal).

Input:
$ARGUMENTS

Output:
- The final reviewed message.
- Questions for me (only if something was ambiguous or missing context; skip this section otherwise).
- A short bullet list of what you changed and why, plus anything you flagged.

Unless `--no-copy` was given, copy ONLY the final reviewed message (no bullets, no commentary) to my clipboard: run it through `pbcopy` using `printf '%s'` (not `echo`, to avoid a trailing newline). Confirm it was copied.

Feedback loop: if I correct your reviewed message or state a writing preference during this session, save it with `memory_add` (target: user, category: preference, mention "proofread") so future runs apply it.

If no message was provided above, ask me to paste it, then do the same.
