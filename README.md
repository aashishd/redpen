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
or local SVG. Scripts, form submission, navigation, frames, media, canvas, and
external requests are blocked. Relative paths resolve from the HTML or CSS file.
Root-relative paths resolve from the reviewed document directory. Assets must
remain in that real directory or a subdirectory. Traversal, encoded paths,
symlink escapes, remote URLs, and bad signatures are rejected. Raster and font
files use tokenized, descriptor-checked routes with `no-store` and `nosniff`.
Small image and font data URLs are allowed. Rejected images show a placeholder.
Rejected styles, fonts, and backgrounds show a compact warning in the page.

This starts a one-shot server on a random localhost port, opens the file in
your browser, and blocks. Mermaid is served from that same local server. It has
no CDN, runtime fetch, or external network request. In the browser you can:

- select text and attach an inline comment to it; Save shows `Save (⌘ + ↵)` on macOS or `Save (⌃ + ↵)` elsewhere,
- see each saved annotation marked with a hand-drawn red underline,
- click an annotation to focus it with a red pen band, or edit its comment inline from the comments pane,
- collapse comments with the `>` button on the document divider; the narrow `<` rail keeps clickable red annotation positions and survives reloads in the same browser tab,
- choose **Auto**, **Dark**, or **Light** in the header; Auto follows your operating-system setting,
- or turn on **Hover select** in the header: hovering marks a paragraph (or a
  line in plain-text files) and clicking it opens the comment box,
- write one general comment on the whole document,
- hide and reopen the comments pane from the header; its state survives reloads in the same browser tab,
- finish with one of two buttons:
  - **Submit Feedback & Revise**: the agent should apply all feedback, then open RedPen on the same file again. This repeats for later revise submissions.
  - **Submit Feedback & Close**: the agent should apply all feedback, report the changes, and stop without reopening RedPen.

On submit, the process prints a report to stdout and exits:

```
ACTION: revise
FILE: /path/to/plan.md

## General Comment

...

## Annotations (2)

### Annotation 1

Quote:

> the selected text

Comment:

the user's comment
```

Status messages go to stderr. Stdout carries only the report.

The theme choice is shared by future RedPen sessions. Set `XDG_CONFIG_HOME` to
store it in `$XDG_CONFIG_HOME/redpen/settings.json` on any platform. Without
that override, RedPen uses `~/Library/Application Support/redpen/settings.json`
on macOS, `%APPDATA%\redpen\settings.json` on Windows, or
`~/.config/redpen/settings.json` on other systems.

Options: `--out <file>` also writes the report to a file, `--port <n>` fixes
the port, and `--no-open` prints the URL without opening a browser.

## Agent setup

`redpen install` adds an on-demand `/redpen` command to coding agents:

```sh
redpen install claude codex opencode gemini pi   # or: redpen install all
redpen uninstall all
```

| Agent | File written |
| --- | --- |
| claude | `~/.claude/skills/redpen/SKILL.md` |
| pi | `~/.pi/agent/skills/redpen/SKILL.md` |
| codex | `~/.codex/prompts/redpen.md` |
| opencode | `~/.config/opencode/command/redpen.md` |
| gemini | `~/.gemini/commands/redpen.toml` |

The command tells the agent to run `redpen <file>`, wait for it to exit, and
act on the `ACTION:` line. `revise` repeats the review loop after applying the
feedback. `close` applies the feedback and ends the loop. Templates prefer RedPen for requests to add inline
comments or annotations to a supported document, including “redpen it”, “red
pen it”, “red-pen it”, “annotate this document”, and “add comments to this
document”. They do not use it for general reading, summarization, proofreading,
or code review without interactive document annotation. Explicit `/redpen
<path>` is reliable. Command-only harness templates do not make natural-language
requests invoke automatically.

## Non-goals

No diff or PR review, no sharing, no persistence, no hooks, no build step.
