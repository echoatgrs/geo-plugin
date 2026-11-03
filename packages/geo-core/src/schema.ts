/**
 * JSON-LD presets beyond Article / BlogPosting / FAQPage: BreadcrumbList, Organization, Person, Product / Offer,
 * HowTo and LocalBusiness.
 *
 * Each preset has a field mapping (what document field feeds which property), a builder and validation rules.
 * Only values found in the document or the config are output: nothing is guessed or made up (no ratings, reviews,
 * prices, stock or opening hours the CMS doesn't hold). A node whose required fields are missing or invalid is left
 * out, with a diagnostic; the other nodes are still output.
 *
 * "Valid" here means the plugin's own rules (schema.org types, ISO formats, absolute URLs). It is not a promise
 * that a search engine or assistant shows a rich result or uses the data. Search platforms support only some types
 * for rich results and change that over time; see docs/jsonld-presets.md for the sources.
 */

export type SchemaIssueSeverity = 'error' | 'warning'

export interface SchemaIssue {
  /** Stable id, e.g. `LD-PRODUCT-PRICE`. */
  ruleId: string
  severity: SchemaIssueSeverity
  /** Node type the issue is about. */
  nodeType: string
  /** Property path inside the node, e.g. `offers.price`. */
  property?: string
  /** Document field the value came from, when known. */
  field?: string
  message: string
}

export type PresetType = 'Product' | 'HowTo' | 'LocalBusiness' | 'Person' | 'Organization'

export type FieldKind = 'text' | 'url' | 'image' | 'images' | 'list' | 'raw' | 'date' | 'duration' | 'decimal' | 'number'

export interface PresetFieldDefinition {
  kind: FieldKind
  /** Default field paths tried when the property isn't mapped. */
  defaults?: string[]
  description: string
}

/** Field mapping per preset: the keys you can set in `jsonLd.fields`. */
export const PRESET_FIELDS: Readonly<Record<PresetType, Readonly<Record<string, PresetFieldDefinition>>>> = {
  Product: {
    name: { kind: 'text', description: 'Product name. Default: the document title.' },
    description: { kind: 'text', description: 'Default: the document description.' },
    image: { kind: 'images', description: 'Image(s). Default: the document image.' },
    sku: { kind: 'text', defaults: ['sku'], description: 'Stock keeping unit.' },
    mpn: { kind: 'text', defaults: ['mpn'], description: 'Manufacturer part number.' },
    gtin: { kind: 'text', defaults: ['gtin'], description: 'GTIN-8/12/13/14 (digits only).' },
    brand: { kind: 'text', defaults: ['brand'], description: 'Brand name (string or `{ name }`).' },
    price: { kind: 'decimal', defaults: ['price'], description: 'Price as a decimal string ("19.90") or number; see `priceUnit`.' },
    priceCurrency: { kind: 'text', defaults: ['currency', 'priceCurrency'], description: 'ISO 4217 code, e.g. EUR.' },
    availability: { kind: 'text', defaults: ['availability', 'stockStatus'], description: 'InStock, OutOfStock, PreOrder, … (schema.org ItemAvailability).' },
    offerURL: { kind: 'url', description: 'URL of the offer. Default: the page URL.' },
    priceValidUntil: { kind: 'date', defaults: ['priceValidUntil'], description: 'ISO date the price is valid until.' },
    itemCondition: { kind: 'text', defaults: ['condition', 'itemCondition'], description: 'NewCondition, UsedCondition, RefurbishedCondition, DamagedCondition.' },
    offers: { kind: 'list', description: 'Several offers: a list of `{ price, priceCurrency, availability, url, priceValidUntil }`.' },
  },
  HowTo: {
    name: { kind: 'text', description: 'Default: the document title.' },
    description: { kind: 'text', description: 'Default: the document description.' },
    image: { kind: 'images', description: 'Default: the document image.' },
    steps: { kind: 'list', defaults: ['steps'], description: 'List of steps `{ name?, text, url?, image? }` (required; never taken from the body).' },
    tools: { kind: 'list', defaults: ['tools'], description: 'Tools: strings or `{ name }`.' },
    supplies: { kind: 'list', defaults: ['supplies', 'materials'], description: 'Materials: strings or `{ name }`.' },
    totalTime: { kind: 'duration', defaults: ['totalTime'], description: 'ISO 8601 duration (PT30M) or minutes as a number.' },
  },
  LocalBusiness: {
    businessType: { kind: 'text', defaults: ['businessType'], description: 'schema.org LocalBusiness subtype, e.g. Restaurant. Default LocalBusiness.' },
    name: { kind: 'text', description: 'Default: the document title.' },
    description: { kind: 'text', description: 'Default: the document description.' },
    image: { kind: 'images', description: 'Default: the document image.' },
    url: { kind: 'url', description: 'Default: the page URL.' },
    telephone: { kind: 'text', defaults: ['telephone', 'phone'], description: 'Phone number, international format recommended.' },
    address: { kind: 'raw', defaults: ['address'], description: '`{ streetAddress, addressLocality, addressRegion, postalCode, addressCountry }`.' },
    openingHours: { kind: 'list', defaults: ['openingHours'], description: 'List of `{ days: ["Monday"], opens: "09:00", closes: "17:00" }`.' },
    latitude: { kind: 'number', defaults: ['latitude', 'geo.latitude', 'location.latitude'], description: 'Decimal degrees.' },
    longitude: { kind: 'number', defaults: ['longitude', 'geo.longitude', 'location.longitude'], description: 'Decimal degrees.' },
    priceRange: { kind: 'text', defaults: ['priceRange'], description: 'e.g. "$$" or "10–20 EUR".' },
  },
  Person: {
    name: { kind: 'text', description: 'Default: the document title.' },
    description: { kind: 'text', description: 'Default: the document description.' },
    image: { kind: 'image', description: 'Photo. Default: the document image.' },
    url: { kind: 'url', description: 'Default: the page URL.' },
    jobTitle: { kind: 'text', defaults: ['jobTitle', 'role'], description: 'Job title.' },
    sameAs: { kind: 'list', defaults: ['sameAs', 'socialLinks'], description: 'Profile URLs elsewhere.' },
  },
  Organization: {
    name: { kind: 'text', description: 'Default: the document title.' },
    description: { kind: 'text', description: 'Default: the document description.' },
    logo: { kind: 'image', defaults: ['logo'], description: 'Default: the document image.' },
    url: { kind: 'url', description: 'Default: the page URL.' },
    sameAs: { kind: 'list', defaults: ['sameAs', 'socialLinks'], description: 'Profile URLs elsewhere.' },
    telephone: { kind: 'text', defaults: ['telephone', 'phone'], description: 'Phone number.' },
    email: { kind: 'text', defaults: ['email'], description: 'Contact email.' },
  },
}

