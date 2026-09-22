import type { Message } from '../../../src/shared';

export function historyAnchor(messages: Message[], since?: number): Message | undefined {
  if (!messages.length) return undefined;
  if (messages.every(message => message.realSeq)) {
    let anchor = messages.at(-1)!;
    let sequence = BigInt(anchor.realSeq!);
    for (let index = messages.length - 2; index >= 0; index--) {
      const candidate = messages[index];
      const candidateSequence = BigInt(candidate.realSeq!);
      if (candidateSequence > sequence || sequence - candidateSequence > 1n) break;
      anchor = candidate;
      sequence = candidateSequence;
    }
    return anchor;
  }
  if (since !== undefined) return messages.find(message => message.time >= since) ?? messages[0];
  return messages[0];
}
