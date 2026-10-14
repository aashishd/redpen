# redpen

Annotate a Markdown, HTML, or plain-text file in the browser with red-pen feedback.
The feedback is printed to stdout so a coding agent can act on it.

redpen is a stripped-down alternative to Plannotator. It has no hooks and no
plan-mode coupling. Run it when you need it, on any file. The only integration
contract is a shell command and its stdout, so it works with any coding agent.

## Install

```sh
npm install -g redpen-review
```

Requires Node 18 or newer. RedPen includes PostCSS for safe local stylesheet rewriting.

## Use

```sh
redpen plan.md
```

Supported files are `.txt`, `.md`, `.markdown`, `.html`, `.htm`, and
extensionless UTF-8 text files. Every other extension, including `.mdx`, `.mmd`,
and `.mermaid`, is rejected before the browser server starts.

Markdown supports fenced Mermaid diagrams:

````markdown
```mermaid
flowchart LR
  Start --> Finish
```
````

Mermaid is only rendered for `.md` and `.markdown` files. RedPen bundles the
official Mermaid 11.17.2 `dist/mermaid.min.js` locally at `ui/mermaid.min.js`.
Its MIT license is at `ui/mermaid.LICENSE`. The bundle adds about 3.6 MB to the
package. Mermaid starts with strict security settings and rejects diagram
frontmatter and every `%%{...}%%` directive, wherever it appears in the source.
Invalid, oversized, or rejected diagrams stay as escaped source with a short
error message.

HTML is rendered as a rich static page in a same-origin sandboxed frame.
RedPen keeps safe markup, inline styles, local stylesheets and nested local
imports, local fonts, native controls, details, raster images, and safe inline
or local SVG, including arrowheads and filter effects. Scripts, form submission,
navigation, frames, media, canvas, and external requests are blocked. Relative
paths resolve from the HTML or CSS file.
Root-relative paths resolve from the reviewed document directory. Assets must
remain in that real directory or a subdirectory. Traversal, encoded paths,
symlink escapes, remote URLs, and bad signatures are rejected. Raster and font
files use tokenized, descriptor-checked routes with `no-store` and `nosniff`.
Small image and font data URLs are allowed. Rejected images show a placeholder.
Rejected styles, fonts, and backgrounds show a compact warning in the page.

RedPen first runs the scripts of an HTML page, out of reach, until the page stops
changing. It then shows the state the page reached with the scripts removed, so
content that scripts draw is visible and you can comment on it. Buttons and
other page actions do nothing in this view.

- The page runs in a sandboxed frame with its own key, so it cannot read or
  change the review session. It may load files from the internet. From its own
  folder it may load only scripts, styles, images, and fonts, never hidden files
  such as `.env` or files in `.config/`.
- RedPen waits until the page has been quiet for half a second. A page that
  never stops changing is shown about three seconds after it loads.
- Form values, scroll positions, and canvas drawings are kept. Styles loaded
  from the internet are copied into the page.
- A reload or a document update runs the page again from the file.
- Local module scripts and root-relative paths such as `/app.js` do not load.
- Use `--no-js` for a file you do not trust. Its scripts never run, and RedPen
  shows the file as it is.

HTML reviews also have an **Enable Actions** switch in the header:

- Turn it on to use the page with its scripts running. The page starts from the file.
  Commenting, hover select, and sending pause while it is on.
- Turn it off to keep the page as it is. RedPen shows that state with scripts
  removed, and commenting resumes on it.
- The kept state lasts only in this browser tab. After a reload or a document
  update, comments on content that only your actions created show
  **Reference unavailable**.

This starts a local review session on a random localhost port, opens the file
in your browser, and waits for feedback. The browser tab and header use the
same red pen icon. Mermaid is served from that same local server. It has
no CDN, runtime fetch, or external network request. In the browser you can:

- select text and attach an inline comment to it; Save shows `Save (⌘ + ↵)` on macOS or `Save (⌃ + ↵)` elsewhere,
- see each saved annotation marked with a hand-drawn red underline,
- click an annotation to focus it with a red pen band, or edit its comment inline from the comments pane,
- collapse comments with the `>` button on the document divider; the narrow `<` rail keeps clickable red annotation positions and survives reloads in the same browser tab,
- choose **Auto**, **Dark**, or **Light** in the header; Auto follows your operating-system setting,
- **Hover select** starts on for HTML, Markdown, and plain text.
- In HTML, hover marks a visible element, including controls, images, and SVG.
  Click it to comment. Turn off **Hover select** to use safe native interactions.
- In Markdown and plain text, hover marks a paragraph or line. Click it to comment.
- use the keyboard shortcuts listed in the header:
  - `C` opens a comment for the hover-marked line or element,
  - `⌘ + ↵` on macOS or `⌃ + ↵` elsewhere saves a new or edited comment,
    and in the message box it does the same as **Send for review**,
  - `⌃ + H` turns **Hover select** on or off.
  `C` and `⌃ + H` do nothing while you type in a text box.