export const PRESET_TYPES = Object.keys(PRESET_FIELDS) as PresetType[]

/** Site-wide organization: the publisher of every article and the `@id` other nodes refer to. */
export interface OrganizationConfig {
  name: string
  /** Default: the site URL. */
  url?: string
  /** Absolute URL or a path on the site. */
  logo?: string
  sameAs?: string[]
  legalName?: string
  email?: string
  telephone?: string
  /** Stable `@id`. Default `<siteURL>/#organization`. Keep it the same if the host site also outputs it. */
  id?: string
}

/** An author as the mapping found it. */
export interface AuthorEntity {
  name: string
  url?: string | null
  image?: string | null
  jobTitle?: string | null
  sameAs?: string[]
}

export interface BreadcrumbItem {
  name: string
  /** Absolute URL or a path on the site. */
  url: string
}

// ---------- Value checks ----------

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** One-line text, control characters removed, length capped. HTML is kept as text (the serializer escapes `<`). */
export function cleanText(value: unknown, max = 5000): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const text = value.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

function isHttp(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Absolute http(s) URL, a path resolved against `base`, or null (javascript:, data:, mailto: … are refused). */
export function absoluteURL(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return isHttp(v) ? v : null
  if (v.startsWith('//')) return isHttp(`https:${v}`) ? `https:${v}` : null
  try {
    if (v.startsWith('/')) return `${base.replace(/\/+$/, '')}${v}`
    return new URL(v, base.endsWith('/') ? base : `${base}/`).href
  } catch {
    return null
  }
}

/**
 * A price as a decimal string without float drift. Numbers are converted with `String()` (never `toFixed`, which
 * rounds); a number with more than 6 decimals is refused as a likely float artefact. `minor` treats the value as
 * an integer amount of minor units (cents) and divides with integer arithmetic.
 */
export function decimalString(value: unknown, unit: 'major' | 'minor' = 'major', fractionDigits = 2): string | null {
  if (unit === 'minor') {
    const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? BigInt(value.trim()) : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : typeof value === 'bigint' ? value : null
    if (n === null || n < 0n) return null
    if (fractionDigits === 0) return n.toString()
    const s = n.toString().padStart(fractionDigits + 1, '0')
    return `${s.slice(0, -fractionDigits)}.${s.slice(-fractionDigits)}`
  }
  let s: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    s = String(value)
    if (/e/i.test(s)) return null
  } else if (typeof value === 'string') s = value.trim()
  else return null
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  if ((s.split('.')[1]?.length ?? 0) > 6) return null
  return s
}

let currencies: Set<string> | null = null
/** ISO 4217 code known to the runtime (falls back to the format check where `Intl.supportedValuesOf` is missing). */
export function isCurrency(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false
  try {
    currencies ??= new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('currency'))
    return currencies.size === 0 || currencies.has(code)
  } catch {
    return true
  }
}

/** Fraction digits of a currency (JPY 0, EUR 2), for minor unit prices. */
export function currencyDigits(code: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

const AVAILABILITY = ['InStock', 'OutOfStock', 'PreOrder', 'PreSale', 'BackOrder', 'Discontinued', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly', 'SoldOut', 'MadeToOrder', 'Reserved']
const CONDITION = ['NewCondition', 'UsedCondition', 'RefurbishedCondition', 'DamagedCondition']

/** `in_stock`, `instock`, `InStock`, `https://schema.org/InStock` → `https://schema.org/InStock`. */
export function schemaEnum(value: unknown, allowed: string[]): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().replace(/^https?:\/\/schema\.org\//i, '').replace(/[\s_-]+/g, '').toLowerCase()
  const hit = allowed.find((a) => a.toLowerCase() === key)
  return hit ? `https://schema.org/${hit}` : null
}

/** ISO 8601 date or date-time (also `Date`). */
export function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return null
  return Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)) ? null : v
}

