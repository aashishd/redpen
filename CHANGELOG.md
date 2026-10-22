# Release notes

Changes in each RedPen release.

## 1.0.0

First stable release.

- Show `<picture>` images in Markdown reviews. RedPen picks the light or dark
  image that matches its theme. **Auto** follows the system setting, and the
  **Dark** and **Light** buttons decide when chosen. A source needs a
  `prefers-color-scheme` rule and one local image; other sources fall back to
  the `<img>`.
- Show SVG images that use `<style>` blocks, in Markdown and HTML reviews.
  Styles with `@import`, outside links, or animation still show a placeholder.
- Rewrite the README for first-time readers, with a review-loop diagram. Move
  the full reference to `docs/reference.md`.
- Link the npm page to the GitHub repository.

## 0.8.0

- Run the scripts of an HTML page before review. RedPen waits until the page
  stops changing, then shows that state with scripts removed, so content that
  scripts draw can be reviewed. Page buttons and other actions do nothing in
  this view.
- Rename the **JavaScript** switch to **Enable Actions**. Turn it on to use the
  page's buttons and other controls.
- Add `--no-js`. HTML page scripts now run by default; use `--no-js` for a file
  you do not trust, and its scripts never run.
- Show inline SVG with arrowheads and filter effects in HTML reviews.

## 0.7.0

- Add keyboard shortcuts and list them in the header. `C` comments on the
  hover-marked line or element. `⌘ + ↵` (`⌃ + ↵` elsewhere) saves a new or
  edited comment, and sends for review from the message box. `⌃ + H` turns
  **Hover select** on or off.
- Add a **JavaScript** switch for HTML reviews. The page's scripts run in a
  separate sandboxed frame, and commenting pauses. Turn it off to comment on
  the page as the scripts left it.
- Show small `data:` images in HTML reviews.

## 0.6.1

- Keep unfinished sessions, review history, comments, and messages across command timeouts and worker restarts.
- Resume one active review per canonical document with a fresh local URL after a crash.
- Synchronize saved drafts across browsers and reject stale writes before they can replace newer feedback.
- Preserve submitted close feedback until the browser confirms delivery.
- Clear cancelled or stale document selections without blocking message input.
- Remove normal HTML metadata silently while retaining sandbox protections.

## 0.6.0

- Keep review history and replies in one browser page across review rounds.
- Add `redpen reply` and `redpen wait` for same-session replies and recoverable feedback.
- Preserve message drafts across refreshes and document updates.
- Pause document commenting until the reply and any document update finish loading.
  Reading, scrolling, history, and message drafting remain available.
- Add shared pen branding, compact controls, and temporary highlights for submitted references.
- Improve browser-test cleanup and cover review flows across HTML, Markdown, and text.

### Upgrade

After upgrading, run `redpen install` with the names of the agents you use to
refresh their installed skills. For `ACTION: revise`, use `redpen reply` and
`redpen wait` instead of starting a new review. Sessions stay open until
**Send feedback and exit**. Closing the browser tab alone does not stop a session.
