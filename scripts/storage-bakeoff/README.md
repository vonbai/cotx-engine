# Storage V2 Bakeoff

This is an isolated experiment for choosing the cotx-engine v2 truth store.
It intentionally does not add candidate database packages to the root package.

Candidates:

- `@ladybugdb/core`
- `kuzu`
- `cozo-node`
- `@duckdb/node-api`

The initial smoke benchmark uses one shared mini dataset with both code facts
and decision-plane facts, then runs the same query families:

- symbol context
- upstream/downstream impact traversal
- API route response shape mismatch
- closure obligations

Run:

```bash
npm install
npm run smoke
```

The result is not the final decision. It only verifies local installability,
API ergonomics, schema fit, and baseline query expression.
