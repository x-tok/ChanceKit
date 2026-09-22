export const jobRecommendationSkills = {
  'clarify-requirements': `Clarify requirements:
- Separate hard constraints, preferences, and exclusions.
- Normalize locations without inventing commute assumptions.
- Ask one compact follow-up only if the missing answer materially changes the search.
- Otherwise search immediately and state assumptions.`,
  'filter-opportunities': `Filter opportunities:
- Role names, technologies, and duties belong in workContents.
- Cities, broader regions, company types, companies, and general keywords use their matching fields.
- Terms inside one field are alternatives. Different non-empty fields are combined.
- Add common textual variants when useful.
- Search includes talks, career fairs, interviews, tests, notices and all other processed messages, without a calendar-week cutoff. Use offset to retrieve additional pages.
- Start focused, then relax only one dimension at a time when appropriate; never replace a specifically requested company with unrelated employers.
- Matches are text evidence, not guaranteed structured attributes.`,
  'compare-opportunities': `Compare opportunities:
- Use the same dimensions for every candidate: location, organization, work content, audience, application route, deadline, recency, and evidence quality.
- Missing data is "未注明", not a negative fact.
- Identify candidates by real title, organization, date and source group; never assign opportunity numbers. Use Markdown tables when useful.`,
  'web-research': `Research public information:
- For company campus recruitment and current facts, search the web unless explicitly limited to local sources.
- Search concise public keywords with company, recruiting year and official site hints. Do not copy private messages, group/account IDs, contact details or resume content into queries.
- Prefer employer careers pages; school employment notices can confirm campus events. Read relevant pages, follow returned links, and verify the year and deadline.
- Search snippets are leads. fetchedAt means retrieval time. Blocked, dynamic or login pages are not verified content; clearly state the limit.
- Refine irrelevant search results rather than displaying them. Local misses or network failures do not mean the company is not hiring.
- Call select_chat_results with only relevant retrieved local results and web URLs, then answer concisely with actual source links. Respect local-only requests.`,
} as const;

export type JobRecommendationSkill = keyof typeof jobRecommendationSkills;