/** ISO 8601 duration (`PT1H30M`, `P2D`); a number is read as minutes. */
export function isoDuration(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? `PT${Math.round(value)}M` : null
  if (typeof value !== 'string') return null
  const v = value.trim().toUpperCase()
  if (!/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(v)) return null
  return v
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'PublicHolidays']
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

function dayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()
  return DAYS.find((d) => d.toLowerCase() === key || d.slice(0, 3).toLowerCase() === key) ?? null
}

const LOCAL_BUSINESS_TYPES = new Set([
  'LocalBusiness', 'AnimalShelter', 'ArchiveOrganization', 'AutomotiveBusiness', 'AutoRepair', 'AutoDealer', 'ChildCare', 'Dentist',
  'DryCleaningOrLaundry', 'EmergencyService', 'EmploymentAgency', 'EntertainmentBusiness', 'FinancialService', 'BankOrCreditUnion',
  'FoodEstablishment', 'Bakery', 'BarOrPub', 'CafeOrCoffeeShop', 'FastFoodRestaurant', 'IceCreamShop', 'Restaurant', 'Winery',
  'GovernmentOffice', 'HealthAndBeautyBusiness', 'BeautySalon', 'DaySpa', 'HairSalon', 'HealthClub', 'NailSalon', 'TattooParlor',
  'HomeAndConstructionBusiness', 'Electrician', 'GeneralContractor', 'HVACBusiness', 'Locksmith', 'MovingCompany', 'Plumber',
  'RoofingContractor', 'InternetCafe', 'LegalService', 'Attorney', 'Notary', 'Library', 'LodgingBusiness', 'BedAndBreakfast',
  'Campground', 'Hostel', 'Hotel', 'Motel', 'Resort', 'MedicalBusiness', 'Optician', 'Pharmacy', 'Physician', 'ProfessionalService',
  'RadioStation', 'RealEstateAgent', 'RecyclingCenter', 'SelfStorage', 'ShoppingCenter', 'SportsActivityLocation', 'ExerciseGym',
  'GolfCourse', 'SportsClub', 'StadiumOrArena', 'Store', 'BikeStore', 'BookStore', 'ClothingStore', 'ComputerStore',
  'ConvenienceStore', 'DepartmentStore', 'ElectronicsStore', 'Florist', 'FurnitureStore', 'GardenStore', 'GroceryStore',
  'HardwareStore', 'HobbyShop', 'HomeGoodsStore', 'JewelryStore', 'LiquorStore', 'MensClothingStore', 'MobilePhoneStore',
  'MovieRentalStore', 'MusicStore', 'OfficeEquipmentStore', 'OutletStore', 'PawnShop', 'PetStore', 'ShoeStore', 'SportingGoodsStore',
  'TireShop', 'ToyStore', 'WholesaleStore', 'TelevisionStation', 'TouristInformationCenter', 'TravelAgency',
])

// ---------- Builders ----------

export interface PresetBuildContext {
  /** Page URL (canonical when set). */
  url: string
  siteURL: string
  /** Field each preset property was read from, for diagnostics. */
  fieldOf?: Record<string, string>
  /** `priceUnit` of the source: `major` (default) or `minor` (integer cents). */
  priceUnit?: 'major' | 'minor'
}

type Node = Record<string, unknown>
type Result = { node: Node | null; issues: SchemaIssue[] }

function issue(nodeType: string, severity: SchemaIssueSeverity, ruleId: string, message: string, property?: string, field?: string): SchemaIssue {
  const i: SchemaIssue = { ruleId, severity, nodeType, message }
  if (property) i.property = property
  if (field) i.field = field
  return i
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return typeof list === 'string' ? [list] : []
  return list
    .map((v) => cleanText(typeof v === 'object' && v ? (v as Node).name ?? (v as Node).title ?? (v as Node).text : v, 300))
    .filter((v): v is string => !!v)
}

function images(value: unknown, base: string): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  return list.map((v) => absoluteURL(typeof v === 'object' && v ? (v as Node).url : v, base)).filter((v): v is string => !!v)
}

function urls(value: unknown, base: string): { ok: string[]; bad: number } {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  const ok: string[] = []
  let bad = 0
  for (const v of list) {
    const u = absoluteURL(typeof v === 'object' && v ? (v as Node).url ?? (v as Node).href : v, base)
    if (u) ok.push(u)
    else bad++
  }
  return { ok, bad }
}

