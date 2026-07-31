# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If either location doesn't exist, **proceed silently**. Don't suggest creating it upfront. The `/domain-modeling` skill creates domain documentation lazily when terms or decisions are resolved.

## File structure

This is a single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
└── web/, cmd/, internal/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If a needed concept isn't in the glossary, reconsider the terminology or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding.
