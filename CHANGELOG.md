# Release notes

Changes in each RedPen release.

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