function offerNode(raw: Node, ctx: PresetBuildContext, at: string, issues: SchemaIssue[]): Node | null {
  const field = (p: string) => ctx.fieldOf?.[p]
  const currency = typeof raw.priceCurrency === 'string' ? raw.priceCurrency.trim().toUpperCase() : raw.priceCurrency
  if (!isCurrency(currency)) {
    issues.push(issue('Offer', 'error', 'LD-PRODUCT-CURRENCY', raw.priceCurrency == null ? 'Offer has a price but no currency; the offer is left out.' : `Currency "${String(raw.priceCurrency)}" is not an ISO 4217 code; the offer is left out.`, `${at}.priceCurrency`, field('priceCurrency')))
    return null
  }
  const price = decimalString(raw.price, ctx.priceUnit, currencyDigits(currency))
  if (price === null) {
    issues.push(issue('Offer', 'error', 'LD-PRODUCT-PRICE', `Price "${String(raw.price)}" is not a plain decimal (use "19.90", no currency signs, no float artefacts); the offer is left out.`, `${at}.price`, field('price')))
    return null
  }
  const offer: Node = { '@type': 'Offer', price, priceCurrency: currency }
  if (raw.availability != null) {
    const a = schemaEnum(raw.availability, AVAILABILITY)
    if (a) offer.availability = a
    else issues.push(issue('Offer', 'warning', 'LD-PRODUCT-AVAILABILITY', `Availability "${String(raw.availability)}" is not a schema.org ItemAvailability value; left out.`, `${at}.availability`, field('availability')))
  }
  if (raw.itemCondition != null) {
    const c = schemaEnum(raw.itemCondition, CONDITION)
    if (c) offer.itemCondition = c
    else issues.push(issue('Offer', 'warning', 'LD-PRODUCT-CONDITION', `Condition "${String(raw.itemCondition)}" is not a schema.org OfferItemCondition; left out.`, `${at}.itemCondition`, field('itemCondition')))
  }
  if (raw.priceValidUntil != null) {
    const d = isoDate(raw.priceValidUntil)
    if (d) offer.priceValidUntil = d.slice(0, 10)
    else issues.push(issue('Offer', 'warning', 'LD-PRODUCT-VALID-UNTIL', `priceValidUntil "${String(raw.priceValidUntil)}" is not an ISO date; left out.`, `${at}.priceValidUntil`, field('priceValidUntil')))
  }
  const url = raw.url == null ? ctx.url : absoluteURL(raw.url, ctx.siteURL)
  if (url) offer.url = url
  else issues.push(issue('Offer', 'warning', 'LD-URL', `Offer URL "${String(raw.url)}" is not an http(s) URL; left out.`, `${at}.url`, field('offerURL')))
  return offer
}

function buildProduct(d: Node, ctx: PresetBuildContext): Result {
  const issues: SchemaIssue[] = []
  const name = cleanText(d.name, 300)
  if (!name) return { node: null, issues: [issue('Product', 'error', 'LD-PRODUCT-NAME', 'Product has no name; the Product node is left out.', 'name', ctx.fieldOf?.name)] }
  const node: Node = { '@type': 'Product', '@id': `${ctx.url}#product`, name, url: ctx.url }
  const description = cleanText(d.description)
  if (description) node.description = description
  const img = images(d.image, ctx.siteURL)
  if (img.length) node.image = img
  for (const key of ['sku', 'mpn'] as const) {
    const v = cleanText(d[key], 100)
    if (v) node[key] = v
  }
  if (d.gtin != null) {
    const g = cleanText(d.gtin, 20)?.replace(/[\s-]/g, '')
    if (g && /^(\d{8}|\d{12,14})$/.test(g)) node.gtin = g
    else issues.push(issue('Product', 'warning', 'LD-PRODUCT-GTIN', `GTIN "${String(d.gtin)}" is not 8, 12, 13 or 14 digits; left out.`, 'gtin', ctx.fieldOf?.gtin))
  }
  const brand = cleanText(typeof d.brand === 'object' && d.brand ? (d.brand as Node).name : d.brand, 200)
  if (brand) node.brand = { '@type': 'Brand', name: brand }

  const rawOffers: Node[] = Array.isArray(d.offers) ? (d.offers.filter((o) => o && typeof o === 'object') as Node[]) : []
  if (!rawOffers.length && (d.price != null || d.priceCurrency != null)) {
    rawOffers.push({ price: d.price, priceCurrency: d.priceCurrency, availability: d.availability, url: d.offerURL ?? undefined, priceValidUntil: d.priceValidUntil, itemCondition: d.itemCondition })
  } else if (!rawOffers.length && d.availability != null) {
    issues.push(issue('Product', 'warning', 'LD-PRODUCT-PRICE', 'Availability is set but there is no price, so no Offer is output.', 'offers.price', ctx.fieldOf?.price))
  }
  const offers = rawOffers.map((o, i) => offerNode(o, ctx, rawOffers.length > 1 ? `offers[${i}]` : 'offers', issues)).filter((o): o is Node => !!o)
  if (offers.length) node.offers = offers.length === 1 ? offers[0] : offers
  else if (!rawOffers.length)
    issues.push(issue('Product', 'warning', 'LD-PRODUCT-OFFER', 'No price: the Product is output without an Offer. Search engines usually need an offer, review or rating for product results (suggestion, not a schema.org requirement).', 'offers'))
  return { node, issues }
}

