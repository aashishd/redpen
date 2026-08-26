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

Requires Node 18 or newer. No dependencies.

## Use

```sh
redpen plan.md
```

Supported files are `.txt`, `.md`, `.markdown`, `.html`, `.htm`, and
extensionless UTF-8 text files. Every other extension, including `.mdx`, is
rejected before the browser server starts.

HTML is rendered as sanitized static content. RedPen removes scripts, styles,
frames, embeds, forms and controls, SVG, MathML, URL-bearing attributes, and
other active or externally loaded content.

This starts a one-shot server on a random localhost port, opens the file in
your browser, and blocks. In the browser you can:

- select text and attach an inline comment to it,
- see each saved annotation marked with a hand-drawn red underline,
- click an annotation to focus it with a red pen band,
- or turn on **Hover select** in the header: hovering marks a paragraph (or a
  line in plain-text files) and clicking it opens the comment box,
- write one general comment on the whole document,
- hide and reopen the comments pane from the header; its state survives reloads in the same browser tab,
- finish with one of two buttons:
  - **Submit Feedback & Revise**: the agent should update the document.
  - **Submit Feedback & Close**: the agent should acknowledge the feedback and
    stop.

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
act on the `ACTION:` line. Templates prefer RedPen for requests to add inline
comments or annotations to a supported document, including “redpen it”, “red
pen it”, “red-pen it”, “annotate this document”, and “add comments to this
document”. They do not use it for general reading, summarization, proofreading,
or code review without interactive document annotation. Explicit `/redpen
<path>` is reliable. Command-only harness templates do not make natural-language
requests invoke automatically.

## Non-goals

No diff or PR review, no sharing, no persistence, no hooks, no build step.