- write a message or question above the bottom action buttons,
- see submitted messages on the right and agent replies on the left,
- expand read-only submitted comments and follow references that still match the document,
- Draft messages while the agent replies. Document commenting pauses until the
  reply and any document update finish loading.
- finish with one of two buttons:
  - **Send for review**: the agent answers questions or edits the document, then replies in the same review page. Submitted document marks disappear. Comments stay in collapsed history and cannot be edited.
  - **Send feedback and exit**: the agent addresses the feedback and reports the result in its normal chat. RedPen ends the review session.

Saved comments, draft messages, and conversation history survive page refreshes,
foreground command timeouts, and worker crashes. RedPen keeps one unfinished
session for each document until **Send feedback and exit**. Running
`redpen <file>` again resumes that session. A worker restart creates a new local
URL. Document updates keep drafts. **Show in document** scrolls to an unchanged
reference and briefly outlines it. A reference that no longer matches shows
muted **Original text changed** text instead of a link.

Browsers opened on the same session URL share saved comments and draft messages.
Changes appear in another browser after a short polling delay. If two browsers
write from the same older draft, RedPen rejects the stale write instead of
silently replacing newer comments. The stale browser keeps its local copy and
asks for a reload.

On submit, the foreground command prints a report to stdout and exits. For
`revise`, the local server stays running so the same page can receive a reply:

```
ACTION: revise
FILE: /path/to/plan.md
SESSION: http://127.0.0.1:<port>/?t=<session-token>
TURN: 1

## General Comment

...

## Annotations (2)

### Annotation 1

Quote:

> the selected text

Comment:

the user's comment
```

HTML element annotations include a separate Element Context section with a
selector, identity details, visible text, and a short sanitized HTML excerpt.
Manual text selections in HTML also retain an advisory Element Location with the
nearest shared meaningful element's selector and identity details. It has no
visible text or HTML excerpt. Form values, hidden content, event attributes,
unsafe URLs, and session data are excluded.

Status messages go to stderr. Stdout carries only the report. After a revise
submission, the agent uses the report's session URL and turn number:

```sh
redpen reply "<SESSION>" --turn 1 --message "Updated the introduction and fixed the example."
redpen wait "<SESSION>" --after 1
```

Use `--message-file <path>` instead of `--message` for a longer UTF-8 reply.
Replies are plain text. A question can receive a reply without a document edit.
The reply command returns after delivery. The wait command returns the next
feedback report. Repeating the same reply is safe. Repeating a wait returns the
same next report; agents must not apply feedback twice. If the foreground
command is interrupted after submission, use `redpen wait "<SESSION>" --after 0`
to recover the first report, or supply the last completed turn for a later one.

RedPen saves an unfinished session in a private local file until **Send feedback
and exit**. It keeps running if the browser tab or foreground command closes, so
reopen the session URL to finish the review. If the worker stops, run
`redpen <file>` again to restore the saved comments and history at a new URL.

The theme choice and unfinished sessions use the RedPen application-data
directory. Set `XDG_CONFIG_HOME` to use `$XDG_CONFIG_HOME/redpen` on any
platform. Without that override, RedPen uses `~/Library/Application
Support/redpen` on macOS, `%APPDATA%\redpen` on Windows, or
`~/.config/redpen` on other systems. Session files use private permissions and
are removed after **Send feedback and exit**.

Options: `--out <file>` also writes the report to a file, `--port <n>` fixes
the port, `--no-open` prints the URL without opening a browser, and `--no-js`
never runs the scripts of an HTML page.

## Agent setup

`redpen install` adds the RedPen native Agent Skill to coding agents:

```sh
redpen install claude codex opencode gemini pi   # or: redpen install all
redpen uninstall all
```

| Agent | Skill file | Native invocation |
| --- | --- | --- |
| Claude | `~/.claude/skills/redpen/SKILL.md` | Activates automatically |
| Pi | `~/.pi/agent/skills/redpen/SKILL.md` | Activates automatically |
| Codex | `~/.agents/skills/redpen/SKILL.md` | `$redpen` or automatic |
| OpenCode | `~/.config/opencode/skills/redpen/SKILL.md` | Activates automatically through its skill tool |
| Gemini CLI | `~/.gemini/skills/redpen/SKILL.md` | Activates automatically; `/skills` manages skills |

The skill tells the agent to run `redpen <file>`, wait for feedback, and act
on the `ACTION:` line. For `revise`, it sends an answer or short change summary
with `redpen reply`, then waits for the next submission with `redpen wait`.
For `close`, it addresses the feedback and ends the loop. Reinstall the skill
after upgrading to update existing agent instructions. It prefers RedPen for
requests to add inline comments or annotations to a supported document,
including “redpen it”, “red pen it”, “red-pen it”, “annotate this document”,
and “add comments to this document”. It does not use RedPen for general
reading, summarization, proofreading, or code review without interactive
document annotation.

## Non-goals

No diff or PR review, no network sharing, no saved completed-session history,
no hooks, no build step.
