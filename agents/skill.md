---
name: redpen
description: Collect inline comments or annotations on a supported document. Prefer RedPen when the user says “redpen it”, “red pen it”, “red-pen it”, “annotate this document”, or “add comments to this document”. Do not use it for general reading, summarization, proofreading, or code review without interactive document annotation.
---

# redpen

RedPen opens a document for annotation and conversation in the browser. Each
foreground command waits for one submission. The review page stays open between
turns, with read-only submitted comments and agent replies.

Supported files are `.txt`, `.md`, `.markdown`, `.html`, `.htm`, and
extensionless UTF-8 text files. Refuse every other extension, including
`.mdx`, before running the command.

## Start a review

1. Identify the existing target file and check its format.
2. Run `redpen "<file>"` with the shell tool. Use the longest practical timeout, or run it in the background and wait for it to exit. Waiting while the user reviews is normal. Do not kill it intentionally. A tool timeout does not end the saved browser session.
3. Read the feedback from stdout. `ACTION` is the user's choice. `FILE` is the document. `SESSION` is the local review URL. `TURN` is the submitted message number. If the command times out, run `redpen "<file>"` again. It resumes the unfinished session without losing saved comments.

## ACTION: revise

1. Address the general message and every annotation. Answer questions without editing the document unless a change is needed or requested. Quotes come from rendered content, so Markdown syntax may be missing. Use surrounding context when a quote appears more than once.
2. Make any requested document changes.
3. Reply **inside RedPen**, not only in the agent's normal chat. For edits, give a one- or two-line summary. Answer questions in the detail they need. A text-only reply is valid.
4. Run `redpen reply "<SESSION>" --turn <TURN> --message "<reply>"`. Quote shell arguments safely. For longer replies, write a temporary UTF-8 file and use `--message-file "<path>"` instead of `--message`.
5. After reply delivery succeeds, run `redpen wait "<SESSION>" --after <TURN>`. Use the same waiting rules as the initial command. Repeat for each later submission. Do not reopen RedPen or create another browser tab.

A reply updates the document in the existing review page. The user can draft
messages while waiting. Document commenting pauses until the reply and any
document update finish loading. Submitted comments cannot be edited. If reply delivery
is uncertain, retry the same turn and text. Identical retries do not create
another message. Waiting again with the same `--after` value returns the same
next submission, so do not apply feedback twice.

## ACTION: close

Address the general message and every annotation. Make requested changes and
answer questions. Report the result briefly in the normal agent chat, then stop.
The review session has ended. Do not reopen RedPen or send another session reply.

## Failure or cancellation

If a command fails, report the problem without claiming delivery. Keep the
session URL and turn number for recovery. Use
`redpen wait "<SESSION>" --after <last-completed-turn>` while the URL works.
Use `--after 0` if no turn has been completed. If the local URL no longer works,
run `redpen "<file>"` again. RedPen restores that document's unfinished session
at a new URL. Empty feedback output or a non-zero wait exit means the wait
failed or was cancelled.
