---
name: pr-submission-discipline
description: VoxMem project pull request and Git submission discipline. Use when adding a new feature, modifying project behavior, preparing a PR title or description, splitting work into reviewable PRs, or verifying that a branch is ready to merge.
---

# PR Submission Discipline

## Overview

Use this skill to keep VoxMem changes small, reviewable, and reproducible. Every feature or behavior change must land through a focused PR that keeps the target branch runnable after merge.

## Core Rules

- Add new features through PRs, not direct commits to the main branch.
- Make each PR do exactly one thing: one feature, one fix, one workflow change, or one documentation concern.
- Split large features into multiple independent PRs that can be reviewed and merged step by step.
- Keep each PR as small as practical while still leaving the project in a runnable state.
- Keep `main` runnable after merge so reviewers can reproduce the demo at any time.

## Workflow

1. Start from an up-to-date `main` branch unless the repository later defines another integration branch.
2. Create a focused branch named for the single scope, such as `feat/add-memory-card`, `fix/audio-upload-error`, or `docs/add-pr-submission-skill`.
3. Implement only the files needed for that scope.
4. Run the narrowest useful validation command for the change.
5. Commit only the intended files with a clear message, such as `feat: add memory card creation` or `docs: add PR submission discipline skill`.
6. Push the branch and open a PR targeting `main`.
7. Do not merge until the PR title, description, and validation evidence are complete.

## PR Title

Write one sentence that clearly states what this PR adds or changes.

Good examples:

- `Add memory card creation flow`
- `Document PR submission discipline`
- `Fix audio upload failure handling`

Avoid vague titles such as `update`, `fix`, `optimize`, `changes`, or `final`.

## PR Description

Use this exact structure:

```markdown
## 功能描述

说明本 PR 新增/修改了什么、解决什么问题、功能如何使用或评委如何复现。

## 实现思路

简要说明技术选型、核心实现逻辑、涉及的关键模块或重要边界。

## 测试方式

- `command`: result
- `command`: result

## 风险与后续

说明未覆盖的边界、上线注意事项、后续 PR 应继续处理什么。没有明显风险时写“暂无已知风险”。
```

## Validation

Before opening or merging a PR:

- Run the relevant tests, build, lint, or manual verification for the changed area.
- Record the exact command and result in the PR description.
- If no automated test exists yet, document the manual verification steps.
- If validation cannot run, state the blocker and residual risk in the PR description.

## Merge Checklist

- The PR has one clear scope.
- The PR title is a one-sentence summary of the change.
- The PR description includes 功能描述, 实现思路, 测试方式, and 风险与后续.
- The listed validation steps actually ran.
- The target branch remains runnable after merge.
- `main` remains demo-ready for reviewers and judges.
- The PR does not include secrets, local logs, generated output, unrelated refactors, or unrelated formatting changes.
