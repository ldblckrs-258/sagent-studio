# Workspace reads and edits

## Revisions
`read_file` returns `revision`, a fingerprint of the content. Only `edit_file` accepts it back as `expect_revision`, and then the write is rejected with `stale_write` when the file changed in between; the failure reports `expected` and `actual`, so re-read the file and rebuild the edit rather than retrying blind. `write_file` takes only `path` and `content` — it has no guard and overwrites whatever is there, reporting `before_hash` and `after_hash` after the fact. Edit an existing file with `edit_file` when concurrent changes matter.

## edit_file
Send `edits: [{ old_string, new_string, replace_all? }]`. The batch applies against one revision and is all-or-nothing, so several hunks for the same file belong in one call. Each `old_string` must match exactly once unless `replace_all` is true.

- `no_match`: the text is not present. Re-read with `line_numbers` or use `find_lines` to copy the exact text, including indentation.
- `multiple_matches`: widen `old_string` with surrounding lines, or set `replace_all`.
- `already_satisfied` in a successful response means the target text was already in place and nothing changed.

## Reading and searching
- `read_file` is capped and sets `truncated` when it clips; for a large file prefer `find_lines` (one file) or `search` (across the tree).
- `search` reports `filesScanned`, `filesSkipped`, and per-file `skipped` reasons — empty hits with skips is not the same as no match.
- `list_dir` with `recursive` has an entry cap; narrow the path or pass a `glob`.

## Debugging
- `path_rejected`: the path escapes the workspace folder.
- `permission_denied`: the current permission mode blocks it, or the call needs user approval.
- `not_found`: check with `stat` before assuming the tool is wrong.
