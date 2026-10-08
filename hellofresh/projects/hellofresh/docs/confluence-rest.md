# Confluence (`curl` REST)

Referenced from `../AGENTS.md`.

Reach Confluence through the REST API with `curl`. The Atlassian account token in `JIRA_API_TOKEN` authenticates Confluence too (Atlassian Cloud tokens are account-wide), so no separate secret is needed. Do not use the Atlassian MCP.

```bash
AUTH="luis.aceituno@hellofresh.com:$JIRA_API_TOKEN"
BASE="https://hellofresh.atlassian.net/wiki"

# Read a page with body (storage format) and current version
curl -s -u "$AUTH" "$BASE/rest/api/content/<page_id>?expand=body.storage,version" | jq .

# CQL search
curl -s -u "$AUTH" -G "$BASE/rest/api/content/search" \
  --data-urlencode 'cql=space = SCMAX AND title ~ "purchase order"' --data-urlencode 'limit=10' \
  | jq '.results[].title'

# Child pages of a parent
curl -s -u "$AUTH" "$BASE/rest/api/content/<parent_id>/child/page?limit=50" | jq '.results[] | {id, title}'
```

Reads via curl are straightforward. Writes are harder: the REST API takes Confluence **storage format** (XHTML), not Markdown (the MCP used to convert for us). For Markdown push, build the `confl` tool (tracked in the integration issue); until then write only simple pages hand-authored in storage format.

## Repos that mirror Confluence

Some docs repos (e.g. `99-meta/po-v2-consolidation/confluence/`) are a 1:1 mirror of Confluence pages. Each markdown file starts with YAML frontmatter binding it to the page:

```yaml
---
confluence_page_id: 6417678348
confluence_title: "2. Current Architecture"
confluence_parent_id: 6408667170   # omit for the landing page
confluence_space: SCMAX
---
```

Treat the page ID in frontmatter as authoritative. Don't look it up by title.

## Pushing edits (REST)

1. Read `confluence_page_id` and `confluence_title` from frontmatter; treat the page ID as authoritative.
2. GET the page (`?expand=version`) to capture the current `version.number`.
3. Strip the frontmatter block and the first H1 from the body (the title is set separately; leaving the H1 duplicates it).
4. Convert the body to storage format (XHTML), then `PUT $BASE/rest/api/content/<page_id>` with `Content-Type: application/json` and a payload that bumps `version.number` by 1:
   ```json
   {"id":"<page_id>","type":"page","title":"<confluence_title>",
    "version":{"number":<current+1>},
    "body":{"storage":{"value":"<xhtml>","representation":"storage"}}}
   ```
5. GET again and confirm the body rendered; some constructs (nested tables, raw HTML, certain emoji) don't survive conversion. Markdown-to-storage conversion is why a dedicated `confl` tool is the long-term answer for mirror-repo pushes.

## Rendering notes (verify after upload)

These apply when converting Markdown to storage format (via `confl` or by hand):

- Tables with very wide columns survive but render tightly; prefer concise cell content.
- Fenced code blocks work; specify the language (```` ```sql ````, ```` ```bash ````).
- Anchor-style links (`[foo](#section-heading)`) work inside the same page but only if the heading slug matches what Confluence generates. When in doubt, check after upload.
- Links to other mirrored pages: use the local relative path (`[page 4](04-pipeline-ops-intelligence.md)`) when iterating in the repo; Confluence resolves them to page links on upload **only if** the target page is in the same space and the ID is recognized, otherwise they end up as literal text. Prefer absolute Confluence URLs for cross-space or external links.
- Unicode dashes and arrows render fine; smart quotes usually do too.

## Useful endpoints

```text
GET  /rest/api/content/<id>?expand=body.storage,version       # read a page + body
GET  /rest/api/content/search?cql=<CQL>                       # CQL search
GET  /rest/api/content/<id>/child/page                        # child pages
GET  /rest/api/content/<id>/child/comment?expand=body.storage # comments
GET  /rest/api/content/<id>/history                           # version history
PUT  /rest/api/content/<id>                                   # update (see Pushing edits)
POST /rest/api/content                                        # create (see below)
```

## Creating new pages (REST)

```bash
curl -s -u "$AUTH" -X POST "$BASE/rest/api/content" -H 'Content-Type: application/json' --data @- <<'JSON'
{"type":"page","title":"<title>","space":{"key":"SCMAX"},
 "ancestors":[{"id":"<parent_id>"}],
 "body":{"storage":{"value":"<xhtml>","representation":"storage"}}}
JSON
```

- After creation, write the returned page ID back into the local file's frontmatter so future edits route correctly.
