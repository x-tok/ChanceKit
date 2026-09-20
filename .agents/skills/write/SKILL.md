---
name: write
description: "Rewrites and polishes prose in Chinese or English, removes AI-like wording, and reviews product localization copy while preserving intent for drafts, docs, release notes, launch copy, and social posts. Use when users ask in any language to draft, rewrite, proofread, localize, polish release notes, remove AI-like wording, or prepare launch and social copy. Not for code comments, commit messages, or inline docs."
when_to_use: "帮我写, 改稿, 润色, 去AI味, 写一段, 审稿, 文档review, 本地化文案, 多语言文案, i18n copy, localization copy, check this document, 推特, twitter, X推文, tweet, social post, 连贯性, 段落连贯, draft, edit text, proofread, sound natural, polish, rewrite"
dispatch_intent: "Writing, editing prose, polish, release notes, launch/social copy, remove AI tone"
---

# Write: Cut the AI Taste

Prefix your first line with 🥷 inline, not as its own paragraph.

Strip AI patterns from prose and rewrite it to sound human. Do not improve vocabulary; remove the performance of improvement.

## Outcome Contract

- Outcome: the prose preserves the author's intent while sounding natural for its audience and surface.
- Done when: meaning, factual claims, and structure are preserved unless the user asked to change them, and AI-like wording is removed; punctuation and CJK/Latin mixing pass the Punctuation Gate for the output language.
- Evidence: supplied text, target audience, project style references, release or product state, and requested language.
- Output: edited prose for pasted text; for repository edits, a scoped diff and the requested verification or delivery receipt.

## Durable Context Preflight

See [references/durable-context.md](references/durable-context.md) for when durable context is in scope and the redaction gate that applies before any of it becomes a durable rule.

For `/write`: the supplied text and current release state override memory. Durable preferences can set brevity, tone, and social-post shape; they do not override the hard rule to edit in place, keep meaning intact, and avoid change lists unless the user explicitly asks.

## Core Stance

This skill is a catalog of smells, not a checklist to run top to bottom. Use it to recognize AI taste, then make judgment calls. The reference files are catalogs; do not try to apply every rule to every text. Applying more rules is not doing a better job.

- **Over-editing is failure, equal to under-editing.** If a sentence is already natural, clear, and stable, leave it. Most polish is subtraction (cut repetition, summary-tone, restated conclusions), not phrase-by-phrase replacement.
- **A piece has a speaker.** Smooth prose that could belong to anyone has lost something. Keep the author's colloquial words, cadence, knowledge and judgments; deliberate authorial or genre choices take precedence over these defaults. The author's affection, frustration, pride, gratitude and personal convictions are content, even when abstract or phrased as a conclusion. Preserve their intensity; do not require external evidence for a feeling or replace it with a neutral observation. Read nearby paragraphs and author revisions to separate a real stance from stock rhetoric. If that distinction is uncertain, keep the sentence. Do not invent emotion or turn "what I did" into "what you must do."
- **Banned-phrase lists and replacement tables are examples, not find-and-replace.** A flagged word that reads naturally in context stays. Match the smell, not the string. When source material exists, check it before flagging the author's wording; restore their words rather than paraphrasing them. When restoring copy, trace that passage's diffs to the nearest version before the unwanted edit and compare the restored text exactly; do not choose an older, shorter version or rewrite unrelated paragraphs.
- **Prefer fewer, stronger edits.** Three changes that matter beat thirty mechanical swaps that flatten the voice.

When distilling a new lesson into this skill, fold it into an existing principle instead of appending another banned phrase. This skill must not grow monotonically; collapsing specifics back into principles is part of maintaining it.

## Pre-flight

1. **Locate the text.** Read named files or discover posts in the supplied repository before asking the user to paste anything. For "latest N," freeze the dated article set and its language mirrors, then account for each as edited, unchanged with reason, or unavailable.
2. **Audience locked?** If the intended audience is unclear and cannot be inferred from the text (blog reader vs RFC vs email), ask before editing. Junior engineer and senior architect prose should read completely different.
3. **Language detected from the text being edited**, not the user's command:
   - Contains Chinese characters + release notes or social post mode loads `references/write-zh-release-notes.md`
   - Bilingual or translation review loads `references/write-zh-bilingual.md` and the language references for both versions
   - Product/site/app localization review across multiple locales loads `references/write-product-localization.md`; also load `references/write-zh-bilingual.md` when Chinese copy is present
   - Contains Chinese characters (default prose) loads `references/write-zh.md`
   - Otherwise loads `references/write-en.md`

