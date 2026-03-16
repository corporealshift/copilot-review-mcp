# Internals: How the Review Reader Works

This document explains the technical mechanisms the extension uses to read review comments from two very different sources.

## Architecture overview

```
┌──────────────────────────────────────────────────────┐
│ Copilot Chat (Agent)                                 │
│                                                      │
│  "Read #reviewComments and fix all issues"           │
│            │                                         │
│            ▼                                         │
│  ┌─────────────────────────────┐                     │
│  │ LanguageModelTool invocation│                     │
│  │ review-reader_getReview...  │                     │
│  └──────────┬──────────────────┘                     │
│             │                                        │
└─────────────┼────────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
┌────────────┐    ┌──────────────┐
│ Local      │    │ PR Comments  │
│ Comments   │    │ (gh CLI)     │
│            │    │              │
│ Object     │    │ gh api       │
│ graph walk │    │ repos/.../   │
│ into       │    │ pulls/N/     │
│ Copilot    │    │ comments     │
│ Chat DI    │    │              │
└────────────┘    └──────────────┘
```

The tool has two independent data pipelines that are merged into a single JSON array at invocation time.

## Part 1: Local Copilot review comments

This is the harder problem. The VS Code Comments API is sandboxed — extensions can only read comment threads they created themselves. There is no cross-extension enumeration API. So we can't just ask VS Code "give me all comments from the Copilot review controller."

### The object graph walk

All VS Code extensions run in the same Node.js process (the extension host). This means their runtime objects coexist in the same heap. The extension exploits this by starting from publicly exported objects and walking the object graph to find Copilot Chat's internal review service.

#### What we're looking for

In Copilot Chat's minified source (`extension.js`), the review service is a class (minified as `Lde`) that:

- Creates a `CommentController` with `id === "github-copilot-review"`
- Maintains a `_comments` array of `{comment, thread}` pairs
- Has methods like `getReviewComments()`, `addReviewComments()`, `removeReviewComments()`

The search target is any object where:

```typescript
obj._commentController?.id === 'github-copilot-review' && Array.isArray(obj._comments)
```

#### Entry points

The walker starts from three entry points, tried in order:

1. **Copilot Chat API** — `vscode.extensions.getExtension('github.copilot-chat').exports.getAPI()`. This returns a public API object. From there, the walker follows property chains through the DI container's service registry (`_instantiationService._services._entries`) to reach the review service.

2. **PR extension exports** — `vscode.extensions.getExtension('github.vscode-pull-request-github').exports`. A fallback in case the service is reachable through a different path.

3. **`require.cache`** — All loaded Node.js modules are in `require.cache`. The walker filters for `copilot-chat` modules and walks their exports.

#### Walk constraints

The walk uses several constraints to avoid infinite loops and excessive traversal:

| Constraint | Value | Why |
|------------|-------|-----|
| Max depth | 15 | Prevents runaway recursion through deep object trees |
| Cycle detection | `WeakSet` | Prevents revisiting the same object |
| Array limit | 20 elements | Arrays can be huge; we only check the first 20 |
| Map limit | 100 entries | Same idea for Maps (DI containers use Maps) |
| Key limit | 50 per object | Skip objects with excessive property counts |
| Skip keys | ~20 patterns | Prunes event emitter internals, disposable arrays, telemetry, credential stores, and other high-noise branches |

#### The actual path found

In practice (as of Copilot Chat 0.38.x), the service is found at:

```
copilotAPI
  ._languageContextProviderService
  .providers[0]
  .provider
  .resolver
  ._gitDiffService
  ._ignoreService
  ._requestLogger
  ._instantiationService
  ._services
  ._entries          ← Map
  .Map[28]           ← the review service instance
```

This path will almost certainly change between Copilot Chat versions. The walker handles this by being signature-based (looking for `_commentController.id`) rather than path-based.

#### Comment extraction

Once the service is found, comments are read from `service._comments`:

```typescript
// Each entry is { comment, thread }
// comment has: uri, range, body, suggestion, document
// suggestion has: edits (array of { newText }), markdown
```

Line numbers are converted from 0-based (VS Code internal) to 1-based, and file paths are made relative to the workspace root.

### Fallback: monkey-patching

On activation, the extension also attempts to monkey-patch `vscode.comments.createCommentController`. If successful, any future call to create a controller with `id === "github-copilot-review"` will have its `createCommentThread` method wrapped to capture threads as they're created.

This is a forward-looking fallback — it only captures threads created _after_ the extension activates. Since `activationEvents` includes `onStartupFinished`, this should catch reviews started after VS Code boots. It won't catch reviews that were already in progress when the extension loads.

In practice, the `vscode.comments` namespace is often frozen/non-configurable, so this patch may silently fail. The object graph walk is the primary mechanism.

### Fallback: file-based

