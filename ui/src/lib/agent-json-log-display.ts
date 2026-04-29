type JsonRecord = Record<string, unknown>

const TEXT_FIELDS = ["text", "content", "result", "output", "message"] as const
const SESSION_FIELDS = ["sessionID", "sessionId", "session_id"] as const
const EVENT_FIELDS = ["status", "state", "phase", "name", "tool", "toolName", "tool_name"] as const
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "total_tokens"] as const

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }

  return value.length > 0 ? value : null
}

const stringField = (record: JsonRecord, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = stringValue(record[name])
    if (value) {
      return value
    }
  }

  return null
}

const extractTextValue = (value: unknown, depth = 0): string[] => {
  if (depth > 3) {
    return []
  }

  const direct = stringValue(value)
  if (direct) {
    return [direct]
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextValue(item, depth + 1))
  }

  if (!isRecord(value)) {
    return []
  }

  return TEXT_FIELDS.flatMap((field) => extractTextValue(value[field], depth + 1))
}

const extractUserText = (record: JsonRecord): string | null => {
  const values = TEXT_FIELDS.flatMap((field) => extractTextValue(record[field]))
  const part = record.part
  const partValues = isRecord(part) ? TEXT_FIELDS.flatMap((field) => extractTextValue(part[field])) : []
  const text = [...values, ...partValues].join("")
  return text.length > 0 ? text : null
}

const conciseString = (value: string): string => (value.length > 80 ? `${value.slice(0, 77)}...` : value)

const isNoisyWithoutText = (type: string | null): boolean => {
  const normalized = type?.toLowerCase() ?? ""
  return normalized.includes("delta") || normalized.includes("token")
}

const formatEventLine = (record: JsonRecord): string | null => {
  const type = stringField(record, ["type"])
  if (isNoisyWithoutText(type)) {
    return null
  }

  const label = type ?? "json"
  const details: string[] = []
  for (const field of EVENT_FIELDS) {
    const value = stringValue(record[field])
    if (value) {
      details.push(`${field}=${conciseString(value)}`)
    }
  }

  const sessionId = stringField(record, SESSION_FIELDS)
  if (sessionId) {
    details.push(`session=${conciseString(sessionId)}`)
  }

  for (const field of TOKEN_FIELDS) {
    const value = record[field]
    if (typeof value === "number" && Number.isFinite(value)) {
      details.push(`${field}=${value}`)
    }
  }

  return details.length > 0 ? `[${label}] ${details.join(" ")}` : `[${label}]`
}

export const renderAgentJsonLogLine = (line: string): string | null => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return line
  }

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return line
  }

  if (!isRecord(value)) {
    return line
  }

  const text = extractUserText(value)
  if (text) {
    return text
  }

  return formatEventLine(value)
}