## Mode Picker

Default is a line-level rewrite of the supplied text. Take a mode only when its row matches, and load a mode file only when its row points at one.

| Ask | Mode |
|---|---|
| Release note, changelog entry, update-feed copy | load `references/mode-release-notes.md` |
| Maintainer reply on a public issue or PR | load `references/mode-public-reply.md` |
| Long draft with several sections, tables, or images that needs structural work | load `references/mode-long-form.md` |
| EN/CN pair to check for drift | [Bilingual Review](#bilingual-review-mode) |
| Product, site, or app copy across locales | [Product Localization Review](#product-localization-review-mode) |
| Document, PDF, or white paper to review | [Document Review](#document-review-mode) |
| Paragraphs that read disconnected | [Paragraph Coherence](#paragraph-coherence-mode) |
| Tweet, thread, or launch post | [Tweet / Social Post](#tweet--social-post-mode) |

## Bilingual Review Mode

Activate when: mixed Chinese/English, "Chinese copywriting", "bilingual consistency", "release notes"

Load `references/write-zh-bilingual.md`; it owns the judgment half that the Punctuation Gate script does not check.

## Product Localization Review Mode

Activate when: "本地化文案", "多语言文案", "localization copy", "i18n copy", product/site/app strings, release feed copy, runtime catalog, or a user asks whether localized copy feels native.

Load `references/write-product-localization.md` and follow its review procedure. If Chinese is one of the locales, also load `references/write-zh-bilingual.md`.

## Document Review Mode

Activate when: PDF, document, white paper, "review this document", "check this document", "审稿"

Review checklist:
- **Privacy scan**: Flag sensitive information whose disclosure is not authorized for the intended audience. Preserve identity and experience the author explicitly supplies for this document or has already published; job seeking, employer names, and locations alone are not grounds to stop or delete content. Resolve uncertain disclosure before exposing it.
- **Tone consistency**: Flag voice shifts, register mismatches, formulaic phrasing.
- **Bilingual validation**: For CN/EN pairs, confirm translation accuracy and terminology consistency. Apply Bilingual Review Mode rules.
- **Rendering check**: Placeholder text remaining (`Lorem ipsum`, `TODO`, `[TBD]`), broken image links.
- **Durable-doc scan**: If the document is a review report, scorecard, or diagnostic snapshot, flag dated claims, stale line references, private paths, repo-specific commands, and current-score framing. Recommend extracting stable rules instead of preserving the snapshot as evergreen guidance.

Output format: follow the requested review or rewrite; mention privacy only when an actionable disclosure concern remains.

## Paragraph Coherence Mode

Activate when: "连贯性", "段落连贯", "可读性", "coherence", "flow check", "段落顺不顺"

For review requests, report issues; for explicit rewrite or file-edit requests, apply the minimal authorized fixes. Check each paragraph for:
1. Flag transitions that abruptly shift topic without a signal.
2. Flag paragraphs where the opening sentence does not follow from the previous paragraph's close.
3. Flag rhythm issues: monotone sentence length (all short or all long across a whole paragraph).
4. Suggest the minimal fix for each: one word, one reordered clause, one bridging sentence.

Output: for review, a numbered list with paragraph locations and minimal fix suggestions; for rewriting, the revised text or scoped file changes. Do not ask again to apply already-authorized edits.

## Tweet / Social Post Mode

Activate when: "推特", "twitter", "X推文", "tweet", "social post", "折叠长度", "长文推特", "发文"

Load `references/write-zh-release-notes.md` for the five announcement rules (community lead, highlights over completeness, UX framing, one stance, native rhythm) and the casual invitation close. For English posts or projects without that community voice, keep the same structure in the project's own voice.

## Hard Rules

- **Meaning first, style second.** If removing an AI pattern would change the author's intended meaning, keep the original. Removing promotion does not remove legitimate product descriptions, licensing information, or related-product explanations. Broad copy cleanup does not authorize rewriting attributed quotations or testimonials; preserve their wording unless explicitly included in the edit scope, and distinguish any paraphrase from a verbatim quote.
- **No silent restructuring.** Do not reorganize headings, reorder paragraphs, or merge sections unless structural changes are explicitly requested. Edit in place. Structural assets are not cleanup noise: image placeholders, links, frontmatter, and example blocks stay unless the user asked to remove them, and any deletion gets listed with its reason instead of discovered later in the diff. (Exception: `references/mode-long-form.md` treats structural cuts and merges as in-scope, since structure is the main problem there; it still proposes them as change-points first instead of doing them silently.)
- **No invented first-person experience.** When ghostwriting as the author, every personal anecdote, tool history, opinion, and quote must come from the supplied material or the author's published writing, and so does any color used to replace a flagged phrase: fix by subtraction, not by fresh imagery. The material lacking an example is a question to ask, not a gap to fill. Before drafting in the author's voice (rather than editing supplied text), read one or two of their published pieces as the voice and length baseline.
- **Material gate before drafting long-form.** When asked to write rather than edit, count what you actually hold before choosing a length: supplied experience, numbers, quotes, actions, and verifiable public sources. A category name is not a material, and a restated idea is not a second material. Reasoning connects material; it does not breed material. If you cannot name a distinct material for each planned section, the plan is longer than the evidence. Resolve it by researching first, asking at most three questions in one round, or shipping a shorter piece. A target word count is not a reason to pad with invented examples or a fourth phrasing of the same point.
- **Shorter than the first draft wants to be.** Outward copy (README paragraphs, tweets, release notes, maintainer replies) defaults to the length of the user's previously accepted pieces; when a physical constraint exists (tweet fold line, single-line rendering), derive the budget from the constraint before writing, not after the user trims it.
- **Artifact-grounded claims.** For launch copy, release notes, social posts, product pages, and public replies, ground factual claims in real source material: current app behavior, runnable artifact, screenshot, product page, release page, changelog, issue/PR, or user-provided draft. Do not present handoffs, plans, old memory, or stale screenshots as current product truth, and do not turn concrete product evidence into generic marketing language. Compare the draft against the shipping artifact and tighten until the two agree.
- **No em-dash.** Never produce em-dash (U+2014) or en-dash (U+2013) in Chinese or English output. Em-dash is the strongest AI-tone fingerprint in this style of writing. Use commas, periods, colons, or parentheses to break clauses. Hyphen-minus (`-`) inside compound words is allowed; replace it with a space or a period when possible. When editing a draft that contains em-dashes, replace every one before returning the text.
- **Match the requested handoff.** Pasted-text rewrites need no explanation. Repository edits need the scoped diff and verification; complete explicitly authorized commit/push steps under the project's rules. A prose-only output convention must not hide unfinished delivery.

## Punctuation Gate

Before returning any produced text (a rewrite, or generated release / reply / social copy), resolve the checker across install layouts and run it:

```bash
GATE=""
for candidate in \
  "<skill-base-dir>/scripts/check-punctuation.sh" \
  "<skill-base-dir>/skills/write/scripts/check-punctuation.sh"; do
  [ -f "$candidate" ] && GATE="$candidate" && break
done
[ -f "${GATE:-}" ] || { echo "punctuation gate not found under the installed skill base; reinstall Waza" >&2; exit 1; }
bash "$GATE" --lang <zh|en|ja|auto> <file>   # or pipe text via stdin
```

Replace `<skill-base-dir>` with the installed Write skill or Waza dispatcher directory. The first path covers direct/plugin installs; the second covers the inlined-root release ZIP.

It enforces character-level punctuation by locale (half/full-width marks, CJK/Latin spacing, em/en dashes) and skips code, inline code, URLs, and markdown link targets, so it never fires on code; the script header documents the exact rule set. Fix every finding while preserving meaning; `--fix` rewrites only the zero-ambiguity zh cases to stdout. `--lang auto` classifies the whole input by fixed priority: any kana routes to ja, else any CJK to zh, else any Hangul to ko (reserved, skipped), else en, so a mostly-Chinese text that merely quotes a Korean glyph still routes to zh; pass an explicit `--lang` for mixed-locale or predominantly-English text. The checker owns character-level punctuation only; quote direction and other judgment calls stay with you and the reference files.

## Gotchas

| What happened | Rule |
|---|---|
| Used formal register for a blog draft | Match the target audience's register. Blog is conversational, not academic. |
| Applied Chinese/English spacing rules to a pure-English text | Bilingual spacing rules (半角/全角) only apply when the text mixes Chinese and English |
| User flagged one word as "not my voice"; only that instance was fixed | A flagged word marks a smell class, not a typo. Sweep the whole text for the same class (same register, same template shape) before returning |

## Output

Follow the Outcome Contract. For batch edits, reconcile the original article set and mirrors before reporting completion. State missing source or verification without treating it as a pass.
