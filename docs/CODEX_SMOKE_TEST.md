# Codex integration smoke test

Use this checklist for release validation against a real Codex CLI. Automated
tests cover config merging, identity collisions, hook transitions, permission
schemas, rollout parsing, live writer-lock discovery, and an isolated filesystem
install/reinstall/uninstall cycle; this check catches upstream hook-schema changes
in the installed CLI.

1. Back up `$CODEX_HOME/hooks.json` and start Cue with Codex hooks disabled.
   Confirm Claude Code hooks and live Claude cards are unchanged.
2. Before enabling hooks, start a Codex root session and confirm it appears in
   Cue via session discovery. Subagent/guardian rollouts must not appear as
   duplicate top-level cards.
3. In **Cue → Settings → Codex Integration**, click **Enable**. Confirm Cue added one
   `cue-codex-*` command per supported event, preserved every non-Cue entry, and
   installed `$CODEX_HOME/hooks/cue-hook` with owner-only permissions.
4. Restart Codex, open it in a trusted test project, run `/hooks`, then enable
   and trust the Cue command hooks. Do not use
   `--dangerously-bypass-hook-trust`.
5. Exercise these transitions and compare Cue with the Codex terminal:

   - session start → `idle`
   - submit a prompt → `thinking`
   - run a shell/file tool → `working`, with tool name/target populated
   - spawn and finish a subagent → `subagent`, then back to the parent state
   - compact context → `compacting`, then `working`
   - trigger a permission prompt → `waiting`; approve once and deny once in Cue
   - finish a turn → `idle`
   - end the session → `ended`

6. Confirm model, effort, message counts, cumulative input/output/cache tokens,
   context usage, git branch, latest prompt/assistant snippets, and duration
   update from the Codex rollout without changing a simultaneous Claude card.
7. From Cue's ended section, resume the Codex card. Confirm the launched command
   is `codex resume <native-id>` and not `claude --resume`.
8. Reinstall Codex hooks. Confirm no duplicate Cue entries appear and the first
   `hooks.json.bak` was not overwritten.
9. Uninstall only Codex hooks. Confirm the Cue commands and Codex script are
   gone, unrelated Codex hooks remain byte-equivalent at the JSON value level,
   and Claude hooks/cards still work. Re-enable Codex and repeat `/hooks` trust
   if the command hash changed.

Codex hook `timeout` values are seconds, unlike Claude Code's millisecond
timeouts. `PermissionRequest` gets the long interactive budget; `SessionEnd`
uses the short Codex-safe budget. Record the Codex CLI version with the result.
