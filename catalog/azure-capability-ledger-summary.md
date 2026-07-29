# Azure Capability Coverage Ledger

Generated: 2026-07-28T05:38:20.318Z

**Total resource types: 1141** (all 1,141 Azure resource types accounted for)

This ledger is the coverage backbone for wiring Azure into the Cloud Control Plane catalog. Every type is classified; catalog waves consume the `catalog_candidate` rows; `engineer_only` and `review_needed` are the recorded not-blindly-wired surface (fail-closed doctrine per ADR-0039).

## Classification Summary

### By Family × Bucket

| Family | Catalog Candidate | Engineer Only | Review Needed | Total |
|--------|-------------------|---------------|---------------|-------|
| ai | 8 | 6 | 24 | 38 |
| analytics | 15 | 7 | 89 | 111 |
| compute | 34 | 1 | 19 | 54 |
| containers | 16 | 3 | 27 | 46 |
| database | 16 | 9 | 53 | 78 |
| governance | 0 | 55 | 0 | 55 |
| identity | 0 | 9 | 0 | 9 |
| integration | 18 | 15 | 75 | 108 |
| iot | 5 | 4 | 10 | 19 |
| keyvault | 1 | 13 | 0 | 14 |
| monitoring | 19 | 12 | 19 | 50 |
| network | 48 | 45 | 30 | 123 |
| other | 122 | 16 | 128 | 266 |
| security | 0 | 81 | 0 | 81 |
| storage | 9 | 8 | 36 | 53 |
| web | 20 | 0 | 16 | 36 |
| **TOTAL** | **331** | **284** | **526** | **1141** |

## Safe Operation Class Coverage

| Safe Op Class | Types Offering | Percentage |
|---------------|----------------|------------|
| `grow_disk` | 7 | 0.6% |
| `resize` | 7 | 0.6% |
| `tag_update` | 387 | 33.9% |
| `tighten_tls` | 1 | 0.1% |

## Notes

- **Catalog Candidate**: Safe self-service operations available. These types enter the catalog pipeline for curation and wiring.
- **Engineer Only**: Gates access, reachability, identity, or policy. Require human judgment. (Tag ops may exist but are curation decisions.)
- **Review Needed**: No obvious safe operations. Require human review for any catalog inclusion.
