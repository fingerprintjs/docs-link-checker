## Core values

- Simple good, accidental complexity bad
- Explicit good, implicit bad
- Best code is no code: if you can delete 100 lines in favor of 10 doing the same thing, do it
- If you must write code, prioritize simplicity and readability

## Code structure

- If you must write complex code, use **deep modules**
  - Encapsulate internal details and complex behavior behind a simple interface
  - Don't leak implementation details outside the module
- Avoid thin wrapper functions and helpers, minimize layers of indirection

## Testing

- Test interfaces of **deep modules** (from consumer perspective), never implementation details
- Minimuze use of mocks
- DO NOT write tests that are trivial, , structure-sensitive or tightly coupled to the implementation (never just reassert an internal implementation detail)
- Not tautological tests: they must be able to fail by messing up the implementation

## Comments & Docs

- Keep short, use simplified technical english
- Focus on WHY (WHAT, HOW must be obvious from the code itself)
- Write like a terse note to a self or teammate, no m-dashed essays
- Prefer bullet points over long `;` chains
- Avoid ambiguous jargon (seam, boundary, gate, envelope, wire shapes, ...), be plain, precise, specific
- No provenance needed, do not overfit comments to current change: docs must stand alone, make sense later without PR/conversation context. Think of what the general long-term purpose of the doc/comment is.
- Module files begin with short overview comment explaining purpose and links to relevant docs
- Any non-obvious design decision, requirement, or claim gets a short explanatory note + exact docs link
  - close to affected code + commit message body (always)
  - in PR description (if significant)
