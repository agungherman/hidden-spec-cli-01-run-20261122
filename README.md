# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agungherman/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agungherman/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It reads a patch in unified diff, SEARCH/REPLACE, V4A, or JSON tool-call form and applies its edits to a tree of text files, all or nothing: it finds the lines an edit names even when the model drifted their whitespace or indentation (three matching tiers), and prints exactly what changed or why each edit failed. Built for make.fun's "Build mend, one patch tool for every AI edit format" bounty.

## Run it

```sh
node main.ts fix.patch
```

Pass a patch file, or pipe one on standard input (`node main.ts -`). Useful flags: `--format=unified|search-replace|v4a|json` to force one format instead of auto-detection, `--check` to report without writing anything, and `--strict` to match lines exactly (tier 0 only). Node 22, standard library only — nothing to install. The full contract is SPEC.md; `runner.ts` is the kit's trial runner and `check.ts` runs the 100 public practice checks (`node check.ts <practice.json>`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=5wyg9qx0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
