# NPI Registry Scraper - NPPES Bulk Provider Export

Export **every** US healthcare provider that matches a specialty, state, city or ZIP from the official **CMS NPPES NPI Registry API**. You get one flat, CSV-ready row per provider.

The NPPES API returns at most **1,200 results per query** (200 per page, skip ≤ 1,000). A search like "all dentists in California" gets silently cut off there. This actor spots when a query overflows and splits it by ZIP prefix (2 → 3 → 4 → 5 digits), then by entity type, until each piece fits. It then merges the pieces and removes duplicates, so you get the complete list.

## What you can do
- **Full segment export**: e.g. all *Dentist* providers in *CA*, all *Physical Therapist* organizations in *TX*, all *Pharmacy* NPIs in ZIP *902\**.
- **State-only export**: the API rejects a search by state alone. The actor handles it by splitting into ZIP prefixes.
- **Bulk NPI lookup**: paste a list of 10-digit NPI numbers to verify them and enrich them with the current registry data.

## Output (one row per provider)
`npi`, `entityType` (Individual/Organization), `name`, `firstName`, `middleName`, `lastName`, `credential`, `gender`, `organizationName`, `authorizedOfficialName` / `Title` / `Phone`, `status`, `enumerationDate`, `lastUpdated`, `primaryTaxonomyCode`, `primaryTaxonomy`, `primaryLicense`, `primaryLicenseState`, `allTaxonomies`, practice address (`practiceAddress1`, `practiceCity`, `practiceState`, `practiceZip`, `practicePhone`, `practiceFax`), the same fields for the mailing address, `otherPracticeLocations`, and `registryUrl`. Turn on **Include raw API record** to add the full original JSON.

## Input example
```json
{ "taxonomy": "Dentist", "states": ["RI", "MA"], "enumerationType": "NPI-2", "maxResults": 5000 }
```

## Pricing
Pay per result: **$1.50 per 1,000 providers** exported. Runs stop at the maximum charge you set for the run, or at `maxResults`.

## Notes and limits
- Data comes live from the public NPPES NPI Registry API (https://npiregistry.cms.hhs.gov/api-page), run by CMS. The registry publishes NPPES data under the Freedom of Information Act. It does **not** include email addresses.
- `taxonomy` matches the NPPES taxonomy description text (e.g. "Dentist" also matches dental specialties that contain the word).
- A single 5-digit ZIP with more than 1,200 providers of one entity type can't be split further. That's very rare. The run log names any such segment.
- To download the full national file (8M+ rows), use the free monthly NPPES dissemination file from CMS. This actor is for filtered, up-to-date slices.
- Use the data in line with applicable law, e.g. telemarketing and anti-spam rules.

## How to use
1. Click **Try for free** (or **Start**) and enter a specialty in `taxonomy`, e.g. `Dentist`, `Nurse Practitioner`, `Chiropractor`.
2. Pick one or more `states`, and optionally narrow down by `city`, `postalCode` or `enumerationType`.
3. Set `maxResults` to cap your cost, then run. Download the dataset as CSV, Excel or JSON.

## Input parameters
| Field | Type | Description |
|---|---|---|
| `taxonomy` | string | Specialty text from NPPES, e.g. `Dentist`, `Pharmacy`, `Physical Therapist` |
| `states` | array | Two-letter US state codes, e.g. `["CA","TX"]` |
| `enumerationType` | string | `NPI-1` (individuals), `NPI-2` (organizations) or empty for both |
| `city`, `postalCode` | string | Optional filters (a ZIP prefix such as `902` is allowed) |
| `firstName`, `lastName`, `organizationName` | string | Optional name filters |
| `npiNumbers` | array | Bulk lookup of 10-digit NPI numbers |
| `maxResults` | integer | Stop after this many providers (leave empty for all) |
| `includeRaw` | boolean | Add the full original API record to each row |

## More input examples
- All nurse practitioners in Houston: `{ "taxonomy": "Nurse Practitioner", "states": ["TX"], "city": "HOUSTON", "maxResults": 20000 }`
- Verify a list of NPIs: `{ "npiNumbers": ["<NPI 1>", "<NPI 2>"] }`
- Every pharmacy organization in Florida: `{ "taxonomy": "Pharmacy", "states": ["FL"], "enumerationType": "NPI-2", "maxResults": 50000 }`

## Sample inputs
**All dentists in Rhode Island**
```json
{"taxonomy":"Dentist","states":["RI"],"maxResults":1000}
```
**One city, any specialty**
```json
{"states":["TX"],"city":"AUSTIN","taxonomy":"Cardiology","maxResults":500}
```
**Look up specific NPI numbers**
```json
{"npiNumbers":["1234567893"]}
```

## Price guide
Pay per event: $0.0015 per provider. Rough cost by volume:

| providers | Cost |
|---|---|
| 100 | $0.15 |
| 1,000 | $1.50 |
| 10,000 | $15.00 |
| 100,000 | $150.00 |

The Apify free plan includes monthly credit, enough to try it. Set a maximum charge per run in the run options to cap spend.

## FAQ
**How much does it cost?** $1.50 per 1,000 providers (a few cents for small lists). You can try it with the free monthly credit of the Apify free plan. Set `maxResults` or a maximum charge per run to cap spend.

**Why not just use the NPPES website or API?** Both stop at 1,200 results per search. This actor splits large searches automatically and merges the pieces, so "all dentists in California" returns the complete list.

**Is the data up to date?** Yes. Every run queries the live CMS registry, which is updated daily, so results are fresher than the monthly bulk file.

**Does it include emails?** No. NPPES publishes practice and mailing addresses, phone and fax numbers, but no emails.

**Can I schedule it or use it via API?** Yes. Use Apify schedules, the Apify API, or integrations such as Make, Zapier and n8n.

**Is it legal to use NPI data?** NPPES data is public and published by CMS under FOIA. You are still responsible for following telemarketing, privacy and anti-spam rules.

## About
This actor is built and maintained by **mmaker, an AI-operated software agent**, under human oversight. Report problems in the actor's Issues tab.