function buildHowTo(d: Node, ctx: PresetBuildContext): Result {
  const issues: SchemaIssue[] = []
  const name = cleanText(d.name, 300)
  const rawSteps = Array.isArray(d.steps) ? d.steps : []
  const steps: Node[] = []
  rawSteps.forEach((s, i) => {
    const step = typeof s === 'string' ? { text: s } : s && typeof s === 'object' ? (s as Node) : {}
    const text = cleanText(step.text ?? step.body ?? step.description ?? step.content)
    if (!text) {
      issues.push(issue('HowTo', 'warning', 'LD-HOWTO-STEP', `Step ${i + 1} has no text; left out.`, `step[${i}].text`, ctx.fieldOf?.steps))
      return
    }
    const node: Node = { '@type': 'HowToStep', position: steps.length + 1, text }
    const stepName = cleanText(step.name ?? step.title, 300)
    if (stepName) node.name = stepName
    if (step.url != null) {
      const u = absoluteURL(String(step.url).startsWith('#') ? `${ctx.url}${step.url}` : step.url, ctx.siteURL)
      if (u) node.url = u
      else issues.push(issue('HowTo', 'warning', 'LD-URL', `Step ${i + 1} URL is not an http(s) URL; left out.`, `step[${i}].url`, ctx.fieldOf?.steps))
    }
    const img = images(step.image, ctx.siteURL)
    if (img.length) node.image = img[0]
    steps.push(node)
  })
  if (!name || !steps.length) {
    issues.push(issue('HowTo', 'error', 'LD-HOWTO-REQUIRED', !name ? 'HowTo has no name; left out.' : 'HowTo has no steps with text; left out (steps are never guessed from the body).', !name ? 'name' : 'step', !name ? ctx.fieldOf?.name : ctx.fieldOf?.steps))
    return { node: null, issues }
  }
  const node: Node = { '@type': 'HowTo', '@id': `${ctx.url}#howto`, name, url: ctx.url, step: steps }
  const description = cleanText(d.description)
  if (description) node.description = description
  const img = images(d.image, ctx.siteURL)
  if (img.length) node.image = img
  const tools = names(d.tools)
  if (tools.length) node.tool = tools.map((t) => ({ '@type': 'HowToTool', name: t }))
  const supplies = names(d.supplies)
  if (supplies.length) node.supply = supplies.map((t) => ({ '@type': 'HowToSupply', name: t }))
  if (d.totalTime != null) {
    const t = isoDuration(d.totalTime)
    if (t) node.totalTime = t
    else issues.push(issue('HowTo', 'warning', 'LD-HOWTO-DURATION', `totalTime "${String(d.totalTime)}" is not an ISO 8601 duration (e.g. PT30M); left out.`, 'totalTime', ctx.fieldOf?.totalTime))
  }
  return { node, issues }
}

function buildLocalBusiness(d: Node, ctx: PresetBuildContext): Result {
  const issues: SchemaIssue[] = []
  let type = 'LocalBusiness'
  if (d.businessType != null) {
    const t = cleanText(d.businessType, 60)
    if (t && LOCAL_BUSINESS_TYPES.has(t)) type = t
    else issues.push(issue('LocalBusiness', 'warning', 'LD-BUSINESS-TYPE', `"${String(d.businessType)}" is not a known LocalBusiness subtype; LocalBusiness is used.`, '@type', ctx.fieldOf?.businessType))
  }
  const name = cleanText(d.name, 300)
  const a = d.address && typeof d.address === 'object' ? (d.address as Node) : typeof d.address === 'string' ? { streetAddress: d.address } : {}
  const address: Node = { '@type': 'PostalAddress' }
  for (const key of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']) {
    const v = cleanText(a[key] ?? a[{ streetAddress: 'street', addressLocality: 'city', addressRegion: 'region', postalCode: 'zip', addressCountry: 'country' }[key]!], 200)
    if (v) address[key] = v
  }
  if (!name || (!address.streetAddress && !address.addressLocality)) {
    issues.push(issue(type, 'error', 'LD-BUSINESS-REQUIRED', !name ? 'Business has no name; left out.' : 'Business has no street address or locality; left out.', !name ? 'name' : 'address', !name ? ctx.fieldOf?.name : ctx.fieldOf?.address))
    return { node: null, issues }
  }
  const url = d.url == null ? ctx.url : absoluteURL(d.url, ctx.siteURL)
  const node: Node = { '@type': type, '@id': `${ctx.url}#business`, name, address, url: url ?? ctx.url }
  if (d.url != null && !url) issues.push(issue(type, 'warning', 'LD-URL', `URL "${String(d.url)}" is not an http(s) URL; the page URL is used.`, 'url', ctx.fieldOf?.url))
  if (address.addressCountry && !/^[A-Z]{2}$/.test(String(address.addressCountry)))
    issues.push(issue(type, 'warning', 'LD-BUSINESS-COUNTRY', 'addressCountry is usually a two-letter ISO 3166-1 code (suggestion).', 'address.addressCountry', ctx.fieldOf?.address))
  const description = cleanText(d.description)
  if (description) node.description = description
  const img = images(d.image, ctx.siteURL)
  if (img.length) node.image = img
  const tel = cleanText(d.telephone, 40)
  if (tel) {
    node.telephone = tel
    if (!/^\+?[\d\s().-]{5,}$/.test(tel)) issues.push(issue(type, 'warning', 'LD-BUSINESS-TELEPHONE', `Telephone "${tel}" has unusual characters.`, 'telephone', ctx.fieldOf?.telephone))
  }
  const range = cleanText(d.priceRange, 100)
  if (range) node.priceRange = range
  if (Array.isArray(d.openingHours)) {
    const specs: Node[] = []
    d.openingHours.forEach((h, i) => {
      const entry = h && typeof h === 'object' ? (h as Node) : {}
      const rawDays = entry.days ?? entry.dayOfWeek ?? entry.day
      const days = (Array.isArray(rawDays) ? rawDays : [rawDays]).map(dayName)
      const opens = typeof entry.opens === 'string' ? entry.opens.trim() : ''
      const closes = typeof entry.closes === 'string' ? entry.closes.trim() : ''
      if (!days.length || days.some((x) => !x) || !TIME.test(opens) || !TIME.test(closes)) {
        issues.push(issue(type, 'warning', 'LD-BUSINESS-HOURS', `Opening hours entry ${i + 1} needs day names and HH:MM times; left out.`, `openingHoursSpecification[${i}]`, ctx.fieldOf?.openingHours))
        return
      }
      specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: days.length === 1 ? days[0] : days, opens, closes })
    })
    if (specs.length) node.openingHoursSpecification = specs
  }
  if (d.latitude != null || d.longitude != null) {
    const lat = Number(d.latitude)
    const lng = Number(d.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && d.latitude !== '' && d.longitude !== '')
      node.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng }
    else issues.push(issue(type, 'warning', 'LD-BUSINESS-GEO', 'Latitude / longitude missing or out of range; left out.', 'geo', ctx.fieldOf?.latitude))
  }
  return { node, issues }
}

