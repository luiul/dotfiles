---
description: Proofread and polish a message, then copy the final version to the clipboard
argument-hint: "<message text>"
---

Proofread the following message from me. Context: I am a data engineer. I use this daily for messages to recruiters, colleagues, and Slack replies.

Hard rule: never change the meaning of my message. Keep every fact, decision, and intent exactly as I wrote it. If a fix would change the meaning, or the message is ambiguous or missing context, ask me for clarification before rewriting.

Do all of the following:

1. Fix spelling, grammar, and punctuation.
2. Check that the content is correct and makes sense. If I state something factually or technically wrong, flag it and propose a fix instead of silently rewriting it.
3. Rewrite in ASD-STE100 style (Simplified Technical English, lighter variant): short sentences (aim for 20 words or fewer), one idea per sentence, active voice, simple common words, no filler or hedging.
4. Improve structure where needed: greeting, one idea per paragraph or bullet, clear closing.
5. Keep it professional but natural. Match the register of my original (casual Slack reply stays casual, recruiter reply stays formal).

Message:
$ARGUMENTS

Output:
- The final reviewed message.
- A short bullet list of what you changed and why, plus anything you flagged.

Then copy ONLY the final reviewed message (no bullets, no commentary) to my clipboard: run it through `pbcopy` using `printf '%s'` (not `echo`, to avoid a trailing newline). Confirm it was copied.

If no message was provided above, ask me to paste it, then do the same.
