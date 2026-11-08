/** Shared by the topic directory, migration, and client picker. */
export function normalizeTopicName(name: string): string {
  return name.trim().normalize("NFC")
}

export function topicNameKey(name: string): string {
  return normalizeTopicName(name).toLowerCase()
}
