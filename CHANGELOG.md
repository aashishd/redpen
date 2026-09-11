# Release notes

Changes in each RedPen release.

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
