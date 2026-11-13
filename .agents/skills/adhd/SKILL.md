---
name: adhd
description: 'Manual only: /adhd condenses the agent messages since the preceding user request into one clear message, preserving sources and current state. It performs no new work.'
---

# adhd

Run only when the user types `/adhd`. Gather every agent message since the user's preceding request, including progress, questions and the final answer. If that is only one short message, include the turn before it. Use only facts already reported or shown by conversation tool results; do no new work.

Keep the latest supported state, concrete results, remaining work and any actual owner need. Drop repeated status, superseded claims, irrelevant finished steps, tangents and narration of intended actions. If claims conflict, retain the latest supported fact and briefly state what changed. Preserve sources, uncertainty labels and necessary context so the message stands alone.

Write one message in plain words:

1. Lead with the actual next action and its owner, or the completed result if none remains.
2. State useful current progress; use step counts only when established, and "Done" only when nothing remains.
3. Use at most five short numbered points if needed, concrete results first, then open work. Define necessary technical terms inline. Give timing only if an existing measurement or supported estimate is available.

No preamble or closing offer. This summary replaces the message pile; it does not cancel or pause previously authorized work. Send only the summary for this command.
