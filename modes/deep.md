# Mode: deep — Deep Research Prompt

Generates a structured prompt for Perplexity/Claude/ChatGPT with 6 axes:

```
## Deep Research: [Company] — [Role]

Context: I'm evaluating a candidacy for [role] at [company]. I need actionable information for the interview.

### 1. Engineering Culture
- How do they ship? (deploy cadence, CI/CD)
- Mono-repo or multi-repo?
- What languages/frameworks do they use?
- Remote-first or office-first?
- Glassdoor/Blind reviews about eng culture?

### 2. Recent Moves (last 6 months)
- Relevant hires in engineering or product?
- Acquisitions or partnerships?
- Product launches or pivots?
- Funding rounds or leadership changes?

### 3. Tech Stack & Architecture
- What is their core stack?
- Any known technical debt or migration efforts?
- Open source contributions or engineering blog posts?
- Papers or talks given by their engineers?

### 4. Likely Challenges
- What scaling problems do they have?
- Reliability, cost, latency challenges?
- Are they migrating anything? (infra, platforms, services)
- What pain points do people mention in reviews?

### 5. Competitors & Differentiation
- Who are their main competitors?
- What is their moat/differentiator?
- How do they position vs. competition?

### 6. Candidate Angle
Given my profile (read from cv.md and profile.yml for specific experience):
- What unique value do I bring to this team?
- Which of my projects are most relevant?
- What story should I tell in the interview?
```

Personalize each section with the specific context of the evaluated offer.