function buildPerson(d: Node, ctx: PresetBuildContext): Result {
  const name = cleanText(d.name, 200)
  if (!name) return { node: null, issues: [issue('Person', 'error', 'LD-PERSON-NAME', 'Person has no name; left out.', 'name', ctx.fieldOf?.name)] }
  const issues: SchemaIssue[] = []
  const url = d.url == null ? ctx.url : absoluteURL(d.url, ctx.siteURL) ?? ctx.url
  const node: Node = { '@type': 'Person', '@id': `${url.split('#')[0]}#person`, name, url }
  const description = cleanText(d.description)
  if (description) node.description = description
  const img = images(d.image, ctx.siteURL)
  if (img.length) node.image = img[0]
  const job = cleanText(d.jobTitle, 200)
  if (job) node.jobTitle = job
  const same = urls(d.sameAs, ctx.siteURL)
  if (same.ok.length) node.sameAs = same.ok
  if (same.bad) issues.push(issue('Person', 'warning', 'LD-URL', `${same.bad} sameAs value(s) are not http(s) URLs; left out.`, 'sameAs', ctx.fieldOf?.sameAs))
  return { node, issues }
}

function buildOrganizationPage(d: Node, ctx: PresetBuildContext): Result {
  const name = cleanText(d.name, 200)
  if (!name) return { node: null, issues: [issue('Organization', 'error', 'LD-ORGANIZATION-NAME', 'Organization has no name; left out.', 'name', ctx.fieldOf?.name)] }
  const issues: SchemaIssue[] = []
  const url = d.url == null ? ctx.url : absoluteURL(d.url, ctx.siteURL) ?? ctx.url
  const node: Node = { '@type': 'Organization', '@id': `${url.split('#')[0]}#organization`, name, url }
  const description = cleanText(d.description)
  if (description) node.description = description
  const logo = images(d.logo, ctx.siteURL)[0]
  if (logo) node.logo = { '@type': 'ImageObject', url: logo }
  const same = urls(d.sameAs, ctx.siteURL)
  if (same.ok.length) node.sameAs = same.ok
  if (same.bad) issues.push(issue('Organization', 'warning', 'LD-URL', `${same.bad} sameAs value(s) are not http(s) URLs; left out.`, 'sameAs', ctx.fieldOf?.sameAs))
  for (const key of ['telephone', 'email'] as const) {
    const v = cleanText(d[key], 200)
    if (v) node[key] = v
  }
  return { node, issues }
}

const BUILDERS: Record<PresetType, (d: Node, ctx: PresetBuildContext) => Result> = {
  Product: buildProduct,
  HowTo: buildHowTo,
  LocalBusiness: buildLocalBusiness,
  Person: buildPerson,
  Organization: buildOrganizationPage,
}

export function isPresetType(type: string | undefined): type is PresetType {
  return !!type && Object.prototype.hasOwnProperty.call(PRESET_FIELDS, type)
}

/** Builds the main node of a preset type from the mapped values. */
export function buildPresetNode(type: PresetType, data: Node, ctx: PresetBuildContext): Result {
  return BUILDERS[type](data, ctx)
}

