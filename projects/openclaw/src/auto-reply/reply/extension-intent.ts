function buildCandidates(body: string): string[] {
  const normalized = body.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }
  const out = new Set<string>();
  const queue: string[] = [normalized];
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      queue.push(trimmed);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()?.trim();
    if (!current || out.has(current)) {
      continue;
    }
    out.add(current);

    const withoutBracketPrefix = current.replace(/^(?:\[[^\]]+\]\s*)+/, "").trim();
    if (withoutBracketPrefix && withoutBracketPrefix !== current) {
      queue.push(withoutBracketPrefix);
    }

    const withoutSpeakerPrefix = current.replace(/^[^:\n]{1,80}:\s*/, "").trim();
    if (withoutSpeakerPrefix && withoutSpeakerPrefix !== current) {
      queue.push(withoutSpeakerPrefix);
    }
  }
  return Array.from(out);
}

export function isExtensionWorkflowRequest(body?: string): boolean {
  if (!body) {
    return false;
  }
  const candidates = buildCandidates(body);
  if (candidates.length === 0) {
    return false;
  }

  const claudeExtension =
    /\bclaude\b[\s\S]{0,48}\b(?:chrome\s+)?(?:browser\s+)?(?:extension|eextension|extention|extnesion)\b/i;
  const explicitExtensionUse = /\buse\s+(?:the\s+)?(?:extension|eextension|extention|extnesion)\b/i;
  const browserRelayPhrases =
    /\b(?:chrome extension|browser relay|toolbar icon|extension icon|attach tab)\b/i;
  const fileExtensionContext =
    /\b(?:file|filename|suffix|extension)\b[\s\S]{0,24}\.[a-z0-9]{1,5}\b/i;

  return candidates.some((candidate) => {
    if (fileExtensionContext.test(candidate) && !claudeExtension.test(candidate)) {
      return false;
    }
    return (
      claudeExtension.test(candidate) ||
      explicitExtensionUse.test(candidate) ||
      browserRelayPhrases.test(candidate)
    );
  });
}

export function isClaudeExtensionRequest(body?: string): boolean {
  if (!body) {
    return false;
  }
  const candidates = buildCandidates(body);
  if (candidates.length === 0) {
    return false;
  }
  const claudeExtension =
    /\bclaude\b[\s\S]{0,48}\b(?:chrome\s+)?(?:browser\s+)?(?:extension|eextension|extention|extnesion)\b/i;
  const extensionWord = /\b(?:extension|eextension|extention|extnesion)\b/i;
  const barHint = /\b(?:nav\s*bar|navbar|toolbar|on\s+my\s+bar|browser\s+bar)\b/i;
  const orangeHint = /\borange\b[\s\S]{0,40}\b(?:icon|extension|one)\b/i;
  return candidates.some(
    (candidate) =>
      claudeExtension.test(candidate) ||
      (extensionWord.test(candidate) && barHint.test(candidate) && orangeHint.test(candidate)),
  );
}

export function hasExplicitWebTarget(body?: string): boolean {
  if (!body) {
    return false;
  }
  const candidates = buildCandidates(body);
  if (candidates.length === 0) {
    return false;
  }
  const explicitUrl = /\bhttps?:\/\/\S+/i;
  const domainLike = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\b/i;
  return candidates.some((candidate) => explicitUrl.test(candidate) || domainLike.test(candidate));
}

export function isVagueUsefulExtensionRequest(body?: string): boolean {
  if (!body || !isExtensionWorkflowRequest(body)) {
    return false;
  }
  const candidates = buildCandidates(body);
  const vagueIntent =
    /\b(?:anything useful|something useful|showcase|demo|capab(?:ility|ilities)|whatever is useful)\b/i;
  const explicitTaskVerb =
    /\b(?:summarize|analyze|draft|write|search|research|open|click|compare|review|extract|check|audit)\b/i;
  return candidates.some(
    (candidate) =>
      vagueIntent.test(candidate) &&
      !explicitTaskVerb.test(candidate) &&
      !hasExplicitWebTarget(candidate),
  );
}
