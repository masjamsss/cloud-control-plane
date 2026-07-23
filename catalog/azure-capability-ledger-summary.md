# Azure Capability Coverage Ledger

Generated: 2026-07-18T05:15:07.868Z

**Total resource types: 1141** (all 1,141 Azure resource types accounted for)

This ledger is the coverage backbone for wiring Azure into the Cloud Control Plane catalog. Every type is classified; catalog waves consume the `catalog_candidate` rows; `engineer_only` and `review_needed` are the recorded not-blindly-wired surface (fail-closed doctrine per ADR-0039).

## Classification Summary

### By Family × Bucket

| Family | Catalog Candidate | Engineer Only | Review Needed | Total |
|--------|-------------------|---------------|---------------|-------|
| ai | 6 | 2 | 19 | 27 |
| analytics | 12 | 9 | 23 | 44 |
| compute | 4 | 0 | 0 | 4 |
| containers | 14 | 1 | 17 | 32 |
| database | 17 | 20 | 46 | 83 |
| governance | 0 | 9 | 0 | 9 |
| identity | 0 | 4 | 0 | 4 |
| integration | 14 | 8 | 28 | 50 |
| iot | 5 | 4 | 11 | 20 |
| monitoring | 12 | 10 | 13 | 35 |
| network | 26 | 23 | 27 | 76 |
| other | 224 | 110 | 328 | 662 |
| security | 0 | 50 | 0 | 50 |
| storage | 7 | 7 | 31 | 45 |
| **TOTAL** | **341** | **257** | **543** | **1141** |

## Safe Operation Class Coverage

| Safe Op Class | Types Offering | Percentage |
|---------------|----------------|------------|
| `grow_disk` | 7 | 0.6% |
| `resize` | 0 | 0.0% |
| `tag_update` | 387 | 33.9% |
| `tighten_tls` | 1 | 0.1% |

## Notes

- **Catalog Candidate**: Safe self-service operations available. These types enter the catalog pipeline for curation and wiring.
- **Engineer Only**: Gates access, reachability, identity, or policy. Require human judgment. (Tag ops may exist but are curation decisions.)
- **Review Needed**: No obvious safe operations. Require human review for any catalog inclusion.