/** The site organization node, with a stable `@id`. */
export function organizationNode(org: OrganizationConfig, siteURL: string): Result {
  const issues: SchemaIssue[] = []
  const name = cleanText(org.name, 200)
  const url = absoluteURL(org.url ?? siteURL, siteURL)
  if (!name || !url) return { node: null, issues: [issue('Organization', 'error', 'LD-ORGANIZATION-NAME', 'Site organization needs a name and an http(s) URL; left out.', !name ? 'name' : 'url')] }
  const node: Node = { '@type': 'Organization', '@id': org.id ?? `${siteURL.replace(/\/+$/, '')}/#organization`, name, url }
  if (org.legalName) node.legalName = cleanText(org.legalName, 200)
  if (org.logo) {
    const logo = absoluteURL(org.logo, siteURL)
    if (logo) node.logo = { '@type': 'ImageObject', url: logo }
    else issues.push(issue('Organization', 'warning', 'LD-URL', 'Organization logo is not an http(s) URL; left out.', 'logo'))
  }
  const same = urls(org.sameAs, siteURL)
  if (same.ok.length) node.sameAs = same.ok
  if (same.bad) issues.push(issue('Organization', 'warning', 'LD-URL', `${same.bad} sameAs value(s) are not http(s) URLs; left out.`, 'sameAs'))
  if (org.email) node.email = cleanText(org.email, 200)
  if (org.telephone) node.telephone = cleanText(org.telephone, 40)
  return { node, issues }
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** A Person node for an author. `@id` is stable: the author's profile URL, else the site URL plus the name. */
export function authorNode(author: AuthorEntity, siteURL: string): Result {
  const issues: SchemaIssue[] = []
  const name = cleanText(author.name, 200)
  if (!name) return { node: null, issues }
  const url = author.url ? absoluteURL(author.url, siteURL) : null
  if (author.url && !url) issues.push(issue('Person', 'warning', 'LD-URL', `Author URL "${author.url}" is not an http(s) URL; left out.`, 'author.url'))
  const node: Node = { '@type': 'Person', '@id': url ? `${url.split('#')[0]}#person` : `${siteURL.replace(/\/+$/, '')}/#person-${slug(name) || 'author'}`, name }
  if (url) node.url = url
  const img = author.image ? absoluteURL(author.image, siteURL) : null
  if (img) node.image = img
  const job = cleanText(author.jobTitle, 200)
  if (job) node.jobTitle = job
  const same = urls(author.sameAs, siteURL)
  if (same.ok.length) node.sameAs = same.ok
  if (same.bad) issues.push(issue('Person', 'warning', 'LD-URL', `${same.bad} author sameAs value(s) are not http(s) URLs; left out.`, 'author.sameAs'))
  return { node, issues }
}

/** BreadcrumbList from ordered items; at least two items, each with a name and an absolute URL. */
export function breadcrumbNode(items: BreadcrumbItem[], pageURL: string, siteURL: string): Result {
  const issues: SchemaIssue[] = []
  const list: Node[] = []
  items.forEach((item, i) => {
    const name = cleanText(item?.name, 200)
    const url = absoluteURL(item?.url, siteURL)
    if (!name || !url) {
      issues.push(issue('BreadcrumbList', 'warning', 'LD-BREADCRUMB-ITEM', `Breadcrumb item ${i + 1} needs a name and an http(s) URL; left out.`, `itemListElement[${i}]`))
      return
    }
    list.push({ '@type': 'ListItem', position: list.length + 1, name, item: url })
  })
  if (list.length < 2) {
    issues.push(issue('BreadcrumbList', 'warning', 'LD-BREADCRUMB-ITEM', 'Breadcrumb needs at least two levels; left out.', 'itemListElement'))
    return { node: null, issues }
  }
  return { node: { '@type': 'BreadcrumbList', '@id': `${pageURL}#breadcrumb`, itemListElement: list }, issues }
}

// ---------- Graph helpers ----------

/** Graph nodes of a JSON-LD object (`@graph`, an array, or a single node). */
export function graphNodes(data: unknown): Node[] {
  if (Array.isArray(data)) return data.flatMap(graphNodes)
  if (!data || typeof data !== 'object') return []
  const d = data as Node
  if (Array.isArray(d['@graph'])) return (d['@graph'] as unknown[]).filter((n): n is Node => !!n && typeof n === 'object')
  return [d]
}

function typesOf(node: Node): string[] {
  const t = node['@type']
  return Array.isArray(t) ? t.map(String) : t ? [String(t)] : []
}

/**
 * The graph without nodes of the given types (e.g. the ones the host site outputs itself). References to the
 * removed nodes by `@id` stay, so the host's node with the same `@id` completes them.
 */
export function omitJsonLdTypes<T>(data: T, types: readonly string[]): T {
  if (!types.length || !data || typeof data !== 'object') return data
  const omit = new Set(types)
  const d = data as Node
  if (Array.isArray(d['@graph'])) return { ...d, '@graph': (d['@graph'] as Node[]).filter((n) => !typesOf(n).some((t) => omit.has(t))) } as T
  return data
}

export interface JsonLdConflict {
  severity: SchemaIssueSeverity
  /** `duplicate-id` (same @id with different values), `same-node` (identical node twice), `same-type` (host and GEO both output a type). */
  kind: 'duplicate-id' | 'same-node' | 'same-type' | 'invalid-json'
  id?: string
  nodeType?: string
  /** Properties whose values differ between the copies. */
  properties?: string[]
  /** Which scripts: `geo` (rendered from the plugin) or `host`. */
  sources: Array<'geo' | 'host'>
  message: string
  suggestion: string
}

/** Types the plugin owns at most once per page: a second one from the host is worth a look. */
const SINGLETON_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'FAQPage', 'BreadcrumbList', 'Product', 'HowTo', 'WebPage'])