As a last resort, the tool checks for a `.review-comments.json` file in the workspace root. This supports manual workflows where comments are dumped via the `Review Reader: Dump Comments to File` command and read back later.

## Part 2: GitHub PR comments

PR comments are fetched via the `gh` CLI, which handles GitHub authentication and API pagination.

### PR detection

```sh
gh pr view --json number,headRefName,baseRefName,url
```

This auto-detects the PR associated with the current branch. If the branch has no open PR, this step returns nothing and PR comments are skipped.

### Comment fetching

Two GitHub API endpoints are called in parallel:

**Review comments** (inline code comments):
```sh
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
```

Returns comments attached to specific file lines, including:
- `path` — file path relative to repo root
- `line` / `startLine` — line position
- `body` — comment text (may include markdown suggestion blocks)
- `outdated` — whether the comment is on code that has since changed
- `author.login` — GitHub username

**Issue comments** (top-level PR conversation):
```sh
gh api repos/{owner}/{repo}/issues/{number}/comments --paginate
```

Returns general PR discussion comments (not attached to specific lines). These have `file: ""` and `line: 0` in the output.

### Why `gh` CLI instead of the GitHub API directly

- **Authentication is already handled** — `gh auth` manages tokens, SSO, etc.
- **Pagination is built in** — `--paginate` handles multi-page results
- **Repository context is automatic** — `{owner}` and `{repo}` are resolved from the git remote
- **No token management in extension code** — avoids storing or passing secrets

## Part 3: Programmatic review initiation

The extension can trigger Copilot's code review on uncommitted changes without any UI interaction. This is exposed both as a VS Code command and as a LanguageModelTool.

### How it works

Copilot Chat registers several hidden commands (not shown in the command palette) that start reviews:

| Command | Scope |
|---------|-------|
| `github.copilot.chat.review.changes` | All uncommitted changes |
| `github.copilot.chat.review.stagedChanges` | Staged (index) only |
| `github.copilot.chat.review.unstagedChanges` | Working tree only |

These are invoked via `vscode.commands.executeCommand()`. Under the hood, each one instantiates Copilot Chat's review runner class and calls `.review(scope, ProgressLocation.Notification)`, which:

1. Computes git diffs for the selected scope
2. Sends the diffs to the Copilot model for review
3. Creates comment threads on the `github-copilot-review` CommentController
4. Shows progress in a notification toast

### The `#startReview` tool

The `review-reader_startReview` tool (referenced as `#startReview` in Copilot Chat) accepts:

- **`scope`** — `"all"` (default), `"staged"`, or `"unstaged"`
- **`waitForComments`** — `true` (default) to poll for up to 60 seconds until review comments appear, or `false` to fire-and-forget

When `waitForComments` is true, the tool polls every 2 seconds using the same object graph walker that `#reviewComments` uses. Once comments appear (or the timeout elapses), it returns them inline — so a single tool call can start a review and return the results.

### End-to-end flow

```
Agent calls #startReview { scope: "all" }
  → executeCommand('github.copilot.chat.review.changes')
    → Copilot Chat computes diffs, sends to model
    → Review comments appear on CommentController
  → Poll loop detects _comments via object graph walk
  → Return comments as JSON
```

This enables fully autonomous workflows like "review my uncommitted changes and fix all the issues" without any manual button clicks.

### The `Review Reader: Request Copilot Review` command

For manual use, the `review-reader.requestReview` command shows a quick-pick menu to select the scope (All / Staged / Unstaged) and triggers the review.

## LanguageModelTool registration

Two tools are registered, each via static declaration in `package.json` and runtime registration in `activate()`:

1. **`review-reader_getReviewComments`** (`#reviewComments`) — Reads existing review comments from local Copilot review and/or GitHub PR.

2. **`review-reader_startReview`** (`#startReview`) — Triggers a new Copilot review on uncommitted changes and optionally waits for the results.

The `canBeReferencedInPrompt: true` flag allows users to reference the tools as `#reviewComments` and `#startReview` in Copilot Chat. The `modelDescription` fields tell the language model what each tool does, so it can decide when to call them autonomously.

## Versioning risks

The local comment reader depends on Copilot Chat's internal object structure, which is:
- **Minified** — class and variable names are arbitrary
- **Undocumented** — no public API contract
- **Version-specific** — structure can change between updates

The signature-based search (`_commentController.id === "github-copilot-review"`) is more stable than a path-based approach, since:
- The comment controller ID is a user-visible string (appears in the Comments panel)
- The `_comments` array is a fundamental data structure, not an implementation detail
- Even if the DI container layout changes, the signature will still match

If a future Copilot Chat update breaks the walker, the debug log (visible via `Review Reader: Show Review Comments` command) will show exactly where traversal stops, making it straightforward to adjust skip-keys or depth limits.
