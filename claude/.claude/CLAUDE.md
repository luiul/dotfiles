# Global Preferences

## Branch Naming

Use the format: `type/TICKET_description`

- Types: major, minor, patch, issue, hotfix, feature, release
- Ticket format: `ABC-123` (uppercase letters, dash, numbers)
- Description: lowercase, words separated by hyphens
- Always ask for the Jira ticket. If none is provided, default to `ISA-1234`
- Examples: `feature/ISA-1234_add-login`, `hotfix/ISA-567_fix-null-pointer`

## Pull Requests

Follow conventional commit style:

- **Title**: `type: Short Description` in proper case, where type matches the branch type (e.g. `feature: Add Login Page`, `hotfix: Resolve Null Pointer on Checkout`)
- **Body**:

  ```markdown
  ## Summary
  - Brief bullet points explaining the changes

  ## Key Changes
  - List of specific changes made

  ## Test Plan
  - How the changes were tested
  ```

- **Assignee**: always assign to me
- **Labels**: always add `squad: scm-analytics-engineers` and `tribe: intl-scm-analytics`

## Commits

- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`
- Do NOT add `Co-Authored-By` lines to commit messages
- Do NOT add Claude Code links or attribution to PR descriptions
- No emoji prefixes in PR titles or body
- Omit empty sections (e.g. Test Plan, Key Changes) rather than writing "N/A"
- Don't list every file changed — focus on the "why"