/**
 * Finds conflicting JSON-LD between the scripts of one page. Several different nodes on a page are fine and are
 * not reported; reported are: the same `@id` with different values, the very same node twice, and a type that
 * both the plugin and the host output (e.g. two Articles), with the properties involved.
 */
export function findJsonLdConflicts(scripts: Array<{ json: string; source: 'geo' | 'host' }>): JsonLdConflict[] {
  const out: JsonLdConflict[] = []
  const nodes: Array<{ node: Node; source: 'geo' | 'host'; script: number }> = []
  scripts.forEach((s, i) => {
    try {
      for (const node of graphNodes(JSON.parse(s.json))) nodes.push({ node, source: s.source, script: i })
    } catch {
      out.push({ severity: 'error', kind: 'invalid-json', sources: [s.source], message: `JSON-LD script ${i + 1} (${s.source}) does not parse.`, suggestion: s.source === 'geo' ? 'Render it with jsonLdScriptProps().' : 'Fix the host site’s JSON-LD.' })
    }
  })
  const byId = new Map<string, typeof nodes>()
  for (const n of nodes) {
    const id = typeof n.node['@id'] === 'string' ? (n.node['@id'] as string) : null
    if (!id) continue
    // A bare reference `{ "@id": … }` is not a copy.
    if (Object.keys(n.node).filter((k) => k !== '@id').length === 0) continue
    byId.set(id, [...(byId.get(id) ?? []), n])
  }
  for (const [id, copies] of byId) {
    if (copies.length < 2) continue
    const [first, ...rest] = copies
    const differing = new Set<string>()
    for (const other of rest) {
      for (const key of new Set([...Object.keys(first!.node), ...Object.keys(other.node)])) {
        if (key in first!.node && key in other.node && JSON.stringify(first!.node[key]) !== JSON.stringify(other.node[key])) differing.add(key)
      }
    }
    const sources = [...new Set(copies.map((c) => c.source))]
    const type = typesOf(first!.node)[0]
    out.push(
      differing.size
        ? { severity: 'error', kind: 'duplicate-id', id, nodeType: type, properties: [...differing], sources, message: `@id ${id} appears ${copies.length} times with different ${[...differing].join(', ')}.`, suggestion: 'Output the node once, or make the values agree (e.g. let the host own it and omit it from GEO).' }
        : { severity: 'warning', kind: 'same-node', id, nodeType: type, sources, message: `@id ${id} appears ${copies.length} times with the same values.`, suggestion: 'Harmless, but one copy is enough.' },
    )
  }
  const geoTypes = new Map<string, Node>()
  for (const n of nodes) if (n.source === 'geo') for (const t of typesOf(n.node)) geoTypes.set(t, n.node)
  const reported = new Set<string>()
  for (const n of nodes) {
    if (n.source !== 'host') continue
    for (const t of typesOf(n.node)) {
      const geo = geoTypes.get(t)
      if (!geo || !SINGLETON_TYPES.has(t) || reported.has(t)) continue
      if (geo['@id'] && geo['@id'] === n.node['@id']) continue
      reported.add(t)
      out.push({
        severity: 'warning',
        kind: 'same-type',
        nodeType: t,
        id: typeof n.node['@id'] === 'string' ? (n.node['@id'] as string) : undefined,
        sources: ['host', 'geo'],
        message: `Both the host site and the GEO plugin output a ${t} (host @id ${String(n.node['@id'] ?? 'none')}, GEO @id ${String(geo['@id'] ?? 'none')}).`,
        suggestion: `Pick one owner: add '${t}' to \`jsonLd.hostManaged\` (GEO omits it with omit: 'host'), or remove it from the host.`,
      })
    }
  }
  return out
}

/** `<script type="application/ld+json">` contents of an HTML page, marked `geo` when rendered by jsonLdScriptProps. */
export function extractJsonLdScripts(html: string): Array<{ json: string; source: 'geo' | 'host' }> {
  const out: Array<{ json: string; source: 'geo' | 'host' }> = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    const attrs = m[1] ?? ''
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(attrs)) continue
    out.push({ json: m[2]!.trim(), source: /data-geo-jsonld/i.test(attrs) ? 'geo' : 'host' })
  }
  return out
}

/**
 * Types to omit from the `?omit=` query of the JSON-LD endpoint: a comma list of types, where `host` stands for the
 * configured `hostManaged` types. Unknown words are ignored.
 */
export function parseOmit(param: string | null | undefined, hostManaged: readonly string[] = []): string[] {
  if (!param) return []
  const out = new Set<string>()
  for (const part of param.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (part === 'host') hostManaged.forEach((t) => out.add(t))
    else if (/^[A-Z][A-Za-z]{1,60}$/.test(part)) out.add(part)
  }
  return [...out]
}
