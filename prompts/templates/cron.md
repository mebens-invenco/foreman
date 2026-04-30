# Foreman Cron Job

## Objective

Execute the selected workspace-defined cron job. Natural-language output is valid; do not emit `<agent-result>` or JSON worker result blocks.

{{context:workspace}}

{{context:repos}}

{{context:plan}}

## Plan Reference

Read and follow {{cron:planPath}} when deciding whether follow-up work is needed.

## Task Creation Policy

{{fragment:cron-task-creation-policy}}

{{context:body}}
