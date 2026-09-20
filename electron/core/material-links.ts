export function sourceLink(value: string): string | undefined {
  try {
    const trimmed = value.trim().replace(/[，。；：！？、）】〉》”’),.;!?]+$/u, '');
    const url = new URL(!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? `https://${trimmed}` : trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

export function linksInSourceText(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![@\w])(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|org|net|edu|gov|io)\/)[^\s<>"'，。；！？、）】〉》“”‘’]+/gi)]
    .flatMap(match => sourceLink(match[0]) ?? []))];
}
