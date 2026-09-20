# Checkpoints and history

Workspace writes, including writes from the sandbox bridge, are recorded in the thread's journal. Coverage is not total: a file the journal cannot read as text (binary or oversized) is skipped, and content over 262144 characters is stored as a partial entry that restore reports as unrestorable.

- `checkpoint` records a restore point and returns an id. Take one before a risky batch of edits.
- `restore` reverts every journaled change made after that checkpoint id. It is a bulk undo, so it also reverts unrelated files touched after the checkpoint. Read its response before assuming success: `restored`, `removed`, `skipped`, and `unrestorable` name the files in each outcome.
- Checkpoint ids are process-local and expire with the retained journal window, so an id from before a reload returns `not_found`. Take a fresh checkpoint instead of reusing an old id.
- `diff` shows what changed in one file, against the previous journaled state by default or against a checkpoint id passed as `since`.
- `history` lists recent journaled changes with hashes and kinds, optionally filtered to one path. It never returns file contents.

Changes made outside the app are not journaled and cannot be restored.
