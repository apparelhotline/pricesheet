# Orders sync — Airtable → GitHub (`orders.json`)

`orders.json` is a snapshot of the **Vendor Order Tracking** Airtable base, refreshed
on a schedule by a Make.com scenario and committed to this repo. The static site can
`fetch('orders.json')` to render live order/shipment status without any backend.

## File shape

```jsonc
{
  "updated": "2026-06-02T21:10:00.000Z",   // ISO timestamp of this snapshot
  "source": "Airtable · Vendor Order Tracking",
  "orderCount": 19,
  "orders": [
    {
      "id": "recRi0UUJ6f4zUqV0",            // Airtable record id (stable key)
      "orderNumber": "73101190",            // Orders.Order Number (primary)
      "vendor": "S&S Activewear",           // Orders.Vendor (linked record name)
      "vendorSO": "Inv 99010215 / 99010216",// Orders.Vendor SO #
      "orderDate": "2026-05-27",            // Orders.Order Date (YYYY-MM-DD)
      "status": "Shipped",                  // Orders.Status (single select name)
      "expectedDelivery": null,             // Orders.Expected Delivery
      "orderTotal": 271.47,                 // Orders.Order Total (currency)
      "totalPieces": null,                  // Orders.Total Pieces
      "carrier": "UPS",                     // Orders.Carrier
      "source": "Email",                    // Orders.Source (single select name)
      "lastUpdated": "2026-06-02T20:55:00.000Z", // Orders.Last Updated
      "orderUrl": null,                     // Orders.Order URL
      "flag": "🔵 In progress",             // Orders.Flag (formula)
      "shipments": [                        // nested from the Shipments table
        {
          "tracking": "1ZK58W750308976746", // Shipments.Tracking Number (primary)
          "carrier": "UPS",                 // Shipments.Carrier
          "shipDate": "2026-05-27",         // Shipments.Ship Date
          "estDelivery": null,              // Shipments.Est. Delivery
          "status": "In Transit",           // Shipments.Ship Status
          "contents": "CN warehouse – $61.47" // Shipments.Contents
        }
      ]
    }
  ]
}
```

Single-select fields (`Status`, `Source`, `Carrier`, `Ship Status`) are flattened to
their **name** string. Linked `Vendor` is flattened to the linked record's name.
Empty Airtable cells become `null`.

## Make.com scenario

Org **PAYRESPECTS** › team **My Team**. The Airtable connection already exists
(`My Airtable OAuth connection`). **You still need to add a GitHub connection** (or
use an HTTP + PAT module — see note below).

| # | Module | Config |
|---|--------|--------|
| 1 | **Schedule** (trigger) | Every 30 minutes |
| 2 | **Airtable › Search Records** | Base `Vendor Order Tracking` (`appaSS8smskprOGW2`), table **Orders** (`tblakbnZYhhKEyYLW`). No filter = all orders. Sort `Order Date` desc. |
| 3 | **Airtable › Search Records** | Same base, table **Shipments** (`tblyPWtzy7rsig5Ml`). Filter formula: `{Order} = "{{2.Order Number}}"` so each order pulls its own boxes. |
| 4 | **Array aggregator** (over module 3) | Target structure = a shipment object: `tracking / carrier / shipDate / estDelivery / status / contents`. Produces the `shipments[]` array per order. |
| 5 | **Array aggregator** (over module 2) | Target structure = an order object (the fields above), mapping `shipments` ← the array from module 4. |
| 6 | **Set variable** `payload` | `{{ { "updated": now, "source": "Airtable · Vendor Order Tracking", "orderCount": length(5.array), "orders": 5.array } }}` (use a JSON string via `toJSON`). |
| 7 | **GitHub › Update a File** | Repo `apparelhotline/pricesheet`, branch `main`, path `orders.json`, content = module 6, commit message `chore: refresh orders.json`. GitHub's update-file API requires the current blob **sha**; the Make GitHub "Update a File" module fetches it for you. |

### No GitHub connection? Use HTTP instead of module 7
The repo has no GitHub connection in Make yet. Two options:

1. **Add the GitHub app connection** in Make and use the native *Update a File* module (simplest).
2. **HTTP module** with a fine-grained PAT (Contents: read/write on this repo):
   - `GET https://api.github.com/repos/apparelhotline/pricesheet/contents/orders.json?ref=main` → read `.sha`
   - `PUT` same URL with body `{ "message": "...", "content": base64(payload), "sha": "<sha>", "branch": "main" }`

## Why a single committed file
GitHub Pages serves `orders.json` straight from the repo, so the price sheet can read a
fresh snapshot with one `fetch` — no API keys in the browser, no rate limits, and full
git history of how orders changed over time.

## Regenerating the seed locally
The committed `orders.json` was seeded from a live read of the base. Make overwrites it
every 30 min; you normally never edit it by hand.
