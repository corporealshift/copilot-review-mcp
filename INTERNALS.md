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

## LanguageModelTool registration

The tool is registered via two mechanisms:

1. **Static declaration** in `package.json` under `contributes.languageModelTools` — this tells VS Code the tool exists, its name (`review-reader_getReviewComments`), reference name (`reviewComments`), input schema, and description.

2. **Runtime registration** in `activate()` via `vscode.lm.registerTool()` — this provides the actual implementation (the `invoke` method).

The `canBeReferencedInPrompt: true` flag allows users to reference the tool as `#reviewComments` in Copilot Chat. The `modelDescription` field tells the language model what the tool does and what parameters it accepts, so the model can decide when to call it autonomously.

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
