# BLG protocol quick reference

The canonical graph uses maps keyed by stable IDs:

- `nodes`: arbitrary-depth business structure through `parentId`;
- `edges`: ordered flow, condition, error, async, data, or dependency relations;
- `claims`: code facts, model inferences, business confirmations, and open
  questions attached to nodes;
- `evidence`: source, configuration, test, runtime, user, or provider-candidate
  locators attached to claims; and
- `tours`: optional ordered node sequences for human walkthroughs.

IDs should express stable business identity and must not encode line numbers or
provider database IDs. Map keys and each object's `id` must match.

## Verification statuses

- `verified`: directly checked against current evidence.
- `inferred`: plausible model interpretation; never present as code fact.
- `user-confirmed`: business truth supplied by a user; normally set `locked`.
- `stale`: previously checked, but commit, locator, or fingerprint is out of date.
- `conflict`: repository evidence and a recorded claim disagree.
- `unknown`: insufficient evidence.

Verified repository evidence records the Git commit and a stable locator. Prefer
symbol or semantic keys plus a fingerprint; line numbers are only navigation
hints. `provider-candidate` evidence is never sufficient for a required plan
claim.

## Progressive packets

Start with the focus node, ancestors, requested child depth, and immediate flow
neighbors. Include only claims for selected nodes and evidence referenced by
those claims. `expansionHints` tells the agent where additional children exist.
Increase depth or change focus only when the current question requires it.

## Patch transactions

A patch envelope contains:

- `baseGraphRevision` for optimistic concurrency;
- `repositoryHead` for code/graph coherence;
- a human-readable `reason`;
- RFC 6902 `operations`; and
- optional postconditions.

Use object-map paths such as `/nodes/driver-filter/summary`, not array indexes.
The patch engine increments `graphRevision`, sets `updatedAt`, validates all
references and parent cycles, and rejects stale revisions, head mismatches, and
user locks.

## Plan gate

The gate expands every affected node through all descendants. A `required` claim
passes only when it is verified or user-confirmed, tied to the current head where
applicable, and supported by at least one current verified evidence item.
Advisory failures are reported but do not block the plan.

Independent workspaces keep original verification commits. A runtime projection
may reuse an older claim only when all its recorded repository evidence has
unchanged file fingerprints. Changed files become stale without modifying
canonical data. Overlay conflicts or an unrebased baseline advance block the gate.
The optional `view` field is generated context/diff metadata, not editable truth.

Context packets default to a 24,000-character serialized budget in addition to
depth/node limits. Optional nodes are pruned first; focused claims and evidence
are never silently omitted. A too-large focus produces an actionable budget
error. Character count is not exact model-token or account-usage accounting.
