---
name: redpen
description: Collect the user's inline feedback on a markdown or plain-text file. Opens the file in the browser for annotation, waits for the user to submit, then applies or acknowledges the feedback. Use when the user asks to annotate, review, or give inline feedback on a document, plan, or text file.
---

# redpen

redpen opens a document in the user's browser for annotation. The CLI blocks
until the user submits feedback, then prints the feedback to stdout.

## Steps

1. Identify the target file from the arguments or the conversation. It must
   exist on disk.
2. Run `redpen "<file>"` with the shell tool. Use a timeout of at least 30
   minutes, or run it in the background and wait for it to exit. It blocks
   while the user annotates in the browser; this is normal. Do not kill it.
3. When it exits, read its stdout. The first line is the decision.

## ACTION: revise

- Revise the file. Address the general comment and every annotation.
- Each annotation has a Quote (the text the user selected) and a Comment.
  Quotes come from the rendered document, so markdown syntax characters may
  be missing; find the matching passage in the source file.
- If a quote appears several times, the annotation includes surrounding
  context to disambiguate.
- Afterwards, list the changes briefly. Do not run redpen again unless the
  user asks.

## ACTION: close

- Do not modify the file. Summarize the feedback, acknowledge it, and stop.

## Empty output or non-zero exit

- The user cancelled or the command failed. Report that and stop.
