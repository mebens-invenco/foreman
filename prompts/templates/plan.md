# Foreman Planning Prompt

You are preparing the current workspace plan for `{{workspaceName}}`.

## Workspace Configuration

```json
{{workspaceConfig}}
```

## Discovered Repositories

```json
{{reposJson}}
```

## Task System Guidance

{{taskSystemPlanningFragment}}

## Shared Guidance

{{workerCommon}}

## Learning Policy

{{learningPolicy}}

## History Policy

{{historyPolicy}}

Produce a concise plan that explains the current workspace operating model, key repos, and how autonomous work should be selected and reviewed.
