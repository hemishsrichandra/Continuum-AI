# Customer A before import; customer B after import

Use the main app at http://localhost:3100 and **Continuum Solutions → Device repair** for the company upload and both customer requests. No AsterWave knowledge was imported into this company while staging these requests.

Both accounts use the fictional password `ContinuumDemo!2026`.

| Customer | Email | Request ID | Prepared state |
| --- | --- | --- | --- |
| A / Alice | showcase-alice@example.test | SR-93B3891B-D404-469A-86E3-21FE0455897D | Initial standard network suggestion displayed; no outcome reported |
| B / Bob | showcase-bob@example.test | SR-2CA59C80-4B3C-4591-8E95-AED71BB5AE4A | Same problem saved; chat not started |

Look for **Aster1 Wi-Fi connected but no internet — CSV demo A/B** in My requests. The IDs are different because personal requests are isolated by customer; the underlying issue is identical.

## Exact customer message

```text
On my Phone Aster1, Wi-Fi shows connected but pages do not load. Device: AsterWave smartphone, Phone Aster1.
```

The uploaded file contains this problem in record **AST-ASTER1-WIFI-03**, titled **Wi-Fi says connected but internet does not work - Aster1**.

Its exact reviewed steps are:

```text
Check whether another device can access the internet; complete any sign-in page for public Wi-Fi; restart the phone and router if authorized.
```

## Demonstration sequence

1. Sign in as Alice and open CSV demo A. Show the initial standard network check. Leave it there; do not confirm success or import anything into Alice’s conversation.
2. Sign in as `showcase-owner@example.test`. Open Team and data sources → Knowledge → Knowledge sources → Connect a source. Upload `/Users/hemish/Downloads/asterwave_mobile_support_1000.csv` as CSV (pasted or uploaded), for Device repair.
3. Use the mappings below. Preview, save and sync. Leave the owner-declared verification box unchecked.
4. In the specialist console → Knowledge → Needs you, find **Wi-Fi says connected but internet does not work - Aster1** (browser Find can locate this exact title), review it and approve it with a note. It must be approved before retrieval; upload alone is not approval.
5. Sign in as Bob, open CSV demo B and send the exact customer message above.
6. The existing product gives Bob its standard network check first too. Click **Still need help**, then send **Continue troubleshooting**. The expected suggestion is the imported Aster1 Wi-Fi fix, with its company-import source label and exact CSV steps.

This is an import-and-retrieval demonstration, not learning from Alice’s outcome. Alice’s unsuccessful/unconfirmed standard suggestion is not published as shared knowledge.

## CSV mapping verified with this file

| App field | CSV column |
| --- | --- |
| Record ID | **record_id** |
| Title | title |
| Symptoms | symptoms |
| Solution steps | steps |
| Applies to (text) | applicability |
| Safety restrictions | safety |
| Model(s) | model |
| Product family | product_family |
| Problem category | problem_category |
| Last updated | updated_at |

Use the original **record_id** column. The CSV follow-up fixed long catalogue IDs without weakening secret detection: credential-shaped opaque identifiers are represented internally by stable non-secret references. Explicit credential syntax is still rejected. The original record_id mapping was verified to sync all 1,000 records; the original CSV was not edited. The title-as-ID workaround from the earlier rehearsal is no longer needed.

Structured title/symptoms/steps CSVs can also be uploaded in the article/ticket import screen: they are detected as records and drafted without a model call. That screen previews at most 500 drafts and explicitly reports the remainder; use Knowledge sources to sync the full 1,000-row file. Both paths retain specialist approval and do not mark imports customer-confirmed.

The isolated verification ran the full sequence: A standard suggestion → import all 1,000 rows → approve this one fix → B standard check fails → Continue troubleshooting → exact CSV suggestion. The main company remains in the before-import state so you can perform the upload yourself.
