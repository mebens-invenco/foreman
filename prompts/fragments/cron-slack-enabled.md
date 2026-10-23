## Slack Result

Natural-language output remains valid and sends no message. To send one direct message, your entire terminating output must instead be exactly one strict result block:

<cron-result>
{"schemaVersion":1,"summary":"Foreman health scan completed.","action":{"type":"send_slack_dm","text":"Repeated failures were found. Review <https://example.com|the report>."}}
</cron-result>

The action may not choose a recipient or channel. Emit at most one action. The message must contain 1 to 4,000 characters.
