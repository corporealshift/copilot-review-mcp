# Copilot Review Reader

A VS Code extension that makes code review comments readable by Copilot Chat. It bridges two normally isolated systems — the Copilot review comment panel and GitHub PR review threads — into a single tool that Copilot Chat agents can invoke programmatically.

## Why this exists

Copilot Chat can run code reviews and leave comments in the VS Code Comments panel, but it has no built-in way to _read_ those comments back. The same goes for GitHub PR review comments — they live on github.com, disconnected from your local Copilot Chat session.

This extension solves both problems by registering a [LanguageModelTool](https://code.visualstudio.com/api/references/vscode-api#lm.registerTool) that Copilot Chat can call to retrieve review comments, enabling a fully automated review-and-fix workflow.

## Setup

### Prerequisites

- VS Code 1.96+
- GitHub Copilot Chat extension
- `gh` CLI (for PR comments) — [install](https://cli.github.com/), then `gh auth login`

### Install

Install by downloading the extension from the releases section on github, then run

`code --install-extension copilot-review-reader-0.1.0.vsix --force`

You will need to reload vscode to enable the extension. Then copy the example agent into one of these locations:

- **Project-scoped:** `.github/agents/review-resolver.md` (available only in that repo)
- **User-scoped:** `~/.copilot/agents/review-resolver.md` (available in all workspaces)

#### From Source

```sh
cd copilot-review-reader
yarn install
yarn build
yarn package  # or: ./node_modules/.bin/vsce package --no-dependencies --allow-missing-repository
code --install-extension copilot-review-reader-0.1.0.vsix --force
```

Then reload VS Code.

## Usage

### In Copilot Chat

Reference the tool with `#reviewComments` in any Copilot Chat message:

```
Read #reviewComments and fix all the issues
```

Or let an agent call it automatically. The extension registers two tools:

#### `#reviewComments` (`review-reader_getReviewComments`)

Reads existing review comments. Use the `source` parameter to filter:

| `source` | What it reads |
|----------|---------------|
| `"all"` (default) | Both local Copilot review comments and GitHub PR comments |
| `"local"` | Only comments from the VS Code Comments panel (Copilot review) |
| `"pr"` | Only comments from the GitHub PR (via `gh` CLI) |

#### `#startReview` (`review-reader_startReview`)

Programmatically triggers a Copilot code review on uncommitted changes and optionally waits for results.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `scope` | `"all"` | `"all"` = staged + unstaged, `"staged"` = index only, `"unstaged"` = working tree only |
| `waitForComments` | `true` | If `true`, blocks until the review completes and returns the comments. If `false`, fires and returns immediately. |

### Automated workflow

1. Run a Copilot review: `Cmd+Shift+P` → **Copilot: Review Changes**
2. Wait for comments to appear in the Comments panel
3. Ask Copilot Chat: _"Read #reviewComments and address all the feedback"_
4. The agent reads the comments and applies fixes

For PR comments, just open a branch that has an active PR and the tool will detect it automatically via `gh pr view`.

### Commands

| Command | Description |
|---------|-------------|
| `Review Reader: Show Review Comments` | Dumps found comments + debug log to an Output channel |
| `Review Reader: Dump Comments to File` | Writes local review comments to `.review-comments.json` in workspace root |

## Comment format

The tool returns a JSON array. Each comment looks like:

```json
{
  "file": "src/editor/fields/media-field.tsx",
  "line": 40,
  "endLine": 42,
  "column": 1,
  "author": "copilot",
  "body": "This layout change from inline-block to block will break the thumbnail grid.",
  "suggestion": "display: 'inline-block'",
  "source": "local",
  "outdated": false,
  "url": null
}
```

| Field | Description |
|-------|-------------|
| `file` | Relative path from workspace root |
| `line` / `endLine` | 1-based line range |
| `column` | 1-based column |
| `author` | `"copilot"` for local, GitHub username for PR |
| `body` | The comment text |
| `suggestion` | Optional suggested fix (code or markdown) |
| `source` | `"local"` or `"pr"` |
| `outdated` | PR only — whether the comment is on outdated code |
| `url` | PR only — GitHub API URL for the comment |

## Example Agent

An example agent definition is included in [example-agent.md](./example-agent.md). It defines a "Review Resolver" agent that autonomously reads review comments, triages and fixes them, triggers local reviews in a loop, and commits the results — all without human intervention.

## Limitations

- **Local comments require an active review.** If no Copilot review is running, `source: "local"` returns nothing.
- **PR comments require `gh` CLI.** The tool shells out to `gh api` — if `gh` is not installed or not authenticated, PR comments won't load. The example agent's GraphQL mutations (replying to and resolving PR threads) require the `repo` scope. If `gh auth status` doesn't show `repo`, re-run `gh auth login` or `gh auth refresh -s repo`.
- **Object graph traversal is version-sensitive.** The local comment reader walks Copilot Chat's internal object graph, which can change between extension updates. See [INTERNALS.md](./INTERNALS.md) for details.
