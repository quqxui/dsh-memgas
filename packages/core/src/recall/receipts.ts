const REFERENCE = /memory:(m_[0-9a-f]{10})/g

/** Memory ids the assistant quoted back; the only online signal that a recall was used. */
export function referencedMemoryIds(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(REFERENCE)) {
    const id = match[1]!
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}
