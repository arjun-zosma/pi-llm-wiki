# Configuration

Wiki configuration lives in `.llm-wiki/config.json`.

## Modes

### Personal

The personal vault lives at `~/.llm-wiki/` (or `$WIKI_HOME`) and is always available as a fallback when no project wiki exists. It accumulates knowledge across all your sessions.

- Extra folders: `wiki/journal/`, `wiki/goals/`
- Track: learning, books, health, reflections

### Company

- Extra folders: `wiki/changes/`, `wiki/decisions/`
- Track: competitors, market, strategy
- Frontmatter: `confidence: high | medium | low`

## Settings

| Setting                    | Default | Description                        |
| -------------------------- | ------- | ---------------------------------- |
| `max_sources_per_discover` | 8       | Sources fetched per discovery run  |
| `auto_fix_lint`            | false   | Auto-fix lint issues               |
| `batch_ingest_size`        | 3       | Sources processed per ingest batch |

## Environment Variables

| Variable                      | Default     | Description                                     |
| ----------------------------- | ----------- | ----------------------------------------------- |
| `WIKI_HOME`                   | `~/.llm-wiki` | Override the personal wiki vault location     |
| `WIKI_MARKITDOWN_TIMEOUT_MS` | 180000      | Timeout (ms) for MarkItDown PDF/text extraction |
| `LLM_WIKI_HOST`              | auto        | Force the host layout: `pi` or `omp`            |

## Agent Settings

Runtime settings for the wiki's background tasks live under the `llm-wiki`
namespace of the host's settings file. Both host layouts are read and merged,
lowest precedence first:

1. `<agentDir>/settings.json`, then `config.yml` / `config.yaml`
   — `~/.pi/agent` under pi, `~/.omp/agent` under oh-my-pi
2. `<cwd>/.pi/{settings.json,config.yml,config.yaml}`
3. `<cwd>/.omp/{settings.json,config.yml,config.yaml}`

The **host-native** project directory is applied last, so it wins: `.omp` under
oh-my-pi, `.pi` under pi. Reading the other host's directory means a vault
configured under pi keeps working after `omp` takes over the repository.

`/wiki-model` and `/wiki-trajectories` write JSON only, into whichever project
config directory already exists (host-native first, created if neither is
present). A hand-authored `config.yml` is read but never rewritten.

| Setting               | Default | Description                                                  |
| --------------------- | ------- | ------------------------------------------------------------ |
| `taskModel`           | —       | Model for background tasks (`{ provider: "openai", id: "gpt-4o" }`) |
| `synthesisLanguage`   | —       | BCP 47 language tag for ingest synthesis (e.g. `"ru"`, `"fr"`). When unset, synthesis defaults to English. |
| `trajectories`        | false   | Enable agent-trajectory working-memory                       |
| `notices`             | true    | Show wiki activity notices in chat                           |

Example:

```json
{
  "llm-wiki": {
    "synthesisLanguage": "ru",
    "taskModel": {
      "provider": "openai",
      "id": "gpt-4o"
    }
  }
}
```

## Vault Resolution

The vault root is resolved in this priority order:

1. **Project vault**: walk up from current directory looking for `.llm-wiki/`
2. **Personal vault**: fall back to `$WIKI_HOME` or `~/.llm-wiki/`

This means when you're in a project with its own `.llm-wiki/`, that project wiki is active. When you're outside any project wiki, your personal `~/.llm-wiki/` takes over automatically.

## Page Frontmatter

```yaml
---
type: entity | concept | source | synthesis | analysis
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [sources/SRC-YYYY-MM-DD-NNN]
---
```

Entity: add `category: person | organization | tool | project | product`
Concept: add `domain: ai | engineering | business | product | design | personal`
