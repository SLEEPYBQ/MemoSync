export function normalizeContent(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function markdownBulletContent(raw: string): string | null {
  const line = raw.trim();
  if (!line.startsWith('- ')) return null;
  return line.replace(/^- (\[[^\]]*\]\s*)?/, '').trim() || null;
}
