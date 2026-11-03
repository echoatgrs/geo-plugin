# JSON-LD presets

`jsonLd.type` picks the main node of a page. Article types (`Article`, `BlogPosting`, `NewsArticle`,
`TechArticle`, …) and `WebPage` are built as before. The presets below have their own field mapping and checks.

All output follows schema.org vocabulary. **Valid JSON-LD is no promise of rich results, AI indexing or
citation**: search engines decide what they show, and some types (HowTo) no longer get rich results in Google.

Every node gets a stable `@id` and refers to others by it, in one `@graph`:

| Node | `@id` |
| --- | --- |
| Main node | `<page URL or canonical>#<type lowercased>` |
| WebPage | `<page URL>` |
| Organization (`llms.organization`) | `organization.id`, default `<siteURL>/#organization` |
| Person (author, with `jsonLd.author`) | `<profile URL>#person`, or `<siteURL>/#person-<name slug>` |
| BreadcrumbList | `<page URL>#breadcrumb` |

Keep `organization.id` the same as the host site's own Organization node if it has one; `?omit=host` (with
`hostManaged`) leaves out types the host already renders while references to them stay valid.

## Field mapping

Per preset, `jsonLd.fields` maps a preset property to a field path, a function, or a list tried in order. Unmapped
properties use the default field names in the table. Nothing is guessed from the body text.

### Product (+ Offer)

| Property | Default field | Notes |
| --- | --- | --- |
| `name`, `description`, `image` | the document title / description / image | |
| `sku`, `mpn`, `brand` | `sku`, `mpn`, `brand` | `brand` may be `{ name }` |
| `gtin` | `gtin` | 8, 12, 13 or 14 digits (spaces / dashes removed), else left out with a warning (LD-PRODUCT-GTIN) |
| `price` | `price` | decimal string or number; `priceUnit: 'minor'` for integer cents. Converted exactly (no float maths); more than 6 decimals is refused |
| `priceCurrency` | `currency`, `priceCurrency` | ISO 4217, checked with `Intl` |
| `availability` | `availability`, `stockStatus` | `InStock`, `OutOfStock`, `PreOrder`, … → `https://schema.org/InStock` |
| `itemCondition` | `condition`, `itemCondition` | |
| `priceValidUntil` | `priceValidUntil` | ISO date |
| `offerURL` | — | default: the page URL |
| `offers` | — | several offers: a list of `{ price, priceCurrency, availability, url, priceValidUntil }` |

A price without a valid ISO 4217 currency, or a price that isn't a plain decimal, drops the offer (errors
LD-PRODUCT-CURRENCY / LD-PRODUCT-PRICE). Invalid availability, condition or date drop that property (warnings). A
product without a name is left out (LD-PRODUCT-NAME). A product without a price gets the suggestion LD-PRODUCT-OFFER:
search engines usually want an offer, review or rating for product results (not a schema.org requirement).

### HowTo

`steps` (required; list of `{ name?, text, url?, image? }`), `tools`, `supplies`, `totalTime` (ISO 8601 duration or
minutes). Steps are never extracted from the body.

### LocalBusiness

`businessType` (a LocalBusiness subtype such as `Restaurant`, `Store`, `Dentist`; unknown types fall back to
`LocalBusiness` with a warning), `address` (`{ streetAddress, addressLocality, addressRegion, postalCode,
addressCountry }`; a name and a street address or locality are required, else the node is left out),
`telephone`, `latitude` / `longitude` (range-checked, output as `geo`), `openingHours`
(`[{ days: ['Monday'], opens: '09:00', closes: '17:00' }]`), `priceRange`, `url`.

### Person and Organization pages

`Person`: `name`, `description`, `jobTitle`, `image`, `url`, `sameAs`. `Organization`: `name`, `description`,
`logo`, `url`, `sameAs`, `email`, `telephone`. The site-wide publisher is `llms.organization`
(`name`, `url`, `logo`, `sameAs`, `legalName`, `email`, `telephone`, `id`).

### BreadcrumbList

`breadcrumb: true` builds home → `parents` → the page; or return the items yourself with `items(doc)`. Needs at
least two items. Never inferred from the URL path alone.

## Checks

