# Filter opportunities

Use this skill to translate a request into `search_job_opportunities`.

- Put role names, technologies and duties in `workContents`.
- Put city names in `cities`, and broader areas such as 华东 or 大湾区 in `regions`.
- Put 国企、央企、民企、外企、事业单位 and similar terms in `companyTypes`.
- Put exact company or industry terms in `companies` or `keywords`.
- Terms inside one field are alternatives. Different non-empty fields are combined as requirements.
- Add common textual variants when useful, for example `北京` and `北京市`, or `国企` and `国有企业`.
- Start with a focused query. Relax only one dimension at a time when appropriate; do not replace a specifically requested company with unrelated employers.
- Treat matches as text evidence, not guaranteed structured attributes.
- All processed records are searchable, including 宣讲会、双选会、招聘会、面试、笔试 and other processed messages, with no calendar-week cutoff.
- Use offset with the same filters for subsequent pages. A full page is not proof that all matches have been returned.
- For current company recruitment, supplement local misses with web research unless explicitly restricted to local sources.
- Use `select_chat_results` to show only relevant retrieved results in the final cards.
