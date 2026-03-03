# AGENTS.md

Project-level guidance for AI coding agents working in this repository.

## Project Overview

This repository contains OpenCode plugins that fix common issues with LLM providers.
The primary plugin is the **Gemini Thought Signature Fix** which prevents unrecoverable
`thought_signature` errors with Gemini 3.x models.

## Directory Map

- `.opencode/plugins/` — plugin source files (TypeScript, loaded by OpenCode at startup)
  - `gemini-thought-signature-fix.ts` — fixes Gemini 3.x thought_signature 400 errors
- `docs/` — research documentation and design decisions
  - `research-gemini-thought-signatures.md` — detailed analysis of the thought_signature problem
  - `solution-design.md` — evaluated approaches and chosen solution
- `references/` — third-party OpenCode plugins and source code for analysis
  - this directory is research input, not first-party implementation code

## Plugin Architecture

The Gemini thought signature fix uses two hooks:

1. `chat.params` — detects if the current model is a Gemini model (pattern match on "gemini" in ID)
2. `experimental.chat.messages.transform` — injects Google's sentinel value
   `"skip_thought_signature_validator"` into reasoning and tool parts that are missing
   valid `thoughtSignature` metadata

The plugin does NOT disable thinking/reasoning. It only patches missing signatures so
the Gemini API accepts the request instead of returning a hard 400 error.

## References Directory Rule

The `references` directory contains third-party OpenCode plugins for analysis.

Do not modify third-party reference internals unless explicitly requested.

When extracting patterns, translate them into project-specific architecture rather than copy-pasting implementation.

## Key Design Decisions

- **Sentinel over disabling thinking**: We use `"skip_thought_signature_validator"` rather
  than turning off `includeThoughts`. This preserves reasoning output with only minor
  degradation in multi-step chain-of-thought continuity.
- **Pattern matching on model name**: We match `gemini` anywhere in the combined
  `providerID/modelID` string. This works with native Google provider, OpenCode Zen,
  OpenRouter, custom providers, and any user-defined Gemini model configuration.
- **Preserve existing valid signatures**: The plugin only injects the sentinel when
  metadata is missing or the existing signature is too short to be real (< 40 chars).
  Valid signatures from the AI SDK are left untouched.