Errors drop the node or property they concern; warnings keep the output. Both show in the editor panel
(LD-* rule ids) and the Markdown / JSON-LD preview. `findJsonLdConflicts` (used by the setup status check
ACT-JSONLD-CONFLICTS) reports duplicate `@id`s with different content, two nodes of a singleton type (e.g. two
Organization nodes without the same `@id`) and invalid JSON in the page's `<script type="application/ld+json">`
blocks, telling GEO's script (`data-geo-jsonld`) from the host site's.

## Real outputs

The outputs below are from the test sites in the sandbox (Strapi 5.60, Payload 3.92), unedited.

### Product (Strapi 5.60, `price` decimal 19.9, `currency` EUR, `availability` InStock)

`GET /api/geo/jsonld?path=/products/widget-pro`

```json
{
    "@context": "https://schema.org",
    "@graph": [
        {
            "@type": "Product",
            "@id": "http://localhost:3000/products/widget-pro#product",
            "name": "Widget Pro",
            "url": "http://localhost:3000/products/widget-pro",
            "description": "A sturdy widget.",
            "sku": "WP-1",
            "brand": {
                "@type": "Brand",
                "name": "Acme"
            },
            "offers": {
                "@type": "Offer",
                "price": "19.9",
                "priceCurrency": "EUR",
                "availability": "https://schema.org/InStock",
                "url": "http://localhost:3000/products/widget-pro"
            }
        },
        {
            "@type": "Organization",
            "@id": "http://localhost:3000/#organization",
            "name": "Acme Ltd",
            "url": "http://localhost:3000",
            "logo": {
                "@type": "ImageObject",
                "url": "http://localhost:3000/logo.png"
            }
        }
    ]
}
```

### BlogPosting with BreadcrumbList and site Organization (Payload 3.92)

`GET /api/geo/jsonld?path=/blog/hello-payload-renamed` with `organization` and `breadcrumb: { parents: [{ name: 'Blog', url: '/blog' }] }`

```json
{
    "@context": "https://schema.org",
    "@graph": [
        {
            "@type": "BlogPosting",
            "@id": "http://localhost:3000/blog/hello-payload-renamed#article",
            "headline": "Hello Payload",
            "url": "http://localhost:3000/blog/hello-payload-renamed",
            "description": "Published edit.",
            "mainEntityOfPage": {
                "@type": "WebPage",
                "@id": "http://localhost:3000/blog/hello-payload-renamed"
            },
            "datePublished": "2026-11-03T14:46:31.262Z",
            "dateModified": "2026-11-03T14:46:40.755Z",
            "author": {
                "@id": "http://localhost:3000/#organization"
            },
            "publisher": {
                "@id": "http://localhost:3000/#organization"
            }
        },
        {
            "@type": "BreadcrumbList",
            "@id": "http://localhost:3000/blog/hello-payload-renamed#breadcrumb",
            "itemListElement": [
                {
                    "@type": "ListItem",
                    "position": 1,
                    "name": "Home",
                    "item": "http://localhost:3000"
                },
                {
                    "@type": "ListItem",
                    "position": 2,
                    "name": "Blog",
                    "item": "http://localhost:3000/blog"
                },
                {
                    "@type": "ListItem",
                    "position": 3,
                    "name": "Hello Payload",
                    "item": "http://localhost:3000/blog/hello-payload-renamed"
                }
            ]
        },
        {
            "@type": "Organization",
            "@id": "http://localhost:3000/#organization",
            "name": "Acme Ltd",
            "url": "http://localhost:3000",
            "logo": {
                "@type": "ImageObject",
                "url": "http://localhost:3000/logo.png"
            },
            "sameAs": [
                "https://github.com/acme"
            ]
        }
    ]
}
```

## Sources

- schema.org: [Product](https://schema.org/Product), [Offer](https://schema.org/Offer),
  [HowTo](https://schema.org/HowTo), [LocalBusiness](https://schema.org/LocalBusiness),
  [Person](https://schema.org/Person), [Organization](https://schema.org/Organization),
  [BreadcrumbList](https://schema.org/BreadcrumbList), [ItemAvailability](https://schema.org/ItemAvailability)
- Google Search Central structured data:
  [Product](https://developers.google.com/search/docs/appearance/structured-data/product),
  [Breadcrumb](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb),
  [Organization](https://developers.google.com/search/docs/appearance/structured-data/organization),
  [Local business](https://developers.google.com/search/docs/appearance/structured-data/local-business),
  [Article](https://developers.google.com/search/docs/appearance/structured-data/article),
  [HowTo rich results deprecation (2023)](https://developers.google.com/search/blog/2023/08/howto-faq-changes)
