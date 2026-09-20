# Public Reply Shape (maintainer, issue or PR)

Reusable by both Triage Mode and Ship / Release Follow-through. Default to this shape unless `AGENTS.md` or `CLAUDE.md` in the target repo contradicts it.

1. Resolve `@<login>` from `gh issue view` / `gh pr view --json author` before posting.
2. **Language:** Match the **opener's** language when it is Chinese or English. If the opener used Japanese or Korean, use English for the maintainer reply unless project docs override.
3. Open with `@<login>` and **at most one** short thanks (`感谢反馈`, `thank you for the report`, etc.). Do **not** add closing thanks stacks (`再次感谢`, `Thanks again`, long courtesy endings).
4. Default to one paragraph and one or two sentences: `@reporter` + one thanks, then the factual state/boundary and the reporter's next step. Include root cause only when it changes what the reporter should do. Internal files, CI approval, and maintainer process stay out.
5. Name the exact boundary: already released, fixed on `main` but unreleased, available in nightly/beta/preview, next release, not planned, duplicate, or still needs evidence. Every sentence must be true at the moment of posting: do not write "landed on main" while the change sits uncommitted, do not write "shipped", "released", or "verified" unless that state was checked in the current turn, and do not imply a verification step (built a branch, ran an artifact) that did not happen.
6. Always give a **next step tied to releases or verification**: next App Store or GitHub release, nightly upgrade command, cache path to clear once, or exactly what info is still needed.
7. For diagnostic bundles, logs, crash dumps, screenshots, or local-state archives, do not ask reporters to paste or attach sensitive material publicly. Ask for the minimum public facts, then use the project's private support channel only when public project context provides one.
8. Prefer **editing** an existing maintainer comment (`PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`) when updating wording; avoid delete plus repost unless the old text must disappear from history.
9. After posting or editing, re-read the comment body, author, target item, and issue/PR state. The public action is not complete without that receipt.

## When closing

The closing comment is the reporter's answer, not the investigation. State the fix state, the channel it arrives on, and when, then stop; root cause, file names, and the reasoning that got there belong in the commit. A reply that needs scrolling to read is over-length however well structured it is.

Close only when the fix is shipped, already available in the latest release, the report is invalid, the report is a duplicate, or the maintainer explicitly asked for closure. Otherwise leave open with the next-release acknowledgement.
