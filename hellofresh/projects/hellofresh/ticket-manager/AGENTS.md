# Ticket Manager: pi Agent Instructions

This repo is a workspace for drafting and pushing Jira tickets via the CLI and REST API. Drafts are Markdown scratch files; the structured record of every ticket's Business Impact lives in harvest (`~/.harvest/`, CLI `harvest`, repo `~/projects/personal/harvest`).

## Jira CLI and REST

- Use `jira` CLI for read operations and issue creation (preferred).
- Use `curl` REST for advanced operations (custom fields, conditional updates).
- Auth: `JIRA_API_TOKEN` environment variable (set in `~/.zshrc` from `~/dotfiles/.env`).

## Required fields for all tickets

**Always include these fields when creating a ticket. Non-negotiable.**

- `project_key`: `GLOA`
- `issue_type`: `Task`
- `summary`: concise, descriptive title
- `description`: see formatting rules below (the Business Impact section stays mandatory)
- `assignee`: **always Luis, accountId `6225f1ed49c900007021abb9`** (never leave unassigned)
- `priority`: `Normal` (GLOA allows Urgent, High, Normal, Low)
- `fixVersions`: not set on create. Optional: `[{"id": "59925"}]` (`Central Ops Data Assets`, the project's only version) for tickets in that asset stream.
- No `components` (GLOA has none; sending one returns 400) and no default `labels`.

### The assignee rule

**Every ticket must be assigned to Luis.** If a ticket is unassigned, the board automation and sync scripts lose track of it.

**Use `accountId`, not `emailAddress`, when setting assignee via the REST API.** Confirmed on 2026-07-21 (ISA-18228): `POST /rest/api/3/issue` with `"assignee": {"emailAddress": "luis.aceituno@hellofresh.com"}` in the create payload returns 201 but silently leaves the ticket unassigned (`fields.assignee: null`), no error, no warning. `jira issue create -a luis.aceituno@hellofresh.com` (the CLI) resolves the email correctly; only the raw REST payload is affected.

Luis's `accountId` is `6225f1ed49c900007021abb9` (fetch fresh via `GET /rest/api/3/myself` if it ever needs re-confirming). Two ways to get this right:
- **Preferred:** `jira issue create -a luis.aceituno@hellofresh.com ...` (CLI resolves email to accountId internally).
- **REST create/update:** set `"assignee": {"accountId": "6225f1ed49c900007021abb9"}` in the payload. If you already created via REST with `emailAddress` and the ticket ended up unassigned, fix it with a follow-up call:
  ```bash
  curl -s -u "luis.aceituno@hellofresh.com:$JIRA_API_TOKEN" -X PUT \
    "https://hellofresh.atlassian.net/rest/api/3/issue/GLOA-XXXXX/assignee" \
    -H 'Content-Type: application/json' \
    --data '{"accountId":"6225f1ed49c900007021abb9"}'
  ```
- **Always verify after create/update:** `jira issue view <KEY> --raw | jq '.fields.assignee.emailAddress'` and confirm it's non-null. Do not trust the 201/204 status code alone.

## Jira description formatting

The description uses Atlassian Document Format (ADF), a JSON structure. Rules:

### Structure

Use this template and expand as needed:

```json
{
  "version": 1,
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": {"level": 2},
      "content": [{"type": "text", "text": "Summary"}]
    },
    {
      "type": "paragraph",
      "content": [{"type": "text", "text": "One-paragraph statement of what this ticket delivers."}]
    },
    {
      "type": "heading",
      "attrs": {"level": 2},
      "content": [{"type": "text", "text": "Context"}]
    },
    {
      "type": "paragraph",
      "content": [{"type": "text", "text": "Why this work is needed, prior tickets, constraints."}]
    },
    {
      "type": "heading",
      "attrs": {"level": 2},
      "content": [{"type": "text", "text": "Scope"}]
    },
    {
      "type": "orderedList",
      "attrs": {"order": 1},
      "content": [
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Step or deliverable one"}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Step or deliverable two"}]}]
        }
      ]
    },
    {
      "type": "heading",
      "attrs": {"level": 2},
      "content": [{"type": "text", "text": "Acceptance Criteria"}]
    },
    {
      "type": "bulletList",
      "content": [
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Observable outcome one"}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Observable outcome two"}]}]
        }
      ]
    },
    {
      "type": "heading",
      "attrs": {"level": 2},
      "content": [{"type": "text", "text": "Business Impact"}]
    },
    {
      "type": "bulletList",
      "content": [
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "**Category:** "}, {"type": "text", "text": "cost_reduction", "marks": [{"type": "code"}]}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "**Estimated Annual Impact:** $0"}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "**Notes:** One or two sentence justification."}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "**Scope:** "}, {"type": "text", "text": "squad", "marks": [{"type": "code"}]}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "**Estimate Basis:** "}, {"type": "text", "text": "modeled", "marks": [{"type": "code"}]}]}]
        },
        {
          "type": "listItem",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": "**Work Type:** "}, {"type": "text", "text": "enablement", "marks": [{"type": "code"}]}]}]
        }
      ]
    }
  ]
}
```

### Formatting rules

1. **Headings are level 2** (`"level": 2`), only for major sections (Summary, Context, Scope, etc.).
2. **Wrap code identifiers in backticks** via the `"code"` mark: `{"type": "text", "text": "my_table", "marks": [{"type": "code"}]}`.
3. **Wrap business terms in bold** via the `"strong"` mark: `{"type": "text", "text": "bold text", "marks": [{"type": "strong"}]}`.
4. **Use bullet lists for simple lists** (`"type": "bulletList"`) and ordered lists for numbered steps (`"type": "orderedList"`).
5. **Always include the Business Impact section** (see HelloFresh AGENTS.md for required fields: Category, Estimated Annual Impact, Notes, Scope, Estimate Basis, Work Type).

### Example: creating via curl

```bash
curl -u "luis.aceituno@hellofresh.com:$JIRA_API_TOKEN" \
  -X POST "https://hellofresh.atlassian.net/rest/api/3/issue" \
  -H 'Content-Type: application/json' \
  --data '{
    "fields": {
      "project": {"key": "GLOA"},
      "issuetype": {"name": "Task"},
      "summary": "My ticket title",
      "description": {<ADF_JSON_ABOVE>},
      "priority": {"name": "Normal"},
      "assignee": {"accountId": "6225f1ed49c900007021abb9"}
    }
  }'
```

**Do not use `"assignee": {"emailAddress": ...}` in the REST create payload**: it silently no-ops (see "The assignee rule" above). Always verify with `jira issue view <KEY> --raw | jq '.fields.assignee.emailAddress'` after create.

## Board visibility (15367, GLOA Scrum Board)

- **Board filter (id 59649):** `project = GLOA`. No fixVersion gate: every GLOA ticket is visible on the board and backlog with no extra fields.
- **Default state:** new tickets land in the backlog with no sprint. Do not add them to a sprint unless the user explicitly asks.
- **Status mapping:** `Open` / `Reopened` → **TO DO** column; `On Hold` → **Blocked**; `In Progress` → **In Progress**; `Peer review` → **PEER REVIEW**; `Done` / `Resolved` / `Closed` → **Done**.
- **URLs:** backlog `https://hellofresh.atlassian.net/jira/software/c/projects/GLOA/boards/15367/backlog`; active sprint via `GET /rest/agile/1.0/board/15367/sprint?state=active`.

## Workflow

1. **Draft first:** write the ticket content to `/Users/luis.aceituno/scratch/jira-*.md` (Markdown, not ADF).
2. **User review:** let the user review the scratch file.
3. **Convert to ADF:** transform the Markdown into ADF JSON.
4. **Create in Jira:** use `curl` REST or `jira` CLI.
5. **Verify:** fetch the ticket and confirm the description rendered correctly AND that `fields.assignee.emailAddress` is non-null (REST create with `emailAddress` silently fails to assign; see "The assignee rule").
6. **Record in harvest:** `harvest record ticket <KEY> --category ... --impact ... --notes ... --scope ... --estimate ... --work-type ...` with the same values as the Business Impact block. The ticket is the source of truth, harvest is its database. When the estimate changes later, update the ticket block AND re-run `harvest record ticket`.

## Common mistakes

- **Unassigned tickets:** every ticket must have an assignee. Don't trust a 201/204 status code as proof it worked; always re-fetch and check `fields.assignee`.
- **Sending a component:** GLOA has no components. A `components` field in the create payload returns HTTP 400.
- **Using `emailAddress` instead of `accountId` for assignee in REST payloads:** `{"assignee": {"emailAddress": "luis.aceituno@hellofresh.com"}}` in a `POST /rest/api/3/issue` create call silently leaves the ticket unassigned, no error thrown. Use `{"accountId": "6225f1ed49c900007021abb9"}`, or the `jira` CLI's `-a` flag (which resolves the email correctly).
- **ADF malformed:** validate JSON before sending. Nested objects must be properly closed.
- **Missing Business Impact section:** every ticket must include the Business Impact block with Category, Estimated Annual Impact, Notes, Scope, Estimate Basis, and Work Type.
- **Business Impact in a PR body:** never. PRs carry only the taxonomy labels (`impact:`/`scope:`/`estimate:`/`work_type:`); the block lives on the Jira ticket, the structured copy lives in harvest. If a PR body has a block, record it in harvest first, then strip the block (labels stay).

## Tools and commands

```bash
# Create a ticket
jira issue create -t Task -s "Summary" -T description.md -a luis.aceituno@hellofresh.com

# View a ticket
jira issue view GLOA-12345

# List tickets assigned to Luis
jira issue list -q "assignee = luis.aceituno@hellofresh.com AND project = GLOA"

# Verify board membership
curl -s -u "luis.aceituno@hellofresh.com:$JIRA_API_TOKEN" \
  "https://hellofresh.atlassian.net/rest/agile/1.0/board/15367/backlog?jql=key=GLOA-XXXXX" \
  | jq '.total'
```
